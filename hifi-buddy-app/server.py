#!/usr/bin/env python3
"""
HiFi Buddy — minimal dev server.

Serves static files and proxies the few API calls the front-end needs:
  - GET  /api/config          → Read durable user config (creds, equipment, etc.)
  - POST /api/config          → Partial-update merge of config (whitelist-filtered)
  - GET  /api/probe-quality   → ffprobe a stream URL → {codec,bitDepth,sampleRate,...}
  - GET  /api/plex/*          → Plex Web API (token in query string)
  - GET  /api/plex-stream/*   → Plex audio stream (FLAC + MP3 transcode for ABX)
  - POST /api/claude          → Anthropic API proxy for the in-app AI guide
  - POST /api/local/scan      → Scan a local folder for audio files, build index
  - GET  /api/local/index     → Return cached local-library index
  - GET  /api/local/stream/N  → Stream a local file (with Range support)
  - GET  /api/local/transcode/N?bitrate=K → ffmpeg-transcoded MP3 (cached on disk)
  - GET  /api/local/probe     → Reports ffmpeg/mutagen availability

Durable state (config, ABX results, timing feedback) lives under
~/.hifi-buddy/ (override with HIFIBUDDY_HOME env var). localStorage in the
browser holds only ephemeral UI prefs.

No external Python deps required (stdlib only). `mutagen` is used if installed
for accurate tag-based indexing; otherwise filename parsing is used.

Run with:

    python3 server.py

Defaults to port 8090. Override with PORT=NNNN env var. Open at:

    http://127.0.0.1:8090/

(IMPORTANT — use 127.0.0.1, NOT localhost. Spotify's OAuth requires the
loopback IP form for HTTP redirect URIs.)
"""
import hashlib
import http.server
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PORT = int(os.environ.get('PORT', 8090))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'
CLAUDE_API_VERSION = '2023-06-01'

# -------- HiFi Buddy persistent state --------
# All durable state (creds, equipment, ABX results, timing feedback) lives here.
# localStorage holds only ephemeral UI preferences. Override the location with
# HIFIBUDDY_HOME=/some/path for testing or sandboxing.
HIFIBUDDY_HOME = os.environ.get('HIFIBUDDY_HOME', os.path.expanduser('~/.hifi-buddy'))
CONFIG_PATH = os.path.join(HIFIBUDDY_HOME, 'config.json')

# Whitelist of config keys the server will store. Anything outside this set is
# silently dropped — defends against the client trying to dump arbitrary
# localStorage payloads (UI prefs, caches, etc.) into the config file.
CONFIG_ALLOWED_KEYS = frozenset({
    'plex_url', 'plex_token',
    'spotify_client_id', 'spotify_client_secret', 'spotify_auth_method',
    'claude_api_key',
    'ollama_url', 'ollama_model',
    'local_folder',
})

# -------- Local Library state --------
LOCAL_INDEX_PATH = os.path.join(DIRECTORY, 'local-library-index.json')
LOCAL_AUDIO_EXTS = {'.flac', '.mp3', '.ogg', '.opus', '.m4a', '.wav', '.aac'}
LOCAL_CONTENT_TYPES = {
    '.flac': 'audio/flac',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.aac': 'audio/aac',
}

try:
    import mutagen  # type: ignore
    HAS_MUTAGEN = True
except ImportError:
    mutagen = None
    HAS_MUTAGEN = False


def ffmpeg_path():
    """Locate ffmpeg in PATH or common Homebrew locations. Returns absolute path or None."""
    p = shutil.which('ffmpeg')
    if p:
        return p
    for cand in ('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'):
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


def ffprobe_path():
    """Locate ffprobe — bundled alongside ffmpeg in every distribution we
    care about. Same lookup strategy as ffmpeg_path()."""
    p = shutil.which('ffprobe')
    if p:
        return p
    for cand in ('/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'):
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


# -------- Config persistence helpers --------

def load_config():
    """Read config.json. Returns {} if the file is missing or malformed —
    we don't want a corrupt config to brick the app."""
    if not os.path.isfile(CONFIG_PATH):
        return {}
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError) as e:
        # Surface in server log but don't crash the request
        print(f'[config] Failed to read {CONFIG_PATH}: {e}')
        return {}


def save_config_atomic(data):
    """Atomic write to ~/.hifi-buddy/config.json. Creates the directory with
    chmod 700 and the file with chmod 600 so only the user can read it
    (these contain auth tokens). Uses .tmp + os.replace so a crash mid-write
    can't corrupt the existing config."""
    os.makedirs(HIFIBUDDY_HOME, exist_ok=True)
    try:
        os.chmod(HIFIBUDDY_HOME, 0o700)
    except OSError:
        # Non-POSIX (Windows) — fall back to default ACLs
        pass
    tmp = CONFIG_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, CONFIG_PATH)


# -------- ABX results & timing feedback (durable user state) --------

ABX_LOG_PATH = os.path.join(HIFIBUDDY_HOME, 'abx_results.jsonl')
TIMING_PATH = os.path.join(HIFIBUDDY_HOME, 'timing_feedback.json')

# Whitelist of fields a single ABX result entry is allowed to contain. Keeps
# the JSONL file from growing into a kitchen-sink as the schema evolves.
ABX_RESULT_FIELDS = frozenset({
    'lessonId', 'bitrate', 'trials', 'correct', 'pValue',
    'segment', 'completedAt',
})


def append_abx_log(entry):
    """Append one result as a single JSON line. JSONL not full-rewrite so
    a crash mid-write at most loses the current line (and never corrupts
    earlier ones)."""
    os.makedirs(HIFIBUDDY_HOME, exist_ok=True)
    try:
        os.chmod(HIFIBUDDY_HOME, 0o700)
    except OSError:
        pass
    line = json.dumps(entry, separators=(',', ':')) + '\n'
    with open(ABX_LOG_PATH, 'a', encoding='utf-8') as f:
        f.write(line)
        f.flush()
        os.fsync(f.fileno())
    try:
        os.chmod(ABX_LOG_PATH, 0o600)
    except OSError:
        pass


def read_abx_log():
    """Read all results, grouped by lessonId. Skips malformed lines (so one
    bad write can never wedge the whole history)."""
    out = {}
    if not os.path.isfile(ABX_LOG_PATH):
        return out
    try:
        with open(ABX_LOG_PATH, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                lid = entry.get('lessonId')
                if not lid:
                    continue
                clean = {k: v for k, v in entry.items()
                         if k in ABX_RESULT_FIELDS and k != 'lessonId'}
                out.setdefault(lid, []).append(clean)
    except OSError as e:
        print(f'[abx] Read failed: {e}')
    return out


def load_timing_feedback():
    if not os.path.isfile(TIMING_PATH):
        return {}
    try:
        with open(TIMING_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError) as e:
        print(f'[timing] Read failed: {e}')
        return {}


def save_timing_feedback_atomic(data):
    """Whole-file replace (the data is small — one entry per lesson — and
    full-replace is simpler than diff-merge for this case)."""
    os.makedirs(HIFIBUDDY_HOME, exist_ok=True)
    try:
        os.chmod(HIFIBUDDY_HOME, 0o700)
    except OSError:
        pass
    tmp = TIMING_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, TIMING_PATH)


# -------- Source-quality probe (ffprobe) --------

# Disk cache for ffprobe results. URL → JSON file, hashed so the cache key
# doesn't leak Plex tokens / paths into a directory listing. 24h TTL because
# Plex stream URLs rotate but the underlying file's quality doesn't.
PROBE_CACHE_DIR = os.path.join(HIFIBUDDY_HOME, 'cache', 'probe')
PROBE_CACHE_TTL = 24 * 60 * 60  # 24 hours

def _probe_cache_key(url):
    """Hash the full URL so two URLs that differ only by token still share a
    cache entry under their canonical (token-stripped) form. We strip any
    `X-Plex-Token=` query param before hashing so a token rotation doesn't
    invalidate the cache."""
    try:
        parsed = urllib.parse.urlparse(url)
        qs = [(k, v) for (k, v) in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
              if k.lower() not in ('x-plex-token', 'plextoken')]
        canonical = urllib.parse.urlunparse((
            parsed.scheme, parsed.netloc, parsed.path, parsed.params,
            urllib.parse.urlencode(qs), '',
        ))
    except Exception:
        canonical = url
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def _probe_cache_read(url):
    key = _probe_cache_key(url)
    path = os.path.join(PROBE_CACHE_DIR, f'{key}.json')
    if not os.path.isfile(path):
        return None
    try:
        if time.time() - os.path.getmtime(path) > PROBE_CACHE_TTL:
            return None
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _probe_cache_write(url, data):
    os.makedirs(PROBE_CACHE_DIR, exist_ok=True)
    key = _probe_cache_key(url)
    path = os.path.join(PROBE_CACHE_DIR, f'{key}.json')
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except OSError as e:
        print(f'[probe] Cache write failed: {e}')


def _probe_url_quality(url, timeout_secs=10):
    """Run ffprobe on a URL. Returns a dict of audio properties or raises.

    Why ffprobe instead of trusting Plex/library/metadata: Plex's metadata
    index can be stale or incomplete (Stream array sometimes missing on
    library/sections/.../search results). ffprobe reads the actual file
    bytes, so it's the source of truth for source-quality detection."""
    fp = ffprobe_path()
    if not fp:
        raise RuntimeError('ffprobe not installed')
    cmd = [
        fp,
        '-v', 'error',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        # ffprobe takes the URL via -i. The microsecond timeout protects us
        # from hanging on a Plex server that's slow to respond.
        '-timeout', str(int(timeout_secs * 1_000_000)),
        '-i', url,
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=timeout_secs + 2,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f'ffprobe timed out after {timeout_secs}s')
    if result.returncode != 0:
        # ffprobe writes diagnostic text to stderr; surface the first line.
        msg = (result.stderr or '').strip().split('\n', 1)[0] or 'ffprobe failed'
        raise RuntimeError(msg[:200])
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f'ffprobe returned non-JSON: {e}')
    streams = data.get('streams') or []
    audio = next((s for s in streams if s.get('codec_type') == 'audio'), None)
    if not audio:
        raise RuntimeError('no audio stream')
    fmt = data.get('format') or {}

    def _i(v):
        try: return int(v) if v is not None else 0
        except (ValueError, TypeError): return 0

    def _f(v):
        try: return float(v) if v is not None else 0.0
        except (ValueError, TypeError): return 0.0

    # bits_per_raw_sample is the meaningful one for FLAC (24-bit FLAC reports
    # 24 here, while bits_per_sample may be 0 because the codec is variable-
    # length). Fall back to bits_per_sample for codecs that always set it.
    bit_depth = _i(audio.get('bits_per_raw_sample')) or _i(audio.get('bits_per_sample'))

    # bit_rate from the audio stream is most precise; format-level bit_rate
    # includes container overhead. Prefer the stream value.
    bit_rate = _i(audio.get('bit_rate')) or _i(fmt.get('bit_rate'))

    # Container: ffprobe's format_name is comma-separated for ambiguous files
    # (e.g., "mov,mp4,m4a,..."). Take the first token.
    container = (fmt.get('format_name') or '').split(',')[0].upper()

    return {
        'codec':      (audio.get('codec_name') or '').upper(),
        'sampleRate': _i(audio.get('sample_rate')),
        'bitDepth':   bit_depth,
        'channels':   _i(audio.get('channels')),
        'bitrate':    bit_rate,
        'container':  container,
        'duration':   _f(fmt.get('duration')) or _f(audio.get('duration')),
        'probedAt':   int(time.time()),
    }


# Plex client identification — required by Plex's universal transcoder
PLEX_CLIENT_HEADERS = {
    'X-Plex-Client-Identifier': 'hifi-buddy',
    'X-Plex-Product': 'HiFi Buddy',
    'X-Plex-Version': '1.0',
    'X-Plex-Platform': 'Web',
    'X-Plex-Device-Name': 'HiFi Buddy',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    # -------- Routing --------

    def do_POST(self):
        if self.path == '/api/config':
            return self.post_config()
        if self.path == '/api/config/reveal':
            return self.reveal_config_folder()
        if self.path == '/api/abx/log':
            return self.post_abx_log()
        if self.path == '/api/abx/import':
            return self.post_abx_import()
        if self.path == '/api/timing/feedback':
            return self.post_timing_feedback()
        if self.path == '/api/claude':
            return self.proxy_claude()
        if self.path == '/api/ollama':
            return self.proxy_ollama()
        if self.path == '/api/local/scan':
            return self.local_scan()
        self.send_error(404, 'Not Found')

    def do_GET(self):
        if self.path == '/api/config':
            return self.get_config()
        if self.path.startswith('/api/probe-quality'):
            return self.probe_quality()
        if self.path.startswith('/api/abx/results'):
            return self.get_abx_results()
        if self.path == '/api/timing/feedback':
            return self.get_timing_feedback()
        if self.path.startswith('/api/plex-stream/'):
            return self.proxy_plex_stream()
        if self.path.startswith('/api/plex/'):
            return self.proxy_plex()
        if self.path.startswith('/api/ollama/models'):
            return self.proxy_ollama_models()
        if self.path == '/api/local/index':
            return self.local_index()
        if self.path == '/api/local/probe':
            return self.local_probe()
        if self.path.startswith('/api/local/stream/'):
            return self.local_stream()
        if self.path.startswith('/api/local/transcode/'):
            return self.local_transcode()
        return super().do_GET()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        self.end_headers()

    # -------- Claude proxy --------

    def proxy_claude(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length else b''
            payload = json.loads(body or b'{}')
            api_key = payload.pop('apiKey', '')
            if not api_key:
                return self.send_json(400, {'error': 'Missing apiKey'})
            req = urllib.request.Request(
                CLAUDE_API_URL,
                data=json.dumps(payload).encode('utf-8'),
                headers={
                    'x-api-key': api_key,
                    'anthropic-version': CLAUDE_API_VERSION,
                    'Content-Type': 'application/json',
                },
                method='POST',
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                self.send_response(resp.status if hasattr(resp, 'status') else 200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(resp.read())
        except urllib.error.HTTPError as e:
            body = b''
            try: body = e.read()
            except Exception: pass
            self.send_json(e.code, {'error': body.decode('utf-8', errors='replace')[:500]})
        except Exception as e:
            self.send_json(500, {'error': str(e)})

    # -------- Ollama proxy (local AI for the AI listening guide) --------

    def proxy_ollama(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length else b''
            payload = json.loads(body or b'{}')
            ollama_url = payload.pop('ollamaUrl', '').rstrip('/')
            if not ollama_url:
                return self.send_json(400, {'error': 'Missing ollamaUrl'})
            ollama_body = {
                'model': payload.get('model', 'gemma2'),
                'messages': ([{'role': 'system', 'content': payload['system']}] if payload.get('system') else []) + payload.get('messages', []),
                'stream': False,
            }
            # Forward format if client requested strict JSON mode (small models really need this)
            if payload.get('format'):
                ollama_body['format'] = payload['format']
            req = urllib.request.Request(
                f'{ollama_url}/api/chat',
                data=json.dumps(ollama_body).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(resp.read())
        except urllib.error.HTTPError as e:
            self.send_json(e.code, {'error': 'Ollama request failed'})
        except Exception as e:
            self.send_json(500, {'error': str(e)})

    # -------- Ollama: list installed models --------

    def proxy_ollama_models(self):
        """GET /api/ollama/models?url=http://localhost:11434
        Proxies to Ollama's /api/tags endpoint, normalizes the response into
        {models: [{name, size, modified_at}, ...]} for the settings UI."""
        try:
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            ollama_url = (params.get('url', ['http://localhost:11434'])[0] or '').rstrip('/')
            if not ollama_url:
                return self.send_json(400, {'error': 'Missing url parameter'})
            req = urllib.request.Request(
                f'{ollama_url}/api/tags',
                headers={'Accept': 'application/json'},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
            models = []
            for m in (data.get('models') or []):
                models.append({
                    'name': m.get('name') or m.get('model') or '',
                    'size': m.get('size') or 0,
                    'modified_at': m.get('modified_at') or '',
                })
            self.send_json(200, {'models': models})
        except urllib.error.HTTPError as e:
            self.send_json(e.code, {'error': f'Ollama returned {e.code}', 'models': []})
        except urllib.error.URLError as e:
            # Connection refused, DNS, etc. — Ollama not running
            self.send_json(503, {'error': f'Cannot reach Ollama at {ollama_url}: {e.reason}', 'models': []})
        except Exception as e:
            self.send_json(500, {'error': str(e), 'models': []})

    # -------- Config (durable user state) --------

    def get_config(self):
        """GET /api/config — read the full config object. Returns only keys in
        CONFIG_ALLOWED_KEYS (defensive against a manually-edited file with
        stray keys). Empty object if the config file doesn't exist yet."""
        try:
            data = load_config()
            filtered = {k: v for k, v in data.items() if k in CONFIG_ALLOWED_KEYS}
            self.send_json(200, filtered)
        except Exception as e:
            self.send_json(500, {'error': str(e)})

    def post_config(self):
        """POST /api/config — partial-update merge. Body is a JSON object;
        keys outside CONFIG_ALLOWED_KEYS are silently dropped. To remove a
        key, send empty string or null. Returns the new full config."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length else b'{}'
            try:
                incoming = json.loads(body or b'{}')
            except json.JSONDecodeError as e:
                return self.send_json(400, {'error': f'Invalid JSON: {e}'})
            if not isinstance(incoming, dict):
                return self.send_json(400, {'error': 'Body must be a JSON object'})
            merged = load_config()
            for k, v in incoming.items():
                if k not in CONFIG_ALLOWED_KEYS:
                    continue
                if v is None or v == '':
                    merged.pop(k, None)
                else:
                    merged[k] = v
            save_config_atomic(merged)
            # Return the new state so callers don't need a follow-up GET
            self.send_json(200, {k: v for k, v in merged.items() if k in CONFIG_ALLOWED_KEYS})
        except Exception as e:
            self.send_json(500, {'error': str(e)})

    def reveal_config_folder(self):
        """POST /api/config/reveal — open ~/.hifi-buddy/ in Finder/Explorer.
        Best-effort: returns the path even if the open command failed so the
        UI can still show it."""
        try:
            os.makedirs(HIFIBUDDY_HOME, exist_ok=True)
        except Exception:
            pass
        opened = False
        try:
            if sys.platform == 'darwin':
                subprocess.Popen(['open', HIFIBUDDY_HOME])
                opened = True
            elif sys.platform.startswith('win'):
                subprocess.Popen(['explorer', HIFIBUDDY_HOME])
                opened = True
            else:
                subprocess.Popen(['xdg-open', HIFIBUDDY_HOME])
                opened = True
        except Exception as e:
            print(f'[config/reveal] {e}')
        self.send_json(200, {'opened': opened, 'path': HIFIBUDDY_HOME})

    # -------- Source-quality probe --------

    def probe_quality(self):
        """GET /api/probe-quality?url=<encoded-stream-url>

        Runs ffprobe on the URL to extract codec/bitDepth/sampleRate/etc.
        Used as a more reliable source than Plex's /library/metadata/ which
        sometimes ships incomplete Stream arrays. Caches the result for 24h
        keyed by a token-stripped hash of the URL, so subsequent renders
        are instant and Plex token rotation doesn't blow away the cache.

        Response shape:
          {codec, sampleRate, bitDepth, channels, bitrate, container, duration, cached}
        """
        try:
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            url = (params.get('url', [''])[0] or '').strip()
            if not url:
                return self.send_json(400, {'error': 'Missing url parameter'})
            # Defensive: only allow http/https. ffprobe will technically open
            # file:// and a few protocol drivers — we don't want this endpoint
            # to be a path-disclosure channel.
            scheme = (urllib.parse.urlparse(url).scheme or '').lower()
            if scheme not in ('http', 'https'):
                return self.send_json(400, {'error': f'Unsupported URL scheme: {scheme!r}'})

            # Cache check
            cached = _probe_cache_read(url)
            if cached:
                cached = dict(cached)
                cached['cached'] = True
                return self.send_json(200, cached)

            if not ffprobe_path():
                return self.send_json(503, {
                    'error': 'ffprobe not installed',
                    'hint': 'Install ffmpeg (which bundles ffprobe). macOS: `brew install ffmpeg`',
                })

            try:
                quality = _probe_url_quality(url)
            except RuntimeError as e:
                return self.send_json(502, {'error': str(e)})

            _probe_cache_write(url, quality)
            quality['cached'] = False
            self.send_json(200, quality)
        except Exception as e:
            self.send_json(500, {'error': str(e)})

    # -------- ABX log + timing-feedback --------

    def get_abx_results(self):
        """GET /api/abx/results[?lesson=X]
        Returns either {lessonId: [results...]} or just the array for one
        lesson if a query param is set."""
        try:
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            lesson = (params.get('lesson', [''])[0] or '').strip()
            all_results = read_abx_log()
            if lesson:
                return self.send_json(200, all_results.get(lesson, []))
            self.send_json(200, all_results)
        except Exception as e:
            self.send_json(500, {'error': str(e)})

    def post_abx_log(self):
        """POST /api/abx/log — append a single ABX result. Body must include
        lessonId and the test fields (bitrate, trials, correct, pValue,
        completedAt). Returns {ok: true}."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length else b'{}'
            try:
                entry = json.loads(body or b'{}')
            except json.JSONDecodeError as e:
                return self.send_json(400, {'error': f'Invalid JSON: {e}'})
            if not isinstance(entry, dict):
                return self.send_json(400, {'error': 'Body must be a JSON object'})
            lid = entry.get('lessonId')
            if not lid or not isinstance(lid, str):
                return self.send_json(400, {'error': 'lessonId required'})
            # Drop unknown keys defensively
            clean = {k: v for k, v in entry.items() if k in ABX_RESULT_FIELDS}
            clean['lessonId'] = lid
            append_abx_log(clean)
            self.send_json(200, {'ok': True})
        except Exception as e:
            self.send_json(500, {'error': str(e)})

    def post_abx_import(self):
        """POST /api/abx/import — bulk import. Body: {lessonId: [results...]}.
        Used once on first M1.2 boot to migrate localStorage history into
        the JSONL file. Skips entries already present (deduped on
        lessonId+completedAt). Returns {imported: N, skipped: M}."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length else b'{}'
            try:
                payload = json.loads(body or b'{}')
            except json.JSONDecodeError as e:
                return self.send_json(400, {'error': f'Invalid JSON: {e}'})
            if not isinstance(payload, dict):
                return self.send_json(400, {'error': 'Body must be a JSON object'})

            existing = read_abx_log()
            # Build a set of (lessonId, completedAt) we already know about so
            # re-running migration doesn't double-count anything.
            seen = set()
            for lid, arr in existing.items():
                for r in arr:
                    seen.add((lid, r.get('completedAt')))

            imported = 0
            skipped = 0
            for lid, arr in payload.items():
                if not isinstance(lid, str) or not isinstance(arr, list):
                    continue
                for r in arr:
                    if not isinstance(r, dict):
                        continue
                    completed = r.get('completedAt')
                    if (lid, completed) in seen:
                        skipped += 1
                        continue
                    clean = {k: v for k, v in r.items() if k in ABX_RESULT_FIELDS}
                    clean['lessonId'] = lid
                    try:
                        append_abx_log(clean)
                        imported += 1
                        seen.add((lid, completed))
                    except OSError as e:
                        print(f'[abx-import] write failed: {e}')
            self.send_json(200, {'imported': imported, 'skipped': skipped})
        except Exception as e:
            self.send_json(500, {'error': str(e)})

    def get_timing_feedback(self):
        """GET /api/timing/feedback — full {lessonId: {originalTime: corrected}}."""
        try:
            self.send_json(200, load_timing_feedback())
        except Exception as e:
            self.send_json(500, {'error': str(e)})

    def post_timing_feedback(self):
        """POST /api/timing/feedback — full-replace. Body is the entire
        overrides object. Caller is responsible for sending the merged
        result; we don't do partial-update merging here because the
        per-lesson edit UI already has the full dict in memory."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length else b'{}'
            try:
                data = json.loads(body or b'{}')
            except json.JSONDecodeError as e:
                return self.send_json(400, {'error': f'Invalid JSON: {e}'})
            if not isinstance(data, dict):
                return self.send_json(400, {'error': 'Body must be a JSON object'})
            # Shape check: every value should be a dict of str→str.
            clean = {}
            for lid, mapping in data.items():
                if not isinstance(lid, str) or not isinstance(mapping, dict):
                    continue
                clean[lid] = {str(k): str(v) for k, v in mapping.items()
                              if isinstance(k, str) and isinstance(v, str)}
            save_timing_feedback_atomic(clean)
            self.send_json(200, {'ok': True, 'lessons': len(clean)})
        except Exception as e:
            self.send_json(500, {'error': str(e)})

    # -------- Plex JSON API --------

    def proxy_plex(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            plex_url = params.get('plexUrl', [''])[0]
            plex_token = params.get('plexToken', [''])[0]
            if not plex_url or not plex_token:
                return self.send_json(400, {'error': 'Missing plexUrl or plexToken'})
            endpoint = self.path.split('/api/plex/', 1)[1].split('?')[0]
            extra = {k: v[0] for k, v in params.items() if k not in ('plexUrl', 'plexToken')}
            extra_qs = '&'.join(f'{k}={urllib.parse.quote(v)}' for k, v in extra.items())
            target = f"{plex_url}/{endpoint}?X-Plex-Token={plex_token}"
            if extra_qs:
                target += f"&{extra_qs}"
            req = urllib.request.Request(target, headers={'Accept': 'application/json'})
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(resp.read())
        except urllib.error.HTTPError as e:
            self.send_json(e.code, {'error': 'Plex request failed'})
        except BrokenPipeError:
            pass
        except Exception as e:
            self.send_json(500, {'error': str(e)})

    # -------- Plex audio stream proxy --------

    def proxy_plex_stream(self):
        """Adds Plex client headers so the universal transcoder accepts the request.
        Used for both direct FLAC streaming and ABX MP3 transcodes."""
        try:
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            plex_url = params.get('plexUrl', [''])[0]
            plex_token = params.get('plexToken', [''])[0]
            if not plex_url or not plex_token:
                return self.send_error(400, 'Missing plexUrl or plexToken')
            endpoint = self.path.split('/api/plex-stream/', 1)[1].split('?')[0]
            extra = {k: v[0] for k, v in params.items() if k not in ('plexUrl', 'plexToken')}
            extra_qs = '&'.join(f'{k}={urllib.parse.quote(v)}' for k, v in extra.items())
            target = f"{plex_url}/{endpoint}?X-Plex-Token={plex_token}"
            if extra_qs:
                target += f"&{extra_qs}"

            req = urllib.request.Request(target)
            range_header = self.headers.get('Range')
            if range_header:
                req.add_header('Range', range_header)
            for k, v in PLEX_CLIENT_HEADERS.items():
                req.add_header(k, v)

            ctx = ssl.create_default_context()
            resp = urllib.request.urlopen(req, context=ctx, timeout=60)

            status = resp.status if hasattr(resp, 'status') else 200
            self.send_response(status)
            content_type = resp.headers.get('Content-Type', 'audio/flac')
            self.send_header('Content-Type', content_type)
            content_length = resp.headers.get('Content-Length')
            if content_length: self.send_header('Content-Length', content_length)
            content_range = resp.headers.get('Content-Range')
            if content_range: self.send_header('Content-Range', content_range)
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'private, max-age=3600')
            self.end_headers()

            CHUNK = 524288
            while True:
                chunk = resp.read(CHUNK)
                if not chunk: break
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except BrokenPipeError:
                    break
            resp.close()
        except BrokenPipeError:
            pass
        except urllib.error.HTTPError as e:
            body = b''
            try: body = e.read()
            except Exception: pass
            msg = f'Plex returned {e.code}: {body.decode("utf-8", errors="replace")[:300]}'
            print(f'[proxy_plex_stream] {msg}')
            try: self.send_error(502, msg)
            except BrokenPipeError: pass
        except Exception as e:
            print(f'[proxy_plex_stream] {type(e).__name__}: {e}')
            try: self.send_error(502, f'Plex stream error: {e}')
            except BrokenPipeError: pass

    # -------- Local Library --------

    def local_probe(self):
        """Tiny capability probe used by the client to decide ABX paths."""
        return self.send_json(200, {
            'ffmpeg': bool(ffmpeg_path()),
            'ffprobe': bool(ffprobe_path()),
            'mutagen': HAS_MUTAGEN,
        })

    def local_index(self):
        """Return the cached index file, or an empty list if none yet."""
        try:
            if os.path.isfile(LOCAL_INDEX_PATH):
                with open(LOCAL_INDEX_PATH, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                # Be permissive: if the file is malformed, just hand back []
                if not isinstance(data, dict):
                    return self.send_json(200, {'folder': '', 'tracks': []})
                # Strip absolute paths from the response — clients only need ids
                tracks = data.get('tracks', [])
                safe = []
                for i, t in enumerate(tracks):
                    safe.append({
                        'id': i,
                        'path': t.get('relPath', ''),
                        'title': t.get('title', ''),
                        'artist': t.get('artist', ''),
                        'album': t.get('album', ''),
                        'duration': t.get('duration', 0),
                        'codec': t.get('codec', ''),
                        'mbid': t.get('mbid', ''),
                    })
                return self.send_json(200, {
                    'folder': data.get('folder', ''),
                    'scanned': data.get('scanned', 0),
                    'indexed': len(safe),
                    'tracks': safe,
                })
        except Exception as e:
            print(f'[local_index] {type(e).__name__}: {e}')
        return self.send_json(200, {'folder': '', 'tracks': [], 'scanned': 0, 'indexed': 0})

    def local_scan(self):
        """Walk a folder for audio files, read tags, persist index. Returns summary."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length else b''
            payload = json.loads(body or b'{}')
            folder = (payload.get('folder') or '').strip()
            if not folder:
                return self.send_json(400, {'error': 'Missing folder'})
            folder = os.path.expanduser(folder)
            if not os.path.isdir(folder):
                return self.send_json(400, {'error': f'Not a directory: {folder}'})

            scanned = 0
            tracks = []
            for root, dirs, files in os.walk(folder):
                # Skip our own cache folder
                dirs[:] = [d for d in dirs if d != '.hifi-buddy-cache']
                for fname in files:
                    ext = os.path.splitext(fname)[1].lower()
                    if ext not in LOCAL_AUDIO_EXTS:
                        continue
                    scanned += 1
                    abs_path = os.path.join(root, fname)
                    rel_path = os.path.relpath(abs_path, folder)
                    entry = self._read_track_meta(abs_path, rel_path, ext)
                    if entry:
                        tracks.append(entry)

            # Sort for stable ids across rescans
            tracks.sort(key=lambda t: (t.get('artist', ''), t.get('album', ''), t.get('relPath', '')))

            index_doc = {
                'folder': folder,
                'scannedAt': int(__import__('time').time()),
                'scanned': scanned,
                'tracks': tracks,
            }
            with open(LOCAL_INDEX_PATH, 'w', encoding='utf-8') as f:
                json.dump(index_doc, f, indent=2)

            resp = {
                'folder': folder,
                'scanned': scanned,
                'indexed': len(tracks),
                'tracks': [
                    {
                        'id': i,
                        'path': t.get('relPath', ''),
                        'title': t.get('title', ''),
                        'artist': t.get('artist', ''),
                        'album': t.get('album', ''),
                        'duration': t.get('duration', 0),
                        'codec': t.get('codec', ''),
                        'mbid': t.get('mbid', ''),
                    } for i, t in enumerate(tracks)
                ],
                'ffmpeg': bool(ffmpeg_path()),
                'mutagen': HAS_MUTAGEN,
            }
            if not HAS_MUTAGEN:
                resp['warning'] = 'Install mutagen for accurate tag-based indexing: pip3 install mutagen'
            return self.send_json(200, resp)
        except Exception as e:
            print(f'[local_scan] {type(e).__name__}: {e}')
            return self.send_json(500, {'error': str(e)})

    def _read_track_meta(self, abs_path, rel_path, ext):
        """Read tag metadata via mutagen if available, else fall back to filename parsing."""
        title = artist = album = ''
        duration = 0
        mbid = ''
        codec = ext.lstrip('.')

        if HAS_MUTAGEN:
            try:
                f = mutagen.File(abs_path, easy=True)
                if f is not None:
                    title = (f.get('title') or [''])[0] if hasattr(f, 'get') else ''
                    artist = (f.get('artist') or [''])[0] if hasattr(f, 'get') else ''
                    album = (f.get('album') or [''])[0] if hasattr(f, 'get') else ''
                    # MusicBrainz Recording ID — different keys per format
                    for k in ('musicbrainz_trackid', 'musicbrainz_releasetrackid', 'musicbrainz_recordingid'):
                        v = f.get(k)
                        if v:
                            mbid = v[0] if isinstance(v, list) else str(v)
                            break
                    if getattr(f, 'info', None) is not None:
                        duration = int(getattr(f.info, 'length', 0) or 0)
            except Exception as e:
                print(f'[mutagen] {abs_path}: {type(e).__name__}: {e}')

        # Filename fallback for missing fields ("Artist - Title.flac" or "NN - Title.flac")
        if not title or not artist:
            base = os.path.splitext(os.path.basename(abs_path))[0]
            # Strip leading track number "01 - " or "01. "
            stripped = re.sub(r'^\s*\d+\s*[-.\s]\s*', '', base)
            if ' - ' in stripped:
                a, _, t = stripped.partition(' - ')
                if not artist:
                    artist = a.strip()
                if not title:
                    title = t.strip()
            else:
                if not title:
                    title = stripped.strip()

        # Album fallback: parent folder name
        if not album:
            album = os.path.basename(os.path.dirname(abs_path)) or ''

        return {
            'relPath': rel_path,
            'title': title,
            'artist': artist,
            'album': album,
            'duration': duration,
            'codec': codec,
            'mbid': mbid,
        }

    def _resolve_track(self, track_id):
        """Return (abs_path, ext, folder, entry) for a track id, or (None, None, None, None)."""
        try:
            tid = int(track_id)
        except (TypeError, ValueError):
            return None, None, None, None
        if not os.path.isfile(LOCAL_INDEX_PATH):
            return None, None, None, None
        try:
            with open(LOCAL_INDEX_PATH, 'r', encoding='utf-8') as f:
                doc = json.load(f)
        except Exception:
            return None, None, None, None
        folder = doc.get('folder', '')
        tracks = doc.get('tracks', [])
        if tid < 0 or tid >= len(tracks):
            return None, None, None, None
        entry = tracks[tid]
        rel = entry.get('relPath', '')
        # Build absolute path and ensure it is contained within `folder` (no traversal)
        abs_path = os.path.realpath(os.path.join(folder, rel))
        folder_real = os.path.realpath(folder)
        if not abs_path.startswith(folder_real + os.sep) and abs_path != folder_real:
            return None, None, None, None
        if not os.path.isfile(abs_path):
            return None, None, None, None
        ext = os.path.splitext(abs_path)[1].lower()
        return abs_path, ext, folder_real, entry

    def local_stream(self):
        """Stream a local file with Range support (chunked, like proxy_plex_stream)."""
        try:
            tail = self.path.split('/api/local/stream/', 1)[1]
            track_id = tail.split('?', 1)[0]
            abs_path, ext, _folder, _entry = self._resolve_track(track_id)
            if not abs_path:
                return self.send_error(404, 'Track not found')

            file_size = os.path.getsize(abs_path)
            content_type = LOCAL_CONTENT_TYPES.get(ext, 'application/octet-stream')

            range_header = self.headers.get('Range')
            start = 0
            end = file_size - 1
            partial = False
            if range_header:
                m = re.match(r'bytes=(\d*)-(\d*)', range_header.strip())
                if m:
                    s, e = m.group(1), m.group(2)
                    if s:
                        start = int(s)
                    if e:
                        end = int(e)
                    if start >= file_size:
                        self.send_response(416)
                        self.send_header('Content-Range', f'bytes */{file_size}')
                        self.end_headers()
                        return
                    end = min(end, file_size - 1)
                    partial = True

            length = end - start + 1
            self.send_response(206 if partial else 200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(length))
            self.send_header('Accept-Ranges', 'bytes')
            if partial:
                self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'private, max-age=3600')
            self.end_headers()

            CHUNK = 524288
            with open(abs_path, 'rb') as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    buf = f.read(min(CHUNK, remaining))
                    if not buf:
                        break
                    try:
                        self.wfile.write(buf)
                        self.wfile.flush()
                    except BrokenPipeError:
                        return
                    remaining -= len(buf)
        except BrokenPipeError:
            pass
        except Exception as e:
            print(f'[local_stream] {type(e).__name__}: {e}')
            try:
                self.send_error(500, f'Stream error: {e}')
            except BrokenPipeError:
                pass

    def local_transcode(self):
        """Stream an MP3 transcode of the requested track via ffmpeg. Cache to disk."""
        try:
            parsed = urllib.parse.urlparse(self.path)
            tail = parsed.path.split('/api/local/transcode/', 1)[1]
            track_id = tail
            params = urllib.parse.parse_qs(parsed.query)
            try:
                bitrate = int(params.get('bitrate', ['192'])[0])
            except ValueError:
                bitrate = 192
            bitrate = max(64, min(bitrate, 320))

            ff = ffmpeg_path()
            if not ff:
                return self.send_json(503, {
                    'error': 'ffmpeg not installed',
                    'install': 'brew install ffmpeg / apt install ffmpeg / port install ffmpeg',
                })

            abs_path, _ext, folder, _entry = self._resolve_track(track_id)
            if not abs_path:
                return self.send_error(404, 'Track not found')

            cache_dir = os.path.join(folder, '.hifi-buddy-cache')
            try:
                os.makedirs(cache_dir, exist_ok=True)
            except Exception as e:
                print(f'[local_transcode] cache mkdir failed: {e}')
                cache_dir = None

            cache_file = None
            if cache_dir:
                cache_file = os.path.join(cache_dir, f'{track_id}-{bitrate}.mp3')

            # Cache hit — serve directly with Range support
            if cache_file and os.path.isfile(cache_file):
                return self._serve_file_with_range(cache_file, 'audio/mpeg')

            # Cache miss — transcode. Write to a temp file then rename, while also
            # streaming to the client. Simplest correct approach: transcode to disk first,
            # then serve. (Transcoding 1 song at 192k takes ~2-5s; acceptable for ABX.)
            tmp_target = (cache_file + '.tmp') if cache_file else os.path.join(
                DIRECTORY, f'.local-transcode-{track_id}-{bitrate}.tmp.mp3'
            )
            cmd = [
                ff, '-y', '-i', abs_path,
                '-vn', '-codec:a', 'libmp3lame',
                '-b:a', f'{bitrate}k',
                '-f', 'mp3',
                tmp_target,
            ]
            try:
                proc = subprocess.run(cmd, capture_output=True, timeout=180)
                if proc.returncode != 0:
                    err = proc.stderr.decode('utf-8', errors='replace')[:400]
                    print(f'[local_transcode] ffmpeg failed: {err}')
                    try: os.unlink(tmp_target)
                    except Exception: pass
                    return self.send_json(500, {'error': 'ffmpeg failed', 'detail': err})
            except subprocess.TimeoutExpired:
                try: os.unlink(tmp_target)
                except Exception: pass
                return self.send_json(504, {'error': 'ffmpeg timeout'})

            served_path = tmp_target
            if cache_file:
                try:
                    os.replace(tmp_target, cache_file)
                    served_path = cache_file
                except Exception as e:
                    print(f'[local_transcode] cache rename failed: {e}')

            try:
                self._serve_file_with_range(served_path, 'audio/mpeg')
            finally:
                # If we couldn't cache, clean up the temp file after sending
                if served_path != cache_file:
                    try: os.unlink(served_path)
                    except Exception: pass
        except BrokenPipeError:
            pass
        except Exception as e:
            print(f'[local_transcode] {type(e).__name__}: {e}')
            try:
                self.send_json(500, {'error': str(e)})
            except BrokenPipeError:
                pass

    def _serve_file_with_range(self, abs_path, content_type):
        """Helper: serve a complete file from disk with HTTP Range support."""
        file_size = os.path.getsize(abs_path)
        range_header = self.headers.get('Range')
        start = 0
        end = file_size - 1
        partial = False
        if range_header:
            m = re.match(r'bytes=(\d*)-(\d*)', range_header.strip())
            if m:
                s, e = m.group(1), m.group(2)
                if s:
                    start = int(s)
                if e:
                    end = int(e)
                if start >= file_size:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{file_size}')
                    self.end_headers()
                    return
                end = min(end, file_size - 1)
                partial = True

        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        if partial:
            self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'private, max-age=3600')
        self.end_headers()

        CHUNK = 524288
        with open(abs_path, 'rb') as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                buf = f.read(min(CHUNK, remaining))
                if not buf:
                    break
                try:
                    self.wfile.write(buf)
                    self.wfile.flush()
                except BrokenPipeError:
                    return
                remaining -= len(buf)

    # -------- Helpers --------

    def send_json(self, code, obj):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        try:
            self.wfile.write(json.dumps(obj).encode('utf-8'))
        except BrokenPipeError:
            pass

    def log_message(self, format, *args):
        first = str(args[0]) if args else ''
        # Quiet down on broken-pipe noise from audio streaming
        if 'Broken pipe' in first:
            return
        super().log_message(format, *args)


def make_server(port=None, host=''):
    """Construct a ThreadingHTTPServer ready to serve. Lets external
    runners (the launcher app) reuse the same Handler + lifecycle without
    duplicating the binding logic here."""
    return http.server.ThreadingHTTPServer((host, port if port is not None else PORT), Handler)


def main():
    server = make_server(PORT)
    print(f'HiFi Buddy server running at http://127.0.0.1:{PORT}/')
    print(f'Config:  {CONFIG_PATH}')
    print('Press Ctrl+C to stop.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down.')
        server.shutdown()


if __name__ == '__main__':
    main()

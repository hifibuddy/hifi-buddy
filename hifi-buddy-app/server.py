#!/usr/bin/env python3
"""
HiFi Buddy — minimal dev server.

Serves static files and proxies the few API calls the front-end needs:
  - GET  /api/plex/*          → Plex Web API (token in query string)
  - GET  /api/plex-stream/*   → Plex audio stream (FLAC + MP3 transcode for ABX)
  - POST /api/claude          → Anthropic API proxy for the in-app AI guide
  - POST /api/local/scan      → Scan a local folder for audio files, build index
  - GET  /api/local/index     → Return cached local-library index
  - GET  /api/local/stream/N  → Stream a local file (with Range support)
  - GET  /api/local/transcode/N?bitrate=K → ffmpeg-transcoded MP3 (cached on disk)
  - GET  /api/local/probe     → Reports ffmpeg/mutagen availability

No external Python deps required (stdlib only). `mutagen` is used if installed
for accurate tag-based indexing; otherwise filename parsing is used.

Run with:

    python3 server.py

Defaults to port 8091. Override with PORT=NNNN env var. Open at:

    http://127.0.0.1:8091/

(IMPORTANT — use 127.0.0.1, NOT localhost. Spotify's OAuth requires the
loopback IP form for HTTP redirect URIs.)
"""
import http.server
import json
import os
import re
import shutil
import ssl
import subprocess
import urllib.error
import urllib.parse
import urllib.request

PORT = int(os.environ.get('PORT', 8091))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'
CLAUDE_API_VERSION = '2023-06-01'

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
        if self.path == '/api/claude':
            return self.proxy_claude()
        if self.path == '/api/ollama':
            return self.proxy_ollama()
        if self.path == '/api/local/scan':
            return self.local_scan()
        self.send_error(404, 'Not Found')

    def do_GET(self):
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


def main():
    server = http.server.ThreadingHTTPServer(('', PORT), Handler)
    print(f'HiFi Buddy server running at http://127.0.0.1:{PORT}/')
    print('Press Ctrl+C to stop.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down.')
        server.shutdown()


if __name__ == '__main__':
    main()

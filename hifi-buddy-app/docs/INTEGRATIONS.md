# Integrations

HiFi Buddy is offline-first. The 30 lessons load with no integrations
configured. But each integration adds something specific:

| Integration | What it adds | Required for |
|---|---|---|
| **Plex** | Library matching, FLAC/ALAC playback, ABX MP3 transcode, lesson-track prefetch, Track Variant Picker, album art, "Browse Plex" tab in the Lesson Generator | HiFi Buddy ABX, lossless playback |
| **Local FLAC** | A folder of audio files, server-side scan + tag-based indexing, ffmpeg-driven ABX transcode, on-disk transcode cache | HiFi Buddy ABX without Plex, fully offline lossless playback |
| **Spotify** | Full-track Premium playback (Web Playback SDK), Spotify Connect device transfer | In-browser Spotify playback for lessons not in Plex/local |
| **Claude API** | The Listening Coach chat, the AI Lesson Generator's Claude path | Per-lesson AI guidance, generating new lessons |
| **Ollama** | Local LLM as the Lesson Generator's free fallback | Free offline lesson generation |
| **MusicBrainz / Cover Art Archive** | Album art when Plex doesn't have it | Lesson album art fallback |

Each integration is described below: what it adds, how to set it up, the
gotchas. Read [SETUP.md](./SETUP.md) first.

## Contents

- [Plex](#plex)
- [Local FLAC](#local-flac)
- [Spotify](#spotify)
- [Claude API](#claude-api)
- [Ollama](#ollama)
- [MusicBrainz / Cover Art Archive](#musicbrainz--cover-art-archive)

---

## Plex

Plex is the heaviest integration and the most rewarding for serious
users. Lossless FLAC playback, ABX testing, library badges, the Browse
Plex tab in the Lesson Generator, and the Track Variant Picker all
depend on it.

### What it adds

- **Library matching.** Lesson tracks are pre-searched and cached.
- **Track playback.** Direct streaming of FLAC/ALAC/MP3/AAC/Ogg/Opus
  through the server's `/api/plex-stream/` proxy (avoids CORS).
- **HiFi Buddy lesson tracks.** All 30 lesson tracks are pre-searched
  and cached in the background.
- **ABX blind testing.** The lossless side comes from your Plex
  library; the lossy side is a Plex transcode at the chosen bitrate.
- **Track Variant Picker.** When Plex has multiple matches for a
  lesson's track, the picker lets you pin a specific one.
- **Album art.** Plex thumbnails are used for lesson album cards when
  the match exists.
- **AI Lesson Generator → Browse Plex tab.** Intersects the curated
  reference catalog (100 tracks) with your Plex library and lets you
  generate lessons for the matches.

### Step-by-step setup

#### 1. Get your Plex server URL

Whatever you'd put into the Plex Web app to reach your server. Local
network examples:

```
http://192.168.1.100:32400
http://plex.local:32400
http://10.0.0.5:32400
```

Remote (via plex.direct):

```
https://192-168-1-100.abc123def.plex.direct:32400
```

Don't include a trailing slash.

#### 2. Get your Plex token

The recommended method:

**Network tab method**

1. Open Plex Web (`https://app.plex.tv`).
2. Open DevTools → Network.
3. Click any item (an album, a track) to trigger a request.
4. Filter requests by `X-Plex-Token` or just look at any URL.
5. Copy the value of the `X-Plex-Token=` query param.

Alternative: the **View XML** method (older Plex versions):

1. In Plex Web, click any item's three-dot menu → **Get Info** →
   **View XML**.
2. The browser opens the XML; the URL ends with
   `?X-Plex-Token=AbCdEf123...`.
3. Copy the value.

> Warning: this token has full access to your Plex server. Keep it
> private. If you accidentally leak it, sign out of all devices in
> your Plex account settings to invalidate.

#### 3. Save in HiFi Buddy

1. Open Settings (gear icon).
2. **Plex Media Server** section:
   - Server URL: paste your URL.
   - Auth Token: paste your token.
3. Click **Test Connection**. You should see "Connected: [server name]".
4. Click **Save Settings**.

After saving:
- The library loads in the background.
- HiFi Buddy starts prefetching lesson tracks (visible on the
  dashboard's Plex Library row: "Indexing 14/30" → "✓ N tracks ready").
- Tracks that match get a Plex-orange play button on their lesson
  page.

### Plex Pass (Premium) features

Some Plex features require a Plex Pass subscription:

| Feature | Plex Pass needed? |
|---|---|
| Library browsing, album art | No |
| Direct file streaming (FLAC, MP3, etc.) | No |
| Transcoding to specific bitrates (`/transcode/universal/*`) | Often Yes — depends on client and source codec. **Required for ABX.** |
| Sonic Analysis | Yes |

If you don't have Plex Pass, you can still use Plex for direct playback
and library matching, but ABX testing won't work. Local FLAC + ffmpeg
is the Plex-Pass-free alternative for ABX.

### Two-layer Plex cache

To keep Plex responsive across origin-switches, Spotify token rotations,
and offline starts, the app maintains two separate caches:

- **Layer A — match data** (`hifibuddy_hifi_plex_matches`): persistent
  per origin. Survives Plex token rotation. Pure metadata
  (`{ratingKey, title, artist, album, ...}` per lesson).
- **Layer B — stream URLs** (`hifibuddy_hifi_plex_streams`): scoped to
  the current Plex token and cleared whenever the token changes. Just
  the resolved direct-stream URLs.

The split lets the UI show "✓ ready" badges instantly from Layer A even
when the token has rotated, while Layer B fills in lazily when you
actually play.

Pre-rename builds used a combined `hifibuddy_hifi_plex_cache` key
(originally `musictrip_hifi_plex_cache`); on first load, it's drained
into the new split layout and removed.

### How the proxy handles Plex

`server.py` proxies all Plex requests through `/api/plex/*` and audio
streams through `/api/plex-stream/*`. The reasons:

- **CORS**: browsers refuse cross-origin streams without proper CORS
  headers, which Plex doesn't send.
- **Transcoding**: Plex's `/transcode/universal/*` requires
  `X-Plex-Client-Identifier` and other client headers; the proxy adds
  these automatically.
- **Range requests**: the proxy forwards `Range` headers so seeking
  works.

The proxy is the reason `127.0.0.1:8090` is the recommended URL —
your browser is talking to the proxy on localhost, which is talking to
Plex on your LAN. The token never leaves your machine (it's passed as
a query param to the local proxy, which makes the actual Plex API
call).

### Common Plex problems

- **"Track not found in Plex"** but you own it: title mismatch, see
  [TROUBLESHOOTING.md → Track not found](./TROUBLESHOOTING.md#1-track-not-found-in-plex-but-i-have-it).
  Try the Track Variant Picker.
- **401 Unauthorized**: token expired or revoked. The Diagnostics
  panel will say so. Refresh your token.
- **502 from `/api/plex-stream/`**: usually the transcoder needs Plex
  Pass, or the proxy isn't sending the X-Plex headers.
- **No prefetch progress**: library hasn't loaded yet. Wait 10–30
  seconds, or check the browser console for `[Plex]` errors.

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for full diagnostics.

---

## Local FLAC

A Plex-free way to use HiFi Buddy with your own audio files. Especially
useful for laptops without a Plex server on the network, for
work-from-home setups, or for users who simply own a folder of FLAC
files.

### What it adds

- **Library scan** — point at a folder, the server walks it, reads
  tags (via `mutagen` if available, falling back to filename parsing),
  and builds an index.
- **Direct streaming** — `/api/local/stream/<id>` serves files with
  HTTP Range support so seeking works. Lessons that match light up
  with a teal **Local** play button.
- **ABX MP3 transcode** — `/api/local/transcode/<id>?bitrate=N` calls
  `ffmpeg` to produce an MP3 at the requested bitrate, cached on disk
  under `<your-folder>/.hifi-buddy-cache/`. Second-run ABX is instant.
- **Track Variant Picker** — local matches participate alongside Plex
  matches when multiple files in your folder match a lesson's
  (artist, title).

### Install ffmpeg + mutagen

ffmpeg is required for ABX on local files. mutagen is strongly
recommended for accurate tag-based indexing.

**macOS** (Homebrew):
```bash
brew install ffmpeg
pip3 install mutagen
```

**Debian / Ubuntu**:
```bash
sudo apt install ffmpeg
pip3 install mutagen
```

**Fedora / RHEL**:
```bash
sudo dnf install ffmpeg
pip3 install mutagen
```

**Arch**:
```bash
sudo pacman -S ffmpeg
pip3 install mutagen
```

**Windows** (via Chocolatey or scoop):
```cmd
choco install ffmpeg
pip install mutagen
```

Or download a static ffmpeg build from
[ffmpeg.org](https://ffmpeg.org/download.html) and put it on your
`$PATH`.

Verify with:
```bash
ffmpeg -version
python3 -c "import mutagen; print(mutagen.version)"
```

The Settings → Local FLAC Library status row reports both:
- "ffmpeg available" / "ffmpeg missing — install for ABX"
- "tag-based indexing" / "filename indexing (install mutagen for tags)"

The Diagnostics panel surfaces both with the same accuracy.

### Configure in HiFi Buddy

1. Open Settings → **Local FLAC Library**.
2. Paste the absolute folder path (e.g., `/Users/you/Music`).
3. Click **Scan Library**.
4. The status row updates as the scan runs. After it finishes, you'll
   see "N tracks indexed (path)".

The matcher uses `(normalized artist, normalized title)` as the
canonical key, with **MusicBrainz Recording ID** as a perfect-match
short-circuit when both the file and the lesson carry one. Sorting is
stable: if you have multiple versions of the same track, the first
encounter (by artist/album/path) wins for the auto-match — but the
Track Variant Picker exposes the rest.

### Behavior

- Scans walk the folder recursively, accepting common audio
  extensions (FLAC, ALAC, AAC, MP3, OGG, WAV, AIFF).
- Files outside the configured folder are 403'd by the proxy, even if
  you craft an `id` for one — the server validates that resolved
  paths stay inside the scanned root.
- The transcode cache is keyed on `(file path, bitrate)` and lives
  under `<your-folder>/.hifi-buddy-cache/`. Run `make clean` from the
  repo root to wipe it.
- The Diagnostics panel reports the cached track count, the configured
  folder, and ffmpeg/mutagen status.

### Common Local FLAC problems

- **"Folder is required" / 400 on scan** — leave the input non-empty.
- **"Permission denied"** during scan — the server can't read the
  folder. Check filesystem permissions.
- **ABX shows ΔRMS = 0** on local files — almost always a missing
  ffmpeg. The Diagnostics panel will say so.
- **"Only some tracks indexed"** — usually missing tags. Install
  mutagen and rescan, or fix tags with a tool like Beets / MusicBrainz
  Picard.

---

## Spotify

Spotify enables full-track playback in-browser via the Web Playback
SDK. **Premium account required and desktop browsers only.**

### What it adds

- **Web Playback SDK** for full-track in-browser playback (Premium).
- **Spotify Connect device picker** — transfer playback to your
  desktop app, mobile app, or any Connect-eligible target (for
  >256 kbps quality).
- The auto-detected "Reconnect for Premium" path when your token is
  missing the `streaming` scope.

Spotify is **not** required for the lessons themselves. If you have
Plex or Local mode, you can ignore this section.

### Mobile is unsupported

The Spotify Web Playback SDK is officially desktop-only (Chrome,
Firefox, Edge, Safari ≥ 11 — desktop). It loads on iOS/Android but
typically fails to acquire a device because mobile browsers block its
EME/protected-media path. The app detects mobile UAs up-front and
hides the Spotify button entirely on those devices, surfacing a clean
fallback rather than a silent timeout.

If you want Spotify on mobile, use the official Spotify mobile app and
keep HiFi Buddy on a desktop browser, or transfer playback to your
phone via the Connect device picker on your desktop.

### Two auth modes

| Mode | What it gives | Limits |
|---|---|---|
| **Client Credentials** | App-only token, no user. Search and metadata work. | No user data, no playback. Simpler to set up. |
| **PKCE (User Login)** | User-scoped token. Search, metadata, *and* full-track Premium playback. | Requires user OAuth flow with an exact-match Redirect URI. |

For HiFi Buddy in-browser playback you need **PKCE + Premium**.

### The 127.0.0.1 vs localhost gotcha

This is the single most common Spotify setup mistake.

Spotify's developer dashboard requires you to register an exact
Redirect URI. The app uses:

```
window.location.origin + window.location.pathname
```

So if you load HiFi Buddy at `http://127.0.0.1:8090/`, the redirect URI
is `http://127.0.0.1:8090/`.

**You must register this exact URL in the Spotify dashboard, including
the trailing slash and the `http` (not `https`).**

Pick one URL and stick with it forever. Use `127.0.0.1` so it matches
the rest of the docs and the
[origin partition note in TROUBLESHOOTING](./TROUBLESHOOTING.md#7-all-settings-disappeared-after-changing-the-url).

### Client Credentials setup

Use this for search-only (no Premium playback).

1. Go to https://developer.spotify.com/dashboard.
2. Create an app.
3. Skip the Redirect URI for now.
4. Tick **Web API**. Save.
5. Copy the **Client ID** *and* the **Client Secret**.
6. In HiFi Buddy Settings:
   - Client ID: paste it.
   - Auth Method: **Client Credentials**.
   - Client Secret: paste it.
   - Save.

The app calls `https://accounts.spotify.com/api/token` with
`grant_type=client_credentials` to get a 1-hour token. It auto-refreshes
on demand.

### PKCE setup (for Premium playback)

This is the real one for HiFi Buddy.

1. Go to https://developer.spotify.com/dashboard.
2. Create an app.
3. **Redirect URI**: register `http://127.0.0.1:8090/`. (If you've
   changed the port via `PORT=NNNN`, register `http://127.0.0.1:NNNN/`
   instead — including the trailing slash.)
4. Tick **Web API** *and* **Web Playback SDK**. Save.
5. Copy the **Client ID** only (PKCE doesn't need the secret).
6. In HiFi Buddy Settings:
   - Client ID: paste.
   - Auth Method: **PKCE (User Login)**.
   - Leave Client Secret blank.
   - Save.
7. Open any HiFi Buddy lesson. The Spotify button shows
   **Connect Spotify**. Click it.
8. You're redirected to Spotify, authorize the app, and bounced back.
9. The Spotify button now says **Spotify** with the play icon. Premium
   in-browser playback is live.

### Scopes

PKCE requests these scopes:

```
user-read-private user-read-email streaming user-modify-playback-state user-read-playback-state
```

The critical one is `streaming`, which authorizes Web Playback SDK
playback.

You can verify which scopes are on your token in DevTools → Console:

```js
localStorage.getItem('hifibuddy_spotify_token_scopes')
```

If `streaming` is missing, the Spotify button auto-detects this and
becomes **Reconnect for Premium**. Click it; it'll force a fresh PKCE
auth.

The auto-detect lives in `renderSpotifyAction` in `js/hifi-buddy.js`
and logs a structured diagnostic to the console with the decision —
`play-button` / `reconnect-button` / `connect-button` / `search-link`
— and the inputs (whether you have a Client ID, whether the token is
valid, whether `streaming` is in the scope list, etc.).

### Premium account requirement

The Web Playback SDK requires Spotify **Premium**. If you connect a
Free account, the SDK fires `account_error` events and the button
degrades back to "Reconnect for Premium". This is enforced by Spotify,
not by the app.

### Token lifetimes

- Access token: 1 hour.
- Refresh token: long-lived (PKCE only).
- The app does not currently auto-refresh the access token (it just
  re-prompts when stale). If you see a sudden "Reconnect" prompt after
  a long session, that's why.

### Spotify Connect device picker

When the Spotify quality card is showing, a **Devices** button opens
the device list. Click any device to transfer playback to it. The
browser stays in control (play/pause/seek) but audio comes out of the
target device.

This is how you get above 256 kbps with Spotify: transfer to the
desktop app (320 kbps Premium), or to a Connect target on Spotify
HiFi (lossless).

### Common Spotify problems

- **`INVALID_CLIENT: Invalid redirect URI`** — see
  [TROUBLESHOOTING.md → Redirect URI](./TROUBLESHOOTING.md#2-spotify-redirect_uri-not-matching-configuration).
- **Search button instead of player** — see
  [TROUBLESHOOTING.md → Search link](./TROUBLESHOOTING.md#3-spotify-play-button-shows-a-search-link-instead-of-an-in-browser-player).
- **256 kbps cap** — that's the Web Playback SDK limit. Transfer to
  the desktop app for 320 kbps Premium or HiFi-tier lossless.
- **Spotify button missing entirely on mobile** — expected. The SDK
  is desktop-only.

---

## Claude API

Anthropic's API. Powers the in-lesson Listening Coach and the AI
Lesson Generator's Claude path. Costs money (per token) but trivially.

### What it adds

- **Listening Coach** — per-lesson chat in the lesson sidebar, scoped
  to the current track / album / skills.
- **AI Lesson Generator** — Quick guide / Paste track / Browse Plex /
  Import pack tabs, all calling Claude when an API key is configured
  (otherwise Ollama).

### Setup

1. Sign up at https://console.anthropic.com.
2. Add a payment method and put a few dollars in (the app's prompts
   are small — typical session is ~$0.01–$0.05).
3. Go to **API Keys** → **Create Key**.
4. Copy the key (starts with `sk-ant-...`).
5. In HiFi Buddy Settings → Claude AI → paste. Save.

The Listening Coach in the lesson sidebar becomes interactive. The
AI Lesson Generator now uses Claude.

### How it works

The HiFi Buddy server proxies requests to
`https://api.anthropic.com/v1/messages` through `POST /api/claude`. The
browser never sees the key in transit (it's read from `localStorage`
and passed in the request body to the local server, which forwards it).

The default model is `claude-sonnet-4-6` for lesson generation;
the Coach uses whatever the server's default is. The app sends
streaming responses so you see the answer being typed.

### Cost expectations

- Each Coach exchange: ~500–2000 tokens → about $0.005–$0.02 on
  Claude Sonnet pricing.
- A full AI Lesson Generator generation: ~3000–5000 tokens → about
  $0.01–$0.05.
- A typical session of light use: well under $0.50.

If you're cost-averse, configure Ollama instead — it's free and good
enough for most prompts.

### Common Claude problems

- **Coach panel input disabled** — the API key isn't set. Open
  Settings, save the key.
- **HTTP 401 / "Unauthorized"** — key was rejected. Check it's pasted
  correctly. If you regenerated, paste the new one.
- **HTTP 429 / rate limit** — you've hit Anthropic's rate limit. Wait
  a minute and try again. If you regularly hit this, you may need to
  upgrade your Anthropic plan.
- **Generator returns invalid JSON** — rare with Claude, common with
  small Ollama models. The error card shows the raw response so you
  can read what came back.

---

## Ollama

Free, local, private LLM. Used as the fallback for the AI Lesson
Generator when no Claude key is configured. No API keys, no costs,
runs on your machine.

### What it adds

- **AI Lesson Generator** — when Claude isn't configured, the app
  routes generation to your Ollama instance via `POST /api/ollama`
  with `format: 'json'` strict mode (small models really need this
  to produce schema-compliant output).

Ollama does *not* drive the Listening Coach — that's Claude-only at
present.

### Install Ollama

1. Download from https://ollama.com/download (macOS, Linux, Windows).
2. Install. On macOS, this drops Ollama into Applications and starts
   a background daemon at `http://localhost:11434`.
3. Pull a model:
   ```bash
   ollama pull gemma2:9b
   ```
   Other recommended models:
   - `gemma2:9b` — best quality vs size for the lesson generator.
   - `llama3.2:3b` — small and fast, OK quality.
   - `qwen2.5:7b` — good for structured outputs.
4. Verify:
   ```bash
   ollama list
   ```

### Configure in HiFi Buddy

1. Settings → Ollama section.
2. Server URL: `http://localhost:11434` (the default).
3. Model: type a name, or click **Load Models** to fetch a list from
   your Ollama instance and click one to select it.
4. Save.

### How it works

The HiFi Buddy server proxies generation requests to Ollama at
`POST /api/ollama`. The Lesson Generator passes
`{ ollamaUrl, model, system, messages, format: 'json' }`; the server
forwards them and returns the response.

### Common Ollama problems

- **"Cannot reach Ollama"** — Ollama isn't running, or the URL is
  wrong. Run `ollama serve` to start the daemon manually. The
  Diagnostics panel checks `/api/local/probe` for ffmpeg, but for
  Ollama the only probe is the `Load Models` button — if it errors,
  Ollama is unreachable.
- **Slow first response** — first run of a model loads it into memory
  (5–30 s). Subsequent calls are fast. A 7B model on a Mac M-series
  is ~1–3 s per generation.
- **Bad / mis-shaped lessons** — try a larger or differently-tuned
  model. `gemma2:9b` consistently gives the best results for this
  app's use case.

---

## MusicBrainz / Cover Art Archive

No API key needed. Used silently when Plex doesn't have an album's
art:

1. Query MusicBrainz for the release-group ID by `(album, artist)`.
2. Ask Cover Art Archive
   (`https://coverartarchive.org/release-group/...`) for the front
   cover.
3. If found, render it on the lesson album card; if not, fall back to
   the stylized vinyl-disc placeholder with the artist's initials.

Results are cached under `localStorage.hifibuddy_mb_cache`.

### Rate limits

MusicBrainz asks for a User-Agent identifying your app and rate-limits
to roughly 1 request per second. The app respects this and includes
`User-Agent: HiFiBuddy/1.0` on every request.

In practice you'll never hit the limit — lesson art lookups are
one-shot and cached.

### Common MusicBrainz problems

- **Wrong album art on a lesson** — the MusicBrainz match was for a
  different release-group with the same name. Configure Plex so the
  art comes from your library instead, or it'll keep using whatever
  MusicBrainz returns first.
- **No art at all** — neither Plex nor MusicBrainz had a match. The
  vinyl-disc placeholder is the fallback. Doesn't affect functionality.

# Troubleshooting

When something breaks. Each section: **Symptom → Root cause → Fix**.
Most issues are some combination of (a) origin partition between
`localhost` and `127.0.0.1`, (b) stale tokens, (c) the service worker
caching old code, or (d) a missing system dep (ffmpeg, mutagen).

**Start with the [Diagnostics panel](#0-diagnostics-panel)**.

## Contents

0. [The Diagnostics panel: your first stop](#0-diagnostics-panel)
1. [Track not found in Plex but I have it](#1-track-not-found-in-plex-but-i-have-it)
2. [Spotify "redirect_uri: Not matching configuration"](#2-spotify-redirect_uri-not-matching-configuration)
3. [Spotify play button shows a search link instead of an in-browser player](#3-spotify-play-button-shows-a-search-link-instead-of-an-in-browser-player)
4. [ABX "Could not load sources: 502" (or fails to start)](#4-abx-could-not-load-sources-502-or-fails-to-start)
5. [ABX shows ΔRMS = 0.00 dB](#5-abx-shows-δrms--000-db)
6. [Service worker shows stale code after an update](#6-service-worker-shows-stale-code-after-an-update)
7. [All settings disappeared after changing the URL](#7-all-settings-disappeared-after-changing-the-url)
8. [401 Unauthorized from Plex](#8-401-unauthorized-from-plex)
9. [Spotify SDK 256 kbps cap (Web SDK quality limit)](#9-spotify-sdk-256-kbps-cap-web-sdk-quality-limit)
10. [Album art doesn't load](#10-album-art-doesnt-load)
11. [Ollama "Cannot reach Ollama"](#11-ollama-cannot-reach-ollama)
12. [Server won't start: port 8090 already in use](#12-server-wont-start-port-8090-already-in-use)
13. [Duration mismatch warning on a lesson](#13-duration-mismatch-warning-on-a-lesson)
14. [Spotify "Premium required" or `account_error`](#14-spotify-premium-required-or-account_error)
15. [Local FLAC: "ffmpeg not installed" / ABX missing on local files](#15-local-flac-ffmpeg-not-installed--abx-missing-on-local-files)
16. [Local FLAC: only some tracks indexed](#16-local-flac-only-some-tracks-indexed)
17. [AI Lesson Generator fails or returns garbage](#17-ai-lesson-generator-fails-or-returns-garbage)
18. [Visualizer is blank when playing on Spotify](#18-visualizer-is-blank-when-playing-on-spotify)
19. [Listening Coach answers in raw JSON](#19-listening-coach-answers-in-raw-json-legacy-bug)
20. [I can't see "Mark as completed" under the visualizer](#20-i-cant-see-mark-as-completed-under-the-visualizer)
21. [Spotify button missing on mobile](#21-spotify-button-missing-on-mobile)
22. [Wrong track loads from Plex (e.g., Hallelujah Money instead of Hallelujah)](#22-wrong-track-loads-from-plex-eg-hallelujah-money-instead-of-hallelujah)
23. [Source Quality shows wrong star rating (CD Quality on a 24/96 FLAC)](#23-source-quality-shows-wrong-star-rating-cd-quality-on-a-2496-flac)

---

## 0. Diagnostics panel

The Diagnostics panel lives inside Settings, between Audio Equipment
and Backup & Restore. It probes every subsystem and renders a live
state table:

| Row | What it tells you |
|---|---|
| Service Worker | Cache name, active state, whether an update is waiting |
| Storage | localStorage usage / quota |
| Plex | Round-trip to `/api/plex/identity`, last successful call timestamp |
| Spotify | Connected? Has the `streaming` scope? |
| Local FLAC | Track count, configured folder |
| ffmpeg | Detected on `$PATH`? (Required for ABX on local files.) |
| mutagen | Importable Python module? (Required for tag-based local indexing.) |
| Origin | `window.location.origin` and whether Spotify PKCE will work there |
| Browser | Detected name + version + OS |

Three buttons:
- **Force Update** — triggers `registration.update()` then reloads.
- **Unregister & Reload** — unregisters the SW, deletes every cache,
  reloads. Use this when "Force Update" doesn't help.
- **Refresh** — re-runs the probes without reloading.

When in doubt, open the Diagnostics panel before anything else. Most
guesses ("I think the SW is stale" / "I think my Plex token expired"
/ "I think ffmpeg got uninstalled") become facts you can SEE here.

---

## 1. Track not found in Plex but I have it

### Symptom

The Plex play button briefly says "Searching Plex…" then shows
**Not found in Plex**, even though you can see the track in your Plex
Web interface. Or the prefetch on the dashboard says
"✓ N tracks ready" with N less than 30.

### Root causes

There are three:

1. **Token expiry / 401.** The Plex token in Settings was revoked or
   expired. The Diagnostics panel will show "Plex: Issue HTTP 401" or
   "unreachable".
2. **Origin partition.** You set up Plex in Settings while loading the
   app from `127.0.0.1:8090`, then switched to `localhost:8090` (or
   vice versa). `localStorage` is partitioned per origin.
3. **Title/artist mismatch.** The lesson says "I Love Being Here With
   You" but your Plex copy is tagged "I Love Being Here with You"
   (case or whitespace), or you have a different cut. The matcher does
   fuzzy matching but isn't perfect.

### Fix

**1. Token expiry**

1. Open Plex Web (`https://app.plex.tv`).
2. DevTools → Network → click any item → look at the request URL.
3. Copy the `X-Plex-Token=...` value.
4. HiFi Buddy Settings → Plex → paste new token → Test Connection.
5. Save.

**2. Origin partition**

See [§7](#7-all-settings-disappeared-after-changing-the-url).

**3. Title/artist mismatch**

The matcher tries: exact normalized match → title-only → substring →
fuzzy across the artist's albums. If all fail:

- Open the **Track Variant Picker** (button on the lesson page when
  multiple matches exist) and pin the right one manually.
- Re-tag your Plex copy to match the lesson's expected title and
  artist.
- Open the browser console and run:
  ```js
  HiFiBuddyPlex.debug('Diana Krall', 'I Love Being Here With You')
  ```
  This logs normalized inputs, whether the artist was found, what
  albums Plex has by that artist.

### Lessons known to have flaky matching

- **L012 Diana Krall — "I Love Being Here With You"** (*Live in Paris*,
  2002). Many libraries have a different live or studio version.
- **L020 D'Angelo — "Untitled (How Does It Feel)"**. Single edit
  (~5:00) vs *Voodoo* album version (~7:09). The lesson is keyed to
  the album cut.
- **L024 Various Artists (Chesky)** and **L025 Sheffield**:
  audiophile-only pressings — almost certainly not in your library
  unless you specifically bought the Chesky / Sheffield rips.

---

## 2. Spotify `redirect_uri: Not matching configuration`

### Symptom

Clicking **Connect Spotify** redirects to Spotify, which shows:

> **INVALID_CLIENT: Invalid redirect URI**

or

> Illegal redirect_uri

### Root cause

The Redirect URI registered in your Spotify Developer Dashboard
doesn't exactly match the URL the browser is loading from. Spotify is
character-exact match.

The app sends:

```
window.location.origin + window.location.pathname
```

So if you load at `http://127.0.0.1:8090/`, the redirect URI sent is
`http://127.0.0.1:8090/`. That exact string must be registered.

Common mismatches:

| Dashboard | What the app sends | Match? |
|---|---|---|
| `http://localhost:8090/` | `http://127.0.0.1:8090/` | No |
| `http://127.0.0.1:8090` (no slash) | `http://127.0.0.1:8090/` | No |
| `http://127.0.0.1:8200/` (different port) | `http://127.0.0.1:8090/` | No |
| `https://127.0.0.1:8090/` | `http://127.0.0.1:8090/` | No |
| `http://127.0.0.1:8090/` | `http://127.0.0.1:8090/` | Yes |

### Fix

1. Note the URL bar of the HiFi Buddy app exactly. Copy it.
2. Go to https://developer.spotify.com/dashboard.
3. Select your app → **Edit**.
4. Under **Redirect URIs**, add the exact URL from step 1, including
   the trailing slash and the `http` (not `https`).
5. **Save**.
6. Back in HiFi Buddy, retry the connect.

If you're going to change which origin you use (`localhost` ↔
`127.0.0.1`), either register both in the dashboard or stick to one.
Same goes for changing port via `PORT=NNNN python3 server.py`.

The Diagnostics panel's **Origin** row warns when the current origin
won't work for Spotify PKCE — it requires HTTPS or a loopback hostname.

---

## 3. Spotify play button shows a search link instead of an in-browser player

### Symptom

In a HiFi Buddy lesson, the Spotify button is one of:
- **Set up Spotify** (opens Settings)
- **Connect Spotify** (kicks off PKCE auth)
- **Reconnect for Premium** (clears token + restarts auth)

…instead of just **Spotify** with a play icon.

### Root cause

The lesson rendering function logs a structured diagnostic to the
console every time it decides which button to show. Open DevTools →
Console:

```
[HiFi/Spotify] renderSpotifyAction: {
  lesson: 'lesson-001',
  hasSpotifyModule: true,
  isConnected: true,
  authMethod: 'credentials',
  grantedScopes: '',
  hasStreamingScope: false,
  hasClientId: true,
  decision: 'reconnect-button'
}
```

The `decision` field tells you exactly which path the code took:

| `decision` | Why |
|---|---|
| `play-button` | All good — Premium playback enabled. |
| `reconnect-button` | Connected, but missing the `streaming` scope. Often because you used Client Credentials auth, which can't grant `streaming`. |
| `connect-button` | Have a Client ID set, but no token. Click to start PKCE. |
| `search-link` | No Client ID. Click to open Settings. |

### Fix

**`reconnect-button`** with `authMethod: 'credentials'`:
1. Settings → Spotify → Auth Method → switch to **PKCE (User Login)**.
2. Save.
3. Click **Reconnect for Premium**. The app forces PKCE.
4. Authorize on Spotify.
5. The button now shows **Spotify**.

**`reconnect-button`** with `authMethod: 'pkce'`:
- The PKCE auth completed but didn't include `streaming`. This usually
  means your Spotify Developer App didn't enable Web Playback SDK.
1. Spotify Dashboard → your app → **Edit**.
2. Tick **Web Playback SDK** (and **Web API**).
3. Save.
4. In HiFi Buddy, click **Reconnect for Premium**.

**`connect-button`**:
- No active token. Click it to authorize.

**`search-link`**:
- No Client ID. Settings → Spotify → paste Client ID → Save.

**Premium-required errors after auth**: see
[§14](#14-spotify-premium-required-or-account_error).

### Verifying token scopes

In DevTools → Console:

```js
localStorage.getItem('hifibuddy_spotify_token_scopes')
```

You should see something like:

```
"streaming user-read-email user-modify-playback-state user-read-playback-state"
```

If `streaming` is missing, that's the problem.

---

## 4. ABX "Could not load sources: 502" (or fails to start)

### Symptom

Clicking the ABX button on a HiFi Buddy lesson shows:

> Could not load sources: fetch http://127.0.0.1:8090/api/plex-stream/... → 502.
> Make sure Plex is reachable and the track is in your library.

### Root cause

`/api/plex-stream/` proxies to Plex's
`/transcode/universal/start.mp3?...` endpoint. Plex's universal
transcoder requires:

- **`X-Plex-Client-Identifier`** header (and `X-Plex-Product`,
  `X-Plex-Platform`, etc.).
- **Plex Pass** in some configurations.

Older versions of `server.py` didn't add these headers. The current
version does (see `proxy_plex_stream` in `server.py`). If you're on an
old `server.py`, the headers aren't sent and Plex returns 502.

### Fix

1. **Pull the latest code** if you're behind.
2. **Restart the server**: `Ctrl+C`, then `python3 server.py` again.
   The server reads `server.py` once at startup.
3. **Hard-refresh** the browser to bust cached JS:
   - macOS: `Cmd+Shift+R`
   - Windows/Linux: `Ctrl+Shift+R`
   - Or use the Diagnostics panel's **Force Update**.
4. **Plex Pass check**: try regular Plex playback first. If that works
   but ABX still fails, you may need Plex Pass for the universal
   transcoder. As a Plex-Pass-free alternative, configure local-library
   mode and use ffmpeg instead.
5. **Server logs**: the server prints
   `[proxy_plex_stream] Plex returned 401: ...` etc. Read the terminal.

If ABX still fails, check the browser console for `[ABX] WARNING:
lossless and lossy bytes are too similar (ratio 1.05x)` — see
[§5](#5-abx-shows-δrms--000-db).

---

## 5. ABX shows ΔRMS = 0.00 dB

### Symptom

The ABX modal's level-matching status reads:

> Level-matched: ΔRMS ≈ 0.00 dB

…and when you actually run the test, A and B sound exactly the same.
You get 8/16 (chance), and the verdict says you can't tell.

### Root cause

The transcoder didn't actually transcode. It returned the same FLAC
(or other lossless format) for both A and B. The console will warn:

> [ABX] WARNING: lossless and lossy bytes are too similar (ratio 1.05x).
> Plex transcoder may be passing through. Content-Types: A=audio/flac,
> B=audio/flac

(Both Content-Types should differ — A `audio/flac`, B `audio/mpeg`.)

For Plex: passthrough happens because the transcoder will sometimes
choose to passthrough the source codec instead of transcoding,
depending on client capabilities.

For local: ffmpeg isn't actually running (not on `$PATH`, or the
binary errored). Diagnostics → ffmpeg row will say "not installed".

### Fix

**Plex side:**
1. Verify you've restarted `server.py` after the last code update.
2. Confirm Plex Pass is active on the account.
3. Re-test. ΔRMS should now be in the 0.05–0.5 dB range, bytes
   differing by 5–8×.
4. If it still passes through, try local-library mode + ffmpeg
   instead — it's a fully separate transcoder pipeline.

**Local side:**
1. Install ffmpeg (see
   [INTEGRATIONS.md → Local FLAC](./INTEGRATIONS.md#install-ffmpeg--mutagen)).
2. Confirm `ffmpeg -version` works in the terminal where the server
   is running.
3. Open Settings → Diagnostics. The ffmpeg row should now read
   "present".
4. Retry ABX. The first run does the transcode (slower); subsequent
   runs hit the on-disk cache under `<your-folder>/.hifi-buddy-cache/`.

---

## 6. Service worker shows stale code after an update

### Symptom

You pulled new code (`git pull`) and restarted the server, but the app
still shows old behavior, old text, or worse — broken behavior because
half the code is new and half is cached.

### Root cause

The PWA service worker (`service-worker.js`) caches the static assets.
Until the cache is invalidated or unregistered, hard-refresh alone may
not be enough.

### Fix

**Easiest:**
1. Settings → Diagnostics → **Force Update**.

If that doesn't help:

2. Settings → Diagnostics → **Unregister & Reload**.

If you want the manual route:

3. DevTools → **Application** tab (Chrome/Edge) or **Storage** tab
   (Firefox).
4. **Service Workers** section: click **Unregister** next to the
   `hifi-buddy` worker.
5. **Cache Storage** section: right-click each cache and delete.
6. Close all tabs.
7. Re-open `http://127.0.0.1:8090/`.

If you're constantly fighting the SW during development, keep DevTools
open with the **Disable cache** checkbox ticked (Network tab) and
**Update on reload** ticked (Application tab).

---

## 7. All settings disappeared after changing the URL

### Symptom

You opened the app at `http://127.0.0.1:8090/` instead of
`http://localhost:8090/` (or vice versa) and now:
- All settings (Plex URL, Spotify Client ID, Claude key) are blank.
- Lesson progress shows 0/30.
- ABX results are gone.
- The Onboarding wizard re-launched.

### Root cause

Browser `localStorage` is partitioned per **origin**: scheme + host +
port.

| Origin A | Origin B | Same store? |
|---|---|---|
| `http://127.0.0.1:8090` | `http://localhost:8090` | **No** |
| `http://127.0.0.1:8090` | `http://127.0.0.1:8090/some/path` | Yes (path doesn't count) |
| `http://127.0.0.1:8090` | `https://127.0.0.1:8090` | No |
| `http://127.0.0.1:8090` | `http://127.0.0.1:8200` | No (different port) |

When you switch from `localhost` to `127.0.0.1`, you're switching to a
different origin that has its own empty `localStorage`. Your data is
not gone — it's still in the original origin's store.

### Fix

**Recover your data:**

1. Go back to the original origin (whichever one had your data).
2. Settings → **Backup & Restore** → **Download Backup**.
3. Switch to the new origin.
4. Settings → **Restore from File…** → pick the backup → confirm.
5. The app reloads with everything restored.

The importer also accepts legacy `musictrip_*`-prefixed backups from
before the standalone rename. Keys are transparently rewritten.

**Avoid this in the future:**

Pick one URL and use it always. The recommended is
`http://127.0.0.1:8090/` because:
- Spotify's PKCE redirect URI must be registered to that exact URL.
- Some browsers treat `localhost` differently for security purposes.

If you ever need to go between machines, use the backup/restore flow
proactively.

The Diagnostics panel's Origin row tells you which origin you're
currently on.

### Verify which origins have data

DevTools → Application → Local Storage shows only the current origin.
To check both, open two tabs (one at `127.0.0.1`, one at `localhost`)
and compare the `hifibuddy_*` key counts.

---

## 8. 401 Unauthorized from Plex

### Symptom

- All Plex requests fail with 401.
- The Diagnostics panel reads "Plex: Issue HTTP 401".
- Plex Test Connection in Settings says "Connection failed".
- HiFi Buddy track prefetch returns nothing.

### Root cause

Your Plex token has been revoked. This happens when:
- You signed out of Plex on another device with "Sign out from all
  devices".
- You changed your Plex password.
- The token was generated very long ago and Plex auto-rotated it.

### Fix

1. Open Plex Web (`https://app.plex.tv`).
2. DevTools → Network tab.
3. Click any item to trigger a request.
4. Find the `X-Plex-Token=` parameter in any request URL.
5. Copy the new token.
6. HiFi Buddy Settings → Plex → paste new token in the Auth Token
   field.
7. Click **Test Connection**. Should say "Connected: [server name]".
8. Save.

The library will reload, lesson tracks will be re-prefetched, and the
two-layer Plex cache will be partially invalidated (Layer B / stream
URLs is wiped because it was scoped to the old token; Layer A / match
metadata persists).

---

## 9. Spotify SDK 256 kbps cap (Web SDK quality limit)

### Symptom

A HiFi Buddy lesson tells you to listen for "the cymbal shimmer at
1:42" — and on Spotify, you can't hear it. The Spotify quality card
is yellow/amber and reads:

> Source: Spotify Web Player
> Premium · ~256 kbps Ogg Vorbis (Web SDK cap)
> Spotify Web SDK is capped at ~256 kbps. For lossless critical
> listening on this lesson, use Plex (FLAC) — or transfer playback to
> your Spotify desktop app for up to 320 kbps.

### Root cause

The Spotify **Web Playback SDK** is hard-capped at 256 kbps Ogg
Vorbis, even on Spotify HiFi Premium. This is a Spotify policy, not a
HiFi Buddy limit.

### Fix

Three options:

**1. Use Plex or Local instead** (recommended)

If the lesson's track is in your library, click **Plex** or **Local**
instead of **Spotify**.

**2. Transfer to the desktop app via Spotify Connect**

1. Open the Spotify desktop app (logged into the same account).
2. In HiFi Buddy, click the **Devices** button on the Spotify quality
   card.
3. Pick the desktop app from the list.
4. The card updates; the desktop app plays at 320 kbps Premium, or
   higher on Spotify HiFi.

**3. Skip the lesson on Spotify**

Some lessons (24, 25) are deliberately NOT on Spotify. Plex or Local
is the only viable source.

---

## 10. Album art doesn't load

### Symptom

A HiFi Buddy lesson shows the stylized vinyl-disc placeholder (with
the artist's initials) instead of real album art.

### Root cause

The app tries two sources, in order:

1. **Plex match.** If `HiFiBuddyPlex.matchAlbum(title, artist)`
   returns a hit with a thumbnail, use that.
2. **MusicBrainz Cover Art Archive.** Otherwise, search MusicBrainz
   for the release-group, then fetch from `coverartarchive.org`.

If both fail, the placeholder shows.

### Fix

This is normal and harmless. Doesn't affect any functionality — just
visuals. Causes:

- **Plex doesn't have the album**: nothing to do unless you add it.
- **Plex has the album but no art**: refresh metadata in Plex
  (right-click → "Refresh Metadata").
- **MusicBrainz match failed**: the album/artist pair didn't match
  any MusicBrainz release-group, or the match did but Cover Art
  Archive has no front cover for it.
- **CORS or network error**: rare — check the console for fetch
  errors.

---

## 11. Ollama "Cannot reach Ollama"

### Symptom

In Settings, the Load Models button or the AI Lesson Generator's
Ollama path shows:

> Cannot reach Ollama

or in the server console:

> [proxy_ollama] ConnectionError: ...

### Root cause

The HiFi Buddy server tries to fetch from your configured Ollama URL
(default `http://localhost:11434`) and can't reach it.

### Fix

1. Verify Ollama is running:
   ```bash
   curl http://localhost:11434/api/tags
   ```
   Should return JSON with a `models` array.

2. If it doesn't, start Ollama:
   - macOS: open the Ollama.app from Applications, or `ollama serve`.
   - Linux: `systemctl start ollama` or `ollama serve`.
   - Windows: launch from the Start menu.

3. If Ollama is on a different host or port, update the URL in
   HiFi Buddy Settings → Ollama → Server URL.

4. Pull a model if you haven't:
   ```bash
   ollama pull gemma2:9b
   ```
   In Settings → Ollama → click **Load Models**, pick `gemma2:9b`,
   save.

5. Verify with a quick AI Lesson Generator run.

---

## 12. Server won't start: port 8090 already in use

### Symptom

Running `python3 server.py` errors with:

```
OSError: [Errno 48] Address already in use
```

### Root cause

Another process is bound to port 8090. Most often a previous
`server.py` you forgot to kill.

### Fix

Find and kill it.

**macOS / Linux:**

```bash
lsof -i :8090
# look for the PID in the output, then:
kill <PID>
```

**Windows:**

```cmd
netstat -ano | findstr :8090
taskkill /PID <PID> /F
```

If you can't free 8090, change the port:

```bash
PORT=8200 python3 server.py
```

…and open `http://127.0.0.1:8200/` instead. **Critical**:

- This is a new origin from the browser's perspective. Your localStorage
  on `:8090` won't be visible. Use the backup/restore flow.
- Your Spotify Redirect URI was registered to `http://127.0.0.1:8090/`.
  If you changed the port, register the new one too (or instead).

---

## 13. Duration mismatch warning on a lesson

### Symptom

A yellow warning banner under the track card:

> Different version loaded. Expected 8:26, got 4:08 (-258s). The
> lesson timestamps may not line up with this cut.

### Root cause

The audio source loaded a different version of the track:
- **Plex matched a different cut** — single edit vs album version,
  live vs studio, remix vs original.
- **Spotify returned a different release** — depends on your market.

### Fix

Verify the version note on the lesson page. Examples:

- L001 Money for Nothing — 8:26 album, NOT 4:08 radio edit (this was
  a known mis-alignment in earlier builds; now fixed at the data
  level).
- L012 I Love Being Here With You — *Live in Paris* 2002, NOT studio.
- L020 Untitled (How Does It Feel) — *Voodoo* album version, ~7:09.

Then:

1. **Use the Track Variant Picker.** If Plex (or local) has the right
   cut, click the picker, scroll the matches, and pin the album
   version. The override persists per lesson.
2. **Switch sources.** If Plex loaded the wrong cut, try Spotify (or
   vice versa).
3. **Re-tag your Plex copy.** If you own the right version but it's
   tagged wrong.
4. **Use the AI Lesson Generator.** Generate timestamps for whatever
   cut you actually have.

The timestamps in the lesson are still mostly useful — they correspond
to structural moments (intro, first verse, bridge, solo) that exist in
all versions of a song, just at different absolute times.

---

## 14. Spotify "Premium required" or `account_error`

### Symptom

The Spotify button shows **Spotify** with the play icon, but clicking
it does nothing visible. The console shows:

> [Spotify SDK] account error (Premium required?): Cannot perform
> operation; no list was loaded.

or similar.

### Root cause

You connected with PKCE successfully, but the underlying Spotify
account isn't Premium. The Web Playback SDK refuses to play.

### Fix

There is no workaround. Spotify enforces this server-side; the Web
Playback SDK is a Premium-only feature.

Your options:
- **Upgrade to Premium.** https://www.spotify.com/premium/
- **Use Plex or Local.** If the track is in your library, those work
  fine.
- **Use YouTube.** Always works as a fallback.

---

## 15. Local FLAC: "ffmpeg not installed" / ABX missing on local files

### Symptom

You configured the local-library folder, scanning works, the **Local**
play button works for direct streaming — but the **ABX** button is
missing on local matches, or ABX errors with "ffmpeg not installed".

The Diagnostics panel reads:

| Row | Status |
|---|---|
| ffmpeg | not installed — install to enable ABX MP3 transcoding |

### Root cause

`/api/local/transcode/*` shells out to `ffmpeg`. If it's not on the
server's `$PATH`, the endpoint refuses with a structured 503.

### Fix

Install ffmpeg. Per OS:

| OS | Command |
|---|---|
| macOS (Homebrew) | `brew install ffmpeg` |
| macOS (MacPorts) | `sudo port install ffmpeg` |
| Debian / Ubuntu | `sudo apt install ffmpeg` |
| Fedora / RHEL | `sudo dnf install ffmpeg` |
| Arch | `sudo pacman -S ffmpeg` |
| Windows (Chocolatey) | `choco install ffmpeg` |
| Windows (manual) | Download from [ffmpeg.org](https://ffmpeg.org/download.html), put on PATH |

Then **restart `server.py`** (the proxy probes `$PATH` at startup) and
hit Diagnostics → Refresh. The ffmpeg row should flip to "present".

The first ABX run on a local file does the transcode (a few seconds
on modern hardware); subsequent runs hit the on-disk cache under
`<your-folder>/.hifi-buddy-cache/`.

---

## 16. Local FLAC: only some tracks indexed

### Symptom

You scanned a folder of, say, 5,000 tracks, but the index reports
only 2,800. Or many lesson tracks that you're sure are in the folder
don't get a Local play button.

### Root cause

Two possible:

1. **mutagen isn't installed.** Without it, the indexer falls back to
   filename-based parsing — `Artist - Title.flac` patterns. Files
   that don't match the pattern get skipped or mis-tagged.
2. **Tags are missing or non-standard.** Even with mutagen, files
   without `artist` and `title` tags can't be matched to lessons.

### Fix

Install mutagen:

```bash
pip3 install mutagen
```

Restart `server.py`. Diagnostics → mutagen should now read "present".

Then in Settings → Local FLAC Library, click **Scan Library** again to
re-index.

For files with bad tags, fix them with [Beets](https://beets.io/),
[MusicBrainz Picard](https://picard.musicbrainz.org/), or your
preferred tagging tool. Look for `artist` (TPE1) and `title` (TIT2) at
minimum.

---

## 17. AI Lesson Generator fails or returns garbage

### Symptom

In any of the four AI Lesson Generator tabs (Quick guide, Paste track,
Browse Plex, Import pack), generation fails with an error card. The
card shows:
- The status code (e.g., 401, 429, 500).
- The actual response body (truncated to 800 chars).
- A **Retry** button.

Or, the lesson generates but the JSON shape is wrong / the timestamps
are gibberish.

### Root cause

Read the rich error card — it tells you the actual error. Common
patterns:

| Error | Cause |
|---|---|
| `No AI backend configured` | Neither Claude nor Ollama set up in Settings. |
| `Claude returned 401` | Bad API key. |
| `Claude returned 429` | Rate limit. Wait, retry. |
| `Claude returned 500` / network errors | Anthropic API outage or local network issue. |
| `Ollama unreachable at ...` | Daemon not running, or wrong URL. |
| `JSON parse failed` | Model returned a non-JSON response (rare on Claude, common with small Ollama models). |

### Fix

1. **Configure or fix the backend** — Settings → Claude AI key, or
   Settings → Ollama URL/model.
2. **Retry** — the button is right there. Some errors (429, transient
   500s) clear on their own.
3. **Switch backends** — if Claude is rate-limited, configure Ollama
   as a fallback.
4. **Use a bigger Ollama model** — `gemma2:9b` consistently produces
   schema-compliant JSON. `llama3.2:3b` sometimes drifts.
5. **Check the raw response** — the error card includes it. If it
   looks like the model started writing prose instead of JSON, that's
   an Ollama strict-JSON-mode failure. Retry, or upgrade your model.

The Ollama path uses `format: 'json'` strict mode, which usually fixes
schema-drift.

---

## 18. Visualizer is blank when playing on Spotify

### Symptom

You're playing a lesson via Spotify. The frequency visualizer panel
shows an "unavailable for Spotify SDK" message and stays blank.

### Root cause

The Spotify Web Playback SDK does not expose its audio output to the
Web Audio API. This is a CORS restriction on Spotify's end —
`AnalyserNode` cannot tap into the SDK's stream.

### Fix

This is **expected behavior**, not a bug. Plex and local streams show
the spectrum fully. Spotify does not, and there's no workaround.

Either:
- Switch to Plex or Local for this lesson.
- Accept the visualizer being blank during Spotify playback. The
  lesson notes are still authoritative.

---

## 19. Listening Coach answers in raw JSON (legacy bug)

### Symptom

You ask the in-lesson Listening Coach a question. Instead of an
answer, you get a wall of `{"role":"assistant","content":[{"type":"text","text":"..."}]}`.

### Root cause

Earlier builds occasionally leaked the raw API response into the chat
panel. This was fixed.

### Fix

If you see this, your bundle is **stale**. Open Settings → Diagnostics
→ **Force Update** (or **Unregister & Reload** if Force Update doesn't
help). Hard-refresh the browser.

After reload the Coach should respond in plain prose.

---

## 20. I can't see "Mark as completed" under the visualizer

### Symptom

You scroll to the bottom of a lesson page, but the **Mark as
Completed** button is hidden behind the audio player bar (or
absent entirely).

### Root cause

A body-padding regression. The audio player bar is `position: fixed`
at the bottom; the lesson page must add bottom padding to the body
when the bar is showing so the last element doesn't go underneath.

This was fixed during the cross-browser pass. If it recurs:

### Fix

1. Hard-refresh / Force Update (the fix is in CSS).
2. If it still happens, scroll a bit further or click anywhere outside
   the player bar — sometimes a stray re-render is the cause.
3. Report it with the browser + OS combo (the cross-browser audit
   covered Chrome, Firefox, Safari, and Edge on macOS/Windows/Linux,
   plus mobile Safari and Chrome).

---

## 21. Spotify button missing on mobile

### Symptom

On an iPhone or Android phone, lesson pages show Plex / YouTube /
Local (where applicable), but the **Spotify** button is absent.

### Root cause

The Spotify Web Playback SDK is officially desktop-only (Chrome,
Firefox, Edge, Safari ≥ 11 — desktop). It loads on mobile but
typically fails to acquire a device because mobile browsers block its
EME/protected-media path. The app detects mobile UAs and hides the
button to avoid showing a broken control.

### Fix

This is **expected behavior**. Options:

- Use Plex, Local, or YouTube on mobile.
- Use the Spotify mobile app directly (independent of HiFi Buddy).
- Stay on desktop for Spotify-driven listening; transfer playback to
  your phone via the Connect device picker if you want the audio on
  the phone but the lesson UI on the laptop.

---

## 22. Wrong track loads from Plex (e.g., Hallelujah Money instead of Hallelujah)

### Symptom

A lesson plays a *different* artist's track. You click L007 (Jeff
Buckley — "Hallelujah") and Plex starts playing Gorillaz' "Hallelujah
Money" instead. Or L022 (Bob Marley — "Jamming") loads a punk cover.
The Source Quality / album art / artist name on the lesson card don't
match what you're hearing.

### Root cause

The Plex search used to accept title-only matches when the artist
string didn't normalize cleanly. If your library had a track titled
"Hallelujah" by an artist Plex didn't index under exactly the lesson's
name, the matcher would silently widen its scope to title-only and pick
the first hit — which can be a completely different song that happens
to share the title.

The cache then stored the wrong-artist `ratingKey` per lesson, so even
after the matcher logic was fixed, returning to the lesson would still
play the wrong track until the entry expired.

### Fix

The current build:

1. **Requires artist match.** The matcher pipeline now insists on at
   least one of: exact normalized artist match, MusicBrainz Recording
   ID short-circuit, or fuzzy artist-similarity above a threshold. A
   title-only hit is rejected with a `[Plex] artist mismatch` console
   warning and the lesson falls back to "Not found in Plex".
2. **Self-heals stale caches.** On every lesson load, the cached
   `ratingKey` is validated against the lesson's expected artist before
   use. Stale entries are evicted on next visit with a
   `[Plex] evicting stale match for lesson-NNN: artist mismatch
   (cached=… expected=…)` console warning, and the search re-runs.

If you're still seeing a wrong track:

1. **Hard-reload** to pick up the new search rule (Cmd+Shift+R / Ctrl+Shift+R)
   or use Diagnostics → **Force Update**.
2. Open DevTools → Console and look for the `[Plex] evicting stale match`
   line. If you see it, the next play uses a fresh search.
3. If the right track *is* in your Plex library but the matcher still
   refuses it, open the **Track Variant Picker** on the lesson and pin
   the correct one explicitly. The override sticks per lesson.
4. If the right track *isn't* in your library, the Plex button drops to
   "Not found in Plex" — fall back to Spotify, Local, or YouTube.

To wipe the Plex match cache manually (rarely needed):

```js
localStorage.removeItem('hifibuddy_hifi_plex_matches');
localStorage.removeItem('hifibuddy_hifi_plex_streams');
location.reload();
```

---

## 23. Source Quality shows wrong star rating (CD Quality on a 24/96 FLAC)

### Symptom

A lesson plays from Plex, the file is genuinely a 24-bit / 96 kHz hi-res
FLAC, but the Source Quality card reads:

> FLAC · 16-bit · 44.1kHz · Stereo · ~880kbps
>
> ★★★ CD Quality

…instead of ★★★★ Hi-Res or ★★★★★ Audiophile. The bit depth and sample
rate look like fallback defaults rather than what's actually on disk.

### Root cause

Plex's `/library/sections/.../search` (and the smaller per-album track
listings) **often omit the `Stream` array** that carries `bitDepth`,
`samplingRate`, and `audioChannels`. Only `/library/metadata/<ratingKey>`
returns it reliably. The first version of the source-quality renderer
trusted whatever the search response gave it and filled in 16-bit /
44.1 kHz / 880 kbps as a CD-Quality fallback, which under-rated every
hi-res track in your library.

### Fix

The current build enriches every Plex search hit with a follow-up
`/library/metadata/<ratingKey>` fetch that pulls the full `Stream`
array, then re-renders the badge with the real bitDepth / sampleRate.

Stale cached entries self-heal on next play: the lesson opens, shows
the (wrong) cached badge for ~300 ms, the enrichment call resolves, and
the badge re-renders with correct hi-res info. Subsequent visits are
instant because the cache now stores the enriched values.

If you're still seeing the wrong stars on a known hi-res track:

1. Hard-reload to pick up the new code (Cmd+Shift+R / Ctrl+Shift+R)
   or Diagnostics → **Force Update**.
2. Click into the lesson; watch the badge for ~300 ms — it should flip
   from CD Quality (★★★) to Hi-Res (★★★★) or Audiophile (★★★★★) as the
   enrichment lands.
3. If it doesn't, open DevTools → Network and look at the
   `/library/metadata/<ratingKey>` call: if it 404s, the cached
   ratingKey is stale (rip the Plex cache as in §22). If it succeeds
   but the response has no `Stream` array, your Plex server didn't
   index the file — refresh metadata in Plex Web (right-click the
   track → Refresh Metadata).
4. If the actual file metadata is wrong on disk (e.g., a 16-bit
   downmix mis-tagged as 24-bit), the badge will reflect what's tagged.
   Re-rip or re-tag to fix.

The star tiers map to:

| Rating | Threshold |
|---|---|
| ★★★★★ Audiophile | bitDepth ≥ 24 *and* sampleRate ≥ 88.2 kHz, lossless codec |
| ★★★★ Hi-Res | bitDepth ≥ 24 *or* sampleRate ≥ 88.2 kHz, lossless codec |
| ★★★ CD Quality | 16/44.1 lossless |
| ★★ Good | lossy ≥ 256 kbps |
| ★ Compressed | lossy < 256 kbps |

---

## When all else fails

1. Open the **Diagnostics panel** (Settings → Diagnostics).
2. Open DevTools → Console. Read the messages. Most failures log
   something useful prefixed with `[HiFi]`, `[Plex]`, `[Spotify]`,
   `[ABX]`, `[LocalLibrary]`, `[LessonGen]`, `[TrackPicker]`, or
   `[TimingFeedback]`.
3. Open DevTools → Network. Look for failed requests (red rows).
4. Read the terminal where `server.py` is running. Plex proxy errors,
   Ollama connection failures, Claude API issues, and ffmpeg failures
   all log there.
5. **Restart the server.** `Ctrl+C`, then `python3 server.py` again.
6. **Force Update** via the Diagnostics panel.
7. **Restore from a recent backup** (see [§7](#7-all-settings-disappeared-after-changing-the-url)).
8. **Open an issue** with: the Diagnostics panel screenshot, the
   browser console output, the server terminal output, and a
   description of what you were trying to do.

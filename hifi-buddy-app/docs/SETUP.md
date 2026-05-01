# Setup

This document walks you through getting HiFi Buddy running on your machine
the first time. Budget five minutes for the basic install, plus 5–15 more
for each optional integration (Plex, Spotify, Local FLAC, Claude, Ollama).

## Two install paths

**Most users (macOS)**: download the prebuilt `.app` from the
[GitHub Releases page](https://github.com/hifibuddy/hifi-buddy/releases).
Drag-to-Applications, right-click → Open the first time, done. Skip
straight to the [integration setup](#plex-recommended) below — the
"Get the code" / "Run the validator" / "Start the server" sections only
apply if you're running from source.

**From source** (Linux, Windows for now, contributors, anyone tracking
`main`): you need Python 3.8+ and the prerequisites table below.

## Prerequisites (source install only)

| Thing | Version | Why |
|---|---|---|
| Python 3 | 3.8+ | Runs the dev server (`server.py`). Python 3 ships with macOS, Linux, and on Windows via the installer. |
| A modern browser | Chrome 120+, Firefox 120+, Safari 17+, Edge 120+ | The app uses the Web Audio API, the Spotify Web Playback SDK, and modern JS. Chrome and Edge are the most thoroughly tested. |
| Open port `8090` | — | The server binds to `127.0.0.1:8090`. Override with `PORT=NNNN python3 server.py` if it conflicts. |

Optional but commonly wanted:

- **Plex Media Server** with a music library — lossless FLAC playback, the
  ABX MP3 transcode, library matching, and the Track Variant Picker.
- **A folder of FLAC files** + **ffmpeg** — the local-library mode is a
  Plex-free alternative for streaming and ABX. (`brew install ffmpeg` on
  macOS, `apt install ffmpeg` on Debian/Ubuntu.)
- **`pip3 install mutagen`** — accurate tag-based indexing of local files.
  Without it the indexer falls back to filename parsing.
- **Spotify Premium account** — for in-browser full-track streaming via
  the Web Playback SDK (desktop browsers only).
- **Anthropic API key** — for the in-lesson Listening Coach and the AI
  Lesson Generator's Claude path.
- **Ollama** running locally — free offline alternative to Claude for the
  AI Lesson Generator.

See [INTEGRATIONS.md](./INTEGRATIONS.md) for setup steps on each.

## 1. Get the code

```bash
git clone https://github.com/hifibuddy/hifi-buddy.git
cd hifi-buddy/hifi-buddy-app
```

If you downloaded a zip instead, just unzip it and `cd` into the folder.

## 2. (Optional) Run the validator

Once before you start the server, run:

```bash
make test
```

This runs `python3 tools/validate_data.py` (schema-validates the JSON data
files), `python3 tools/lint_lessons.py` (cross-field sanity checks like
"timestamps are inside the track duration"), then `node -c` on every JS
file and `py_compile` on the Python sources. Prints `All tests passed.`
on success. If you ever wonder "did I break something?", run this. CI
runs it on every push.

## 3. Start the server

```bash
python3 server.py
```

Or, equivalently:

```bash
make serve
```

You should see:

```
HiFi Buddy server running at http://127.0.0.1:8090/
```

The server is dumb on purpose — it serves the static files (HTML/CSS/JS),
proxies a few API calls (Plex, Anthropic Claude, Ollama, MusicBrainz),
streams audio from Plex to bypass CORS, and serves local-library files
when you've configured a folder. There is no database, no build step,
no `node_modules`. To update: `git pull`, then hard-refresh the browser
(or use the Diagnostics panel's "Force Update" button — see
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)).

> Warning: leave the terminal running. Closing it kills the server.

## 4. Open the app

Open your browser to:

```
http://127.0.0.1:8090/
```

> Critical: use `127.0.0.1`, NOT `localhost`. They look the same to you,
> but Spotify's PKCE OAuth flow and most browsers treat them as different
> origins. If you bounce between `localhost` and `127.0.0.1`, your
> settings, lesson progress, and Plex token will appear to vanish, because
> `localStorage` is partitioned per origin. Pick one — and pick
> `127.0.0.1` if you have any chance of using Spotify, because Spotify's
> redirect URI registration is character-exact match.
>
> See [origin partition](./TROUBLESHOOTING.md#7-all-settings-disappeared-after-changing-the-url)
> for the gory details.

## 5. The Onboarding wizard (first run)

On first run, a 5-step wizard appears:

1. **Welcome** — short intro plus a "Skip for now" escape hatch.
2. **Pick a source** — Plex / Spotify / Local FLAC / Skip.
3. **Configure that source** — paste your Plex URL+token (with a Test
   button), or your Spotify Client ID, or your local-library folder path.
4. **Headphones** — model name (autocompleted from `headphones-fr.json`
   if available) and type (open-back / closed-back / IEM / planar /
   unknown). Optional but powers the equipment-aware annotations.
5. **You're set** — pointer to Lesson 1 (*Money for Nothing*).

You can skip at any step. To re-run the wizard later, append
`?onboarding=1` to the URL or `?reset_onboarding=1` to clear the flag.
Everything you fill in is also editable in Settings later.

## 6. Open Settings (the gear icon)

Click the gear icon in the top-right of the header. Sections:

| Section | Fields |
|---|---|
| Spotify | Client ID, Auth Method (Client Credentials or PKCE), Client Secret (Client Credentials only), connection status |
| Claude AI | API Key |
| Ollama | Server URL, Model name, "Load Models" button to enumerate installed models |
| Plex Media Server | Server URL, Auth Token, "Test Connection" button |
| Local FLAC Library | Folder Path, "Scan Library" button, ffmpeg/mutagen status |
| Audio Equipment | Headphones, Headphone Type, DAC, Amp, Preferred source format |
| Diagnostics | Live state of every subsystem; Force Update / Unregister & Reload buttons |
| Backup & Restore | Download Backup, Restore from File |

Common starting setups:

| If you... | Fill in |
|---|---|
| Just want to browse the lessons | Nothing. The 30 lessons load with no integrations. |
| Have Plex with a music library | Plex URL + Token. Click `Test Connection`. |
| Have a folder of FLAC instead | Folder Path. Click `Scan Library`. |
| Want full Spotify track playback (Premium) | Spotify Client ID + select `PKCE (User Login)`. |
| Want the in-lesson AI Listening Coach | Claude API Key (`sk-ant-...`). |
| Want free local AI for lesson generation | Ollama URL (default `http://localhost:11434`) + Model name. |
| Want personalized lesson notes | Audio Equipment fields (especially Headphone Type and Preferred Format). |

Click `Save Settings`. The app re-renders with your new connections active.

For details on each integration, including how to obtain tokens/keys,
see [INTEGRATIONS.md](./INTEGRATIONS.md).

## 7. Install as a PWA (optional)

The app is a Progressive Web App. In Chrome/Edge, look for an "Install"
button in the address bar (or a `+` icon). Installing gives you:

- A standalone window without browser chrome.
- An icon in your dock/start menu.
- Offline support — the service worker caches the JS, CSS, and built-in
  data, so the app loads even with no internet (Plex/Spotify will of
  course not work offline).

On iOS Safari, *Share → Add to Home Screen* installs it as a PWA, which
also helps your localStorage survive Safari's ITP 7-day inactivity wipe
on non-PWA contexts.

If the service worker ever misbehaves (stale code after an update), use
the Diagnostics panel's **Force Update** or **Unregister & Reload**
buttons. See
[TROUBLESHOOTING.md → Service Worker caching issues](./TROUBLESHOOTING.md#6-service-worker-shows-stale-code-after-an-update).

## 8. Back up your settings (recommended)

The app stores everything in `localStorage`, which is fragile:

- Cleared if you reset browser data.
- Partitioned per origin (`localhost:8090` vs `127.0.0.1:8090` are
  different stores).
- Tied to a single browser profile on a single machine.
- On iOS Safari, ITP can wipe non-PWA localStorage after 7 days of
  inactivity.

To back up:

1. Open Settings.
2. Scroll to the **Backup & Restore** section.
3. Click **Download Backup**.
4. You'll get a file like `hifibuddy-backup-2026-04-25T14-32-10.json`.
   Save it somewhere safe.

The backup contains every `hifibuddy_*` localStorage key — settings,
Spotify and Plex tokens, lesson progress, ABX results, generated user
lessons, taste data, caches, the lot. It's plain JSON; you can inspect
or hand-edit it.

To restore on another machine (or after switching origins):

1. Settings → **Restore from File…**
2. Pick the JSON file.
3. Confirm.
4. The app reloads with all your data back.

The importer also accepts legacy `musictrip_*`-prefixed backups from the
pre-rename build — keys are transparently rewritten to `hifibuddy_*`.

> Warning: the backup includes API keys and OAuth tokens in plaintext.
> Don't email it to yourself or check it into git.

## 9. Verify the install

Try these to make sure things are working:

- **Open the Lessons view.** You should see 5 colored path cards with
  30 lessons total.
- **Click any lesson.** The lesson detail page should load with the
  album card, "What to Listen For" timestamps, and play buttons. If
  you have Plex configured, the Plex button will say "Plex" or "Plex ✓"
  once the background prefetch finishes.
- **Open the Reference Library** (top nav). 55 short clips grouped by
  skill should appear.
- **Open Stats** (top nav). If you've never run an ABX test it's empty;
  otherwise it shows aggregate pass-rate by bitrate.
- **YouTube fallback:** every lesson has a YouTube button that opens a
  search in a new tab. This always works — no setup needed.

## 10. Stop the server

`Ctrl+C` in the terminal where you ran `python3 server.py`. The browser
tab will then fail to load anything (the static files are served by
`server.py`), but already-loaded views will still work until you reload.

## Where to go next

- [USER_GUIDE.md](./USER_GUIDE.md) — tour every view in the app.
- [HIFI_BUDDY.md](./HIFI_BUDDY.md) — the audiophile listening trainer in
  full detail (ABX methodology, equipment profiles, visualizer, AI
  Lesson Generator, Track Variant Picker, Timing Feedback,
  `propose_lessons.py`).
- [INTEGRATIONS.md](./INTEGRATIONS.md) — wire up Plex, Spotify,
  Local FLAC, Claude, Ollama.
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — when things break,
  starting with the Diagnostics panel.

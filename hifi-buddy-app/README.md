# HiFi Buddy

**Critical-listening tutor for audiophiles.** Train your ears on real reference recordings — 30 curated lessons, ABX blind testing, equipment-aware annotations, frequency visualizer, and a searchable reference clip library.

> Stop guessing. Start hearing.

## Screenshots

![Lesson view with player, source quality, and skills sidebar](./screenshots/full_lesson.png)

![Timestamped listening segments](./screenshots/segments.png)

![ABX blind test](./screenshots/abx.png)

![Source quality detection](./screenshots/quality.png)

## What it does

HiFi Buddy teaches the things audiophiles actually talk about — **soundstage, imaging, dynamics, transients, micro-detail, tonal color, bass quality, separation, air, layering** — using timestamped passages of real reference tracks (Dire Straits, Steely Dan, Diana Krall, Aphex Twin, Bill Evans, Massive Attack, and 20+ more).

You play the song from your **Plex library** (lossless FLAC — recommended) or **Spotify Premium** (256 kbps Ogg via the Web Playback SDK). The app calls out exactly what to listen for and when. Click any timestamp to seek directly there. When you've internalized a lesson, take the **ABX test** — proper double-blind methodology, 16 trials, level-matched FLAC vs MP3 comparison, with a binomial p-value and a blunt verdict telling you whether you can actually distinguish the formats.

## Features

- **30 curated lessons** organized by 10 critical-listening skills and 3 difficulty tiers
- **Reference Clip Library** — 55 short tagged clips (~3-15 sec each) for skill-specific ear training, separate from the lessons
- **ABX blind testing** — Web Audio gapless A/B/X switcher, RMS level matching, binomial p-value, results saved per lesson
- **Frequency visualizer** — real-time log-frequency spectrum, configurable bar count, peak hold, color schemes
- **Equipment profiles** — annotates lessons based on your headphones/DAC/amp ("✓ Ideal for your open-back headphones", "⚠ This passage may be subtle on IEMs")
- **Spotify Web Playback SDK** integration — play tracks directly in-browser with click-to-seek that maps to lesson timestamps
- **Spotify Connect** — transfer playback to your desktop app or Connect speakers (for higher quality than the 256 kbps web cap)
- **Plex transcoded streaming** for the ABX MP3 source
- **Settings backup/restore** — export everything to JSON, restore on another machine
- **PWA** — installs as a desktop/mobile app, works offline (cached lessons + clips)
- **Privacy-first** — runs entirely locally, no telemetry, all settings in your browser

## Quickstart

### macOS — install the app

1. Download [**`HiFi-Buddy.dmg`**](https://github.com/hifibuddy/hifi-buddy/releases/latest/download/HiFi-Buddy.dmg) (~18 MB, Apple Silicon)
2. Open the DMG, drag **HiFi Buddy** into `/Applications`
3. **First launch**: right-click → **Open** → confirm "Open Anyway" once. The app is unsigned in v1.x; one-time Gatekeeper confirmation, then double-click works normally
4. The app shows a soundwave icon in the menu bar and auto-opens your default browser at `http://127.0.0.1:8090/`

Quit from the menu bar icon. Everything you configure lives at `~/.hifi-buddy/` — back up the folder to migrate to another machine.

### Run from source (Linux, contributors, anyone without a Mac)

```bash
git clone https://github.com/hifibuddy/hifi-buddy.git
cd hifi-buddy/hifi-buddy-app
python3 server.py
```

Then open **http://127.0.0.1:8090/** in your browser. (Use `127.0.0.1`, **not** `localhost` — Spotify's OAuth requires the loopback IP form for HTTP redirect URIs.) To use a different port: `PORT=8200 python3 server.py`.

No build step, no dependencies, no Node, no bundler. Pure Python 3 stdlib + vanilla browser JS. Building the macOS app yourself: see [docs/BUILDING.md](./docs/BUILDING.md).

## Setup

### Plex (recommended)

For lossless FLAC playback and the ABX test:

1. **Settings → Plex** → paste your Plex server URL (e.g. `http://your-server.local:32400`) and a current Plex token
2. To get a Plex token: open Plex Web (`https://app.plex.tv/`) → DevTools → Network tab → click any track → look for `X-Plex-Token=...` in the request URL
3. Click **Test Connection**

### Spotify Premium (optional, for in-browser playback)

1. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Add **`http://127.0.0.1:8090/`** to your app's **Redirect URIs**
3. **Settings → Spotify** → paste your Client ID, choose **PKCE**, click Connect
4. Approve the OAuth scopes (`streaming`, `user-modify-playback-state`, etc.)

> Spotify Premium is required — the Web Playback SDK is Premium-only. The free tier won't work.

### Optional integrations

- **Claude API** — AI listening guide generator (Claude writes a personalized listening walkthrough for any track). Get a key at [console.anthropic.com](https://console.anthropic.com)
- **Ollama** — local-LLM alternative for the AI listening guide. Free, runs on your machine. Recommended model: `gemma2:9b` or any chat-tuned model

## Local FLAC mode

If you have a folder of FLAC (or MP3, etc.) files, you can use them directly without Plex.

1. Settings → **Local FLAC Library** → paste your folder path → click **Scan Library**.
2. The server walks the folder, reads tags, and indexes tracks. Lessons with matching tracks light up with a **Local** play button.
3. For ABX testing on local files, install **ffmpeg**:
   - macOS: `brew install ffmpeg`
   - Linux: `apt install ffmpeg` / `dnf install ffmpeg` / etc.
   - Windows: download from ffmpeg.org or `choco install ffmpeg`
4. Optional but recommended: `pip3 install mutagen` for accurate tag reading. Without it, the indexer falls back to filename parsing (`Artist - Title.flac`).

Lessons match local files by normalized `(artist, title)`, with MusicBrainz Recording ID as the perfect-disambiguation short-circuit when both sides have one. Transcoded MP3s are cached on disk under `<your-folder>/.hifi-buddy-cache/` so the second ABX trial is instant.

## Recommended gear setup

The lessons are designed around the assumption that you're listening on **open-back headphones** and **lossless audio**. They'll still work on closed-backs, IEMs, or Spotify, but the equipment-aware annotations will tell you when a particular passage's effect is going to be subtle for your gear.

A reasonable starter setup:
- Headphones: Sennheiser HD 560s or HD 600 (open-back, neutral)
- DAC: any modern USB DAC (Topping E50, Schiit Modi+, FiiO K7, or even your Mac's headphone jack)
- Amp: optional unless your headphones are >150Ω (Schiit Magni, JDS Atom)
- Source: FLAC via Plex, or Spotify Premium

## ABX methodology

ABX is the standard for blind audio testing. You hear three buttons: **A** (one source), **B** (another source), **X** (randomly assigned A or B). After listening as much as you want, you guess "X is A" or "X is B." Repeat 16 times.

12-of-16 correct gives p < 0.05 — statistically significant discrimination. Below that and you can't reliably tell the two formats apart on this passage. The app reports results bluntly: most listeners cannot reliably distinguish FLAC from 256 kbps MP3 on most passages, and that's a *finding*, not a failure.

## Project structure

```
hifi-buddy/
├── index.html              # Entry point — single-page app shell
├── styles.css              # All styles
├── server.py               # Minimal Python proxy (Plex + Claude + static)
├── service-worker.js       # PWA offline support
├── manifest.json           # PWA manifest
├── js/
│   ├── app.js              # Bootstrap + nav between Lessons / Reference Library
│   ├── hifi-buddy.js       # Lesson dashboard + lesson detail (largest module)
│   ├── reference-bank.js   # Reference Clip Library
│   ├── abx.js              # ABX blind tester
│   ├── visualizer.js       # Real-time frequency spectrum (Web Audio AnalyserNode)
│   ├── settings.js         # Settings + backup/restore
│   ├── audio-player.js     # Mini audio player chrome
│   ├── plex.js             # Plex library matching + transcoding
│   ├── spotify.js          # Spotify SDK + PKCE auth + Connect transfer
│   ├── musicbrainz.js      # Album cover lookups
│   ├── claude.js           # Claude AI Q&A panel, optional
│   └── toast.js            # UI notifications
├── data/
│   ├── hifi-guide.json     # 30 lessons + 10 skills definitions
│   └── reference-clips.json # 55 reference clips
└── assets/
    └── favicon.svg
```

## Tech stack

Vanilla HTML, CSS, JavaScript. Web Audio API. AudioContext + AnalyserNode. Service Worker. PKCE OAuth flow. Spotify Web Playback SDK. Python 3 stdlib HTTP server.

**No frameworks.** No bundler. No transpiler. No build step. No package.json. No node_modules. Lockstep with the audiophile principle of avoiding unnecessary processing.

## Known limits

- The frequency visualizer cannot tap into Spotify SDK output — Spotify's web player is CORS-restricted by design. Plex playback shows the spectrum; Spotify shows an "unavailable" notice.
- ABX requires Plex (both the FLAC source and the on-the-fly MP3 transcode come from Plex). Plex Pass is needed for the universal transcoder on most servers.

## Acknowledgements

Lesson curation draws on classic audiophile reference recordings and decades of accumulated wisdom from forums like Head-Fi, Audio Science Review, and the Stereophile archives.

## License

MIT — see [LICENSE](./LICENSE).

Contributions welcome. The lesson catalog (`data/hifi-guide.json`) and reference clip library (`data/reference-clips.json`) are particularly easy places to contribute new content.

---

## Repository layout (when pushed to GitHub)

This README documents the **runtime app**, which lives in `hifi-buddy-app/`
inside the [`hifibuddy/hifi-buddy`](https://github.com/hifibuddy/hifi-buddy)
monorepo. The repo also contains:

- **`hifi-buddy-app/`** — this folder. The runtime app. Self-hosted, Python +
  vanilla JS, no build step.
- **`hifi-buddy-site/`** — the marketing site at
  [hifibuddy.net](https://hifibuddy.net). Static HTML/CSS/JS.
- **`hifi-buddy-app/docs/`** — user docs: setup, integrations, ABX
  methodology, troubleshooting.

When the repo is pushed for the first time, place a top-level `README.md`
at the repo root with content like this so visitors landing at
`github.com/hifibuddy/hifi-buddy` see something coherent before drilling
in:

```markdown
# HiFi Buddy

Critical-listening tutor for audiophiles. Train your ears on real
reference recordings.

> Stop guessing. Start hearing.

This monorepo contains:

- **[hifi-buddy-app/](./hifi-buddy-app/)** — the runtime app. Standalone,
  self-hosted. Python + vanilla JS, no build step. Start with
  [hifi-buddy-app/README.md](./hifi-buddy-app/README.md).
- **[hifi-buddy-site/](./hifi-buddy-site/)** — the marketing site at
  [hifibuddy.net](https://hifibuddy.net). Static HTML/CSS/JS, deployed
  on Vercel.
- **[hifi-buddy-app/docs/](./hifi-buddy-app/docs/)** — user documentation:
  setup, integrations, ABX methodology, troubleshooting.

## Quickstart (run the app locally)

\`\`\`bash
git clone https://github.com/hifibuddy/hifi-buddy.git
cd hifi-buddy/hifi-buddy-app
python3 server.py
\`\`\`

Then open http://127.0.0.1:8090/ (use 127.0.0.1, **not** localhost —
Spotify OAuth requires the loopback IP).

## License

MIT — see [hifi-buddy-app/LICENSE](./hifi-buddy-app/LICENSE).

## Contributing

Contributions welcome. The lesson catalog
(`hifi-buddy-app/data/hifi-guide.json`), reference clips, and reference
catalog are particularly easy entry points.
```

A matching root-level `LICENSE` (MIT) and `.gitignore` are also recommended
at the repo root. The `LICENSE` file in this folder applies to the app code;
the same MIT terms cover everything in the repo.

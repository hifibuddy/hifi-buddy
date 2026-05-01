# HiFi Buddy

Critical-listening tutor for audiophiles. Train your ears on real reference recordings — 30 curated lessons, ABX blind testing, equipment-aware annotations, frequency visualizer, and a searchable reference clip library.

> Stop guessing. Start hearing.

## Screenshots

![A lesson in progress with player, source-quality detection, and skills sidebar](./hifi-buddy-app/screenshots/full_lesson.png)
*One screen, the whole lesson — album context, source-aware playback, inline quality detection, and a live skills sidebar.*

![Timestamped listening segments, color-coded by skill](./hifi-buddy-app/screenshots/segments.png)
*Each lesson breaks the track into timestamped passages tagged by skill — soundstage, imaging, dynamics, detail. Click any range to seek there.*

![ABX blind test with binomial statistics](./hifi-buddy-app/screenshots/abx.png)
*Proper double-blind ABX testing — level-matched FLAC vs MP3, 16 trials, binomial p-value verdict.*

![Source quality detection — real bit-depth and sample-rate](./hifi-buddy-app/screenshots/quality.png)
*Reads the actual stream — FLAC, bit depth, sample rate, bitrate, channels — not just "lossless ✓".*

## Repository layout

- **[hifi-buddy-app/](./hifi-buddy-app/)** — the runtime app. Standalone,
  self-hosted. Python + vanilla JS, no build step. Start here:
  [hifi-buddy-app/README.md](./hifi-buddy-app/README.md).
- **[hifi-buddy-site/](./hifi-buddy-site/)** — the marketing site at
  [hifibuddy.net](https://hifibuddy.net). Static HTML/CSS/JS, deployed on
  Vercel.
- **[hifi-buddy-app/docs/](./hifi-buddy-app/docs/)** — user documentation:
  setup, integrations, ABX methodology, troubleshooting.

## What it does

HiFi Buddy teaches the things audiophiles actually talk about — **soundstage,
imaging, dynamics, transients, micro-detail, tonal color, bass quality,
separation, air, layering** — using timestamped passages of real reference
tracks (Dire Straits, Steely Dan, Diana Krall, Aphex Twin, Bill Evans, Massive
Attack, and 20+ more).

You play the song from your **Plex library** (lossless FLAC — recommended),
**Spotify Premium** (256 kbps Ogg via the Web Playback SDK), or a **local FLAC
folder**. The app calls out exactly what to listen for and when. Click any
timestamp to seek directly there. When you've internalized a lesson, take the
**ABX test** — proper double-blind methodology, 16 trials, level-matched FLAC
vs MP3 comparison, with a binomial p-value and a blunt verdict telling you
whether you can actually distinguish the formats.

## Quickstart

### macOS — download the app

[**Download `HiFi-Buddy.dmg`**](https://github.com/hifibuddy/hifi-buddy/releases/latest/download/HiFi-Buddy.dmg)
(~18 MB, Apple Silicon)

1. Open the DMG, drag **HiFi Buddy** into `/Applications`.
2. **First launch only**: right-click → **Open** → confirm. macOS Gatekeeper
   blocks unsigned apps the first time; one-time confirmation, then
   double-click works normally. Apple notarization is on the roadmap.
3. The app shows a wave-shaped icon in the menu bar and auto-opens your
   default browser at `http://127.0.0.1:8090/`.

### Windows

Coming soon — auto-built via GitHub Actions in v1.3.0.

### Run from source (Linux, contributors, all platforms)

```bash
git clone https://github.com/hifibuddy/hifi-buddy.git
cd hifi-buddy/hifi-buddy-app
python3 server.py
```

Then open **http://127.0.0.1:8090/** in your browser. (Use `127.0.0.1`,
**not** `localhost` — Spotify's OAuth requires the loopback IP form.)

No dependencies, no Node, no bundler. Pure Python 3 stdlib + vanilla browser JS.

## Configure

After installing, set up your music sources from inside the app:

| Source | Setup link |
|---|---|
| **Plex Media Server** (recommended for lossless + ABX) | [docs/INTEGRATIONS.md#plex](./hifi-buddy-app/docs/INTEGRATIONS.md#plex) |
| **Spotify Premium** (in-browser playback) | [docs/INTEGRATIONS.md#spotify](./hifi-buddy-app/docs/INTEGRATIONS.md#spotify) |
| **Local FLAC folder** | [docs/SETUP.md#local-flac-mode](./hifi-buddy-app/docs/SETUP.md#local-flac-mode) |
| **Claude API / Ollama** (AI Listening Coach + Lesson Generator) | [docs/INTEGRATIONS.md#claude-api](./hifi-buddy-app/docs/INTEGRATIONS.md#claude-api) |

Full user guide: [docs/USER_GUIDE.md](./hifi-buddy-app/docs/USER_GUIDE.md).
Stuck? [docs/TROUBLESHOOTING.md](./hifi-buddy-app/docs/TROUBLESHOOTING.md).

## Privacy

Runs entirely locally. No telemetry. Durable config (Plex token, Spotify
client ID, equipment profile, ABX history, timing edits) lives at
**`~/.hifi-buddy/`** as plain JSON files, `chmod 600`. Back up by copying
the folder. Move to another machine by copying the folder.

The only network calls leave your machine when you explicitly:
- Play from Spotify or Plex
- Use the Claude AI Listening Coach (calls Anthropic with your key)
- Look up album art (MusicBrainz)

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

Contributions welcome. The lesson catalog
(`hifi-buddy-app/data/hifi-guide.json`), reference clips
(`hifi-buddy-app/data/reference-clips.json`), and reference catalog
(`hifi-buddy-app/data/reference-catalog.json`) are particularly easy entry
points for new content.

Bug reports and feature requests:
[issues](https://github.com/hifibuddy/hifi-buddy/issues).

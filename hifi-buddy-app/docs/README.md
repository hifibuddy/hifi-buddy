# HiFi Buddy — End-User Documentation

This folder is the end-user documentation for HiFi Buddy, a standalone
critical-listening tutor for audiophiles. If you're a developer working on
HiFi Buddy itself, see `README.md` and `tools/README.md` at the repo root.

These docs assume you can run a Python script in a terminal, copy a token
from a browser DevTools panel, and paste an API key into a settings dialog.
You don't need to write code.

HiFi Buddy is the descendant of the HiFi-Buddy subsystem inside the original
MusicTrip project. In April 2026 it was extracted into this standalone app.
A first-run migration copies any leftover `musictrip_*` localStorage keys to
their `hifibuddy_*` equivalents, so existing users carry their progress over
automatically.

## Documentation index

| Doc | What it covers |
|---|---|
| [SETUP.md](./SETUP.md) | First-time install, running the server on `127.0.0.1:8090`, `make test`, settings backup |
| [USER_GUIDE.md](./USER_GUIDE.md) | Tour of every view: Lessons, Reference Library, Stats, Settings, Onboarding |
| [HIFI_BUDDY.md](./HIFI_BUDDY.md) | Deep dive on lessons, ABX, equipment profiles, visualizer + FR overlay, AI lesson generation, track variant picker, timing feedback, the reference-catalog/`propose_lessons.py` workflow |
| [INTEGRATIONS.md](./INTEGRATIONS.md) | Plex, Spotify, Local FLAC (ffmpeg + mutagen), Claude API, Ollama, MusicBrainz |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Real failure modes, the actual error messages, and how to fix each, plus the Diagnostics panel as a self-service debugging tool |
| [cross-browser-audit.md](./cross-browser-audit.md) | Internal QA notes: per-browser support matrix, known cross-browser issues |

## Recommended reading order

1. [SETUP.md](./SETUP.md) — get the app running (5 minutes)
2. [USER_GUIDE.md](./USER_GUIDE.md) — skim to learn what each view does
3. [INTEGRATIONS.md](./INTEGRATIONS.md) — wire up Plex (the big one) plus
   Local FLAC or Spotify if relevant
4. [HIFI_BUDDY.md](./HIFI_BUDDY.md) — the main event for serious listeners
5. [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — when something breaks

## What's new since the last revision

- **Local FLAC mode** — point at a folder, server-side scan, lessons match
  by tag. ffmpeg powers the ABX MP3 transcode. (See INTEGRATIONS.md →
  Local FLAC and HIFI_BUDDY.md → Source priority.)
- **Headphone FR overlay** on the visualizer — 39 popular headphones with
  measured frequency-response curves, picked from a cog popover.
- **Onboarding wizard** — a 5-step first-run flow. Pick a music source,
  paste your headphones, you're done.
- **Stats view** — new top-level nav target. Aggregate ABX progress
  across every lesson and bitrate.
- **Unified AI Lesson Generator** — one modal, four input modes (Quick
  guide, Paste track, Browse Plex, Import pack from `propose_lessons.py`).
- **Track Variant Picker** — when Plex or local has multiple matches for
  the same lesson track, pick the exact one.
- **Player context badge** — the bottom audio bar always tells you where
  the audio is coming from (Lesson X / Reference Clip Y / Local / Plex /
  Spotify).
- **Diagnostics panel** in Settings — live state of SW, Plex, Spotify,
  Local FLAC, ffmpeg/mutagen, origin, browser. Force-update / unregister
  buttons one click away.
- **Timing-feedback** — fix lesson timestamps in-app, export corrections
  as JSON to send upstream.
- **Reference-catalog expansion** — `data/reference-catalog.json` (100
  audiophile candidates) plus a `propose_lessons.py` CLI script that
  drafts new lessons from your Plex library.
- **Lesson 1 timestamps** were re-aligned to the album version of *Money
  for Nothing* (8:26, Bob Ludwig master), not the 4:08 radio edit.
- **Listening Coach is the only chat surface** — the generic
  bottom-right chat FAB was removed. The lesson-aware Listening Coach
  remains.

## Where things live

- App code is at the repo root: `index.html`, `js/*.js`, `server.py`.
- Lesson content: `data/hifi-guide.json` (30 lessons + 10 skills).
- Reference clip library: `data/reference-clips.json` (55 short clips).
- Reference candidate pool: `data/reference-catalog.json` (100 tracks).
- Headphone FR data: `data/headphones-fr.json` (39 headphones).
- Schema validators + linters: `tools/`. Run `make test` to validate.
- All your settings, lesson progress, ABX results, and caches live in
  your browser's `localStorage`. No remote server holds your data — but
  it is bound to a specific browser origin. See the
  [origin partition note](./TROUBLESHOOTING.md#7-all-settings-disappeared-after-changing-the-url)
  before you panic.

## Audience

Audiophile-leaning end users running the app on their own machine.
Comfortable in a terminal, willing to register a Spotify Developer App,
knows what FLAC is, has opinions about headphones.

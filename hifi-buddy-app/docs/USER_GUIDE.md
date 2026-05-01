# User Guide

A tour of every view in HiFi Buddy. Start with [SETUP.md](./SETUP.md) if
you haven't already got the app running.

For lesson and ABX detail — the bulk of the app — there's a dedicated
[HIFI_BUDDY.md](./HIFI_BUDDY.md). This guide only summarizes those parts.

## Contents

- [Navigation overview](#navigation-overview)
- [Onboarding (first run)](#onboarding-first-run)
- [Lessons view](#lessons-view) — the dashboard and the lesson detail page
- [Reference Library](#reference-library) — 55 short tagged clips for skill drills
- [Stats](#stats) — ABX progress dashboard
- [Audio player bar](#audio-player-bar)
- [Settings modal](#settings-modal)
- [Diagnostics panel](#diagnostics-panel)
- [Settings backup/restore](#settings-backuprestore)
- [Theme toggle](#theme-toggle)
- [Offline / PWA mode](#offline--pwa-mode)

---

## Navigation overview

The header bar runs across the top. From left to right:

1. **HiFi Buddy logo** — clicking it returns you to the Lessons view.
2. **Top nav** — three pages:
   - **Lessons** — the lesson dashboard and detail pages (default).
   - **Reference Library** — short tagged ear-training clips.
   - **Stats** — your ABX progress dashboard.
3. **Theme toggle** — sun/moon. Persists to `localStorage`.
4. **Settings gear** — opens the Settings modal.

The audio player bar slides up from the bottom when something plays. It
spans every view; only one source plays at a time.

There is **no longer a generic chat FAB**. Earlier builds had a
bottom-right speech-bubble that opened a global Q&A panel; that surface
was removed. The lesson-aware **Listening Coach** lives in the lesson
sidebar instead — see [HIFI_BUDDY.md → Listening Coach](./HIFI_BUDDY.md#the-listening-coach-chat).

---

## Onboarding (first run)

The first time you load the app, a 5-step wizard appears:

1. **Welcome** — a one-paragraph intro and a "Skip for now" button.
2. **Pick your music source** — Plex (recommended) / Spotify Premium /
   Local FLAC folder / Skip. The pick determines step 3.
3. **Configure that source** — enter the appropriate fields (Plex URL +
   token, Spotify Client ID, or local folder path). Plex has a Test
   button that pings `/api/plex/library/sections` and reports section
   count.
4. **Headphones** — model name (autocompletes from the FR catalog) +
   type (open-back / closed-back / IEM / planar / unknown). Skippable.
5. **You're set** — a pointer to Lesson 1 (*Money for Nothing*).

URL helpers:
- `?onboarding=1` — force-launch the wizard regardless of completion.
- `?reset_onboarding=1` — clear the completion flag and re-launch.

Everything you fill in is also editable later in Settings.

---

## Lessons view

The default view. Two screens: the dashboard and the lesson detail page.

### Dashboard

What you see:

- A header card with the title, a one-line equipment hint (e.g., "Best
  experienced with: lossless audio (FLAC/CD) + open-back headphones"),
  and progress overview — lessons completed, skills explored, percentage.
- (If Plex is configured) A **Plex Library** row with prefetch status:
  "Indexing 14/30" → "✓ 28 tracks ready". The app pre-searches Plex for
  every lesson's track in the background so the Plex play button is
  instant.
- A nav row: **Skill Progress** (per-skill grid), **AI Guide / Add Lesson**
  (opens the unified Lesson Generator modal — see
  [HIFI_BUDDY.md → AI Lesson Generator](./HIFI_BUDDY.md#ai-lesson-generator)),
  and **Filter tabs** (All / Beginner / Intermediate / Advanced).
- The **5 paths**: Listening Foundations, Deeper Listening, Reference
  Grade, Genre Mastery, Audiophile Essentials. Each contains its lessons
  as cards with title, artist+track, and skill chips. Completed lessons
  carry a green check.
- Any lessons you generated yourself (via the AI Lesson Generator) appear
  in their own "My Lessons" row, deletable individually.

Click any lesson card to open its detail page.

### Lesson detail page

The heart of the app. Top to bottom:

1. **Top nav** — back arrow + path crumb.
2. **Lesson hero** — difficulty badge, title, skill chips.
3. **Album card** — art (Plex match → MusicBrainz Cover Art Archive →
   stylized vinyl placeholder), title, artist, year, label, mastering
   engineer if known.
4. **Track info + version note** — *which* version this lesson is for,
   often with a "NOT the X edit" warning. Lessons are tied to a specific
   pressing/master. Lesson 1, for instance, is the 8:26 album version of
   *Money for Nothing*, NOT the 4:08 radio edit (a previous version of
   the lesson was misaligned to the radio cut; that's been fixed).
5. **Duration mismatch warning** — fires when the loaded audio is more
   than 5 seconds off from the expected duration. Tells you which version
   was loaded and by how much.
6. **Play buttons row** — Plex / Spotify / Local / YouTube / A/B / ABX,
   subject to availability. Track Variant Picker triggers from the row
   when Plex or local has multiple matches; see
   [HIFI_BUDDY.md → Track Variant Picker](./HIFI_BUDDY.md#track-variant-picker).
7. **Source quality card** — a yellow Spotify card (256 kbps Ogg cap
   warning + Devices button for Spotify Connect) or a green Plex card
   (codec / bit depth / sample rate / star rating).
8. **Frequency visualizer** — real-time spectrum analyzer of whatever is
   playing on Plex or local; gracefully unsupported for Spotify SDK due
   to CORS. A cog popover toggles bar count, color scheme, peak hold,
   and the headphone FR overlay (39 popular models). See
   [HIFI_BUDDY.md → Visualizer](./HIFI_BUDDY.md#frequency-visualizer).
9. **Playback progress line** — clickable scrubber.
10. **Recording notes** — prose about the album's recording approach.
11. **Intro paragraph** — context for what to expect.
12. **What to Listen For** — 4–6 timestamped items, each tagged with
    a skill and 1–3 sentences of guidance. **Click any item to seek**
    the active source to that timestamp. While playing, the matching
    item highlights and auto-scrolls into view. Each item can carry an
    equipment-aware badge ("Ideal for your open-back headphones",
    "This passage may be subtle on IEMs", "Best heard on a lossless
    source") — driven by your Audio Equipment settings and the
    `bestRevealedBy` / `weakOn` tags in the lesson data.
13. **Edit timing / Export corrections** — toggle a per-segment
    correction mode. See
    [HIFI_BUDDY.md → Timing Feedback](./HIFI_BUDDY.md#timing-feedback).
14. **Key Takeaway** — one sentence.
15. **Source & Equipment** — recommended source format and why it
    matters here.
16. **Mark as Completed** — adds +1 to each of the lesson's skills.
    Persists to `hifibuddy_hifi_progress`.
17. **Previous / Next** — step through the path.
18. **Sidebar — Skills in This Lesson** — full description + concrete
    listening tip per skill.
19. **Sidebar — Listening Coach** — Claude-powered chat scoped to this
    specific lesson. Three pre-seeded chips. Requires the Claude API
    key.

The audio player bar at the bottom shows a **context badge** — a pill
labeled "Lesson 5 · Giorgio by Moroder" (purple) or "Reference Clip ·
Snare crack" (orange) or "Plex" (Plex orange) or "Local" (teal) or
"Spotify" (green) — so you can always see what's playing FROM, even when
you've navigated away from the lesson page.

For a deep dive on every other lesson-page feature (ABX, equipment
profiles, visualizer FR overlay, Track Variant Picker, AI Lesson
Generator, Timing Feedback), see [HIFI_BUDDY.md](./HIFI_BUDDY.md).

---

## Reference Library

55 short clips (typically 3–15 seconds each) curated for specific
skill drills. Independent from the 30 lessons.

What you see:

- A header with skill-filter chips (Soundstage, Imaging, Detail,
  Dynamics, Tonal Color, Bass, Separation, Transients, Air, Layering)
  plus All.
- A grid of clip cards. Each card shows: title, artist + album, the
  primary skill, a short note, a play button, and a star (favorite)
  toggle.
- Favorited clips float to the top of the grid (in their own "Favorites"
  band) so your most-used drills stay one click away.

Each clip has a Plex match, a Local match, or both (resolved in the
background). Clicking play streams via Plex or Local; if neither has
a match the clip is dimmed and the play button is disabled.

When playing, the audio player bar shows the clip's context badge
("Reference Clip · …", orange).

Use the Reference Library when you want to drill a single skill in
isolation, separate from the structured lesson flow.

---

## Stats

A new top-level view (added with the standalone build). Aggregates ABX
results across every lesson into a single dashboard.

What you see:

- **Headline counters** — total ABX sessions run, pass rate (p<0.05),
  borderline rate (0.05 ≤ p < 0.20), unique lessons tested.
- **Discrimination floor** — your best-performing bitrate vs your
  worst, color-coded (320 blue / 256 green / 192 amber / 128 red).
- **Per-lesson grid** — every lesson you've ABX'd, with run count, last
  run date, best correct/16, best p-value, and a green/amber/red dot.
- **Trend** — a 5-session moving-average chart of correct/16 over time,
  so you can see your discrimination ability improving (or not) with
  practice.

Pass thresholds:

| p-value | Class | Verdict |
|---|---|---|
| p < 0.05 | green | reliable discrimination |
| 0.05 ≤ p < 0.20 | amber | borderline |
| p ≥ 0.20 | red | not better than chance |

Stats reads `localStorage.hifibuddy_abx_results`. If you've never run
an ABX test, the view shows a single "no data yet" card pointing back
to a lesson with ABX configured.

---

## Audio player bar

The mini bar that slides up from the bottom whenever something is
playing.

Controls:
- Play / pause toggle.
- A clickable progress bar.
- Track title + artist + small album art (when available).
- **Context badge** — left-most pill identifying the source:
  - **Lesson · Track Title** (purple) — playing from a HiFi Buddy lesson.
  - **Reference Clip · Title** (orange) — playing from the Reference
    Library.
  - **Plex** (Plex orange) — direct Plex stream not tied to a lesson.
  - **Local** (teal) — local-library stream.
  - **Spotify** (Spotify green) — Spotify SDK playback.
- Close × button.

Behavior:
- Only one source plays at a time. Starting Plex stops Spotify; starting
  Spotify stops Plex.
- The lesson detail view has its own *playback progress line* in
  addition to this bar — the bar is the global indicator, the playline
  is the lesson-specific one with click-to-seek into "What to Listen
  For" items.

---

## Settings modal

Opens via the gear icon. Sections:

| Section | Fields |
|---|---|
| Spotify | Client ID, Auth Method (Client Credentials / PKCE), Client Secret (Client Credentials only), connection status |
| Claude AI | API Key |
| Ollama | Server URL, Model name, Load Models button |
| Plex Media Server | Server URL, Auth Token, Test Connection button |
| Local FLAC Library | Folder Path, Scan Library button, ffmpeg/mutagen status |
| Audio Equipment | Headphones (free text), Headphone Type (open-back / closed-back / IEM / planar / unknown), DAC, Amp, Preferred source format (FLAC / MP3 320 / MP3 192 / Streaming / unknown) |
| Diagnostics | Live state of every subsystem (see below) |
| Backup & Restore | Download Backup, Restore from File |

Saving the form fires a `hifibuddy-settings-changed` event that triggers
modules to re-init (Plex re-loads the library, Spotify clears caches,
the local-library indexer re-runs, etc.).

The **Audio Equipment** fields are not cosmetic. Each lesson segment
in `data/hifi-guide.json` carries `bestRevealedBy` / `weakOn` headphone
type tokens; the renderer matches your stored type and prints
contextual badges on each "What to Listen For" item ("Ideal for your
open-back headphones", "This passage may be subtle on IEMs"). Set them
honestly for the most useful per-segment annotations.

For deep dives on each integration's setup, see
[INTEGRATIONS.md](./INTEGRATIONS.md).

---

## Diagnostics panel

Sits inside the Settings modal, between Audio Equipment and Backup.
Probes a handful of subsystems and renders a compact live-state table
in the modal:

| Row | Tells you |
|---|---|
| **Service Worker** | Cache name, active state, whether an update is waiting |
| **Storage** | Used / quota, via `navigator.storage.estimate()` |
| **Plex** | Round-trip to `/api/plex/identity`, last successful call timestamp |
| **Spotify** | Connected? Has the `streaming` scope? |
| **Local FLAC** | Track count + folder |
| **ffmpeg** | Detected on `$PATH`? Path if so. (Required for ABX on local files.) |
| **mutagen** | Importable Python module? (Required for tag-based local indexing.) |
| **Origin** | Current `window.location.origin` and whether Spotify PKCE will work there (HTTPS or loopback only) |
| **Browser** | Detected browser name + version + OS |

Three buttons below:
- **Force Update** — calls `registration.update()` then reloads.
- **Unregister & Reload** — unregisters the service worker, deletes
  every cache, then reloads.
- **Refresh** — re-runs the probes without reloading.

Use this when something is silently broken. Most "I think the SW is
stale" / "I think my Plex token expired" guesses become things you can
SEE here. See
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for symptom-mapped fixes.

---

## Settings backup/restore

Exports every `hifibuddy_*` localStorage key to a JSON file you can save
and re-import elsewhere.

### Why you might need it

- Moving from `localhost:8090` to `127.0.0.1:8090` (or vice versa).
  Browsers treat them as separate origins, so localStorage doesn't
  carry over. See
  [origin partition](./TROUBLESHOOTING.md#7-all-settings-disappeared-after-changing-the-url).
- Setting up HiFi Buddy on a second machine.
- Before clearing browser data.
- Before testing destructive actions.
- iOS Safari's ITP can wipe localStorage after 7 days of inactivity for
  non-PWA contexts. Periodic backups guard against this.

### How to export

1. Settings → **Backup & Restore** → **Download Backup**.
2. The file downloads as `hifibuddy-backup-YYYY-MM-DDTHH-MM-SS.json`.
3. The status line below shows `Exported N keys`.

The file looks like:

```json
{
  "exportedAt": "2026-04-25T14:32:10.000Z",
  "origin": "http://127.0.0.1:8090",
  "version": 1,
  "data": {
    "hifibuddy_plex_url": "http://192.168.1.100:32400",
    "hifibuddy_plex_token": "...",
    "hifibuddy_hifi_progress": "{\"completedLessons\":[\"lesson-001\"],\"skillScores\":{\"soundstage\":1}}",
    "hifibuddy_abx_results": "{\"lesson-001\":[{\"correct\":12,\"trials\":16,\"pValue\":0.038}]}",
    "hifibuddy_user_lessons": "[...]",
    "hifibuddy_timing_overrides": "{...}"
  }
}
```

### How to restore

1. Settings → **Backup & Restore** → **Restore from File…**
2. Pick the JSON.
3. Confirm "Restore N keys?".
4. The app reloads.

The importer accepts both current `hifibuddy_*` backups and legacy
`musictrip_*` exports (from before the standalone rename). Legacy keys
are transparently rewritten to the new prefix on import.

### What's included

Every localStorage key starting with `hifibuddy_`:
- API keys (Spotify, Claude)
- OAuth tokens (Spotify access/refresh + scope list)
- Plex URL + token
- Local-library folder
- Audio equipment fields
- HiFi Buddy lesson progress + skill scores
- ABX results (per-lesson, per-bitrate, full history)
- User-generated lessons (from the AI Lesson Generator)
- Timing-feedback overrides
- Track Variant Picker overrides
- Reference-bank favorites
- Plex match cache (Layer A: persistent) and stream URL cache (Layer B:
  token-scoped)
- Spotify URI cache
- MusicBrainz cover-art cache
- Visualizer settings + FR overlay preference
- Onboarding-completed flag
- Display preferences (theme)
- Ollama model preference

Not included: anything outside `localStorage` (cookies, IndexedDB,
service-worker caches, browser bookmarks, the on-disk transcoded MP3
cache under `<your-folder>/.hifi-buddy-cache/`).

> Warning: the backup contains your tokens and API keys in plaintext.
> Treat it as you would a password file. Don't email it to yourself.

---

## Theme toggle

Sun/moon icon in the header. Toggles between dark and light themes.
Persists to `localStorage` as `hifibuddy_theme = "light"` or `"dark"`.

The dark theme is the default. The light theme is reasonable but the
visualizer and lesson album art look better in dark mode.

---

## Offline / PWA mode

The app is a Progressive Web App with a service worker that caches:
- The HTML, CSS, and all JS modules.
- The bundled JSON datasets (`hifi-guide.json`, `reference-clips.json`,
  `reference-catalog.json`, `headphones-fr.json`).

What works offline:
- Browsing the lesson dashboard, opening any lesson, reading "What to
  Listen For".
- Reference Library (the data ships in the bundle).
- Stats (uses your localStorage data).
- The Diagnostics panel (every probe handles offline gracefully).

What does NOT work offline:
- Plex playback (server unreachable).
- Local-library streaming (the dev server isn't running).
- Spotify (no internet).
- The Listening Coach.
- AI Lesson Generator.
- Album art that hasn't been previously cached.

When you go offline, an "Offline" indicator slides in from the bottom of
the page. It disappears automatically when the network returns.

If the service worker ever caches a stale version of the app, use the
Diagnostics panel's **Force Update** or **Unregister & Reload** buttons.
See [TROUBLESHOOTING.md → Service Worker](./TROUBLESHOOTING.md#6-service-worker-shows-stale-code-after-an-update).

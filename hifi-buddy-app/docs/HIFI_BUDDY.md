# HiFi Buddy — Lessons, ABX, and the Audiophile Toolkit

HiFi Buddy is a critical-listening tutor — the skill of picking apart a
recording and hearing what the engineers and players actually did, instead
of letting the music just wash over you.

There are 30 curated lessons, organized into 5 paths from Beginner to
Advanced. Each lesson is built around a specific reference recording with
timestamped guidance, integrated playback (Plex / Local FLAC / Spotify
Premium / YouTube), an A/B lossless-vs-lossy toggle, a real ABX blind test
you can take to prove (or disprove) your own ability to distinguish
formats, and equipment-aware annotations driven by your gear settings.

The whole thing is meant to be used with **good headphones in a quiet
room** playing **lossless source material**. It will work with cheap
earbuds and the Spotify Web SDK at 256 kbps Ogg, but you will get less
out of it.

## Contents

- [What is critical listening?](#what-is-critical-listening)
- [The 10 listening skills](#the-10-listening-skills)
- [The lesson dashboard](#the-lesson-dashboard)
- [Anatomy of a lesson page](#anatomy-of-a-lesson-page)
- [Source priority: Plex > Local > Spotify > YouTube](#source-priority-plex--local--spotify--youtube)
- [Equipment Profiles](#equipment-profiles)
- [Track Variant Picker](#track-variant-picker)
- [The A/B comparison toggle](#the-ab-comparison-toggle)
- [ABX blind testing](#abx-blind-testing)
- [The ABX Stats dashboard](#the-abx-stats-dashboard)
- [Frequency Visualizer](#frequency-visualizer)
- [Headphone FR Overlay](#headphone-fr-overlay)
- [AI Lesson Generator](#ai-lesson-generator)
- [Lesson catalog expansion: `propose_lessons.py`](#lesson-catalog-expansion-propose_lessonspy)
- [Timing Feedback](#timing-feedback)
- [The Listening Coach chat](#the-listening-coach-chat)
- [Per-skill progress tracking](#per-skill-progress-tracking)
- [The 30 lessons (full table)](#the-30-lessons-full-table)
- [Recording venues](#recording-venues)
- [Audiophile-only pressings (lessons 24/25)](#audiophile-only-pressings-lessons-2425)
- [Equipment recommendations](#equipment-recommendations)
- [Lesson 1 timestamp note](#lesson-1-timestamp-note)

---

## What is critical listening?

Critical listening is paying attention to *how* a recording sounds, not
just what it sounds like. It is what mastering engineers, mixers, and
audiophile reviewers do — and it's a skill, not a sense. You can develop
it.

The aim of HiFi Buddy is to:

1. Give you a vocabulary (the 10 skills below).
2. Hand you reference recordings where each skill is on display.
3. Tell you exactly when in the song to listen and what to listen for.
4. Let you test yourself with ABX (can you actually tell FLAC from MP3?).
5. Track your progress per skill across 30 lessons and across every ABX
   session you've ever run (the Stats dashboard).

It is *not* trying to convince you that 24/192 hi-res is meaningful or
that your DAC matters. The ABX test cheerfully tells you when you can't
tell two formats apart — and the language is blunt by design.

---

## The 10 listening skills

Every lesson teaches one or more of these. Each has a color, an SVG
icon, a short description, and a one-line tip — all visible in the
sidebar of the lesson page. (The icons used to be Unicode emoji; they
are now centralized SVGs in `js/icons.js`, exposed as
`HiFiBuddyIcons.*` for consistency.)

| Skill ID | What it is | Tip |
|---|---|---|
| **soundstage** | The perceived 3D space of the recording — width, depth, height. | Close your eyes. Does the music extend beyond your ears? |
| **imaging** | The precise placement of each instrument inside the soundstage. | Can you point to where the guitar is? The piano? Each player should have a position. |
| **detail** | Micro-details: finger slides, breath before a vocal, the texture of a cymbal's decay. | Listen for the small things. They reveal recording quality. |
| **dynamics** | Contrast between quiet and loud passages. | Do quiet passages feel genuinely soft, climaxes feel powerful without distortion? |
| **tonal-color** | Whether instruments sound *real* — Steinway vs Bösendorfer, Strat vs Les Paul. | Does the piano sound wooden and resonant? Does the sax have reed warmth? |
| **bass** | Not how much, but how good. Extension, texture, speed, decay. | Can you hear pitch in the bass, or is it just rumble? |
| **separation** | Hearing individual instruments in dense passages. | In a busy chorus, can you follow one instrument without losing it? |
| **transients** | The sharp onset of a note — pick hitting string, stick hitting drum. | Snare drums are the best test. Sharp crack, or rounded mush? |
| **air** | The atmosphere around instruments — you "hear" the room. | After a note ends, can you hear the room decay? |
| **layering** | Front-to-back placement: vocal up close, drums further back. | Is there a depth axis, or is everything pasted to the same plane? |

Skills are stored in `data/hifi-guide.json` under the `skills` array.

---

## The lesson dashboard

The first screen you see when you click **Lessons** in the header.

What you see:
- A header card: title, subtitle, and a one-line equipment hint
  ("Best experienced with: lossless audio (FLAC/CD) + open-back
  headphones").
- A progress overview: lessons completed, total lessons, skills explored
  count, and a percentage progress bar.
- (If Plex is configured) A **Plex Library** row showing the prefetch
  status — e.g., "✓ 28 tracks ready" or "Indexing 14/30". The app
  pre-searches Plex for every lesson's track in the background so the
  Plex play button is instant when you click in.
- A nav row with three buttons:
  - **Skill Progress** → opens the per-skill progress page.
  - **AI Guide / Add Lesson** → opens the unified
    [AI Lesson Generator](#ai-lesson-generator) modal.
  - **Filter tabs** (All / Beginner / Intermediate / Advanced) — filters
    the path list below.
- The **paths**: 5 colored cards, each containing the lessons in that
  path as a vertical list. Each lesson card shows title, artist+track,
  and the skill chips it teaches. Completed lessons get a green check
  icon.
- (If you've generated any custom lessons) A "My Lessons" row, sourced
  from `localStorage.hifibuddy_user_lessons`. Each card has a delete
  button.

Tip: the path color codes the difficulty.

### The 5 paths

| Path | Difficulty | Lessons |
|---|---|---|
| **Listening Foundations** | Beginner | L001–L005, L013–L015 |
| **Deeper Listening** | Intermediate | L006–L009 |
| **Reference Grade** | Advanced | L010–L012 |
| **Genre Mastery** | Intermediate | L016–L023 |
| **Audiophile Essentials** | Advanced | L024–L030 |

Click any lesson card to open its detail page.

---

## Anatomy of a lesson page

The page is split into a wide main column (the lesson content) and a
narrower sidebar (skill descriptions and the Listening Coach).

### 1. Top nav

A back arrow ("All Lessons") and a path crumb showing which path this
lesson belongs to.

### 2. Lesson hero

A large header with:
- Difficulty badge in the difficulty color.
- Lesson title.
- Skill badges with their colors and icons.

### 3. Album info card

Album art (loaded via Plex match → MusicBrainz Cover Art Archive →
stylized vinyl placeholder fallback). Album title, artist, year, label,
mastering engineer if known.

### 4. Track info + version note

The track title and listed duration. Critically, a **version note** —
for example:

> Album version on Brothers in Arms (1985), 8:26. Bob Ludwig master.
> NOT the 4:08 radio edit.

This matters. Many famous songs have multiple official versions with
different masters and durations. The lesson timestamps are tied to the
version named in the note.

### 5. Duration mismatch warning

If the loaded track's actual duration differs from the lesson's
expected duration by more than 5 seconds, a yellow warning banner
appears:

> Different version loaded. Expected 8:26, got 4:08 (-258s). The lesson
> timestamps may not line up with this cut.

If you see this, either find the correct version manually, switch
sources, or use the [Track Variant Picker](#track-variant-picker) to
pin the lesson to a specific match in your library.

### 6. Play buttons row

Up to six buttons, depending on what's available:

- **Plex** — green/orange Plex-branded button. Plays through the proxy
  in your browser. Disabled if Plex isn't configured.
- **Local** — teal button. Plays via the `/api/local/stream/<id>`
  endpoint. Visible only if local-library mode is configured *and* this
  lesson's track was matched in the index.
- **Spotify** — green Spotify button. Auto-detects state and renders
  one of:
  - "Spotify" (Premium plays the full track via Web Playback SDK)
  - "Reconnect for Premium" (you have a token but it's missing the
    `streaming` scope, or you used Client Credentials)
  - "Connect Spotify" (no token, but you have a Client ID set)
  - "Set up Spotify" (no Client ID — opens Settings)
  - Hidden entirely on mobile, where the Web Playback SDK does not work.
- **YouTube** — opens a YouTube search for the track in a new tab.
  Always available as a fallback.
- **A/B** — appears when Plex (or local) is playing a lossless source.
  See [A/B comparison](#the-ab-comparison-toggle).
- **ABX** — appears when the lesson has ABX configured *and* either Plex
  or local-with-ffmpeg is available. See [ABX](#abx-blind-testing).

### 7. Source quality card

When Spotify is the source, a yellow/amber card appears:

> Source: Spotify Web Player · Premium · ~256 kbps Ogg Vorbis (Web SDK
> cap). Spotify Web SDK is capped at ~256 kbps. For lossless critical
> listening on this lesson, use Plex (FLAC) — or transfer playback to
> your Spotify desktop app for up to 320 kbps.

A **Devices** button opens the Spotify Connect device picker so you can
transfer playback to a desktop app, smart speaker, or any other Connect
target.

When Plex (or local) is the source, a different card shows:
- Codec / bit depth / sample rate / channels / bitrate — e.g., "FLAC ·
  16-bit · 44.1kHz · Stereo · 880kbps".
- A 5-star quality rating: ★★★★★ Audiophile, ★★★★ Hi-Res, ★★★ CD
  Quality, ★★ Good, ★ Compressed.
- A note: "✓ Great source for this lesson" if rated Hi-Res or above.

### 8. Frequency Visualizer

Real-time spectrum analyzer for the active source. Plex and local
streams display fully; Spotify SDK output is CORS-restricted by design,
so the panel shows an "unavailable for Spotify SDK" message. See the
[full Visualizer section](#frequency-visualizer) for FR overlay and
controls.

### 9. Playback progress line

A clickable scrubber. Bar updates every 500 ms. Click anywhere on it
to seek.

### 10. Recording notes / format card

A descriptive paragraph about the album's recording approach.

### 11. Intro paragraph

A 2–4 sentence prose intro setting up the recording's significance.

### 12. "What to Listen For" section

The heart of the lesson. 4–6 timestamped items. Each shows:
- A timestamp range (e.g., "0:55-1:15"). Honors any user override (see
  [Timing Feedback](#timing-feedback)).
- The skill being demonstrated (with its color).
- A 1–3 sentence note explaining what's happening at that point.
- An equipment-aware badge when relevant — see
  [Equipment Profiles](#equipment-profiles).

Click any item to seek the active source there. While playing, the
matching item gets a colored border and auto-scrolls into view.

### 13. Edit timing / Export corrections row

A small toolbar above the listenFor list. Toggles edit mode (per-item
M:SS-M:SS inputs with validation), exports your accumulated
corrections as JSON, or imports corrections back. See
[Timing Feedback](#timing-feedback).

### 14. Key Takeaway

A single-sentence summary.

### 15. Source & Equipment

Two short paragraphs:
- **Recommended source** (e.g., "CD or FLAC 16/44.1").
- **Why it matters** (e.g., "This recording was born digital, so
  CD/FLAC gives you exactly what the engineers heard.").

### 16. Mark as Completed

Bottom-of-page button. Clicking it marks the lesson done and adds +1 to
each skill score it teaches. Persisted under
`hifibuddy_hifi_progress`. Re-clicking says "Completed — Listen Again
Anytime".

### 17. Previous / Next

Step through lessons in the same path.

### 18. Sidebar — Skills in This Lesson

Each skill: icon, name, full description, and a "Tip:" line.

### 19. Sidebar — Listening Coach

A collapsible chat panel. See
[the Listening Coach section](#the-listening-coach-chat).

---

## Source priority: Plex > Local > Spotify > YouTube

The app's strong opinion is that **lossless local files are the right
way to do this**, and Plex is the easiest way to manage them.

1. **Lossless vs lossy.** A FLAC at 16/44.1 from a CD rip is bit-perfect
   identical to the master. A 256 kbps Ogg from Spotify is not. The
   lessons are specifically engineered to highlight transients,
   micro-detail, and air — exactly what lossy compression strips.

2. **Predictable mastering.** Your local copy is whatever pressing/master
   you bought. Spotify and YouTube can serve different masters at
   different times — including loudness-war remasters that crush
   dynamics into a brick. The duration-mismatch warning often fires on
   Spotify because the streaming version is a different cut.

3. **ABX requires a transcoder.** The blind ABX test compares your
   lossless source against an MP3 transcode at a chosen bitrate. Plex's
   universal transcoder does this server-side; for local-library mode,
   ffmpeg does the same client-server-side and caches under
   `<your-folder>/.hifi-buddy-cache/`. Spotify SDK and YouTube cannot
   participate.

4. **No DRM, no caps.** Plex and local both stream the actual file
   through the local server proxy. There's no rate limit, no quota,
   no "Premium required" gate.

When neither is an option, Spotify Premium is the next best — full-track
playback in-browser, ~256 kbps Ogg Vorbis on the Web SDK, up to 320 kbps
if you transfer to the desktop app and have Premium, or higher on
Spotify HiFi.

YouTube is the universal fallback. Quality is unpredictable, no
integrated playback (it opens in a new tab), no progress tracking.
Useful when nothing else works.

For lessons 24 and 25 — both audiophile-only pressings — Plex or local
is the only viable source. See
[Audiophile-only pressings](#audiophile-only-pressings-lessons-2425).

---

## Equipment Profiles

Settings → **Audio Equipment** captures five fields:

| Field | Values | Used for |
|---|---|---|
| **Headphones** (text) | free text, autocompletes from `data/headphones-fr.json` | Visualizer FR overlay default match |
| **Headphone Type** | open-back / closed-back / IEM / planar / unknown | Per-segment "Ideal for…" / "Subtle on…" badges |
| **DAC** (text) | free text | Currently informational |
| **Amp** (text) | free text | Currently informational |
| **Preferred Source Format** | FLAC / MP3 320 / MP3 192 / Streaming / unknown | "Best heard on a lossless source" badges when bestRevealedBy includes `lossless` and your pref is lossy |

How it works: each "What to Listen For" segment in `data/hifi-guide.json`
can carry `bestRevealedBy` and `weakOn` arrays of headphone-type tokens
(`open-back`, `closed-back`, `closed-back-budget`, `iem`, `bass-shy-iem`,
`planar`, `lossless`). The renderer maps your stored type to those
tokens and prints one of:

- **"Ideal for your open-back headphones"** (green check) — when your
  type matches a `bestRevealedBy` token.
- **"This passage may be subtle on IEMs"** (yellow warn) — when your
  type matches a `weakOn` token.
- **"Best heard on a lossless source"** (yellow warn) — when the
  segment is best on lossless and you're set to a lossy preference.
- A neutral note when only the segment's `headphoneNote` is set.

If you set neither field (Type = unknown, Format = unknown), no badges
print — the lesson stays clean.

Set them honestly. The point isn't to flatter your gear; it's to tell
you when the lesson's effect is going to be subtle on what you have.

---

## Track Variant Picker

When Plex (or your local library) has multiple matches for a lesson's
track — studio + live + remaster + compilation — `HiFiBuddyPlex.searchTrack`
picks one heuristically. This isn't always right.

The Track Variant Picker surfaces every match. You see a modal with:

- A row per Plex match: title, artist, album, year, duration, codec /
  bit depth / sample rate, and a play button.
- A row per local-library match (when local mode is configured): title,
  artist, album, duration, codec.
- A radio toggle that pins the lesson to a specific match.

The choice is persisted in
`localStorage.hifibuddy_track_overrides`:

```json
{
  "lesson-001": { "source": "plex", "id": "12345" },
  "lesson-012": { "source": "local", "id": "abc-def-ghi" }
}
```

`playFromPlex` and `playFromLocal` consult this map first. To clear an
override, open the picker and choose "Auto (default)".

When to use it:
- The duration-mismatch warning keeps firing on a lesson because Plex
  matched a single edit and you have the album cut too.
- A lesson sounds wrong because the matcher picked a remix or a live
  version.
- You have multiple pressings of the same album and want a specific
  master.

---

## The A/B comparison toggle

A simpler precursor to the full ABX test. When Plex (or local) is
playing a lossless source, the **A/B** button appears in the play row.

Clicking opens an A/B Quality Comparison panel:

- **Lossless** button — the FLAC/ALAC source you're already playing.
- **Compressed** button — a Plex- or ffmpeg-transcoded MP3 of the
  same track.
- A hint: "Listen for: soundstage width, cymbal shimmer, bass texture,
  stereo separation".

Switching between the two re-routes playback. This is *not blind* — you
can see which one is which. Use it for quick training; use ABX to
actually prove discrimination.

---

## ABX blind testing

ABX is the standard scientific method for proving you can tell two
audio sources apart.

### What is ABX?

You hear two named samples (A and B) and one unknown (X). X is
randomly chosen to match either A or B at the start of each trial.
Your job: say whether X is A or X is B.

Doing it once is luck. Doing it 16 times in a row is a statistical
experiment with a clean binomial p-value:

| Correct out of 16 | p-value | Verdict |
|---|---|---|
| 16 | 0.00002 | Highly significant |
| 14 | 0.002 | Significant |
| 12 | 0.038 | **Just significant (p < 0.05)** |
| 11 | 0.105 | Not significant |
| 8 | 0.598 | Chance |

12 out of 16 is the conventional threshold for "yes, you can tell".
Below that, you can't reliably distinguish.

### How to launch ABX

1. Open any HiFi Buddy lesson where the **ABX** button shows. (It needs
   either Plex configured or local-library + ffmpeg, *and* the lesson
   must not have `abx.skip = true`. Lessons 24 and 25 don't have ABX
   because they're audiophile-only pressings.)
2. The button title shows the bitrate, e.g., "Blind ABX test: can you
   tell FLAC from 192 kbps MP3?".
3. Click. The ABX modal opens with a loading spinner.

**AI-generated lessons get ABX too.** When you save a lesson out of the
[AI Lesson Generator](#ai-lesson-generator), the app auto-derives an
`abx` block from the lesson's `listenFor` segments by picking the highest
priority skill (dynamics > transients > detail > separation > tonal-color
> bass > imaging > soundstage > air > layering) and using its segment as
the ABX window. So custom user lessons show the ABX button on the same
terms as the curated 30, with no extra hand-editing.

### What happens behind the scenes

1. The app finds the lesson's track in your Plex library or local
   index (Track Variant Picker override is honored).
2. It builds two stream URLs:
   - **A (lossless)**: the direct FLAC/ALAC stream.
   - **B (lossy)**: a Plex `/transcode/universal/start.mp3` URL, or a
     local `/api/local/transcode/<id>?bitrate=N` URL routed through
     ffmpeg. The local transcode is cached on disk under
     `<your-folder>/.hifi-buddy-cache/` so the second run is instant.
3. It downloads both fully into Web Audio buffers.
4. **Sanity check**: it compares the byte sizes. A FLAC and a 192 kbps
   MP3 should differ by roughly 5–8×. If the sizes are within 1.5× of
   each other, the app warns in the console:
   > [ABX] WARNING: lossless and lossy bytes are too similar (ratio
   > 1.05x). Plex transcoder may be passing through.

   This usually means Plex isn't actually transcoding (codec
   passthrough for codec-eligible clients) — see
   [TROUBLESHOOTING.md → ΔRMS = 0](./TROUBLESHOOTING.md#5-abx-shows-δrms--000-db).
5. **Level matching**: it computes RMS over the chosen segment for
   both buffers and applies a gain to whichever is louder so they're
   matched at the audio output. Without this, you'd just be picking the
   louder one.
6. The trial state machine starts with a randomized X assignment.

### The trial UI

Each of the 16 trials shows:
- A meta block: lesson, segment, bitrate, "Trial N of 16".
- A leveling status: "Level-matched: ΔRMS ≈ 0.04 dB" (green) or warning
  (yellow if > 0.5 dB).
- Three buttons: **▶ A FLAC**, **▶ B MP3 192**, **▶ X ?** — switch
  between freely. Switching is gapless: parallel sources with gain
  adjustment, no click or hiccup.
- Two guess buttons: **X is A**, **X is B**.
- A progress bar showing trials completed and a running p-value.
- A "Reveal answer after each guess (training mode)" checkbox.

The segment is short by design (typically 10–30 seconds, padded
slightly on each side).

### The final result

After 16 trials, the modal flips to a verdict card with one of three
tones, depending on your score:

**12+/16 (significant)** — green:
> Statistically significant — you can reliably distinguish FLAC from
> 192 kbps MP3 on this passage. 13/16 correct, p = 0.011.

**8–11/16 (not significant)** — yellow:
> Not significant. 9/16 correct, p = 0.402. Doesn't mean the formats
> sound identical — the difference is below your discrimination
> threshold here.

**Below 8/16 (below chance)** — red:
> Below chance. 5/16 correct. Either you guessed inverted, the
> level-matching was off, or you genuinely can't tell.

Two action buttons: "Run Another 16 Trials" and "Done".

### Persistence

Every completed run is saved per-lesson under
`localStorage.hifibuddy_abx_results`:

```json
{
  "lesson-001": [
    {
      "bitrate": 192,
      "trials": 16,
      "correct": 12,
      "pValue": 0.038,
      "segment": "0:55-1:15",
      "completedAt": 1735000000000
    }
  ]
}
```

Prior runs at the same bitrate are listed under the verdict card
("Prior runs at 192 kbps") so you can see your trajectory over time.

The aggregate of all runs powers the [Stats dashboard](#the-abx-stats-dashboard).

### Known limits

- **Plex Pass may be required.** The `/transcode/universal/*` endpoint
  is a Plex feature. Without Plex Pass, requests may return 502 or 500.
- **Plex transcoder passthrough.** If the source codec is one Plex
  considers safe (opus, aac), the transcoder may not actually re-encode.
  The byte-size sanity check warns; ΔRMS will be 0.00 dB.
- **Local-library mode requires ffmpeg.** Without it, the ABX button
  doesn't appear on local matches. Install via `brew install ffmpeg` /
  `apt install ffmpeg` etc.
- **Headphones / DAC matter.** If your equipment can't resolve the
  difference, no amount of training will help. The level-matched test
  is honest about that.
- **Listening fatigue is real.** Don't run 5 ABX tests in a row. Take
  breaks. The first round is usually the most accurate.

---

## The ABX Stats dashboard

The **Stats** view in the top nav aggregates every ABX session you've
ever run.

What you see:

- **Headline counters** — total sessions run, pass rate (p<0.05),
  borderline rate (0.05 ≤ p < 0.20), unique lessons tested.
- **Discrimination floor** — the lowest bitrate at which you can pass,
  color-coded (320 blue / 256 green / 192 amber / 128 red).
- **Per-lesson grid** — every lesson you've ABX'd, with run count,
  last-run date, best correct/16, best p-value, and a green/amber/red
  dot.
- **Trend** — a 5-session moving-average line of correct/16 over time,
  so you can see whether your discrimination is improving with
  practice.

Pass thresholds match the ABX module's verdict colors:

| p-value | Class |
|---|---|
| p < 0.05 | green (pass) |
| 0.05 ≤ p < 0.20 | amber (borderline) |
| p ≥ 0.20 | red (chance) |

The view re-renders every time you open it, so freshly completed
sessions show up immediately. Stats reads
`localStorage.hifibuddy_abx_results` directly — restoring a backup
populates this view too.

If you've never run an ABX test, Stats shows a single empty-state card
pointing back to a lesson with ABX configured.

---

## Frequency Visualizer

A real-time log-frequency spectrum analyzer that sits inside the lesson
detail page (and is reusable from the Reference Library). Drives off
the Web Audio `AnalyserNode` attached to the active `<audio>` element.

Configurable from the **cog popover** in the visualizer header:

- **Bars** — number of FFT bins to render (32, 64, 128, 256). Default 64.
- **Color scheme** — `single`, `gradient`, or `skill` (highlights bands
  in the colors of the lesson's skills).
- **Peak hold** — toggle the slow-decaying peak indicators.
- **Headphone FR overlay** — toggle and pick a headphone (see below).

Settings persist to `localStorage.hifibuddy_visualizer_settings`. The
FR overlay choice is stored separately under
`hifibuddy_visualizer_fr_overlay`.

The visualizer captures the audio element via a
`MediaElementAudioSourceNode`. Because the spec forbids creating two
sources for the same element, the module caches the source on a
`WeakMap` so re-attach is a no-op.

**Spotify SDK is unsupported.** The Web Playback SDK output isn't
exposed to Web Audio (CORS restriction). The panel shows an
"unavailable for Spotify SDK" message and gracefully degrades. Plex
and local streams work fully.

The audio element's `crossOrigin = 'anonymous'` is set *before* the
first `src` is assigned. If you ever see a silent spectrum on a known-good
source, the most likely cause is that crossOrigin got assigned after
the first load and the element is now "tainted" — open and re-open the
lesson page to recreate the element.

---

## Headphone FR Overlay

A 39-headphone catalog of measured frequency-response curves, ready to
overlay on the live spectrum so you can see — visually — where your
headphones are likely emphasizing or rolling off the music.

Catalog source: `data/headphones-fr.json`. Includes Sennheiser HD 600 /
HD 650 / HD 800S, Beyerdynamic DT880 / DT990 / DT1990, HiFiMan Sundara
/ Edition XS / Arya, AKG K712 / K371, Audeze LCD-X / LCD-2, Focal
Clear / Utopia, Drop + HD 6XX, Hifiman HE400se, ATH-M50x, AirPods Max,
plus IEMs (Etymotic ER2SE, Moondrop Aria, etc.) — 39 in total at
present, easily extensible.

Each entry has:
- `id`, `name`, `type` (open-back / closed-back / iem / planar)
- `fr`: an array of `{ freq, db }` points
- `notes`: a short one-liner

How it works:
- Toggle "Headphone FR overlay" in the cog popover.
- Pick a headphone from the dropdown — defaults to a name match against
  your `Settings → Audio Equipment → Headphones` field if it exists.
- A semi-transparent line overlays the spectrum. Vertical scale: ±15 dB
  maps to ±half-canvas-height.

The data is loaded lazily and cached in memory — first toggle takes one
fetch, subsequent toggles are instant.

The overlay is descriptive, not normative. It doesn't try to "correct"
your spectrum; it just shows you what shape you're listening *through*.
The lesson notes remain the authoritative guidance about what to listen
for; the FR curve is a sanity check ("oh — my K712s are rolling off
above 12k, that's why the air on this lesson sounds polite").

---

## AI Lesson Generator

A unified modal that lets you create lessons for tracks not in the
built-in 30. Replaces the older standalone "AI Guide" page. One modal,
four tabs:

### Tab A — Quick guide

Fill out a form:
- **Artist** (required)
- **Track title** (required)
- **Album** (optional)
- **Duration** in M:SS (optional)
- **Focus skill** (dropdown: All skills auto-detect, or one of the 10)

Click **Generate**. The app calls Claude (if API key set) or Ollama (if
URL set) with a structured system prompt that pins the schema, valid
skill IDs, and writing-style rules. The model returns a complete
lesson. Review in the modal, click **Save** to persist or **Discard**
to throw away. Saved lessons appear in "My Lessons" on the dashboard.

### Tab B — Paste track

A free-form input. Accepts:
- "Artist - Title" plain text
- A Spotify track URL or URI
- A Plex track ID (the matcher will resolve metadata)

Same generation pipeline as Quick guide. Useful when the artist/track
disambiguation is straightforward and you don't want to fill out a
five-field form.

### Tab C — Browse Plex

Intersects `data/reference-catalog.json` (100 audiophile-curated
candidate tracks) with your Plex library and shows you the matches.
Each match card has the track + artist + album, the primary skills,
the audiophile note, and a **Generate Lesson** button.

The intersection is computed once per Plex URL and cached in
`localStorage.hifibuddy_browseplex_matches`, fingerprinted against the
catalog so it auto-invalidates when the catalog updates. A **Rescan**
button forces a re-search.

This is the fastest way to get a high-quality lesson for a track you
already own and that the curator already audiophile-vetted.

### Tab D — Import pack

Loads a `proposed-lessons.json` file from disk. The expected shape is
the output of [`propose_lessons.py`](#lesson-catalog-expansion-propose_lessonspy):

```json
{
  "version": 1,
  "generatedAt": "...",
  "lessons": [
    { "lesson": {...}, "status": "ok" | "needs_review" | "ai_failed", "score": 0.87, "errors": [] }
  ]
}
```

The modal renders one row per lesson with status badges and lets you
checkbox-pick the ones to import in bulk. **Select OK only** is a
shortcut. **Import selected** writes them into
`hifibuddy_user_lessons`.

### Errors

When a generation fails, the modal renders a rich error card with the
status code, the actual response body (truncated to 800 chars), and a
**Retry** button. Common cases:

- **No AI backend configured** — set up Claude or Ollama in Settings.
- **Claude returned 401** — bad API key.
- **Claude returned 429** — rate limit. Wait, retry.
- **Ollama unreachable** — daemon not running, or wrong URL.
- **JSON parse failed** — model returned something un-shapeable. The
  error card includes the raw text so you can read what came back.

The model is asked to return JSON only; both Claude (via instruction)
and Ollama (via `format: 'json'` strict mode) usually comply.

---

## Lesson catalog expansion: `propose_lessons.py`

A stdlib-only Python CLI in the repo root that drafts new HiFi Buddy
lessons from your Plex library. Useful for contributors building out
the lesson catalog, or for advanced users who want a one-shot batch of
20 candidate lessons to import.

How it works:

1. Reads `data/reference-catalog.json` (the audiophile candidate pool —
   100 tracks at present) and `data/hifi-guide.json` (the live lesson
   catalog).
2. Talks to your Plex server, finds which candidates are actually in
   your library.
3. Scores them (genre coverage, skill diversity, audiophile-recording
   pedigree).
4. Drafts the top N as full lessons by calling the running HiFi Buddy
   server's `/api/claude` or `/api/ollama` proxy.
5. Writes `proposed-lessons.json` for human review.

Usage:

```bash
python3 propose_lessons.py \
    --plex-url http://192.168.1.100:32400 \
    --plex-token YOUR_TOKEN \
    --ai claude \
    --claude-key sk-ant-... \
    --top 12 \
    --output proposed-lessons.json
```

Or use environment variables / interactive prompts (the script will ask
for missing values). Set `--ai none` to skip generation and just emit
the candidate list.

You then load `proposed-lessons.json` via the AI Lesson Generator's
**Import pack** tab. Review each draft, check the ones you want, click
import.

The script does not modify `data/hifi-guide.json`. It's a proposer,
not an applier. Merging into the live catalog is a manual review step
on purpose.

See `propose_lessons.py --help` for the full flag list.

---

## Timing Feedback

A per-user mechanism for correcting timestamp drift in lesson
"What to Listen For" segments. Two reasons it exists:

- The lesson catalog might be slightly off (a 0:55-1:15 segment that's
  actually 0:50-1:10 in the master you have).
- You might want to pin segments to a different cut than the canonical
  one, even if the version note matches.

How to use it:

1. On any lesson, click **Edit timing** above the listenFor list.
2. Each item becomes editable. Replace the M:SS-M:SS string with your
   correction.
3. Validation enforces M:SS-M:SS format, end > start, and (when track
   duration is known) end ≤ duration.
4. Click **Done editing** when finished. Corrections persist
   immediately.

Storage shape (`localStorage.hifibuddy_timing_overrides`):

```json
{
  "lesson-001": {
    "0:15-0:55": "1:30-2:00",
    "0:55-1:15": "2:00-2:30"
  }
}
```

Keys are the canonical lesson timestamps; values are your corrections.

### Export / Import

Once you have at least one correction, an **Export corrections (N)**
button appears. Clicking it downloads:

```json
{
  "version": 1,
  "exportedAt": "2026-04-25T14:32:10.000Z",
  "totalCorrections": 5,
  "lessons": {
    "lesson-001": { "0:15-0:55": "1:30-2:00" },
    "lesson-007": { "1:00-1:30": "1:05-1:35" }
  }
}
```

This file is meant to be sent upstream — the maintainer can use these
to validate and fold the corrections into the canonical
`data/hifi-guide.json`.

In edit mode, an **Import** button appears that accepts the same JSON
shape (and also the raw `{lessonId: {...}}` shape). Imports merge on
top of existing overrides; new value wins on conflict.

Corrections are honored everywhere a timestamp is read — click-to-seek,
ABX segment matching, the highlighted-current-segment tracker, the
duration-mismatch check.

---

## The Listening Coach chat

A collapsible chat panel inside the lesson sidebar. Powered by the
Claude API, scoped to the current lesson — the system prompt includes
the track, album, skills, and timestamps so its answers are concretely
about what you're hearing.

Useful for:
- "I can't hear the imaging in the opening section. What am I missing?"
- "My HD600s are bright. Will they exaggerate or hide what I'm trying
  to hear here?"
- "Compare this to a Steve Wilson remaster — would I hear something
  different?"

Three pre-seeded quick chips below the input:
- **Focus tips** — "What should I focus on right now?"
- **Lossless vs lossy** — "I can't hear the difference between lossless
  and compressed. Help me."
- **Equipment advice** — "What equipment upgrades would help me hear
  more detail?"

Requires the Claude API key (Settings → Claude AI). Without it, the
panel still appears but the input is disabled.

The Coach used to occasionally answer in raw JSON — a bug fixed in the
standalone build. If you ever see that happen, your bundle is stale;
use Diagnostics → Force Update.

The Coach is the **only** chat surface in the app. The earlier global
chat FAB was removed.

---

## Per-skill progress tracking

The **Skill Progress** button on the dashboard opens a per-skill grid.
Each card shows:

- The skill icon, name, and color.
- A "completed/total" count of lessons teaching that skill.
- A bar showing your progress.
- The skill's full description and tip.
- A list of lessons that teach the skill — completed ones with a
  checkmark.

Click any lesson in the list to open it directly.

How scores work:
- Marking a lesson "Completed" gives +1 to each of that lesson's skills.
- A lesson that teaches Soundstage and Imaging contributes to both
  scores.
- Skill bars are normalized against the maximum score, so the
  most-completed skill maxes at 100% and others scale relative to it.

If your "Bass Quality" bar is high but "Air & Space" is low, your next
session should probably be Lessons 4, 14, 15, 17, or 19.

---

## The 30 lessons (full table)

| ID | Title | Artist | Year | Track | Difficulty | Skills |
|---|---|---|---|---|---|---|
| L001 | Your First Soundstage | Dire Straits | 1985 | Money for Nothing | Beginner | Soundstage, Imaging |
| L002 | The Art of Detail | Steely Dan | 1977 | Aja | Beginner | Detail, Tonal Color |
| L003 | Feeling the Dynamics | Fleetwood Mac | 1977 | The Chain | Beginner | Dynamics, Bass |
| L004 | Space Between the Notes | Norah Jones | 2002 | Don't Know Why | Beginner | Air, Imaging |
| L005 | Deep Bass Done Right | Daft Punk | 2013 | Giorgio by Moroder | Beginner | Bass, Transients |
| L006 | Layered Complexity | Radiohead | 1997 | Let Down | Intermediate | Separation, Layering |
| L007 | Vocal Textures | Jeff Buckley | 1994 | Hallelujah | Intermediate | Tonal Color, Detail, Air |
| L008 | The Weight of Atmosphere | Massive Attack | 1998 | Teardrop | Intermediate | Bass, Air, Layering |
| L009 | Precision and Transparency | Miles Davis | 1959 | So What | Intermediate | Imaging, Transients, Separation |
| L010 | Classical Grandeur | Carlos Kleiber / Vienna Philharmonic | 1976 | Symphony No. 7 — II. Allegretto | Advanced | Soundstage, Dynamics, Layering |
| L011 | Electronic Precision | Boards of Canada | 1998 | Roygbiv | Advanced | Transients, Bass, Separation |
| L012 | The Live Experience | Diana Krall | 2002 | I Love Being Here With You | Advanced | Soundstage, Dynamics, Air, Imaging |
| L013 | Hip-Hop Production Basics | Nas | 1994 | N.Y. State of Mind | Beginner | Bass, Transients, Layering |
| L014 | Acoustic Recording Purity | Nick Drake | 1972 | Pink Moon | Beginner | Air, Tonal Color, Detail |
| L015 | Female Vocal Excellence | Eva Cassidy | 1996 | Fields of Gold | Beginner | Tonal Color, Dynamics, Air |
| L016 | Electronic Textures | Aphex Twin | 1992 | Xtal | Intermediate | Layering, Bass, Air |
| L017 | Jazz Piano Intimacy | Bill Evans Trio | 1961 | Waltz for Debby | Intermediate | Imaging, Air, Detail |
| L018 | Metal Dynamics | Tool | 2001 | Lateralus | Intermediate | Dynamics, Bass, Transients |
| L019 | Singer-Songwriter Clarity | Joni Mitchell | 1971 | A Case of You | Intermediate | Tonal Color, Detail, Air |
| L020 | R&B Warmth | D'Angelo | 2000 | Untitled (How Does It Feel) | Intermediate | Bass, Layering, Tonal Color |
| L021 | Post-Rock Build | Sigur Rós | 2002 | Untitled #3 (Samskeyti) | Intermediate | Dynamics, Soundstage, Layering |
| L022 | Reggae Space | Bob Marley & The Wailers | 1977 | Jamming | Intermediate | Imaging, Bass, Separation |
| L023 | Country Storytelling | Johnny Cash | 2002 | Hurt | Intermediate | Tonal Color, Detail, Dynamics |
| L024 | Binaural Recording (audiophile-only) | Various Artists (Chesky) | 2013 | Magnificat — Amber Rubarth | Advanced | Soundstage, Imaging, Air |
| L025 | Direct-to-Disc (audiophile-only) | Jim Keltner / Ron Tutt (Sheffield) | 1981 | Track 1 — Jim Keltner | Advanced | Transients, Dynamics, Detail |
| L026 | Tube vs Solid-State | Ahmad Jamal Trio | 1958 | Poinciana | Advanced | Tonal Color, Detail |
| L027 | Vinyl Mastering | King Crimson | 1969 | 21st Century Schizoid Man | Advanced | Dynamics, Bass, Tonal Color |
| L028 | High-Res vs CD | Neil Young | 1972 | Heart of Gold | Advanced | Detail, Air, Soundstage |
| L029 | Spatial Audio Pioneer | Yosi Horikawa | 2012 | Bubbles | Advanced | Imaging, Soundstage, Separation |
| L030 | The Perfect Recording | Patricia Barber | 1994 | Nardis | Advanced | Imaging, Tonal Color, Air, Detail |

---

## Recording venues

Lessons whose tracks were recorded in iconic studios, halls, or clubs now
show a photo of the room itself, with a short caption about the acoustic
and a CC-licensed attribution. Currently 10 lessons carry a venue card:

  - **L006 Layered Complexity** — Radiohead, "Let Down" — *St Catherine's Court*, Bath, England.
  - **L009 Precision and Transparency** — Miles Davis, "So What" — *30th Street Studio (Adams Memorial Church)*, New York City, USA.
  - **L010 Classical Grandeur** — Carlos Kleiber / Vienna Philharmonic, "Symphony No. 7 — II. Allegretto" — *Musikverein, Goldener Saal*, Vienna, Austria.
  - **L012 The Live Experience** — Diana Krall, "I Love Being Here With You" — *L'Olympia*, Paris, France.
  - **L015 Female Vocal Excellence** — Eva Cassidy, "Fields of Gold" — *Blues Alley*, Washington, D.C., USA.
  - **L017 Jazz Piano Intimacy** — Bill Evans Trio, "Waltz for Debby" — *Village Vanguard*, New York City, USA.
  - **L020 R&B Warmth** — D'Angelo, "Untitled (How Does It Feel)" — *Electric Lady Studios*, New York City, USA.
  - **L022 Reggae Space** — Bob Marley & The Wailers, "Jamming" — *Island Studios (Basing Street)*, Notting Hill, London, UK.
  - **L023 Country Storytelling** — Johnny Cash, "Hurt" — *Cash Cabin Studio*, Hendersonville, Tennessee, USA.
  - **L026 Tube vs Solid-State** — Ahmad Jamal Trio, "Poinciana" — *Pershing Hotel Lounge*, Chicago, Illinois, USA.

The room is part of every recording — when a lesson note talks about
"the natural reverb of L'Olympia" or "the wood-and-gold acoustic of the
Musikverein," seeing the actual hall makes the spatial language click.
Each venue block in `data/hifi-guide.json` carries `name`, `location`,
optional `year` and `type` (studio / concert-hall / club / home-studio /
…), a short prose `caption`, and an `image` with `url`, `thumbnailUrl`,
`alt`, plus a CC-license `attribution`.

The venue card sits between the album info card and the play row so the
photo is the first thing you see after the album art — a deliberate
priming cue for the spatial guidance that follows.

---

## Audiophile-only pressings (lessons 24/25)

Lessons 24 (*The Ultimate Headphone Demonstration Disc* by Chesky) and
25 (*The Sheffield Drum Record*, direct-to-disc) are reference
recordings deliberately not licensed to streaming.

Practical consequences:

- **No Spotify button** — `lesson.track.audiophilePressing === true`
  suppresses the Spotify action.
- **No ABX test** — `lesson.abx.skip === true`. There's no point if
  you only have one source.
- **Plex or Local is the only realistic source.** Buy or rip the
  physical media (or buy a download from HDtracks/Chesky's store).
- **YouTube is iffy** — bootleg uploads exist but are poor quality
  re-rips that defeat the purpose.

If you don't own these, skip the two lessons. The other 28 are still
plenty.

---

## Equipment recommendations

The dashboard's header reads:

> Best experienced with: lossless audio (FLAC/CD) + open-back
> headphones (HD560s, HD600)

That's a serious recommendation, not marketing copy:

- **Open-back headphones** (Sennheiser HD560s, HD600, HD650, HD800S;
  Beyerdynamic DT880/DT990; HiFiMan Sundara/Edition XS; AKG K712)
  produce a wider, more natural soundstage than closed-back. The
  soundstage and imaging skills are *much* easier to hear on
  open-backs.
- **Source quality** dominates everything else. A $200 open-back fed
  by a Plex FLAC stream will reveal more detail than a $2,000
  closed-back fed by Spotify Free.
- **A neutral DAC + amp** matters less than people think for these
  lessons, but a DAC/amp like the iFi Zen DAC, Schiit Modi/Magni
  stack, or a JDS Atom is plenty.
- **Speakers** also work. The lessons aren't headphone-exclusive —
  they emphasize headphones because most users will be on them, but
  near-field studio monitors in a treated room are arguably better for
  soundstage and depth.

What does *not* matter:
- Cable upgrades.
- 24/192 hi-res over 16/44.1 (Lesson 28 explicitly addresses this with
  ABX).
- "Audiophile" Ethernet switches.

If you're new to this, the path is: lossless source first, then
headphones, then a basic DAC/amp, then maybe a higher-end pair of
headphones much later. The lessons will tell you when you're hitting
your equipment's ceiling.

---

## Lesson 1 timestamp note

Earlier builds of HiFi Buddy had Lesson 1 (*Money for Nothing*) keyed
to the **4:08 radio edit** by accident. Many "What to Listen For"
timestamps fell outside the radio edit's runtime, and the
duration-mismatch warning fired more or less constantly.

That's been fixed. Lesson 1 is now firmly tied to the **8:26 album
version on Brothers in Arms (1985), Bob Ludwig master**. The
`versionNote` calls this out explicitly. The 4:08 radio edit will
trip the duration-mismatch banner; switch sources or pin the album
version with the [Track Variant Picker](#track-variant-picker).

If you saved any timing-feedback corrections against the old (radio
edit) layout, they'll be wrong against the album version. Clear them
via Settings → Backup & Restore (export, edit out the Lesson 1
overrides, re-import) or by toggling Edit timing on Lesson 1 and
clearing each item.

---

## Where to go next

- The lessons themselves — start with Lesson 1.
- [INTEGRATIONS.md](./INTEGRATIONS.md) — full Plex, Spotify, Local FLAC,
  Claude, Ollama setup.
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — when something breaks.
- [USER_GUIDE.md](./USER_GUIDE.md) — the rest of the app (Reference
  Library, Stats, settings backup, the Diagnostics panel).

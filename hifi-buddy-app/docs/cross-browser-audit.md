# HiFi Buddy — Cross-Browser Audit

Date: 2026-04-25
Scope: standalone app at `hifi-buddy-app/` (16 JS modules + service worker + 1 HTML + 1 CSS file).
Audit target: code that has only been exercised on Mac Chrome / Mac Safari, expected to also run on Firefox, iOS Safari, Android Chrome, and (best-effort) older Safari/Edge.

---

## Summary

**Headline counts: 2 blocking, 7 degraded, 4 cosmetic, 5 safe-to-ignore.**

| # | Severity | Area | Browser(s) | File | Status |
|---|----------|------|------------|------|--------|
| 1 | Blocking | Spotify Web Playback SDK on mobile | iOS Safari, Android Chrome | `js/spotify.js` | **Patched** — bail-out + clean log instead of hung SDK |
| 2 | Blocking | `crypto.subtle` on http:// origins | Firefox, Safari (any non-HTTPS dev) | `js/spotify.js:286-292` | **Patched** — explicit error message |
| 3 | Degraded | `AudioContext.resume()` not awaited | Safari (incl. iOS) | `js/abx.js:50` | **Patched** — defensive promise-catch + retry on next gesture |
| 4 | Degraded | `decodeAudioData` legacy callback form | Safari < 14.1 | `js/abx.js:60` | **Patched** — fallback to callback API |
| 5 | Degraded | `getByteFrequencyData` mid-teardown race | Firefox, Safari | `js/visualizer.js:659` | **Patched** — try/catch wraps frame |
| 6 | Degraded | Service Worker auto-update on iOS PWA | iOS Safari (added-to-home-screen) | `service-worker.js`, `index.html:103-108` | **Wave 2** — needs update prompt UX |
| 7 | Degraded | localStorage reset by Safari ITP | iOS Safari | every settings/cache key | **OK** — already wrapped in try/catch with cold-start fallbacks |
| 8 | Degraded | `<input type="file" accept="">` ignored on iOS | iOS Safari | `js/lesson-generator.js:800`, `js/settings.js:232`, `js/hifi-buddy.js:188` | **Wave 2** — move accept logic to JS validation |
| 9 | Degraded | `MediaElementSource` x crossOrigin race | Firefox, Safari | `js/visualizer.js:480-488` | **OK** — already defended with logged warning |
| 10 | Cosmetic | Missing `-webkit-backdrop-filter` prefix | Safari < 18 | `styles.css:1083` | **Wave 2** — CSS is do-not-modify |
| 11 | Cosmetic | `:has()` selector | Safari < 15.4, Firefox < 121 | `styles.css:4052` | **Wave 2** — graceful (no border highlight on old browsers) |
| 12 | Cosmetic | `color-mix()` | Safari < 16.2, Firefox < 113 | `styles.css` x 17 sites | **Wave 2** — graceful (falls back to inherited bg/border) |
| 13 | Cosmetic | Grid `auto-fill` consistency | All current browsers | `styles.css` x 8 sites | **OK** — auto-fill is universally supported since 2017 |
| 14 | Safe-to-ignore | `URL.createObjectURL` for Blob downloads | All current browsers | `js/settings.js:349`, `js/hifi-buddy.js:258` | **OK** — supported everywhere targeted |
| 15 | Safe-to-ignore | `FileReader.readAsText` | All current browsers | `js/lesson-generator.js:830` | **OK** |
| 16 | Safe-to-ignore | `crypto.getRandomValues` | All current browsers | `js/spotify.js:281` | **OK** — universal (non-subtle) crypto |
| 17 | Safe-to-ignore | `padStart`, optional chaining, nullish coalescing | All current browsers | many | **OK** — ES2020 baseline is fine for our targets |
| 18 | Safe-to-ignore | Drag-and-drop / File System Access | n/a | n/a | **OK** — codebase does not use them |

---

## Detailed findings

### 1. Spotify Web Playback SDK on mobile  —  Blocking  —  PATCHED

**Browsers**: iOS Safari (any version), Android Chrome.
**File**: `js/spotify.js` (originally `initPlayer` at line 324; SDK auto-load at line 128 / `handleCallback`).

**Problem**: The official Spotify Web Playback SDK only supports desktop Chrome/Firefox/Edge/Safari ≥ 11. On mobile, `sdk.scdn.co/spotify-player.js` loads but cannot acquire a device — it sits in a "ready"-never-fires state, and the user sees the "Connect Spotify" button with no error.

**Patch**: Added `isLikelyMobile()` (UA + `navigator.maxTouchPoints` for iPadOS spoofing) and `isPlaybackSDKSupported()` (also checks for `MediaSource`). `initPlayer()` now early-returns `null` and logs a clean reason. The auth flow still works — the user gets a token; they just won't see the in-browser player. PKCE callers (`hifi-buddy.js renderSpotifyAction`) already gracefully fall back to the open-in-Spotify search link when the player isn't ready, so this is now a clean degradation path.

**Recommendation for Wave 2**: Surface a dismissible toast on mobile devices when the user clicks "Connect Spotify" explaining that they should use the Spotify mobile app instead, and offer the "Transfer Playback" path via `MusicTripSpotify.transferPlayback()` (already implemented).

---

### 2. `crypto.subtle` on non-secure origins  —  Blocking  —  PATCHED

**Browsers**: Firefox (any version), Safari (any version) on `http://` origins; Chrome is more permissive on localhost.
**File**: `js/spotify.js` `sha256Base64url`.

**Problem**: `crypto.subtle` is only exposed in secure contexts (HTTPS or `localhost`). PKCE auth used `crypto.subtle.digest('SHA-256', ...)` directly. On a LAN-served `http://192.168.x.x:8080/` dev URL (a common audiophile pattern — running the server on a NAS), Firefox/Safari users would see PKCE silently fail.

**Patch**: Explicit guard with a human-readable error (`'Spotify PKCE requires a secure context (https:// or localhost). Use Client Credentials auth or serve over HTTPS.'`). Also replaced `String.fromCharCode(...new Uint8Array(hash))` with an explicit loop (defensive — irrelevant for 32-byte SHA-256 but flagged in audit literature for very large arrays).

---

### 3. `AudioContext.resume()` not awaited  —  Degraded  —  PATCHED

**Browsers**: All Safari (incl. iOS Safari), affecting ABX comparator.
**File**: `js/abx.js:45-52` (`ensureCtx`).

**Problem**: Safari requires `AudioContext.resume()` to be called from a user gesture and the returned promise to be handled. The original code did `audioCtx.resume()` and discarded the promise. On iOS Safari the first ABX play occasionally produced silence until a second click.

**Patch**: Wrapped resume in a try/catch and attached a no-op `.catch()` to the returned promise, with a comment documenting that all play paths re-enter `ensureCtx()` so a failed resume self-heals on the next user gesture. We deliberately do NOT await the resume here because `playSelection()` needs the synchronous `ctx.currentTime` reference to schedule the gain ramps.

---

### 4. `decodeAudioData` legacy callback form  —  Degraded  —  PATCHED

**Browsers**: Safari < 14.1 (April 2021) — relevant for users on older iPads or Mac Mojave/Big Sur with frozen Safari.
**File**: `js/abx.js:60` (`fetchAndDecode`).

**Problem**: The promise form of `decodeAudioData` was added to Safari in 14.1. Older Safari rejects the call (or returns `undefined` from `await`) and ABX would error before any audio plays.

**Patch**: Promise form is tried first; on rejection, fall back to the callback form. We pass `arrBuf.slice(0)` to the callback form because some Safari versions detach the buffer on the first failed call.

---

### 5. `getByteFrequencyData` mid-teardown race  —  Degraded  —  PATCHED

**Browsers**: Firefox, Safari.
**File**: `js/visualizer.js:659`.

**Problem**: When the user toggles the visualizer off (or switches lessons) while a frame is in flight, `analyser` can be in a disconnected state and Firefox throws `InvalidStateError`. The rAF loop dies silently and the visualizer becomes a black box until the page is reloaded.

**Patch**: Wrapped the call in try/catch and `return` from the frame on failure. The next `startLoop()` call re-enters cleanly.

---

### 6. Service Worker auto-update on iOS PWA  —  Degraded  —  Wave 2

**Browsers**: iOS Safari standalone PWA (add-to-home-screen).
**File**: `service-worker.js`, `index.html:103-108`.

**Problem**: iOS Safari aggressively caches the service worker file itself. When `service-worker.js` changes (e.g. `CACHE_NAME` bump from `hifibuddy-v3` to `v4`), the iOS PWA may keep serving the old worker for hours. The current registration code does not call `registration.update()` on a schedule and there's no in-app prompt when a new version is detected.

**Recommendation**: In `index.html`'s registration block, listen for `reg.waiting` and surface a "New version available — tap to refresh" toast. Service worker file is do-not-modify, so this fix has to live in `index.html` registration code (also do-not-modify) — explicitly flagged for Wave 2 review.

---

### 7. Safari ITP wipes localStorage  —  Degraded  —  OK

**Browsers**: iOS Safari, macOS Safari with strict ITP.
**Files**: every module that uses localStorage.

**Problem**: After 7 days of no first-party interaction, Safari's Intelligent Tracking Prevention purges localStorage for the origin. Users would lose their Spotify/Plex tokens, ABX history, equipment settings, lesson progress, timing corrections.

**Status**: All read paths I audited already handle missing/corrupt localStorage gracefully:

- `js/abx.js:212-237` — try/catch on read & write.
- `js/visualizer.js:78-101` — try/catch wrapping every read/write.
- `js/spotify.js:23-40` — try/catch wrapping cache load/save; missing token simply triggers re-auth.
- `js/timing-feedback.js:35-65` — try/catch with empty-object fallback.
- `js/lesson-generator.js:56-78` — try/catch with array fallback.
- `js/settings.js:27` — `localStorage.getItem(key) || ''` — would throw if `localStorage` itself is `null` (private browsing on old iOS), but works with the empty/string fallbacks downstream. A `SecurityError` on `localStorage` access is theoretically possible in iOS private mode but extremely rare in 2026.
- `js/onboarding.js:29` — same pattern.
- `js/hifi-buddy.js` — 23 sites, all wrapped in try/catch.

The user's loss of Spotify token / Plex token after 7 days is annoying but not breaking — both modules detect missing tokens and prompt re-auth.

**Recommendation**: Display a one-time "Your settings may be cleared after 7 days of inactivity in iOS Safari — install as PWA for permanent storage" notice in onboarding. Wave 2.

---

### 8. iOS Safari ignores `<input type="file" accept="">`  —  Degraded  —  Wave 2

**Browsers**: iOS Safari (any).
**Files**:
- `js/lesson-generator.js:800` — `accept=".json"` for proposed-lessons import
- `js/settings.js:232` — `accept="application/json"` for settings backup restore
- `js/hifi-buddy.js:188` — `accept="application/json"` for timing-corrections import

**Problem**: iOS Safari frequently shows "Take Photo / Photo Library / Browse..." regardless of `accept`, and on file pick can hand back any file type. If a user picks a non-JSON file, downstream `JSON.parse` throws.

**Status**: Each handler already does `try { JSON.parse(text) }` and surfaces a status error. The user will see a confusing file picker UI but won't crash the app.

**Recommendation for Wave 2**: Add an explicit `if (!file.name.endsWith('.json') && file.type !== 'application/json')` early bailout with a friendly message. This is in scope as a JS-only patch, but the scope of the audit deferred it because it changes UX behavior (e.g. would block users with `.txt` files containing valid JSON who would today succeed).

---

### 9. `MediaElementSource` × `crossOrigin` race  —  Degraded  —  OK

**Browsers**: Firefox, Safari (Chrome is more lenient).
**File**: `js/visualizer.js:478-488`.

**Problem**: For `createMediaElementSource()` to produce non-silent FFT data when the `<audio>` element streams from any origin (including same-origin reverse-proxied), `crossOrigin='anonymous'` MUST be set before the `src` is assigned. The audio-player module sets `audio.src = url` immediately on `play()`, so by the time visualizer attaches (via `setTimeout(..., 0)` at `hifi-buddy.js:1714` and `:1980`), the src is already set.

**Status**: The visualizer already implements the right defensive logic — it sets crossOrigin if the src is unset OR if `readyState === 0`, and logs a console warning when neither is true. In practice, the `setTimeout(0)` handoff usually hits before the audio element starts loading, but on slower devices or on Firefox this race is real.

**Recommendation for Wave 2**: Have audio-player.js set `audio.crossOrigin = 'anonymous'` once at construction (line 24, `audio = new Audio()`). That guarantees the visualizer's spectrum is always live. NOT applied as a patch in this wave because (a) audio-player.js is owned by the audio team and (b) setting crossOrigin globally requires CORS headers from Plex/local-library endpoints — a server-side concern outside the scope of a defensive client patch.

---

### 10. Missing `-webkit-backdrop-filter`  —  Cosmetic  —  Wave 2

**Browsers**: Safari < 18 (still common). Chrome and Firefox use the unprefixed property.
**File**: `styles.css:1083`.

```css
.modal-overlay {
    backdrop-filter: blur(4px);   /* unprefixed */
}
```

Other backdrop-filter sites (lines 3868, 3951) correctly include `-webkit-backdrop-filter`. The settings/lesson-gen modal overlay will not blur on Safari < 18.

**Recommendation**: Add `-webkit-backdrop-filter: blur(4px);` to `.modal-overlay`. Since `styles.css` is do-not-modify in this wave, flagged for Wave 2.

---

### 11. `:has()` selector  —  Cosmetic  —  Wave 2

**File**: `styles.css:4052` — `.ob-radio:has(input:checked) { ... }` (onboarding "What kind of headphones" step).

**Browsers**: Safari 15.4+, Firefox 121+, Chrome 105+. Older Firefox (a fraction of users in 2026 still on ESR 115) will not show the purple highlight on the selected radio card.

**Status**: Degrades to "no special highlight on selected card" — radio button itself still works (it's a real `<input type="radio">`).

---

### 12. `color-mix()`  —  Cosmetic  —  Wave 2

**File**: `styles.css` — 17 sites (genre badges, mood buttons, skill cards, equipment chips, ABX result cards).

**Browsers**: Safari 16.2+, Firefox 113+, Chrome 111+. Users on older browsers get the value-fallback (the `var(--mood-color, var(--accent-color))` part) without the alpha mixing.

**Status**: Each `color-mix()` site has a sensible fallback colour because the surrounding `var()` declarations fire when `color-mix()` is parsed-but-unsupported (browsers drop the entire declaration). Worst case: skill cards lose their tinted background but text + border still render. No interactive flow is impacted.

---

### 13. Grid `auto-fill`  —  Cosmetic  —  OK

**File**: `styles.css` — 8 sites (`cards-grid`, `albums-grid`, `mood-grid`, `journey-cards`, `hifi-skills-grid`, two more in onboarding).

`auto-fill` has been universally supported since 2017. No issues.

---

### 14. `URL.createObjectURL` for Blob downloads  —  Safe-to-ignore  —  OK

**Files**: `js/settings.js:349` (settings backup), `js/hifi-buddy.js:258` (timing-corrections export).

Both call `URL.createObjectURL(blob)` → click an anchor → `URL.revokeObjectURL`. iOS Safari 13+ supports this. On older iOS the download will open in a new tab; not blocking.

---

### 15. `FileReader.readAsText`  —  Safe-to-ignore  —  OK

**File**: `js/lesson-generator.js:830`.

Standard FileReader. Universally supported.

---

### 16. `crypto.getRandomValues`  —  Safe-to-ignore  —  OK

**File**: `js/spotify.js:281`. Used for PKCE verifier randomness. Available in all browsers we target (it does NOT require a secure context, unlike `crypto.subtle`).

---

### 17. ES2020 baseline (`padStart`, `?.`, `??`, async/await)  —  Safe-to-ignore  —  OK

The codebase relies on `padStart` (12+ sites), optional chaining (heavy use), nullish coalescing, async/await, BigInt-free template literals. All supported in Safari 14+, Firefox 78+, Chrome 80+. Within our target browser matrix.

---

### 18. Drag-and-drop / File System Access  —  Safe-to-ignore  —  OK

Searched: no `dataTransfer`, no `dragover`, no `showOpenFilePicker`, no `webkitGetAsEntry`. Confirmed unused.

---

## Patches applied

### `js/abx.js` (+ ~25 LOC)
- `ensureCtx()` — defensive `AudioContext` constructor + `.catch()` on `resume()` promise (CROSS-BROWSER comments)
- `fetchAndDecode()` — fall back to callback form of `decodeAudioData()` on Safari < 14.1

### `js/spotify.js` (+ ~30 LOC)
- New `isLikelyMobile()` and `isPlaybackSDKSupported()` helpers
- `initPlayer()` — early-return on mobile / unsupported environments + try/catch around `ensureSDK`
- `sha256Base64url()` — explicit secure-context guard with friendly error message + safer Uint8Array → string conversion

### `js/visualizer.js` (+ 8 LOC)
- `draw()` — try/catch around `getByteFrequencyData` to survive teardown races

### Total
- **3 files patched, ~63 LOC added**, all annotated with `// CROSS-BROWSER:` comments.
- Every patch is purely defensive — adds fallback paths or graceful degradation; removes nothing; changes no public API.

---

## Manual test plan

**Goal**: Verify HiFi Buddy works on the four target browsers in under 30 minutes per browser.

### Common pre-conditions

1. Clone the app to a machine with the Plex server reachable and `local-library` populated.
2. In `Settings`, populate Plex URL+token AND a Spotify Client ID.
3. (Tester sanity) Confirm no console errors on initial load.

### Test matrix per browser

For each browser (Mac Chrome [baseline], Mac Safari, Mac Firefox, iOS Safari, Android Chrome):

#### Block A — Audio playback (≈8 min)

- [ ] Open lesson `lesson-001` — confirm tile renders, click Plex play button.
- [ ] Verify audio starts within 3s.
- [ ] Click "Spectrum" toggle — confirm visualizer shows live FFT bars, not the "unavailable" fallback (mobile may legitimately show fallback if audio is Spotify SDK).
- [ ] Pause, scrub to 1:00 via a `listenFor` segment click — confirm `audio.currentTime` advances.
- [ ] Console should be free of errors.

#### Block B — ABX comparator (≈6 min)

- [ ] On a lesson with an `abx` block, click ABX. Confirm modal opens.
- [ ] Confirm "Loading lossless source…" appears, then trial UI renders within ~10s.
- [ ] Click A, then B, then X buttons — confirm gapless switching (no audible re-buffer between clicks).
- [ ] Make 3 guesses. Confirm scoreboard updates.
- [ ] On Safari/iOS specifically: confirm first click reliably plays audio (no silent first attempt).
- [ ] On Safari < 14.1 (if available): confirm decode succeeds (callback fallback).

#### Block C — Spotify (≈5 min)

- [ ] On desktop browsers: click "Connect Spotify" — PKCE flow opens, redirects back, "Connected" appears.
- [ ] Click a lesson's Spotify play button. On desktop with Premium → in-browser playback. On mobile → expect graceful "Set up Spotify" or fallback link, NO hung loading state. Console should log "Web Playback SDK is not supported on this browser/device".
- [ ] If serving over `http://`: Firefox/Safari users clicking PKCE → expect a clean error toast referencing "secure context", not a silent failure.

#### Block D — Storage / backup (≈4 min)

- [ ] Settings → Download Backup. Confirm a `.json` file downloads in the browser's download UI.
- [ ] Settings → Restore from File... Confirm file picker opens (on iOS, may not respect `.json` filter — expected).
- [ ] Open a lesson, edit a timing override, then Export corrections. Confirm download works.
- [ ] Re-load the page. Confirm equipment / lesson progress / Spotify token survive across reloads.

#### Block E — Service worker / offline (≈4 min)

- [ ] First load: confirm `[SW] Registered` log line.
- [ ] Reload with DevTools → Network → Offline. Confirm app still loads with cached lessons.
- [ ] Online again — confirm "Offline" indicator clears.
- [ ] iOS Safari only: Add to Home Screen, launch from icon, confirm splash + standalone display.

#### Block F — CSS visual sanity (≈3 min)

- [ ] Open settings modal — confirm overlay blur is visible (Safari < 18 may render flat black; this is the cosmetic finding #10).
- [ ] Open onboarding (`?onboarding=1`) — confirm the headphones-type radio cards highlight on selection (Safari 15.4+ / Firefox 121+ only).
- [ ] Confirm equipment badges in the Reference Library show tinted backgrounds (`color-mix` — Safari 16.2+ / Firefox 113+).

### Pass/fail criteria

- **Pass**: Blocks A + B + D + E pass on all five browsers, with mobile gracefully showing fallbacks for Spotify SDK.
- **Pass with caveats**: Block F has cosmetic differences on older Safari/Firefox — flag for Wave 2 CSS prefix/fallback work.
- **Fail**: Any console error that breaks subsequent flows, or any silent broken state (e.g. Spotify connect button disappearing into nothingness on mobile).

---

## Wave 2 follow-up checklist

- [ ] **CSS prefixes**: add `-webkit-backdrop-filter` at `styles.css:1083`.
- [ ] **CSS fallbacks**: audit `:has()` and `color-mix()` sites — provide a basic non-tinted fallback for Safari < 16.2 / Firefox < 113 / older Edge.
- [ ] **Mobile Spotify UX**: surface a toast on iOS/Android when the user clicks "Connect Spotify" explaining the SDK limitation and offering Spotify Connect / mobile-app fallback.
- [ ] **`accept=""` validation** in JS (file extension/type check before `JSON.parse`).
- [ ] **Service worker update prompt** in `index.html` registration block.
- [ ] **Audio-player crossOrigin** — set `audio.crossOrigin = 'anonymous'` at construction in `js/audio-player.js:init()` so the visualizer is reliable on Firefox/Safari.
- [ ] **iOS Safari add-to-home-screen** — verify manifest is correct, splash screens load, status-bar style is correct.
- [ ] **Touch targets** — `js/visualizer.js` cog/close buttons are 22px square; mobile a11y minimum is 44pt.
- [ ] **localStorage 7-day notice** in onboarding for iOS Safari users.

---
*Generated 2026-04-25 by cross-browser audit pass.*

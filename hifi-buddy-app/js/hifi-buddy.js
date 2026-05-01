/**
 * HiFi Buddy — main app module
 * Curated audiophile listening guide — learn critical listening skills
 * with reference recordings and timestamped guidance.
 */
window.HiFiBuddyApp = (() => {
    'use strict';

    let guideData = null;
    let genreData = null;
    let containerEl = null;
    let navigateCallback = null;

    // State
    let currentView = 'dashboard'; // dashboard | lesson | skills
    let currentLessonId = null;
    let activeFilter = 'all'; // all | beginner | intermediate | advanced
    let progress = { completedLessons: [], skillScores: {} };
    let playbackTracker = null; // interval ID for tracking audio position
    let coachMessages = [];      // listening coach chat history
    let coachVisible = false;
    let abMode = false;          // A/B comparison active
    let abSources = { lossless: null, lossy: null };
    let abCurrent = 'lossless';  // which source is currently playing
    // ---- Plex cache (two-layer) ----
    // Layer A (long-lived metadata, keyed by plexUrlHash → trackKey):
    //   { ratingKey, title, artist, album, thumb, codec, bitrate, mbid, partKey, cachedAt }
    // Layer B (token-scoped streamUrls, keyed by plexTokenHash → trackKey):
    //   <streamUrl>
    // Layer A survives token rotation. Layer B is rebuilt locally from Layer A
    // whenever the token changes, with no Plex round-trip.
    let plexMatches = {};        // trackKey → matchEntry (Layer A, current URL hash)
    let plexStreams = {};        // trackKey → streamUrl  (Layer B, current token hash)
    let plexUrlHashCurrent = ''; // hash of plexUrl
    let plexTokenHashCurrent = ''; // hash of plexToken
    let prefetchInProgress = false;
    let prefetchProgress = { done: 0, total: 0 };
    let activeSource = null;     // 'plex' | 'spotify' | null — drives seek + tracker
    let spotifyState = null;     // last known SDK state (for tracker + duration check)
    let spotifyLessonUriCache = null; // { lessonId: { uri, durationMs, cachedAt } } — lazy-loaded

    const STORAGE_KEY = 'hifibuddy_hifi_progress';
    const PLEX_MATCHES_KEY = 'hifibuddy_hifi_plex_matches';   // Layer A
    const PLEX_STREAMS_KEY = 'hifibuddy_hifi_plex_streams';   // Layer B
    const PLEX_LEGACY_KEY  = 'hifibuddy_hifi_plex_cache';     // pre-split, drained on first load
    const SPOTIFY_LESSON_URIS_KEY = 'hifibuddy_spotify_lesson_uris';
    const SPOTIFY_URI_TTL_MS = 90 * 24 * 60 * 60 * 1000;       // 90 days
    const DIFFICULTY_COLORS = {
        beginner: '#667eea',
        intermediate: '#e6a817',
        advanced: '#e05555'
    };
    const DIFFICULTY_LABELS = {
        beginner: 'Beginner',
        intermediate: 'Intermediate',
        advanced: 'Advanced'
    };

    // ==================== EQUIPMENT TAGS ====================

    function getEquipmentTags() {
        return {
            headphoneType: window.HiFiBuddySettings?.getEquipmentHeadphoneType?.() || '',
            formatPref: window.HiFiBuddySettings?.getEquipmentFormatPref?.() || '',
        };
    }

    // Map a user's stored headphone type to the tag tokens used in segment.bestRevealedBy / weakOn.
    function headphoneTypeTokens(headphoneType) {
        if (!headphoneType || headphoneType === 'unknown') return [];
        // The user's broad type maps to the bucketed tokens used in the data file.
        const map = {
            'open-back': ['open-back'],
            'closed-back': ['closed-back', 'closed-back-budget'],
            'iem': ['iem', 'bass-shy-iem'],
            'planar': ['planar', 'open-back'],
        };
        return map[headphoneType] || [];
    }

    function formatPrefTokens(formatPref) {
        if (!formatPref || formatPref === 'unknown') return { lossless: false, lossy: false, set: false };
        if (formatPref === 'flac') return { lossless: true, lossy: false, set: true };
        return { lossless: false, lossy: true, set: true };
    }

    function headphoneLabel(headphoneType) {
        return ({
            'open-back': 'open-back headphones',
            'closed-back': 'closed-back headphones',
            'iem': 'IEMs',
            'planar': 'planar magnetic headphones',
        })[headphoneType] || 'your gear';
    }

    function escAttr(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Render a small venue card under the album card on the lesson page.
    // Shows a Wikimedia-Commons-licensed photo of the iconic studio/hall/club
    // where the track was recorded, with caption and attribution.
    // Returns '' when the lesson has no venue.image (most lessons).
    function renderVenueCard(lesson) {
        const venue = lesson && lesson.venue;
        if (!venue || !venue.image || !venue.image.url) return '';
        const img = venue.image;
        const src = img.thumbnailUrl || img.url;
        const VENUE_TYPE_LABEL = {
            'concert-hall': 'concert hall',
            'studio': 'recording studio',
            'jazz-club': 'jazz club',
            'church': 'church',
            'home-studio': 'home studio',
            'other': 'venue',
        };
        const typeLabel = VENUE_TYPE_LABEL[venue.type] || 'venue';
        const metaParts = [venue.location];
        if (venue.year) metaParts.push(String(venue.year));
        metaParts.push(typeLabel);
        const meta = metaParts.join(' · ');
        return `
            <div class="hifi-venue-card">
                <figure class="hifi-venue-figure">
                    <img class="hifi-venue-img"
                         src="${escAttr(src)}"
                         alt="${escAttr(img.alt)}"
                         loading="lazy" decoding="async"
                         referrerpolicy="no-referrer"
                         onerror="this.closest('.hifi-venue-card').style.display='none'">
                </figure>
                <div class="hifi-venue-body">
                    <div class="hifi-venue-name">${venue.name}</div>
                    <div class="hifi-venue-loc">${meta}</div>
                    <p class="hifi-venue-caption">${venue.caption}</p>
                    <p class="hifi-venue-attr">Photo: <a href="${escAttr(img.sourceUrl)}" target="_blank" rel="noopener noreferrer">${img.author}</a> &middot; ${img.license}</p>
                </div>
            </div>
        `;
    }

    function renderEquipmentBadge(segment) {
        const eq = getEquipmentTags();
        const bestFor = Array.isArray(segment.bestRevealedBy) ? segment.bestRevealedBy : [];
        const weakOn = Array.isArray(segment.weakOn) ? segment.weakOn : [];
        const note = segment.headphoneNote || '';

        const hpTokens = headphoneTypeTokens(eq.headphoneType);
        const fmt = formatPrefTokens(eq.formatPref);
        const anySet = hpTokens.length > 0 || fmt.set;

        if (!anySet) return '';

        const hpMatchesBest = hpTokens.some(t => bestFor.includes(t));
        const hpMatchesWeak = hpTokens.some(t => weakOn.includes(t));

        const CHECK_SVG = HiFiBuddyIcons.check({ size: 14, strokeWidth: 2.5 });
        const WARN_SVG = HiFiBuddyIcons.warning({ size: 14 });
        if (hpMatchesBest) {
            return `<span class="hifi-equip-badge hifi-equip-badge-good" title="${escAttr(note)}">${CHECK_SVG} Ideal for your ${headphoneLabel(eq.headphoneType)}</span>`;
        }
        if (hpMatchesWeak) {
            return `<span class="hifi-equip-badge hifi-equip-badge-warn" title="${escAttr(note)}">${WARN_SVG} This passage may be subtle on ${headphoneLabel(eq.headphoneType)}</span>`;
        }
        if (fmt.set && bestFor.includes('lossless') && fmt.lossy) {
            return `<span class="hifi-equip-badge hifi-equip-badge-warn" title="${escAttr(note)}">${WARN_SVG} Best heard on a lossless source</span>`;
        }
        if (note) {
            return `<span class="hifi-equip-badge hifi-equip-badge-info">${escAttr(note)}</span>`;
        }
        return '';
    }

    // ==================== TIMING FEEDBACK (per-segment overrides) ====================

    // Resolve the time string to display for a given segment. Honors the
    // user's saved override; falls back to the canonical (lesson-data) time.
    function getDisplayTime(lesson, segment) {
        if (typeof HiFiBuddyTimingFeedback === 'undefined' || !lesson || !segment) {
            return segment?.time;
        }
        return HiFiBuddyTimingFeedback.getOverride(lesson.id, segment.time) || segment.time;
    }

    // Best-effort lookup of track duration in seconds for validation.
    // Falls back to undefined when we can't determine it (validation skips the cap).
    function getLessonDurationSecs(lesson) {
        // Prefer live audio element if it knows the duration.
        const audioEl = document.querySelector('audio');
        if (audioEl && audioEl.duration && isFinite(audioEl.duration)) {
            return audioEl.duration;
        }
        // Spotify state cache (last known)
        if (spotifyState && spotifyState.duration) {
            return spotifyState.duration / 1000;
        }
        // Fallback: canonical "M:SS" string from lesson metadata.
        const dur = lesson?.track?.duration;
        if (typeof dur === 'string') {
            const parts = dur.split(':').map(p => parseInt(p, 10));
            if (parts.length === 2 && parts.every(n => !isNaN(n))) return parts[0] * 60 + parts[1];
            if (parts.length === 3 && parts.every(n => !isNaN(n))) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
        return undefined;
    }

    // Top-of-list controls: edit-mode toggle + export button (visible when overrides exist).
    function renderListenControls() {
        if (typeof HiFiBuddyTimingFeedback === 'undefined') return '';
        const editing = HiFiBuddyTimingFeedback.isEditMode();
        const total = HiFiBuddyTimingFeedback.countOverrides();
        const PENCIL_SVG = HiFiBuddyIcons.edit({ size: 14 });
        const DOWNLOAD_SVG = HiFiBuddyIcons.download({ size: 14 });
        const UPLOAD_SVG = HiFiBuddyIcons.upload({ size: 14 });
        return `
            <div class="hifi-listen-controls">
                <button class="hifi-edit-timing-btn ${editing ? 'is-active' : ''}" id="hifiEditTimingBtn" title="Toggle timing-correction mode" aria-pressed="${editing ? 'true' : 'false'}">
                    ${PENCIL_SVG}
                    <span>${editing ? 'Done editing' : 'Edit timing'}</span>
                </button>
                ${editing ? '<span class="hifi-edit-pill" role="status">Editing</span>' : ''}
                <button class="hifi-export-corrections-btn" id="hifiExportCorrectionsBtn" title="Export your timing corrections as JSON" aria-label="Export timing corrections as JSON" style="${total > 0 ? '' : 'display:none'}">
                    ${DOWNLOAD_SVG}
                    <span>Export corrections (${total})</span>
                </button>
                <button class="hifi-import-corrections-btn" id="hifiImportCorrectionsBtn" title="Import timing corrections from JSON" aria-label="Import timing corrections from JSON" style="${editing ? '' : 'display:none'}">
                    ${UPLOAD_SVG}
                    <span>Import</span>
                </button>
                <input type="file" id="hifiImportCorrectionsFile" accept="application/json" style="display:none">
            </div>
        `;
    }

    // Per-segment edit row (only rendered; visibility is controlled by container class).
    function renderListenEditRow(segment, displayTime) {
        const CHEVRON_UP = HiFiBuddyIcons.chevronUp({ size: 14 });
        const CHEVRON_DOWN = HiFiBuddyIcons.chevronDown({ size: 14 });
        const RESET_SVG = HiFiBuddyIcons.reset({ size: 14 });
        return `
            <div class="hifi-listen-edit-row" data-original-time="${segment.time}">
                <input type="text" class="hifi-listen-time-input"
                       value="${displayTime}"
                       pattern="\\d{1,2}:\\d{2}-\\d{1,2}:\\d{2}"
                       placeholder="M:SS-M:SS"
                       aria-label="Corrected time range" />
                <button class="hifi-listen-mark hifi-listen-mark-start" data-side="start" title="Set start to current playback time" aria-label="Mark start at current playback time">${CHEVRON_UP}<span>Start</span></button>
                <button class="hifi-listen-mark hifi-listen-mark-end" data-side="end" title="Set end to current playback time" aria-label="Mark end at current playback time">${CHEVRON_DOWN}<span>End</span></button>
                <button class="hifi-listen-reset" title="Reset to canonical time" aria-label="Reset to canonical time">${RESET_SVG}</button>
                <span class="hifi-listen-original" title="Canonical time from the lesson">Canonical: ${segment.time}</span>
            </div>
        `;
    }

    // Replace half of an "M:SS-M:SS" range with the supplied seconds. If the
    // input was empty/invalid, prefills the other side: start+30s for "start",
    // start (input minus 30s, clamped to 0) for "end".
    function applyMark(currentRangeStr, side, seconds) {
        const TF = HiFiBuddyTimingFeedback;
        const fmt = TF._utils.formatTimestamp;
        const parsed = TF._utils.parseRange(currentRangeStr);
        const newTs = fmt(seconds);
        if (!parsed) {
            if (side === 'start') {
                return `${newTs}-${fmt(seconds + 30)}`;
            }
            return `${fmt(Math.max(0, seconds - 30))}-${newTs}`;
        }
        if (side === 'start') {
            const end = parsed.end > seconds ? parsed.end : seconds + 30;
            return `${newTs}-${fmt(end)}`;
        }
        const start = parsed.start < seconds ? parsed.start : Math.max(0, seconds - 30);
        return `${fmt(start)}-${newTs}`;
    }

    // Wire up all timing-feedback controls inside containerEl for the given lesson.
    function wireTimingFeedback(lesson) {
        if (typeof HiFiBuddyTimingFeedback === 'undefined') return;
        const TF = HiFiBuddyTimingFeedback;
        const toast = (window.HiFiBuddyToast) || null;

        // Reflect current edit-mode state on the container so CSS can theme it.
        const applyEditClass = () => {
            containerEl.classList.toggle('hifi-edit-timing-active', TF.isEditMode());
        };
        applyEditClass();

        // Edit mode toggle
        containerEl.querySelector('#hifiEditTimingBtn')?.addEventListener('click', () => {
            TF.toggleEditMode();
            // Re-render only the controls + edit-state class (full re-render is fine and simpler).
            renderLesson(lesson.id);
        });

        // Export
        containerEl.querySelector('#hifiExportCorrectionsBtn')?.addEventListener('click', () => {
            const dump = TF.exportAll();
            const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const dateStr = new Date().toISOString().slice(0, 10);
            a.href = url;
            a.download = `hifi-buddy-timing-corrections-${dateStr}-${dump.totalCorrections}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            toast?.success(`Exported ${dump.totalCorrections} corrections`);
        });

        // Import
        const importBtn = containerEl.querySelector('#hifiImportCorrectionsBtn');
        const importFile = containerEl.querySelector('#hifiImportCorrectionsFile');
        importBtn?.addEventListener('click', () => importFile?.click());
        importFile?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            // CROSS-BROWSER: iOS Safari ignores `accept="application/json"`.
            // Reject obviously-non-JSON picks before parsing.
            const looksJson = /\.json$/i.test(file.name) || (file.type && /json/i.test(file.type));
            if (!looksJson) {
                toast?.error('Please choose a .json file.');
                e.target.value = '';
                return;
            }
            try {
                const text = await file.text();
                const count = TF.importAll(text);
                toast?.success(`Imported ${count} corrections`);
                renderLesson(lesson.id);
            } catch (err) {
                toast?.error(`Import failed: ${err.message}`);
            } finally {
                e.target.value = '';
            }
        });

        // Per-segment edit rows
        const durationSecs = getLessonDurationSecs(lesson);
        containerEl.querySelectorAll('.hifi-listen-edit-row').forEach(row => {
            const originalTime = row.dataset.originalTime;
            const input = row.querySelector('.hifi-listen-time-input');

            const saveFromInput = () => {
                const value = (input.value || '').trim();
                input.classList.remove('is-invalid');
                if (!value) {
                    // Empty = reset to canonical
                    TF.clearOverride(lesson.id, originalTime);
                    toast?.info(`Reset ${originalTime}`);
                    renderLesson(lesson.id);
                    return;
                }
                try {
                    TF.setOverride(lesson.id, originalTime, value, { durationSecs });
                    toast?.success(`Saved: ${originalTime} → ${value}`);
                    renderLesson(lesson.id);
                } catch (err) {
                    input.classList.add('is-invalid');
                    input.title = err.message;
                    toast?.error(err.message);
                }
            };

            input?.addEventListener('blur', saveFromInput);
            input?.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    saveFromInput();
                }
            });
            // Stop click from bubbling to the listen-item (which would seek)
            input?.addEventListener('click', ev => ev.stopPropagation());

            row.querySelectorAll('.hifi-listen-mark').forEach(btn => {
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const side = btn.dataset.side;
                    const secs = getCurrentTimeSecs();
                    const next = applyMark(input.value, side, secs);
                    input.value = next;
                    // Validate + persist immediately so the displayed time updates.
                    try {
                        TF.setOverride(lesson.id, originalTime, next, { durationSecs });
                        toast?.success(`Saved: ${originalTime} → ${next}`);
                        renderLesson(lesson.id);
                    } catch (err) {
                        input.classList.add('is-invalid');
                        input.title = err.message;
                        toast?.error(err.message);
                    }
                });
            });

            row.querySelector('.hifi-listen-reset')?.addEventListener('click', (ev) => {
                ev.stopPropagation();
                TF.clearOverride(lesson.id, originalTime);
                toast?.info(`Reset to canonical: ${originalTime}`);
                renderLesson(lesson.id);
            });

            // Avoid bubbling clicks from the row to the seek handler.
            row.addEventListener('click', ev => ev.stopPropagation());
        });
    }

    // ==================== INIT ====================

    function init(genres) {
        genreData = genres;
        loadProgress();
        // Initialize the frequency visualizer module (it stays hidden until the user toggles it)
        if (typeof HiFiBuddyVisualizer !== 'undefined') {
            try { HiFiBuddyVisualizer.init(); } catch (e) { console.warn('[HiFi] visualizer init failed:', e); }
        }
        // Re-evaluate Plex cache when settings change. Layer A (metadata) is keyed
        // by URL only; Layer B (streamUrls) is keyed by token. So a token rotation
        // wipes Layer B but leaves Layer A intact — all 30 lesson tiles stay
        // populated and the Plex play button works on first click via
        // rebuildStreamUrl(matchEntry, plexUrl, newToken). A URL change wipes
        // Layer A under the old hash but other servers' entries (different URL
        // hashes) survive in storage.
        window.addEventListener('hifibuddy-settings-changed', () => {
            const newUrlHash = getPlexUrlHash();
            const newTokenHash = getPlexTokenHash();
            if (newUrlHash !== plexUrlHashCurrent) {
                plexMatches = {};
                if (plexUrlHashCurrent) {
                    // Drop the old URL's matches but keep entries for other URLs.
                    try {
                        const all = JSON.parse(localStorage.getItem(PLEX_MATCHES_KEY) || '{}');
                        delete all[plexUrlHashCurrent];
                        localStorage.setItem(PLEX_MATCHES_KEY, JSON.stringify(all));
                    } catch { /* ignore */ }
                }
                plexUrlHashCurrent = newUrlHash;
                if (newUrlHash) {
                    try {
                        const all = JSON.parse(localStorage.getItem(PLEX_MATCHES_KEY) || '{}');
                        plexMatches = all[newUrlHash] || {};
                    } catch { /* ignore */ }
                }
            }
            if (newTokenHash !== plexTokenHashCurrent) {
                plexStreams = {};
                if (plexTokenHashCurrent) {
                    try {
                        const all = JSON.parse(localStorage.getItem(PLEX_STREAMS_KEY) || '{}');
                        delete all[plexTokenHashCurrent];
                        localStorage.setItem(PLEX_STREAMS_KEY, JSON.stringify(all));
                    } catch { /* ignore */ }
                }
                plexTokenHashCurrent = newTokenHash;
            }
            prefetchInProgress = false;
        });
    }

    async function ensureData() {
        if (guideData) return;
        try {
            const resp = await fetch('/data/hifi-guide.json');
            guideData = await resp.json();
            // Apply any timestamp corrections saved from admin tool
            applyTimestampFixes();
            mergeUserLessons();
        } catch (e) {
            console.error('HiFi Buddy: Failed to load guide data', e);
        }
    }

    // Pull AI-generated lessons out of localStorage and append them to the
    // in-memory guideData. Idempotent: existing user lessons (by id) are
    // refreshed in place. Built-in lessons are never replaced.
    function mergeUserLessons() {
        if (!guideData?.lessons) return;
        if (typeof HiFiBuddyLessonGenerator === 'undefined') return;
        const userLessons = HiFiBuddyLessonGenerator.listUserLessons() || [];
        // Strip prior generated entries, then re-insert
        guideData.lessons = guideData.lessons.filter(l => !l.generated);
        for (const ul of userLessons) {
            // Defensive: ensure flag is set
            ul.generated = true;
            guideData.lessons.push(ul);
        }
    }

    function applyTimestampFixes() {
        if (!guideData?.lessons) return;
        try {
            const fixes = JSON.parse(localStorage.getItem('hifibuddy_hifi_timestamp_fixes') || '{}');
            for (const lesson of guideData.lessons) {
                if (fixes[lesson.id] && Array.isArray(fixes[lesson.id])) {
                    lesson.guide.listenFor = fixes[lesson.id];
                }
            }
            const fixCount = Object.keys(fixes).length;
            if (fixCount > 0) console.log(`[HiFi] Applied timestamp fixes for ${fixCount} lessons`);
        } catch (e) { /* ignore */ }
    }

    function loadProgress() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                progress = {
                    completedLessons: saved.completedLessons || [],
                    skillScores: saved.skillScores || {}
                };
            }
        } catch (e) { /* ignore */ }
    }

    function saveProgress() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
        } catch (e) { /* ignore */ }
    }

    // ==================== PLEX CACHE (TWO-LAYER) ====================

    function _hashStr(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
        return Math.abs(h).toString(36);
    }

    function getPlexUrlHash() {
        const url = (typeof HiFiBuddySettings !== 'undefined' && HiFiBuddySettings.getPlexUrl?.()) || '';
        if (!url) return '';
        return 'pu_' + _hashStr(url);
    }

    function getPlexTokenHash() {
        const token = (typeof HiFiBuddySettings !== 'undefined' && HiFiBuddySettings.getPlexToken?.()) || '';
        if (!token) return '';
        return 'pt_' + _hashStr(token);
    }

    // Back-compat shim: callers ask "is Plex configured?" via this. We require
    // both URL + token (matches old getPlexHash semantics).
    function getPlexHash() {
        const u = getPlexUrlHash();
        const t = getPlexTokenHash();
        return (u && t) ? (u + '|' + t) : '';
    }

    // Pull the partKey portion out of a stream URL produced by HiFiBuddyPlex.
    // Direct stream looks like: /api/plex-stream/library/parts/123/file.flac?plexUrl=…&plexToken=…
    // Transcoded looks like:    /api/plex-stream/music/:/transcode/…&plexUrl=…&plexToken=…
    // We extract everything between the prefix and the first plexUrl/plexToken
    // query-param marker. The leading slash is preserved on the saved partKey.
    function extractPartKeyFromStreamUrl(streamUrl) {
        if (!streamUrl || typeof streamUrl !== 'string') return null;
        const prefix = '/api/plex-stream/';
        const i = streamUrl.indexOf(prefix);
        if (i < 0) return null;
        let tail = streamUrl.slice(i + prefix.length);
        // Strip plexUrl/plexToken (they may be introduced with `?` or `&`).
        const cut = tail.search(/[?&]plex(Url|Token)=/);
        if (cut >= 0) tail = tail.slice(0, cut);
        // Re-prepend leading slash so the rebuilder's `replace(/^\//,'')` is a no-op.
        return '/' + tail;
    }

    // Rebuild a stream URL from a Layer A entry + the current token, no network.
    // For direct-play parts (FLAC/MP3/etc) the partKey is /library/parts/…; for
    // transcoded fallbacks the partKey embeds its own `?path=…` query, so we
    // pick `&plexUrl=` vs `?plexUrl=` based on what's already present.
    function rebuildStreamUrl(matchEntry, plexUrl, plexToken) {
        if (!matchEntry?.partKey || !plexUrl || !plexToken) return null;
        const path = matchEntry.partKey.replace(/^\//, '');
        const sep = path.includes('?') ? '&' : '?';
        return `/api/plex-stream/${path}${sep}plexUrl=${encodeURIComponent(plexUrl)}&plexToken=${encodeURIComponent(plexToken)}`;
    }

    // Strip a Plex search/cache result down to the long-lived Layer A shape.
    function buildMatchEntry(result) {
        if (!result) return null;
        const q = result.quality || {};
        return {
            ratingKey: result.ratingKey || null,
            title:     result.title || '',
            artist:    result.artist || '',
            album:     result.album || '',
            thumb:     result.thumb || '',
            codec:     q.codec || result.codec || '',
            bitrate:   q.bitrate || result.bitrate || 0,
            // Hi-res fields — persisted so the Source Quality card is accurate
            // across reloads without re-fetching /library/metadata every time.
            bitDepth:    q.bitDepth || 0,
            sampleRate:  q.sampleRate || 0,
            channels:    q.channels || 2,
            container:   q.container || '',
            mbid:        result.mbid || result.musicbrainzId || '',
            partKey:     extractPartKeyFromStreamUrl(result.streamUrl),
            cachedAt:    Date.now(),
        };
    }

    function migrateLegacyPlexCache(urlHash) {
        try {
            const raw = localStorage.getItem(PLEX_LEGACY_KEY);
            if (!raw) return 0;
            const legacy = JSON.parse(raw);
            const tracks = legacy?.tracks || {};
            if (!urlHash) {
                // Without a current Plex URL we can't index the legacy entries.
                // Drop the legacy blob anyway so it doesn't keep firing.
                localStorage.removeItem(PLEX_LEGACY_KEY);
                return 0;
            }
            // Read existing Layer A so we don't clobber other URL hashes.
            const all = JSON.parse(localStorage.getItem(PLEX_MATCHES_KEY) || '{}');
            const bucket = all[urlHash] || {};
            let imported = 0;
            for (const [k, v] of Object.entries(tracks)) {
                if (!v) continue; // skip cached misses
                if (bucket[k]) continue; // already migrated
                const entry = buildMatchEntry(v);
                if (!entry) continue;
                bucket[k] = entry;
                imported++;
            }
            all[urlHash] = bucket;
            localStorage.setItem(PLEX_MATCHES_KEY, JSON.stringify(all));
            localStorage.removeItem(PLEX_LEGACY_KEY);
            console.log(`[HiFi] Migrated ${imported} legacy plex cache entries to two-layer schema.`);
            return imported;
        } catch (e) {
            console.warn('[HiFi] Legacy plex cache migration failed:', e);
            return 0;
        }
    }

    function loadPlexCache() {
        plexUrlHashCurrent = getPlexUrlHash();
        plexTokenHashCurrent = getPlexTokenHash();

        // One-shot migration from the old single-blob cache.
        if (localStorage.getItem(PLEX_LEGACY_KEY)) {
            migrateLegacyPlexCache(plexUrlHashCurrent);
        }

        // Layer A
        try {
            const all = JSON.parse(localStorage.getItem(PLEX_MATCHES_KEY) || '{}');
            plexMatches = (plexUrlHashCurrent && all[plexUrlHashCurrent]) || {};
        } catch { plexMatches = {}; }

        // Layer B
        try {
            const all = JSON.parse(localStorage.getItem(PLEX_STREAMS_KEY) || '{}');
            plexStreams = (plexTokenHashCurrent && all[plexTokenHashCurrent]) || {};
        } catch { plexStreams = {}; }

        const aCount = Object.keys(plexMatches).length;
        const bCount = Object.keys(plexStreams).length;
        if (aCount || bCount) {
            console.log(`[HiFi] Loaded Plex cache: ${aCount} matches, ${bCount} stream URLs`);
        }
    }

    function savePlexMatches() {
        if (!plexUrlHashCurrent) return;
        try {
            const all = JSON.parse(localStorage.getItem(PLEX_MATCHES_KEY) || '{}');
            all[plexUrlHashCurrent] = plexMatches;
            localStorage.setItem(PLEX_MATCHES_KEY, JSON.stringify(all));
        } catch (e) { /* ignore */ }
    }

    function savePlexStreams() {
        if (!plexTokenHashCurrent) return;
        try {
            const all = JSON.parse(localStorage.getItem(PLEX_STREAMS_KEY) || '{}');
            all[plexTokenHashCurrent] = plexStreams;
            localStorage.setItem(PLEX_STREAMS_KEY, JSON.stringify(all));
        } catch (e) { /* ignore */ }
    }

    // Back-compat: persist both layers in one call, for sites that touched the
    // old savePlexCache().
    function savePlexCache() {
        savePlexMatches();
        savePlexStreams();
    }

    function trackCacheKey(title, artist) {
        return (artist + '|' + title).toLowerCase().replace(/[^a-z0-9|]/g, '');
    }

    // Validate that a cached match actually corresponds to the lesson's request.
    // Older cache writes (before the artist-required scoring rule) could have
    // stored a wrong-artist match — e.g., "Hallelujah Money" by Gorillaz cached
    // under the request for "Hallelujah" by Jeff Buckley. Detect and reject.
    function cachedMatchIsValid(match, requestedTitle, requestedArtist) {
        if (!match) return false;
        const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const nReqTitle  = norm(requestedTitle);
        const nReqArtist = norm(requestedArtist);
        const nMatchTitle  = norm(match.title);
        const nMatchArtist = norm(match.artist);
        if (!nMatchTitle || !nMatchArtist || !nReqTitle || !nReqArtist) return false;
        const titleOk  = nMatchTitle.includes(nReqTitle)  || nReqTitle.includes(nMatchTitle);
        const artistOk = nMatchArtist.includes(nReqArtist) || nReqArtist.includes(nMatchArtist);
        return titleOk && artistOk;
    }

    // ---- Spotify lesson-URI cache (persistent across reloads) ----
    // Schema: { [lessonId]: { uri, durationMs, cachedAt } }
    // URIs are stable globally so we don't token-scope them. A 90-day TTL is a
    // conservative guard against the (rare) case where Spotify retires a URI.
    function loadSpotifyLessonUriCache() {
        if (spotifyLessonUriCache) return spotifyLessonUriCache;
        try {
            const raw = localStorage.getItem(SPOTIFY_LESSON_URIS_KEY);
            spotifyLessonUriCache = raw ? (JSON.parse(raw) || {}) : {};
        } catch {
            spotifyLessonUriCache = {};
        }
        return spotifyLessonUriCache;
    }

    function saveSpotifyLessonUriCache() {
        try {
            localStorage.setItem(
                SPOTIFY_LESSON_URIS_KEY,
                JSON.stringify(spotifyLessonUriCache || {})
            );
        } catch { /* ignore */ }
    }

    function getSpotifyLessonUri(lessonId) {
        const cache = loadSpotifyLessonUriCache();
        const entry = cache[lessonId];
        if (!entry?.uri) return null;
        // Staleness check
        if (entry.cachedAt && (Date.now() - entry.cachedAt) > SPOTIFY_URI_TTL_MS) {
            delete cache[lessonId];
            saveSpotifyLessonUriCache();
            return null;
        }
        return entry;
    }

    function setSpotifyLessonUri(lessonId, uri, durationMs) {
        const cache = loadSpotifyLessonUriCache();
        cache[lessonId] = { uri, durationMs, cachedAt: Date.now() };
        saveSpotifyLessonUriCache();
    }

    // Cache a fresh Plex search result by splitting it across both layers.
    function cachePlexResult(key, result) {
        if (!key || !result) return;
        const entry = buildMatchEntry(result);
        if (!entry) return;
        plexMatches[key] = entry;
        savePlexMatches();
        if (result.streamUrl && plexTokenHashCurrent) {
            plexStreams[key] = result.streamUrl;
            savePlexStreams();
        }
    }

    // Resolve a cached track. Layer A hit + Layer B miss → rebuild streamUrl
    // synchronously (no Plex round-trip) and populate Layer B.
    function getCachedTrack(title, artist) {
        const key = trackCacheKey(title, artist);
        const match = plexMatches[key];
        if (!match) return null;

        // Validate: did the cached entry actually match the request? Older
        // cache writes (looser scoring) could store a wrong-artist match.
        // If invalid, evict and force a fresh search.
        if (!cachedMatchIsValid(match, title, artist)) {
            console.warn(`[HiFi] Evicting stale cache entry for "${title}" by "${artist}" — cached match was "${match.title}" by "${match.artist}".`);
            delete plexMatches[key];
            delete plexStreams[key];
            savePlexMatches();
            savePlexStreams();
            return null;
        }

        let streamUrl = plexStreams[key];
        if (!streamUrl) {
            const url = HiFiBuddySettings?.getPlexUrl?.() || '';
            const token = HiFiBuddySettings?.getPlexToken?.() || '';
            streamUrl = rebuildStreamUrl(match, url, token);
            if (streamUrl) {
                plexStreams[key] = streamUrl;
                savePlexStreams();
            }
        }
        return {
            streamUrl: streamUrl || null,
            title: match.title,
            artist: match.artist,
            album: match.album,
            ratingKey: match.ratingKey,
            thumb: match.thumb,
            quality: {
                codec:      match.codec,
                bitrate:    match.bitrate,
                bitDepth:   match.bitDepth || 0,
                sampleRate: match.sampleRate || 0,
                channels:   match.channels || 2,
                container:  match.container || '',
            },
            mbid: match.mbid,
            partKey: match.partKey,
            // Surface staleness flag so callers can self-heal — entries cached
            // before the hi-res schema update don't have bitDepth/sampleRate.
            needsEnrichment: !match.bitDepth && !match.sampleRate,
        };
    }

    async function prefetchAllTracks() {
        if (prefetchInProgress || !guideData) return;
        const hash = getPlexHash();
        if (!hash) return; // Plex not configured

        // Check what's missing from cache
        const missing = [];
        for (const lesson of guideData.lessons) {
            const key = trackCacheKey(lesson.track.title, lesson.album.artist);
            if (!plexMatches[key]) {
                missing.push({ title: lesson.track.title, artist: lesson.album.artist, key });
            }
        }

        if (missing.length === 0) {
            console.log('[HiFi] All tracks already cached');
            updatePrefetchUI(guideData.lessons.length, guideData.lessons.length);
            return;
        }

        prefetchInProgress = true;
        prefetchProgress = { done: guideData.lessons.length - missing.length, total: guideData.lessons.length };
        updatePrefetchUI(prefetchProgress.done, prefetchProgress.total);
        console.log(`[HiFi] Pre-fetching ${missing.length} tracks from Plex...`);

        // Throttled: 2 concurrent searches
        const concurrency = 2;
        let idx = 0;

        async function next() {
            while (idx < missing.length) {
                const item = missing[idx++];
                try {
                    const result = await HiFiBuddyPlex.searchTrack(item.title, item.artist);
                    if (result) {
                        cachePlexResult(item.key, result);
                    }
                    // Misses are intentionally NOT cached — the legacy code wrote
                    // a `null` sentinel under the same key, but with the
                    // two-layer schema we'd need to mark misses explicitly to
                    // avoid confusing getCachedTrack(). Cheap re-search on a
                    // miss is acceptable; it only happens on track-not-found.
                } catch (e) {
                    console.warn(`[HiFi] Prefetch failed for "${item.title}":`, e);
                }
                prefetchProgress.done++;
                updatePrefetchUI(prefetchProgress.done, prefetchProgress.total);
                // Save periodically (every 5 tracks)
                if (prefetchProgress.done % 5 === 0) savePlexCache();
            }
        }

        const workers = [];
        for (let i = 0; i < concurrency; i++) workers.push(next());
        await Promise.all(workers);

        savePlexCache();
        prefetchInProgress = false;
        console.log(`[HiFi] Prefetch complete: ${Object.keys(plexMatches).length} tracks matched`);
    }

    function updatePrefetchUI(done, total) {
        const el = containerEl?.querySelector('#hifiPlexCacheStatus');
        if (!el) return;
        const cached = Object.keys(plexMatches).length;
        if (done >= total) {
            el.innerHTML = `${HiFiBuddyIcons.check({ size: 14 })} ${cached} tracks ready`;
            el.className = 'hifi-plex-cache-status hifi-cache-done';
        } else {
            const pct = Math.round((done / total) * 100);
            el.innerHTML = `<div class="hifi-cache-progress-bar"><div class="hifi-cache-progress-fill" style="width:${pct}%"></div></div> Indexing ${done}/${total}`;
            el.className = 'hifi-plex-cache-status hifi-cache-loading';
        }
    }

    function getCacheStatusText() {
        const cached = Object.keys(plexMatches).length;
        if (cached > 0) return `${HiFiBuddyIcons.check({ size: 14 })} ${cached} tracks ready`;
        return 'Connecting...';
    }

    // ==================== RENDER ====================

    async function render(container, onNavigate) {
        containerEl = container;
        navigateCallback = onNavigate;
        await ensureData();

        if (!guideData) {
            containerEl.innerHTML = '<div class="hifi-error">Failed to load HiFi Buddy data.</div>';
            return;
        }

        // Load Plex cache and start background prefetch
        loadPlexCache();
        if (getPlexHash()) {
            // Kick off background prefetch after a short delay (don't block render)
            setTimeout(() => prefetchAllTracks(), 500);
        }

        if (currentView === 'lesson' && currentLessonId) {
            renderLesson(currentLessonId);
        } else if (currentView === 'skills') {
            renderSkillsOverview();
        } else {
            renderDashboard();
        }
    }

    // ==================== DASHBOARD ====================

    function renderDashboard() {
        currentView = 'dashboard';
        const totalLessons = guideData.lessons.length;
        const completed = progress.completedLessons.length;
        const pct = totalLessons > 0 ? Math.round((completed / totalLessons) * 100) : 0;

        containerEl.innerHTML = `
            <div class="hifi-dashboard">
                <div class="hifi-header">
                    <div class="hifi-header-icon">${HiFiBuddyIcons.headphones({ size: 28 })}</div>
                    <h2 class="hifi-title">HiFi Buddy</h2>
                    <p class="hifi-subtitle">Develop your critical listening skills with curated reference recordings</p>
                    <p class="hifi-equip-note">Best experienced with: <strong>lossless audio (FLAC/CD)</strong> + <strong>open-back headphones (HD560s, HD600)</strong></p>
                </div>

                <div class="hifi-progress-overview">
                    <div class="hifi-progress-stats">
                        <div class="hifi-stat">
                            <span class="hifi-stat-value">${completed}</span>
                            <span class="hifi-stat-label">Completed</span>
                        </div>
                        <div class="hifi-stat">
                            <span class="hifi-stat-value">${totalLessons}</span>
                            <span class="hifi-stat-label">Total Lessons</span>
                        </div>
                        <div class="hifi-stat">
                            <span class="hifi-stat-value">${getSkillsLearned()}</span>
                            <span class="hifi-stat-label">Skills Explored</span>
                        </div>
                    </div>
                    <div class="hifi-progress-bar-wrap">
                        <div class="hifi-progress-bar">
                            <div class="hifi-progress-fill" style="width: ${pct}%"></div>
                        </div>
                        <span class="hifi-progress-pct">${pct}%</span>
                    </div>
                </div>

                ${getPlexHash() ? `
                <div class="hifi-plex-cache-row">
                    ${HiFiBuddyIcons.libraryShelves({ size: 16 })}
                    <span>Plex Library</span>
                    <span class="hifi-plex-cache-status" id="hifiPlexCacheStatus">${getCacheStatusText()}</span>
                </div>
                ` : ''}

                <div class="hifi-nav-row">
                    <button class="hifi-skill-overview-btn" id="hifiSkillsBtn">
                        ${HiFiBuddyIcons.barChart({ size: 16 })}
                        Skill Progress
                    </button>
                    <div class="hifi-filter-tabs">
                        ${['all', 'beginner', 'intermediate', 'advanced'].map(f => `
                            <button class="hifi-filter-tab ${activeFilter === f ? 'active' : ''}" data-filter="${f}"
                                    ${f !== 'all' ? `style="--tab-color: ${DIFFICULTY_COLORS[f]}"` : ''}>
                                ${f === 'all' ? 'All' : DIFFICULTY_LABELS[f]}
                            </button>
                        `).join('')}
                    </div>
                </div>

                <div class="hifi-generate-row">
                    <button class="hifi-generate-btn" id="hifiGenerateBtn" title="Use AI to write a custom lesson for any track">
                        ${HiFiBuddyIcons.sparkles({ size: 18, className: 'hifi-generate-sparkle' })}
                        <span>Generate New Lesson</span>
                        <span class="hifi-generate-sub">AI-composed for any track</span>
                    </button>
                </div>

                ${renderUserLessonsSection()}

                <div class="hifi-paths" id="hifiPaths">
                    ${renderPaths()}
                </div>
            </div>
        `;

        bindDashboardEvents();
    }

    // Render the "Your Generated Lessons" section above the built-in paths.
    // Hidden entirely when the user has no generated lessons yet.
    function renderUserLessonsSection() {
        const userLessons = (guideData?.lessons || []).filter(l => l.generated);
        if (userLessons.length === 0) return '';
        return `
            <div class="hifi-user-lessons">
                <div class="hifi-user-lessons-header">
                    <h3 class="hifi-user-lessons-title">
                        ${HiFiBuddyIcons.sparkle({ size: 16 })}
                        Your Generated Lessons
                    </h3>
                    <span class="hifi-user-lessons-count">${userLessons.length}</span>
                </div>
                <div class="hifi-user-lesson-list">
                    ${userLessons.map(l => renderUserLessonCard(l)).join('')}
                </div>
            </div>
        `;
    }

    function renderUserLessonCard(lesson) {
        const isComplete = progress.completedLessons.includes(lesson.id);
        const skills = (lesson.skills || [])
            .map(sid => guideData.skills.find(s => s.id === sid))
            .filter(Boolean);
        const accent = DIFFICULTY_COLORS[lesson.difficulty] || DIFFICULTY_COLORS.beginner;
        return `
            <div class="hifi-lesson-card hifi-lesson-card-user ${isComplete ? 'completed' : ''}" data-lesson="${lesson.id}">
                <div class="hifi-lesson-num" style="background: ${isComplete ? '#2ecc71' : accent}">
                    ${HiFiBuddyIcons.sparkle({ size: 14 })}
                </div>
                <div class="hifi-lesson-info">
                    <div class="hifi-lesson-title">
                        ${lesson.title}
                        <span class="hifi-generated-badge">Generated</span>
                    </div>
                    <div class="hifi-lesson-meta">
                        <span class="hifi-lesson-album">${lesson.album.artist} &mdash; "${lesson.track.title}"</span>
                    </div>
                    <div class="hifi-lesson-skills">
                        ${skills.map(s => `<span class="hifi-skill-chip" style="color: ${s.color}; border-color: ${s.color}40">${s.name}</span>`).join('')}
                    </div>
                </div>
                <button class="hifi-lesson-delete" data-delete-lesson="${lesson.id}" title="Delete this generated lesson" aria-label="Delete generated lesson: ${lesson.title}">
                    ${HiFiBuddyIcons.trash({ size: 14 })}
                </button>
                <div class="hifi-lesson-arrow">${HiFiBuddyIcons.chevronRight({ size: 16 })}</div>
            </div>
        `;
    }

    function renderPaths() {
        const paths = guideData.paths.filter(p =>
            activeFilter === 'all' || p.difficulty === activeFilter
        );

        return paths.map(path => {
            const lessons = path.lessonIds.map(id => guideData.lessons.find(l => l.id === id)).filter(Boolean);
            const pathCompleted = lessons.filter(l => progress.completedLessons.includes(l.id)).length;
            const pathPct = lessons.length > 0 ? Math.round((pathCompleted / lessons.length) * 100) : 0;

            return `
                <div class="hifi-path-card" style="--path-color: ${path.color}">
                    <div class="hifi-path-header">
                        <div class="hifi-path-info">
                            <h3 class="hifi-path-name">${path.name}</h3>
                            <p class="hifi-path-desc">${path.description}</p>
                        </div>
                        <div class="hifi-path-badge" style="background: ${path.color}20; color: ${path.color}">
                            ${DIFFICULTY_LABELS[path.difficulty]}
                        </div>
                    </div>
                    <div class="hifi-path-progress">
                        <div class="hifi-path-bar">
                            <div class="hifi-path-bar-fill" style="width: ${pathPct}%; background: ${path.color}"></div>
                        </div>
                        <span class="hifi-path-progress-text">${pathCompleted}/${lessons.length}</span>
                    </div>
                    <div class="hifi-lesson-list">
                        ${lessons.map((lesson, idx) => renderLessonCard(lesson, idx, path.color)).join('')}
                    </div>
                </div>
            `;
        }).join('');
    }

    function renderLessonCard(lesson, idx, pathColor) {
        const isComplete = progress.completedLessons.includes(lesson.id);
        const skills = lesson.skills.map(sid => guideData.skills.find(s => s.id === sid)).filter(Boolean);

        return `
            <div class="hifi-lesson-card ${isComplete ? 'completed' : ''}" data-lesson="${lesson.id}">
                <div class="hifi-lesson-num" style="background: ${isComplete ? '#2ecc71' : pathColor}">
                    ${isComplete ? HiFiBuddyIcons.check({ size: 14, strokeWidth: 3 }) : idx + 1}
                </div>
                <div class="hifi-lesson-info">
                    <div class="hifi-lesson-title">${lesson.title}</div>
                    <div class="hifi-lesson-meta">
                        <span class="hifi-lesson-album">${lesson.album.artist} &mdash; "${lesson.track.title}"</span>
                    </div>
                    <div class="hifi-lesson-skills">
                        ${skills.map(s => `<span class="hifi-skill-chip" style="color: ${s.color}; border-color: ${s.color}40">${s.name}</span>`).join('')}
                    </div>
                </div>
                <div class="hifi-lesson-arrow">${HiFiBuddyIcons.chevronRight({ size: 16 })}</div>
            </div>
        `;
    }

    function bindDashboardEvents() {
        // Filter tabs
        containerEl.querySelectorAll('.hifi-filter-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                activeFilter = tab.dataset.filter;
                renderDashboard();
            });
        });

        // Lesson cards (built-in + user). Delete button stops propagation
        // so clicking the trash icon doesn't open the lesson.
        containerEl.querySelectorAll('.hifi-lesson-card').forEach(card => {
            // a11y: role/tabindex/aria-label so keyboard users can open lessons.
            if (!card.hasAttribute('role')) {
                card.setAttribute('role', 'button');
                card.setAttribute('tabindex', '0');
                const titleEl = card.querySelector('.hifi-lesson-title');
                if (titleEl && !card.hasAttribute('aria-label')) {
                    card.setAttribute('aria-label', `Open lesson: ${titleEl.textContent.trim()}`);
                }
            }
            const open = (e) => {
                if (e.target.closest('[data-delete-lesson]')) return;
                currentLessonId = card.dataset.lesson;
                currentView = 'lesson';
                renderLesson(currentLessonId);
            };
            card.addEventListener('click', open);
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    if (e.target.closest('[data-delete-lesson]')) return;
                    e.preventDefault();
                    open(e);
                }
            });
        });

        // Delete generated lessons
        containerEl.querySelectorAll('[data-delete-lesson]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.deleteLesson;
                if (!id) return;
                if (typeof HiFiBuddyLessonGenerator === 'undefined') return;
                if (!confirm('Delete this generated lesson? This cannot be undone.')) return;
                HiFiBuddyLessonGenerator.deleteUserLesson(id);
                mergeUserLessons();
                renderDashboard();
            });
        });

        // Skills button
        containerEl.querySelector('#hifiSkillsBtn')?.addEventListener('click', () => {
            currentView = 'skills';
            renderSkillsOverview();
        });

        // AI Generate button
        containerEl.querySelector('#hifiGenerateBtn')?.addEventListener('click', () => {
            if (typeof HiFiBuddyLessonGenerator === 'undefined') {
                if (typeof HiFiBuddyToast !== 'undefined') {
                    HiFiBuddyToast.error('Lesson generator failed to load — reload the page.');
                }
                return;
            }
            HiFiBuddyLessonGenerator.open();
        });

        // Re-render dashboard when a new user lesson is created
        if (!bindDashboardEvents._listenersBound) {
            window.addEventListener('hifibuddy-user-lesson-created', () => {
                mergeUserLessons();
                if (currentView === 'dashboard') renderDashboard();
            });
            window.addEventListener('hifibuddy-track-override-changed', () => {
                if (currentView === 'lesson' && currentLessonId) renderLesson(currentLessonId);
            });
            bindDashboardEvents._listenersBound = true;
        }
    }

    // ==================== LESSON VIEW ====================

    function renderLesson(lessonId) {
        const lesson = guideData.lessons.find(l => l.id === lessonId);
        if (!lesson) return;

        const isComplete = progress.completedLessons.includes(lessonId);
        const skills = lesson.skills.map(sid => guideData.skills.find(s => s.id === sid)).filter(Boolean);
        const diffColor = DIFFICULTY_COLORS[lesson.difficulty];
        const path = guideData.paths.find(p => p.lessonIds.includes(lessonId));

        // Find next/prev in path
        let nextLessonId = null;
        let prevLessonId = null;
        if (path) {
            const idx = path.lessonIds.indexOf(lessonId);
            if (idx > 0) prevLessonId = path.lessonIds[idx - 1];
            if (idx < path.lessonIds.length - 1) nextLessonId = path.lessonIds[idx + 1];
        }

        containerEl.innerHTML = `
            <div class="hifi-lesson-view">
                <div class="hifi-lesson-nav-top">
                    <button class="hifi-back-btn" id="hifiBackBtn">
                        ${HiFiBuddyIcons.arrowLeft({ size: 18 })}
                        All Lessons
                    </button>
                    ${path ? `<span class="hifi-path-crumb" style="color: ${path.color}">${path.name}</span>` : ''}
                </div>

                <div class="hifi-lesson-hero" style="--lesson-color: ${diffColor}">
                    <div class="hifi-lesson-hero-badge" style="background: ${diffColor}20; color: ${diffColor}">
                        ${DIFFICULTY_LABELS[lesson.difficulty]}
                    </div>
                    <h2 class="hifi-lesson-hero-title">${lesson.title}</h2>
                    <div class="hifi-lesson-hero-skills">
                        ${skills.map(s => `
                            <span class="hifi-skill-badge-lg" style="background: ${s.color}15; color: ${s.color}; border-color: ${s.color}30">
                                <span class="hifi-skill-icon">${s.icon}</span> ${s.name}
                            </span>
                        `).join('')}
                    </div>
                </div>

                <div class="hifi-lesson-body">
                    <div class="hifi-lesson-main">
                        <!-- Album Info -->
                        <div class="hifi-album-card">
                            <div class="hifi-album-art-wrap">
                                <img class="hifi-album-art" src="" alt="${lesson.album.title}" style="display:none"
                                     onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                                <div class="hifi-album-vinyl">
                                    <div class="hifi-vinyl-disc" style="--vinyl-color: ${diffColor}">
                                        <div class="hifi-vinyl-label">${lesson.album.artist.substring(0, 2)}</div>
                                    </div>
                                </div>
                            </div>
                            <div class="hifi-album-details">
                                <div class="hifi-album-title">${lesson.album.title}</div>
                                <div class="hifi-album-artist">${lesson.album.artist}</div>
                                <div class="hifi-album-meta">
                                    <span>${lesson.album.year}</span>
                                    <span>&middot;</span>
                                    <span>${lesson.album.label}</span>
                                </div>
                                ${lesson.album.masteredBy ? `<div class="hifi-album-mastered">Mastered by ${lesson.album.masteredBy}</div>` : ''}
                            </div>
                        </div>

                        <!-- Venue (iconic studio/hall/club, optional per lesson) -->
                        ${renderVenueCard(lesson)}

                        <!-- Track + Play -->
                        <div class="hifi-track-card">
                            <div class="hifi-track-info">
                                <span class="hifi-track-icon">${HiFiBuddyIcons.music({ size: 14 })}</span>
                                <div>
                                    <div class="hifi-track-title">${lesson.track.title}</div>
                                    <div class="hifi-track-artist">${lesson.album.artist} &middot; ${lesson.track.duration}</div>
                                </div>
                                <span class="hifi-playback-time" id="hifiPlaybackTime"></span>
                            </div>
                            ${lesson.track.versionNote ? `<div class="hifi-track-version" title="Which version of the song this lesson teaches">${HiFiBuddyIcons.infoLines({ size: 13 })}<span>${lesson.track.versionNote}</span></div>` : ''}
                            <div class="hifi-duration-warning" id="hifiDurationWarning" style="display:none"></div>
                            <div class="hifi-playline" id="hifiPlayline" style="display:none">
                                <span class="hifi-playline-source" id="hifiPlaylineSource"></span>
                                <span class="hifi-playline-current" id="hifiPlaylineCurrent">0:00</span>
                                <div class="hifi-playline-track" id="hifiPlaylineTrack" title="Click to seek">
                                    <div class="hifi-playline-fill" id="hifiPlaylineFill"></div>
                                </div>
                                <span class="hifi-playline-total" id="hifiPlaylineTotal">0:00</span>
                            </div>
                            <div class="hifi-track-actions">
                                <button class="hifi-play-btn hifi-play-plex ${getCachedTrack(lesson.track.title, lesson.album.artist) ? 'hifi-plex-ready' : ''}" id="hifiPlayPlex" title="${getCachedTrack(lesson.track.title, lesson.album.artist) ? 'Cached — instant play' : 'Play from Plex'}">
                                    ${HiFiBuddyIcons.play({ size: 16 })}
                                    ${getCachedTrack(lesson.track.title, lesson.album.artist) ? `Plex ${HiFiBuddyIcons.check({ size: 12, strokeWidth: 3 })}` : 'Plex'}
                                </button>
                                <button class="hifi-play-btn hifi-play-local" id="hifiPlayLocal" title="Play from your local library" style="display:none">
                                    ${HiFiBuddyIcons.folder({ size: 16 })}
                                    Local
                                </button>
                                ${lesson.track.audiophilePressing ? '' : renderSpotifyAction(lesson)}
                                <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(lesson.album.artist + ' ' + lesson.track.title)}"
                                   target="_blank" rel="noopener" class="hifi-play-btn hifi-play-youtube" title="Search on YouTube">
                                    ${HiFiBuddyIcons.youtube({ size: 16 })}
                                    YouTube
                                </a>
                                <button class="hifi-play-btn hifi-play-ab" id="hifiABToggle" title="A/B compare lossless vs compressed" aria-expanded="false" aria-controls="hifiABPanel" style="display:none">
                                    ${HiFiBuddyIcons.boxCorners({ size: 14 })}
                                    A/B
                                </button>
                                ${(() => {
                                    const a = getEffectiveAbx(lesson);
                                    if (!a || a.skip) return '';
                                    const br = a.defaultBitrate || 192;
                                    return `<button class="hifi-play-btn hifi-play-abx" id="hifiABXBtn" title="Blind ABX test: can you tell FLAC from ${br}kbps MP3?">
                                        ${HiFiBuddyIcons.checkSquare({ size: 14 })}
                                        ABX
                                    </button>`;
                                })()}
                                <button class="hifi-play-btn hifi-play-spectrum" id="hifiSpectrumBtn" title="Toggle real-time frequency spectrum (works for Plex playback; Spotify SDK output is not accessible)">
                                    ${HiFiBuddyIcons.spectrum({ size: 14 })}
                                    Spectrum
                                </button>
                            </div>
                            <div class="hifi-loaded-row" id="hifiLoadedRow" style="display:none">
                                <span class="hifi-loaded-text" id="hifiLoadedText"></span>
                                <button class="hifi-choose-track-btn" id="hifiChooseTrackBtn" style="display:none">
                                    Choose track
                                    ${HiFiBuddyIcons.chevronDown({ size: 12 })}
                                </button>
                            </div>
                        </div>

                        <!-- A/B Comparison Panel (hidden until activated) -->
                        <div class="hifi-ab-panel" id="hifiABPanel" style="display:none">
                            <div class="hifi-ab-header">
                                ${HiFiBuddyIcons.boxCorners({ size: 16 })}
                                A/B Quality Comparison
                                <button class="hifi-ab-close" id="hifiABClose" aria-label="Close A/B comparison panel">${HiFiBuddyIcons.close({ size: 14 })}</button>
                            </div>
                            <p class="hifi-ab-desc">Switch between lossless and compressed to train your ear on format differences.</p>
                            <div class="hifi-ab-toggle-wrap">
                                <button class="hifi-ab-btn hifi-ab-active" id="hifiABLossless" data-source="lossless">
                                    ${HiFiBuddyIcons.music({ size: 14 })}
                                    Lossless
                                    <span class="hifi-ab-format" id="hifiABLosslessFormat"></span>
                                </button>
                                <button class="hifi-ab-btn" id="hifiABLossy" data-source="lossy">
                                    ${HiFiBuddyIcons.music({ size: 14 })}
                                    Compressed
                                    <span class="hifi-ab-format">MP3 transcode</span>
                                </button>
                            </div>
                            <div class="hifi-ab-hint">
                                ${HiFiBuddyIcons.info({ size: 14 })}
                                Listen for: soundstage width, cymbal shimmer, bass texture, stereo separation
                            </div>
                        </div>

                        <!-- Format Info -->
                        <div class="hifi-format-card">
                            <div class="hifi-format-header">
                                ${HiFiBuddyIcons.clock({ size: 18 })}
                                Recording Notes
                            </div>
                            <p class="hifi-format-text">${lesson.album.format}</p>
                        </div>

                        <!-- Intro -->
                        <div class="hifi-guide-intro">
                            <p>${lesson.guide.intro}</p>
                        </div>

                        <!-- Timestamped Guide -->
                        <div class="hifi-listen-section">
                            <h3 class="hifi-section-title">
                                ${HiFiBuddyIcons.mic({ size: 20 })}
                                What to Listen For
                            </h3>
                            ${renderListenControls()}
                            <div class="hifi-listen-list">
                                ${lesson.guide.listenFor.map(item => {
                                    const skill = guideData.skills.find(s => s.id === item.skill);
                                    const equipBadge = renderEquipmentBadge(item);
                                    const displayTime = getDisplayTime(lesson, item);
                                    const isOverridden = displayTime !== item.time;
                                    return `
                                        <div class="hifi-listen-item ${isOverridden ? 'hifi-listen-overridden' : ''}" data-time="${displayTime}" data-original-time="${item.time}" style="--item-color: ${skill?.color || '#667eea'}; cursor: pointer;" title="Click to jump to ${displayTime}" role="button" tabindex="0" aria-label="Jump to ${displayTime} — ${(skill?.name || item.skill)}">
                                            <div class="hifi-listen-header">
                                                <span class="hifi-timestamp">${displayTime}</span>
                                                <span class="hifi-listen-skill" style="color: ${skill?.color || '#667eea'}">${skill?.name || item.skill}</span>
                                                ${equipBadge}
                                                ${isOverridden ? `<span class="hifi-listen-override-badge" title="You corrected this from ${item.time}">corrected</span>` : ''}
                                            </div>
                                            <p class="hifi-listen-note">${item.note}</p>
                                            ${renderListenEditRow(item, displayTime)}
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        </div>

                        <!-- Takeaway -->
                        <div class="hifi-takeaway">
                            <h3 class="hifi-section-title">
                                ${HiFiBuddyIcons.arrowRight({ size: 20 })}
                                Key Takeaway
                            </h3>
                            <p class="hifi-takeaway-text">${lesson.guide.takeaway}</p>
                        </div>

                        <!-- Equipment -->
                        <div class="hifi-equipment-card">
                            <h3 class="hifi-section-title">
                                ${HiFiBuddyIcons.headphones({ size: 20 })}
                                Source & Equipment
                            </h3>
                            <div class="hifi-equip-source">
                                <strong>Recommended source:</strong> ${lesson.equipment.source}
                            </div>
                            <div class="hifi-equip-why">
                                <strong>Why it matters:</strong> ${lesson.equipment.whyItMatters}
                            </div>
                        </div>

                        <!-- Complete Button -->
                        <div class="hifi-lesson-footer">
                            <button class="hifi-complete-btn ${isComplete ? 'is-complete' : ''}" id="hifiCompleteBtn">
                                ${isComplete ? `${HiFiBuddyIcons.check({ size: 14, strokeWidth: 3 })} Completed — Listen Again Anytime` : `${HiFiBuddyIcons.check({ size: 14, strokeWidth: 3 })} Mark as Completed`}
                            </button>
                            <div class="hifi-lesson-nav-bottom">
                                ${prevLessonId ? `<button class="hifi-nav-btn hifi-prev-btn" data-lesson="${prevLessonId}">&larr; Previous</button>` : '<span></span>'}
                                ${nextLessonId ? `<button class="hifi-nav-btn hifi-next-btn" data-lesson="${nextLessonId}">Next &rarr;</button>` : '<span></span>'}
                            </div>
                        </div>
                    </div>

                    <!-- Sidebar: Skill Tips -->
                    <div class="hifi-lesson-sidebar">
                        <div class="hifi-sidebar-card">
                            <h4 class="hifi-sidebar-title">Skills in This Lesson</h4>
                            ${skills.map(s => `
                                <div class="hifi-sidebar-skill">
                                    <div class="hifi-sidebar-skill-header">
                                        <span class="hifi-sidebar-skill-icon" style="color: ${s.color}">${s.icon}</span>
                                        <span class="hifi-sidebar-skill-name" style="color: ${s.color}">${s.name}</span>
                                    </div>
                                    <p class="hifi-sidebar-skill-desc">${s.description}</p>
                                    <p class="hifi-sidebar-skill-tip"><strong>Tip:</strong> ${s.tip}</p>
                                </div>
                            `).join('')}
                        </div>

                        <!-- Listening Coach -->
                        <div class="hifi-coach-card">
                            <button class="hifi-coach-toggle" id="hifiCoachToggle" aria-expanded="false" aria-controls="hifiCoachPanel">
                                ${HiFiBuddyIcons.messageSquare({ size: 16 })}
                                Listening Coach
                                ${HiFiBuddyIcons.chevronDown({ size: 14, className: 'hifi-coach-chevron' })}
                            </button>
                            <div class="hifi-coach-panel" id="hifiCoachPanel" style="display:none">
                                <div class="hifi-coach-messages" id="hifiCoachMessages" role="log" aria-live="polite">
                                    <div class="hifi-coach-msg hifi-coach-system">
                                        Ask me anything about this track, the recording techniques, what to listen for, or how to improve your listening skills.
                                    </div>
                                </div>
                                <div class="hifi-coach-input-wrap">
                                    <input type="text" class="hifi-coach-input" id="hifiCoachInput" placeholder="e.g. I can't hear the imaging, help me..." aria-label="Ask the listening coach" />
                                    <button class="hifi-coach-send" id="hifiCoachSend" aria-label="Send message">
                                        ${HiFiBuddyIcons.send({ size: 16 })}
                                    </button>
                                </div>
                                <div class="hifi-coach-quick">
                                    <button class="hifi-coach-chip" data-q="What should I focus on right now?">Focus tips</button>
                                    <button class="hifi-coach-chip" data-q="I can't hear the difference between lossless and compressed. Help me.">Lossless vs lossy</button>
                                    <button class="hifi-coach-chip" data-q="What equipment upgrades would help me hear more detail?">Equipment advice</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        bindLessonEvents(lessonId, lesson);
        fetchAlbumArt(lesson);
        // If the user navigated away and came back while Spotify was still
        // playing this lesson's track, restore the visible "Playing" state
        // (button label, source-quality card, playline tracker). Otherwise
        // the controls would look as if nothing was playing — but the audio
        // would keep coming out of Spotify with no way to pause it from
        // inside the app.
        rehydrateLessonPlayback(lesson);
        containerEl.scrollTop = 0;
        window.scrollTo(0, 0);
    }

    function bindLessonEvents(lessonId, lesson) {
        // Back button
        containerEl.querySelector('#hifiBackBtn')?.addEventListener('click', () => {
            stopPlaybackTracking();
            currentView = 'dashboard';
            currentLessonId = null;
            renderDashboard();
        });

        // Complete button
        containerEl.querySelector('#hifiCompleteBtn')?.addEventListener('click', () => {
            if (!progress.completedLessons.includes(lessonId)) {
                progress.completedLessons.push(lessonId);
                // Update skill scores
                lesson.skills.forEach(sid => {
                    progress.skillScores[sid] = (progress.skillScores[sid] || 0) + 1;
                });
                saveProgress();
            }
            renderLesson(lessonId);
        });

        // Nav buttons
        containerEl.querySelectorAll('.hifi-nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                currentLessonId = btn.dataset.lesson;
                renderLesson(btn.dataset.lesson);
            });
        });

        // Plex play
        containerEl.querySelector('#hifiPlayPlex')?.addEventListener('click', () => {
            playFromPlex(lesson.track.title, lesson.album.artist);
        });

        // Local play — visibility decided by probeLocalForLesson() below
        containerEl.querySelector('#hifiPlayLocal')?.addEventListener('click', () => {
            playFromLocal(lesson);
        });

        // Track Variant Picker
        containerEl.querySelector('#hifiChooseTrackBtn')?.addEventListener('click', () => {
            if (typeof HiFiBuddyTrackPicker === 'undefined') return;
            HiFiBuddyTrackPicker.open(lesson);
        });

        // Background: probe variants so we can show "Loaded: ..." + the picker button
        probeTrackVariants(lesson);

        // Top "Spotify" button = source selector. Clicking it always (re)plays
        // from Spotify. Pause/resume lives on the playline transport button
        // next to the progress bar — that's the canonical transport surface.
        containerEl.querySelector('#hifiPlaySpotify')?.addEventListener('click', () => {
            playFromSpotify(lesson);
        });

        // Spotify connect / reconnect — both buttons share this handler.
        // Forces auth method to PKCE, clears any stale token, kicks off OAuth.
        containerEl.querySelector('#hifiReconnectSpotify')?.addEventListener('click', () => {
            if (!HiFiBuddySettings?.getSpotifyClientId?.()) {
                if (typeof HiFiBuddyToast !== 'undefined') {
                    HiFiBuddyToast.error('Set your Spotify Client ID in Settings first');
                }
                HiFiBuddySettings.show?.();
                return;
            }
            // CROSS-BROWSER: Spotify Web Playback SDK is desktop-only. On mobile
            // browsers OAuth still completes but the SDK can't acquire a device,
            // so surface a clear fallback path before the user signs in.
            if (typeof HiFiBuddySpotify?.isLikelyMobile === 'function' && HiFiBuddySpotify.isLikelyMobile()) {
                if (typeof HiFiBuddyToast !== 'undefined') {
                    HiFiBuddyToast.warning(
                        "Spotify Web Playback SDK isn't supported on mobile. Open the Spotify app on this device, then transfer playback from a desktop session.",
                        9000
                    );
                }
                // Still let OAuth proceed — read-only API calls (track search,
                // device list) work fine on mobile, and the user may want to
                // transfer playback later from desktop.
            }
            try { HiFiBuddySettings.setSpotifyAuthMethod?.('pkce'); } catch { /* ignore */ }
            HiFiBuddySettings.clearSpotifyTokens?.();
            HiFiBuddySpotify.startPKCEAuth();
        });

        // No Client ID yet — open Settings so they can paste it in.
        containerEl.querySelector('#hifiOpenSpotifySettings')?.addEventListener('click', () => {
            HiFiBuddySettings.show?.();
        });

        // ABX blind test launcher
        containerEl.querySelector('#hifiABXBtn')?.addEventListener('click', () => launchABX(lesson));

        // Spectrum visualizer toggle
        containerEl.querySelector('#hifiSpectrumBtn')?.addEventListener('click', () => {
            if (typeof HiFiBuddyVisualizer === 'undefined') return;
            const audioEl = document.querySelector('audio');
            if (audioEl) HiFiBuddyVisualizer.attach(audioEl).catch(() => {});
            HiFiBuddyVisualizer.toggle();
        });

        // Background preload: search Plex and start buffering audio immediately
        (async () => {
            const cached = getCachedTrack(lesson.track.title, lesson.album.artist);
            if (cached?.streamUrl) {
                // Already cached — preload the audio buffer so playback is instant
                if (typeof HiFiBuddyAudio !== 'undefined') {
                    HiFiBuddyAudio.preload(cached.streamUrl);
                }
                return;
            }
            // Not cached — search Plex in background, cache result, preload stream
            if (typeof HiFiBuddyPlex !== 'undefined' && HiFiBuddySettings?.getPlexUrl?.() && HiFiBuddySettings?.getPlexToken?.()) {
                try {
                    const result = await HiFiBuddyPlex.searchTrack(lesson.track.title, lesson.album.artist);
                    if (result?.streamUrl) {
                        const key = trackCacheKey(lesson.track.title, lesson.album.artist);
                        cachePlexResult(key, result);
                        // Update button to show it's ready
                        const plexBtn = containerEl.querySelector('#hifiPlayPlex');
                        if (plexBtn && !plexBtn.disabled) {
                            plexBtn.classList.add('hifi-plex-ready');
                            plexBtn.innerHTML = `${HiFiBuddyIcons.play({ size: 16 })} Plex ${HiFiBuddyIcons.check({ size: 12, strokeWidth: 3 })}`;
                        }
                        // Start buffering the audio
                        if (typeof HiFiBuddyAudio !== 'undefined') {
                            HiFiBuddyAudio.preload(result.streamUrl);
                        }
                    }
                } catch (e) {
                    console.warn('[HiFi] Background preload failed:', e);
                }
            }
        })();

        // Background: probe local library for this lesson's track. If a match
        // exists, reveal the "Local" play button. Re-runs whenever the user
        // rescans the library.
        probeLocalForLesson(lesson);
        const onLocalChanged = () => probeLocalForLesson(lesson);
        window.addEventListener('hifibuddy-local-library-changed', onLocalChanged);
        // Detach when this lesson is left (renderLesson re-runs and replaces DOM)
        // — listener leak is bounded; harmless beyond a couple navigations.

        // Click-to-seek on "What to Listen For" items
        containerEl.querySelectorAll('.hifi-listen-item[data-time]').forEach(item => {
            const trigger = async (ev) => {
                // When clicking inside the edit row controls, don't trigger seek.
                if (ev.target.closest('.hifi-listen-edit-row')) return;
                if (activeSource === null) {
                    // No playback yet — fall back to checking the audio element
                    const audioEl = document.querySelector('audio');
                    if (!audioEl || !audioEl.src) return;
                }
                const timeStr = item.dataset.time;
                const range = parseTimeRange(timeStr);
                await seekActiveTo(range.start);
                if (!playbackTracker) {
                    startPlaybackTracking(lesson);
                }
            };
            item.addEventListener('click', trigger);
            // a11y: items have role="button" + tabindex=0 so they're focusable;
            // wire Enter / Space to the same click path.
            item.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    if (ev.target.closest('.hifi-listen-edit-row')) return;
                    ev.preventDefault();
                    trigger(ev);
                }
            });
        });

        // Timing-feedback controls (Edit timing, Export, per-segment edit rows)
        wireTimingFeedback(lesson);

        // A/B comparison toggle
        containerEl.querySelector('#hifiABToggle')?.addEventListener('click', () => {
            const panel = containerEl.querySelector('#hifiABPanel');
            const toggle = containerEl.querySelector('#hifiABToggle');
            if (panel) {
                const opening = panel.style.display === 'none';
                panel.style.display = opening ? 'block' : 'none';
                if (toggle) toggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
            }
        });
        containerEl.querySelector('#hifiABClose')?.addEventListener('click', () => {
            const panel = containerEl.querySelector('#hifiABPanel');
            if (panel) panel.style.display = 'none';
            const toggle = containerEl.querySelector('#hifiABToggle');
            if (toggle) toggle.setAttribute('aria-expanded', 'false');
            stopABMode();
        });
        containerEl.querySelector('#hifiABLossless')?.addEventListener('click', () => switchABSource('lossless'));
        containerEl.querySelector('#hifiABLossy')?.addEventListener('click', () => switchABSource('lossy'));

        // Listening Coach
        containerEl.querySelector('#hifiCoachToggle')?.addEventListener('click', () => {
            const panel = containerEl.querySelector('#hifiCoachPanel');
            const toggle = containerEl.querySelector('#hifiCoachToggle');
            if (panel) {
                coachVisible = !coachVisible;
                panel.style.display = coachVisible ? 'flex' : 'none';
                containerEl.querySelector('.hifi-coach-chevron')?.classList.toggle('hifi-coach-open', coachVisible);
                if (toggle) toggle.setAttribute('aria-expanded', coachVisible ? 'true' : 'false');
            }
        });
        containerEl.querySelector('#hifiCoachSend')?.addEventListener('click', () => sendCoachMessage(lesson));
        containerEl.querySelector('#hifiCoachInput')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') sendCoachMessage(lesson);
        });
        containerEl.querySelectorAll('.hifi-coach-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const input = containerEl.querySelector('#hifiCoachInput');
                if (input) { input.value = chip.dataset.q; }
                sendCoachMessage(lesson);
            });
        });
    }

    // ==================== SKILLS OVERVIEW ====================

    function renderSkillsOverview() {
        const skills = guideData.skills;
        const maxScore = Math.max(1, ...Object.values(progress.skillScores));

        containerEl.innerHTML = `
            <div class="hifi-skills-view">
                <div class="hifi-lesson-nav-top">
                    <button class="hifi-back-btn" id="hifiBackBtn">
                        ${HiFiBuddyIcons.arrowLeft({ size: 18 })}
                        All Lessons
                    </button>
                </div>

                <div class="hifi-header">
                    <h2 class="hifi-title">Listening Skills</h2>
                    <p class="hifi-subtitle">Track your progress across the 10 critical listening dimensions</p>
                </div>

                <div class="hifi-skills-grid">
                    ${skills.map(skill => {
                        const score = progress.skillScores[skill.id] || 0;
                        const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
                        const lessonsWithSkill = guideData.lessons.filter(l => l.skills.includes(skill.id));
                        const completedWithSkill = lessonsWithSkill.filter(l => progress.completedLessons.includes(l.id));

                        return `
                            <div class="hifi-skill-card" style="--skill-color: ${skill.color}">
                                <div class="hifi-skill-card-header">
                                    <span class="hifi-skill-card-icon">${skill.icon}</span>
                                    <span class="hifi-skill-card-name">${skill.name}</span>
                                    <span class="hifi-skill-card-count">${completedWithSkill.length}/${lessonsWithSkill.length}</span>
                                </div>
                                <p class="hifi-skill-card-desc">${skill.description}</p>
                                <div class="hifi-skill-bar-wrap">
                                    <div class="hifi-skill-bar">
                                        <div class="hifi-skill-bar-fill" style="width: ${pct}%; background: ${skill.color}"></div>
                                    </div>
                                </div>
                                <p class="hifi-skill-card-tip">${skill.tip}</p>
                                <div class="hifi-skill-lessons">
                                    ${lessonsWithSkill.map(l => {
                                        const done = progress.completedLessons.includes(l.id);
                                        return `<button class="hifi-skill-lesson-link ${done ? 'done' : ''}" data-lesson="${l.id}">${done ? `${HiFiBuddyIcons.check({ size: 14, strokeWidth: 3 })} ` : ''}${l.title}</button>`;
                                    }).join('')}
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;

        // Bind events
        containerEl.querySelector('#hifiBackBtn')?.addEventListener('click', () => {
            currentView = 'dashboard';
            renderDashboard();
        });

        containerEl.querySelectorAll('.hifi-skill-lesson-link').forEach(link => {
            link.addEventListener('click', () => {
                currentLessonId = link.dataset.lesson;
                currentView = 'lesson';
                renderLesson(link.dataset.lesson);
            });
        });
    }

    // ==================== PLAYBACK ====================

    async function playFromPlex(trackTitle, artist) {
        const btn = containerEl.querySelector('#hifiPlayPlex');

        // Check Plex availability — need settings at minimum
        const hasSettings = typeof HiFiBuddySettings !== 'undefined' &&
            HiFiBuddySettings.getPlexUrl?.() && HiFiBuddySettings.getPlexToken?.();

        if (typeof HiFiBuddyPlex === 'undefined' || !hasSettings) {
            if (btn) {
                btn.textContent = 'Plex not connected';
                btn.style.opacity = '0.5';
                setTimeout(() => {
                    btn.innerHTML = `${HiFiBuddyIcons.play({ size: 16 })} Plex`;
                    btn.style.opacity = '';
                }, 2000);
            }
            return;
        }

        if (btn) {
            btn.disabled = true;
        }

        const setLoading = (label) => {
            if (!btn) return;
            btn.innerHTML = `<span class="hifi-play-spinner"></span> ${label}`;
        };

        try {
            // Honor a saved Plex track override before falling back to the
            // heuristic. If the override is for a non-Plex source, ignore.
            const overrideLesson = guideData?.lessons?.find(l => l.id === currentLessonId);
            const override = (overrideLesson && typeof HiFiBuddyTrackPicker !== 'undefined')
                ? HiFiBuddyTrackPicker.getOverride(overrideLesson.id) : null;

            let result = null;
            if (override && override.source === 'plex' && typeof HiFiBuddyPlex.getTrackByRatingKey === 'function') {
                setLoading('Loading override…');
                result = await HiFiBuddyPlex.getTrackByRatingKey(override.id);
            }

            if (!result) {
                // Check cache first — instant if pre-fetched
                result = getCachedTrack(trackTitle, artist);
                if (result) {
                    console.log(`[HiFi] Cache hit: "${trackTitle}"`);
                    setLoading('Loading…');
                } else {
                    setLoading('Searching Plex…');
                    result = await HiFiBuddyPlex.searchTrack(trackTitle, artist);
                    // Cache for next time
                    if (result) {
                        const key = trackCacheKey(trackTitle, artist);
                        cachePlexResult(key, result);
                    }
                }
            }

            if (result?.streamUrl) {
                const thumbUrl = result.thumb ? HiFiBuddyPlex.getThumbUrl(result.thumb) : '';

                if (typeof HiFiBuddyAudio !== 'undefined') {
                    setLoading('Buffering…');
                    // If Spotify is currently playing, stop it to avoid two sources at once
                    if (activeSource === 'spotify' && typeof HiFiBuddySpotify !== 'undefined') {
                        HiFiBuddySpotify.pause().catch(() => {});
                    }
                    activeSource = 'plex';
                    window.HiFiBuddyActiveSource = 'plex';
                    const ctxLesson = guideData?.lessons?.find(l => l.id === currentLessonId);
                    const ctx = ctxLesson
                        ? { type: 'lesson', label: `${ctxLesson.title} · ${ctxLesson.track.title}` }
                        : { type: 'plex-direct', label: 'Plex' };
                    HiFiBuddyAudio.play(result.streamUrl, result.title, result.artist, thumbUrl, ctx);
                    // Auto-attach visualizer (it'll only render if visible)
                    if (typeof HiFiBuddyVisualizer !== 'undefined') {
                        setTimeout(() => {
                            const audioEl = document.querySelector('audio');
                            if (audioEl) HiFiBuddyVisualizer.attach(audioEl).catch(() => {});
                        }, 0);
                    }
                    // Surface Plex-stream failures (502 from proxy = transcode
                    // failure on Plex side; audio element's error event fires
                    // with no useful detail). Probe the URL once, after a
                    // short delay, to extract the proxy's textual reason.
                    if (typeof HiFiBuddyPlex !== 'undefined' && HiFiBuddyPlex.reportStreamFailure) {
                        const streamUrl = result.streamUrl;
                        setTimeout(() => {
                            const audioEl = document.querySelector('audio');
                            if (!audioEl || !audioEl.error) return;  // playing fine
                            // Only attempt the diagnostic fetch on failure.
                            fetch(streamUrl, { method: 'GET', headers: { Range: 'bytes=0-127' } })
                                .then(r => HiFiBuddyPlex.reportStreamFailure(r, { label: 'audio' }))
                                .catch(() => { /* network errors handled elsewhere */ });
                        }, 1500);
                    }
                    // Start interactive playback tracking once audio actually starts
                    const lesson = guideData.lessons.find(l => l.id === currentLessonId);
                    if (lesson) {
                        const audioEl = document.querySelector('audio');
                        if (audioEl) {
                            const onPlaying = () => {
                                audioEl.removeEventListener('playing', onPlaying);
                                startPlaybackTracking(lesson);
                            };
                            audioEl.addEventListener('playing', onPlaying);
                            // Fallback: start after 3s even if event missed
                            setTimeout(() => {
                                audioEl.removeEventListener('playing', onPlaying);
                                startPlaybackTracking(lesson);
                            }, 3000);
                            const onMeta = () => {
                                audioEl.removeEventListener('loadedmetadata', onMeta);
                                checkDurationMismatch(audioEl, lesson);
                            };
                            if (audioEl.readyState >= 1 && audioEl.duration) {
                                checkDurationMismatch(audioEl, lesson);
                            } else {
                                audioEl.addEventListener('loadedmetadata', onMeta);
                            }
                        }
                    }
                }

                // Update album art if we got a thumb from Plex
                if (thumbUrl) {
                    updateAlbumArt(thumbUrl);
                }

                // Show quality info badge
                if (result.quality) {
                    showQualityBadge(result.quality);
                    // Self-heal: cache entries written before the hi-res schema
                    // update don't have bitDepth/sampleRate. Detect the gap and
                    // enrich in the background, then refresh the badge + cache.
                    if (result.needsEnrichment && result.ratingKey
                        && typeof HiFiBuddyPlex?.enrichQuality === 'function') {
                        HiFiBuddyPlex.enrichQuality(result.ratingKey, result.quality).then(enriched => {
                            if (!enriched || (!enriched.bitDepth && !enriched.sampleRate)) return;
                            // Re-render the badge with the better data
                            showQualityBadge(enriched);
                            // Persist the enriched quality back to the cache
                            const key = trackCacheKey(trackTitle, artist);
                            const urlHash = getPlexUrlHash();
                            if (urlHash && plexMatches[key]) {
                                plexMatches[key].bitDepth   = enriched.bitDepth   || 0;
                                plexMatches[key].sampleRate = enriched.sampleRate || 0;
                                plexMatches[key].channels   = enriched.channels   || 2;
                                plexMatches[key].container  = enriched.container  || '';
                                if (enriched.codec)   plexMatches[key].codec   = enriched.codec;
                                if (enriched.bitrate) plexMatches[key].bitrate = enriched.bitrate;
                                savePlexMatches();
                            }
                        }).catch(() => { /* silent */ });
                    }
                }

                // Activate A/B comparison if lossless source
                if (result.ratingKey && result.quality) {
                    const codec = (result.quality.codec || '').toLowerCase();
                    if (['flac', 'alac', 'wav', 'aiff', 'dsd'].includes(codec)) {
                        activateABMode(result.streamUrl, result.ratingKey, result.quality);
                    }
                }

                if (btn) {
                    btn.innerHTML = `${HiFiBuddyIcons.play({ size: 14 })} Playing from Plex`;
                    btn.style.background = 'rgba(229,160,13,0.2)';
                    btn.style.color = '#e5a00d';
                    btn.disabled = false;
                }
            } else {
                if (btn) {
                    btn.textContent = 'Not found in Plex';
                    setTimeout(() => {
                        btn.innerHTML = `${HiFiBuddyIcons.play({ size: 16 })} Plex`;
                        btn.disabled = false;
                        btn.style.background = '';
                        btn.style.color = '';
                    }, 2000);
                }
            }
        } catch (e) {
            console.error('Plex search failed:', e);
            // The Plex helper already toasts on HTTP/network errors with a
            // rich "Open Settings" action. Only fire a fallback toast for
            // unknown errors that didn't go through handlePlexResponse.
            if (typeof HiFiBuddyToast !== 'undefined') {
                HiFiBuddyToast.show({
                    type: 'error',
                    message: 'Plex search failed unexpectedly.',
                    details: e?.message || String(e),
                    action: { label: 'Open Settings', onClick: () => document.getElementById('settingsBtn')?.click() },
                });
            }
            if (btn) {
                btn.textContent = 'Plex error';
                btn.disabled = false;
                setTimeout(() => {
                    btn.innerHTML = `${HiFiBuddyIcons.play({ size: 16 })} Plex`;
                    btn.style.background = '';
                }, 2000);
            }
        }
    }

    // ===== Local library playback =====

    // Reveal the Local button (and a small "Available locally" badge) iff this
    // lesson's track has a match in HiFiBuddyLocalLibrary. Idempotent — safe to
    // re-run whenever the index changes.
    async function probeLocalForLesson(lesson) {
        if (typeof HiFiBuddyLocalLibrary === 'undefined') return null;
        try {
            // First call lazily loads the index (cheap GET to /api/local/index).
            if (!HiFiBuddyLocalLibrary.isAvailable()) {
                await HiFiBuddyLocalLibrary.loadIndex();
            }
        } catch { /* ignore */ }
        const match = HiFiBuddyLocalLibrary.findTrack(
            lesson.track.title,
            lesson.album.artist,
            lesson.track.musicbrainzRecordingId,
        );
        const btn = containerEl.querySelector('#hifiPlayLocal');
        if (btn) {
            btn.style.display = match ? '' : 'none';
            if (match) {
                btn.title = `Play from local library — ${match.path || match.title}`;
                btn.dataset.localId = String(match.id);
            }
        }
        // Add a subtle "Available locally" badge near the format card if not present.
        const formatCard = containerEl.querySelector('.hifi-format-card');
        const existingBadge = containerEl.querySelector('.hifi-local-available-badge');
        if (match && formatCard && !existingBadge) {
            const badge = document.createElement('div');
            badge.className = 'hifi-local-available-badge';
            badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 10px;margin-top:8px;border-radius:12px;background:rgba(122,199,79,0.14);color:#7AC74F;font-size:0.75rem;font-weight:600;border:1px solid rgba(122,199,79,0.3)';
            badge.innerHTML = `${HiFiBuddyIcons.folder({ size: 12 })} Available locally`;
            formatCard.insertAdjacentElement('afterend', badge);
        } else if (!match && existingBadge) {
            existingBadge.remove();
        }
        return match;
    }

    // Probe Plex + local for track variants so we can render the
    // "Loaded: ..." line and reveal the picker button when there are 2+
    // candidates. Cheap when the Plex prefetch has already cached results.
    async function probeTrackVariants(lesson) {
        if (!lesson) return;
        const row = containerEl.querySelector('#hifiLoadedRow');
        const textEl = containerEl.querySelector('#hifiLoadedText');
        const btn = containerEl.querySelector('#hifiChooseTrackBtn');
        if (!row || !textEl) return;

        let plexMatches = [];
        let localMatches = [];

        try {
            if (typeof HiFiBuddyPlex !== 'undefined' && HiFiBuddySettings?.getPlexUrl?.() && HiFiBuddySettings?.getPlexToken?.()) {
                if (typeof HiFiBuddyPlex.searchTrackAll === 'function') {
                    plexMatches = await HiFiBuddyPlex.searchTrackAll(
                        lesson.track.title, lesson.album.artist
                    ) || [];
                }
            }
        } catch { /* ignore */ }

        try {
            if (typeof HiFiBuddyLocalLibrary !== 'undefined' && typeof HiFiBuddyLocalLibrary.findAllMatches === 'function') {
                if (!HiFiBuddyLocalLibrary.isAvailable()) {
                    await HiFiBuddyLocalLibrary.loadIndex();
                }
                localMatches = HiFiBuddyLocalLibrary.findAllMatches(
                    lesson.track.title, lesson.album.artist
                ) || [];
            }
        } catch { /* ignore */ }

        const totalMatches = plexMatches.length + localMatches.length;
        if (totalMatches === 0) {
            row.style.display = 'none';
            return;
        }

        // Resolve which track is actually "loaded" given the override (if any)
        const override = typeof HiFiBuddyTrackPicker !== 'undefined'
            ? HiFiBuddyTrackPicker.getOverride(lesson.id) : null;
        let loaded = null;
        if (override) {
            if (override.source === 'plex') {
                loaded = plexMatches.find(m => String(m.ratingKey) === String(override.id));
                if (loaded) loaded._source = 'plex';
            } else if (override.source === 'local') {
                const m = localMatches.find(m => String(m.id) === String(override.id));
                if (m) loaded = { ...m, _source: 'local' };
            }
        }
        if (!loaded) {
            // Fall back to the heuristic: first Plex match, else first local.
            if (plexMatches[0]) loaded = { ...plexMatches[0], _source: 'plex' };
            else if (localMatches[0]) loaded = { ...localMatches[0], _source: 'local' };
        }

        if (loaded) {
            const album = loaded.album || '';
            const year = loaded.albumYear || loaded.year || '';
            // Plex returns duration in ms; local index returns seconds.
            const durMs = loaded._source === 'plex'
                ? loaded.duration
                : ((loaded.duration || 0) > 1000 ? loaded.duration : (loaded.duration || 0) * 1000);
            const dur = fmtMsLabel(durMs);
            const srcLabel = loaded._source === 'plex' ? 'Plex' : 'Local';
            const albumBit = album ? `${escAttr(album)}${year ? ' ' + year : ''}` : '';
            textEl.textContent = `Loaded: ${loaded.title}${albumBit ? ' — ' + albumBit : ''}${dur ? ' (' + dur + ')' : ''} · ${srcLabel}${override ? ' (override)' : ''}`;
            row.style.display = '';
        }

        if (btn) {
            // Only show the picker when there's something to choose between
            btn.style.display = totalMatches > 1 ? '' : 'none';
        }
    }

    function fmtMsLabel(ms) {
        if (!ms || ms < 0) return '';
        const total = Math.floor(ms / 1000);
        const m = Math.floor(total / 60);
        const s = total % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    async function playFromLocal(lesson) {
        const btn = containerEl.querySelector('#hifiPlayLocal');
        if (typeof HiFiBuddyLocalLibrary === 'undefined') return;

        // Honor a saved local override before falling back to the heuristic
        // findTrack(). Override for a different source is ignored (the user
        // explicitly clicked "Local").
        let match = null;
        const override = (typeof HiFiBuddyTrackPicker !== 'undefined')
            ? HiFiBuddyTrackPicker.getOverride(lesson.id) : null;
        if (override && override.source === 'local' && typeof HiFiBuddyLocalLibrary.getById === 'function') {
            match = HiFiBuddyLocalLibrary.getById(override.id);
        }
        if (!match) {
            match = HiFiBuddyLocalLibrary.findTrack(
                lesson.track.title,
                lesson.album.artist,
                lesson.track.musicbrainzRecordingId,
            );
        }
        if (!match) {
            if (btn) {
                btn.textContent = 'Not in local library';
                setTimeout(() => {
                    btn.innerHTML = `${HiFiBuddyIcons.folder({ size: 16 })} Local`;
                }, 1800);
            }
            return;
        }
        const streamUrl = HiFiBuddyLocalLibrary.getStreamUrl(match.id);
        if (!streamUrl) return;

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<span class="hifi-play-spinner"></span> Loading…`;
        }

        try {
            // Stop competing sources
            if (activeSource === 'spotify' && typeof HiFiBuddySpotify !== 'undefined') {
                HiFiBuddySpotify.pause().catch(() => {});
            }
            if (typeof HiFiBuddyAudio !== 'undefined' && HiFiBuddyAudio.stop) {
                try { HiFiBuddyAudio.stop(); } catch { /* ignore */ }
            }

            activeSource = 'local';
            window.HiFiBuddyActiveSource = 'local';

            if (typeof HiFiBuddyAudio !== 'undefined') {
                const ctx = { type: 'lesson', label: `${lesson.title} · ${lesson.track.title}` };
                HiFiBuddyAudio.play(streamUrl, match.title || lesson.track.title, match.artist || lesson.album.artist, '', ctx);
                // Same-origin, so visualizer can attach safely (just like Plex)
                if (typeof HiFiBuddyVisualizer !== 'undefined') {
                    setTimeout(() => {
                        const audioEl = document.querySelector('audio');
                        if (audioEl) HiFiBuddyVisualizer.attach(audioEl).catch(() => {});
                    }, 0);
                }
                const audioEl = document.querySelector('audio');
                if (audioEl) {
                    const onPlaying = () => {
                        audioEl.removeEventListener('playing', onPlaying);
                        startPlaybackTracking(lesson);
                    };
                    audioEl.addEventListener('playing', onPlaying);
                    setTimeout(() => {
                        audioEl.removeEventListener('playing', onPlaying);
                        startPlaybackTracking(lesson);
                    }, 3000);
                }
            }

            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `${HiFiBuddyIcons.play({ size: 14 })} Playing locally`;
                btn.style.background = 'rgba(122,199,79,0.2)';
                btn.style.color = '#7AC74F';
            }
        } catch (e) {
            console.error('[HiFi] Local play failed:', e);
            if (typeof HiFiBuddyToast !== 'undefined') HiFiBuddyToast.error('Local playback failed.');
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `${HiFiBuddyIcons.folder({ size: 16 })} Local`;
            }
        }
    }

    // ===== ABX launcher =====

    // Derive an ABX block from a lesson's listenFor when one isn't explicitly
    // defined (AI-generated lessons don't get one by default). Picks the most
    // codec-sensitive segment by skill priority.
    function getEffectiveAbx(lesson) {
        if (lesson.abx) return lesson.abx;
        const segs = lesson.guide?.listenFor || [];
        if (!segs.length) return null;
        // Same priority as apply_abx_defaults.py
        const PRIORITY = ['dynamics', 'transients', 'detail', 'bass', 'tonal-color',
            'air', 'soundstage', 'imaging', 'layering', 'separation'];
        let best = segs[0];
        let bestRank = PRIORITY.length;
        for (const s of segs) {
            const r = PRIORITY.indexOf(s.skill);
            if (r >= 0 && r < bestRank) { best = s; bestRank = r; }
        }
        return { segment: best.time, skill: best.skill, defaultBitrate: 192, derived: true };
    }

    async function launchABX(lesson) {
        const abx = getEffectiveAbx(lesson);
        if (!abx || abx.skip) return;
        // Mutate so downstream code (which reads lesson.abx.segment / .defaultBitrate) just works
        if (!lesson.abx) lesson.abx = abx;

        if (typeof HiFiBuddyABX === 'undefined') {
            if (typeof HiFiBuddyToast !== 'undefined') {
                HiFiBuddyToast.error('ABX module failed to load — reload the page');
            }
            return;
        }

        const bitrate = lesson.abx.defaultBitrate || 192;

        // Stop any current playback so the AudioContext doesn't fight the <audio> element.
        if (typeof HiFiBuddyAudio !== 'undefined' && HiFiBuddyAudio.stop) {
            try { HiFiBuddyAudio.stop(); } catch { /* ignore */ }
        }
        if (activeSource === 'spotify' && typeof HiFiBuddySpotify !== 'undefined') {
            HiFiBuddySpotify.pause().catch(() => {});
        }

        // ===== Source preference: local first (if available + ffmpeg), then Plex =====
        if (typeof HiFiBuddyLocalLibrary !== 'undefined' && HiFiBuddyLocalLibrary.isAvailable()) {
            const localMatch = HiFiBuddyLocalLibrary.findTrack(
                lesson.track.title,
                lesson.album.artist,
                lesson.track.musicbrainzRecordingId,
            );
            if (localMatch) {
                if (!HiFiBuddyLocalLibrary.isFFmpegAvailable()) {
                    if (typeof HiFiBuddyToast !== 'undefined') {
                        HiFiBuddyToast.error('Local FLAC is available, but ABX needs ffmpeg for MP3 transcoding. Install ffmpeg and rescan.');
                    }
                    // Fall through to Plex if Plex is configured; otherwise bail.
                } else {
                    const losslessUrl = HiFiBuddyLocalLibrary.getStreamUrl(localMatch.id);
                    const lossyUrl = HiFiBuddyLocalLibrary.getTranscodedUrl(localMatch.id, bitrate);
                    if (losslessUrl && lossyUrl) {
                        HiFiBuddyABX.open({
                            lesson,
                            segment: lesson.abx.segment,
                            bitrate,
                            trackResult: { source: 'local', id: localMatch.id, title: localMatch.title, artist: localMatch.artist },
                            losslessUrl,
                            lossyUrl,
                        });
                        return;
                    }
                }
            }
        }

        // ===== Plex fallback =====
        const plexUp = typeof HiFiBuddyPlex !== 'undefined' &&
            HiFiBuddySettings?.getPlexUrl?.() && HiFiBuddySettings?.getPlexToken?.();
        if (!plexUp) {
            if (typeof HiFiBuddyToast !== 'undefined') {
                HiFiBuddyToast.error('ABX needs Plex or a local library with ffmpeg — neither is configured');
            }
            return;
        }

        // Resolve track in Plex (use cache if available)
        let track = getCachedTrack(lesson.track.title, lesson.album.artist);
        if (!track) {
            if (typeof HiFiBuddyToast !== 'undefined') {
                HiFiBuddyToast.info(`Searching Plex for "${lesson.track.title}"…`);
            }
            track = await HiFiBuddyPlex.searchTrack(lesson.track.title, lesson.album.artist);
        }
        if (!track?.ratingKey) {
            if (typeof HiFiBuddyToast !== 'undefined') {
                HiFiBuddyToast.error(`Track not found in Plex: "${lesson.track.title}"`);
            }
            return;
        }

        const losslessUrl = track.streamUrl;
        const lossyUrl = HiFiBuddyPlex.getTranscodedMp3Url(track.ratingKey, bitrate);
        if (!losslessUrl || !lossyUrl) {
            if (typeof HiFiBuddyToast !== 'undefined') {
                HiFiBuddyToast.error('Could not build Plex stream URLs');
            }
            return;
        }

        HiFiBuddyABX.open({
            lesson,
            segment: lesson.abx.segment,
            bitrate,
            trackResult: track,
            losslessUrl,
            lossyUrl,
        });
    }

    // ===== Source-aware playback helpers =====

    function getCurrentTimeSecs() {
        if (activeSource === 'spotify' && spotifyState) {
            return (spotifyState.position || 0) / 1000;
        }
        const audioEl = document.querySelector('audio');
        return audioEl ? audioEl.currentTime : 0;
    }

    function isActivePaused() {
        if (activeSource === 'spotify') return spotifyState?.paused ?? true;
        const audioEl = document.querySelector('audio');
        return !audioEl || audioEl.paused;
    }

    async function seekActiveTo(seconds) {
        if (activeSource === 'spotify') {
            await HiFiBuddySpotify.seek(Math.floor(seconds * 1000));
            // refresh cached state so tracker shows new position immediately
            try { spotifyState = await HiFiBuddySpotify.getCurrentState(); } catch { /* ignore */ }
            return;
        }
        const audioEl = document.querySelector('audio');
        if (!audioEl) return;
        audioEl.currentTime = seconds;
        if (audioEl.paused) audioEl.play().catch(() => {});
    }

    // Render a Spotify action button based on sync auth state.
    // Decision matrix:
    //   1) Connected via PKCE with streaming scope        → "Spotify" play button (SDK)
    //   2) Connected but missing streaming scope          → "Reconnect for Premium"  (clears token + PKCE)
    //   3) Not connected, Client ID set                   → "Connect Spotify"        (PKCE auth)
    //   4) Not connected, no Client ID                    → search-link fallback (must set up in Settings)
    function renderSpotifyAction(lesson) {
        const SPOT_SVG = HiFiBuddyIcons.spotify({ size: 16, brand: false });

        const hasSpotify = typeof HiFiBuddySpotify !== 'undefined';
        const isConnected = hasSpotify && !!HiFiBuddySpotify.isConnected?.();
        const authMethod = HiFiBuddySettings?.getSpotifyAuthMethod?.() || '(none)';
        const grantedScopes = HiFiBuddySettings?.getSpotifyTokenScopes?.() || '';
        const hasStreaming = hasSpotify && !!HiFiBuddySpotify.hasStreamingScope?.();
        const hasClientId = !!HiFiBuddySettings?.getSpotifyClientId?.();
        const canPremium = isConnected && authMethod === 'pkce' && hasStreaming;

        let decision;
        if (canPremium)            decision = 'play-button';
        else if (isConnected)      decision = 'reconnect-button';
        else if (hasClientId)      decision = 'connect-button';
        else                       decision = 'search-link';

        console.log('[HiFi/Spotify] renderSpotifyAction:', {
            lesson: lesson.id,
            hasSpotifyModule: hasSpotify,
            isConnected,
            authMethod,
            grantedScopes: grantedScopes || '(empty)',
            hasStreamingScope: hasStreaming,
            hasClientId,
            decision,
        });

        if (decision === 'play-button') {
            return `<button class="hifi-play-btn hifi-play-spotify" id="hifiPlaySpotify" title="Play on Spotify (Premium)">
                ${SPOT_SVG} Spotify
            </button>`;
        }
        if (decision === 'reconnect-button') {
            const reason = authMethod !== 'pkce'
                ? 'Switch auth method to PKCE and reconnect for Premium playback'
                : 'Existing token is missing the "streaming" scope; click to re-auth';
            return `<button class="hifi-play-btn hifi-play-spotify" id="hifiReconnectSpotify" title="${reason}">
                ${SPOT_SVG} Reconnect for Premium
            </button>`;
        }
        if (decision === 'connect-button') {
            return `<button class="hifi-play-btn hifi-play-spotify" id="hifiReconnectSpotify" title="Connect your Spotify Premium account">
                ${SPOT_SVG} Connect Spotify
            </button>`;
        }
        // Last resort: open Settings to set up the Client ID.
        return `<button class="hifi-play-btn hifi-play-spotify" id="hifiOpenSpotifySettings" title="Set your Spotify Client ID in Settings to enable Premium playback">
            ${SPOT_SVG} Set up Spotify
        </button>`;
    }

    // Update the visible Spotify source button to its "active source" look
    // when this lesson's track is loaded in the SDK player. Transport
    // controls (pause/resume) live on the playline button next to the
    // progress bar — this button is just a source selector.
    function updateSpotifyButtonForState(state) {
        const btn = containerEl?.querySelector('#hifiPlaySpotify');
        if (!btn) return;
        const SPOT_SVG = HiFiBuddyIcons.spotify({ size: 16, brand: false });
        btn.disabled = false;
        btn.style.background = 'rgba(29,185,84,0.18)';
        btn.style.color = '#1db954';
        btn.title = 'Spotify is the active source — use the playline button to pause';
        btn.innerHTML = `${SPOT_SVG} Playing on Spotify`;
        // Mirror state on the playline transport button
        updatePlaylineTransport(state);
    }

    // The playline transport button: ▶ when paused/stopped, ⏸ when playing.
    // Click toggles pause/resume on whichever source is active. The playline
    // is the canonical transport — the top buttons are only source selectors.
    function updatePlaylineTransport(spotifyStateMaybe) {
        const el = containerEl?.querySelector('#hifiPlaylineSource');
        if (!el) return;
        let label = '';
        let paused = false;
        if (activeSource === 'spotify') {
            label = 'Spotify';
            paused = spotifyStateMaybe ? !!spotifyStateMaybe.paused : !!spotifyState?.paused;
        } else if (activeSource === 'plex' || activeSource === 'local') {
            label = activeSource === 'plex' ? 'Plex' : 'Local';
            const audioEl = document.querySelector('audio');
            paused = audioEl ? audioEl.paused : true;
        }
        const ICON = paused
            ? HiFiBuddyIcons.play({ size: 11 })
            : HiFiBuddyIcons.pause({ size: 11 });
        el.innerHTML = label ? `${ICON} ${label}` : '';
        el.title = label
            ? (paused ? `Resume ${label} playback` : `Pause ${label} playback`)
            : '';
        el.style.cursor = label ? 'pointer' : '';
    }

    async function togglePlaylineTransport() {
        if (activeSource === 'spotify') {
            if (typeof HiFiBuddySpotify === 'undefined') return;
            try {
                let state = spotifyState;
                if (!state) state = await HiFiBuddySpotify.getCurrentState();
                if (!state) return;
                if (state.paused) await HiFiBuddySpotify.resume?.();
                else              await HiFiBuddySpotify.pause?.();
                // Pull fresh state and refresh both UIs immediately.
                const fresh = await HiFiBuddySpotify.getCurrentState();
                if (fresh) { spotifyState = fresh; updateSpotifyButtonForState(fresh); }
            } catch { /* ignore */ }
            return;
        }
        if (activeSource === 'plex' || activeSource === 'local') {
            const audioEl = document.querySelector('audio');
            if (!audioEl) return;
            if (audioEl.paused) audioEl.play().catch(() => {});
            else                audioEl.pause();
            updatePlaylineTransport();
        }
    }

    // After a re-render, re-attach the visible playback state if Spotify is
    // still playing this lesson's track. Without this, the button shows the
    // default "Spotify" play state and there's no in-app way to pause —
    // even though audio is still coming out of the SDK player.
    async function rehydrateLessonPlayback(lesson) {
        if (typeof HiFiBuddySpotify === 'undefined') return;
        if (!HiFiBuddySpotify.isPlayerReady?.()) return;
        let state;
        try { state = await HiFiBuddySpotify.getCurrentState(); }
        catch { return; }
        if (!state) return;
        const playingUri = state.track_window?.current_track?.uri;
        if (!playingUri) return;
        const cached = getSpotifyLessonUri(lesson.id);
        if (cached?.uri !== playingUri) return;

        // This lesson's track is loaded in the player. Re-bind everything
        // playFromSpotify would have set up on a fresh play.
        activeSource = 'spotify';
        window.HiFiBuddyActiveSource = 'spotify';
        spotifyState = state;
        if (!playFromSpotify._subscribed) {
            HiFiBuddySpotify.addPlayerListener(s => {
                spotifyState = s;
                updateSpotifyButtonForState(s);
            });
            playFromSpotify._subscribed = true;
        }
        updateSpotifyButtonForState(state);
        showSpotifyQualityInfo();
        startPlaybackTracking(lesson);
    }

    async function playFromSpotify(lesson) {
        const btn = containerEl.querySelector('#hifiPlaySpotify');
        if (!btn) return;
        const setBtn = (label, busy) => {
            btn.disabled = !!busy;
            btn.innerHTML = busy
                ? `<span class="hifi-play-spinner"></span> ${label}`
                : `${HiFiBuddyIcons.spotify({ size: 16, brand: false })} ${label}`;
        };

        try {
            // 1) Ensure SDK player ready
            if (!HiFiBuddySpotify.isPlayerReady()) {
                setBtn('Connecting…', true);
                await HiFiBuddySpotify.ensureSDK();
                await HiFiBuddySpotify.initPlayer();
                // Wait briefly for 'ready' event after connect()
                if (!HiFiBuddySpotify.isPlayerReady()) {
                    await new Promise(resolve => {
                        const t = setTimeout(resolve, 5000);
                        window.addEventListener('hifibuddy-spotify-player-ready', () => {
                            clearTimeout(t); resolve();
                        }, { once: true });
                    });
                }
                if (!HiFiBuddySpotify.isPlayerReady()) {
                    setBtn('Spotify', false);
                    if (typeof HiFiBuddyToast !== 'undefined') {
                        HiFiBuddyToast.error('Spotify player not ready — Premium required');
                    }
                    return;
                }
            }

            // 2) Resolve track URI (persistent cache by lesson id)
            const cached = getSpotifyLessonUri(lesson.id);
            let uri = cached?.uri;
            let durationMs = cached?.durationMs;
            if (!uri) {
                setBtn('Searching Spotify…', true);
                const track = await HiFiBuddySpotify.searchTrack(
                    lesson.track.title, lesson.album.artist, lesson.album.title
                );
                if (!track?.uri) {
                    setBtn('Spotify', false);
                    if (typeof HiFiBuddyToast !== 'undefined') {
                        HiFiBuddyToast.error(`Not found on Spotify: ${lesson.track.title}`);
                    }
                    return;
                }
                uri = track.uri;
                durationMs = track.duration_ms;
                setSpotifyLessonUri(lesson.id, uri, durationMs);
            }

            // 3) Play — first stop any local Plex audio so we don't have two sources
            if (typeof HiFiBuddyAudio !== 'undefined' && HiFiBuddyAudio.stop) {
                try { HiFiBuddyAudio.stop(); } catch { /* ignore */ }
            }
            setBtn('Buffering…', true);
            const ok = await HiFiBuddySpotify.playTrackUri(uri, 0);
            if (!ok) {
                setBtn('Spotify', false);
                if (typeof HiFiBuddyToast !== 'undefined') {
                    HiFiBuddyToast.error('Spotify playback failed');
                }
                return;
            }

            // 4) Mark active source + start tracking + duration check
            activeSource = 'spotify';
            window.HiFiBuddyActiveSource = 'spotify';
            // Subscribe once to keep spotifyState fresh AND push the latest
            // state to the visible button. Without the UI update here, an
            // external pause (e.g., from a phone via Spotify Connect) would
            // leave the in-app button stuck on "Pause".
            if (!playFromSpotify._subscribed) {
                HiFiBuddySpotify.addPlayerListener(state => {
                    spotifyState = state;
                    updateSpotifyButtonForState(state);
                });
                playFromSpotify._subscribed = true;
            }
            // Duration mismatch check using metadata from search
            if (durationMs) {
                checkDurationMismatchMs(durationMs, lesson);
            }
            // Source/quality card with device picker (Spotify Connect transfer)
            showSpotifyQualityInfo();
            startPlaybackTracking(lesson);
            setBtn('Playing on Spotify', false);
            btn.disabled = false;
            btn.style.background = 'rgba(29,185,84,0.18)';
            btn.style.color = '#1db954';
        } catch (e) {
            console.warn('[HiFi] Spotify play error:', e);
            setBtn('Spotify', false);
        }
    }

    // Duration mismatch using a known duration in ms (no audio element involved).
    function checkDurationMismatchMs(actualMs, lesson) {
        const warnEl = containerEl.querySelector('#hifiDurationWarning');
        if (!warnEl) return;
        const expected = parseDurationStr(lesson.track?.duration);
        const actualSecs = actualMs / 1000;
        if (!expected || !actualSecs) { warnEl.style.display = 'none'; return; }
        const delta = Math.round(actualSecs) - expected;
        if (Math.abs(delta) <= 5) { warnEl.style.display = 'none'; return; }
        warnEl.innerHTML = `
            ${HiFiBuddyIcons.warningCompact({ size: 14 })}
            <span><strong>Different version loaded.</strong>
            Expected ${lesson.track.duration}, got ${fmtSecs(actualSecs)} (${delta > 0 ? '+' : ''}${delta}s).
            The lesson timestamps may not line up with this cut.</span>`;
        warnEl.style.display = '';
    }

    function parseDurationStr(s) {
        if (!s) return 0;
        const m = String(s).trim().match(/^(\d+):(\d{1,2})$/);
        if (!m) return 0;
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }

    function fmtSecs(s) {
        s = Math.round(s);
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m}:${String(sec).padStart(2, '0')}`;
    }

    // ===== Playback progress line =====

    function getActiveDurationSecs(lesson) {
        if (activeSource === 'spotify' && spotifyState?.duration) {
            return spotifyState.duration / 1000;
        }
        const audioEl = document.querySelector('audio');
        if (audioEl && isFinite(audioEl.duration) && audioEl.duration > 0) {
            return audioEl.duration;
        }
        return parseDurationStr(lesson?.track?.duration) || 0;
    }

    function showPlayline(lesson) {
        const line = containerEl?.querySelector('#hifiPlayline');
        if (!line) return;
        const sourceEl = line.querySelector('#hifiPlaylineSource');
        if (sourceEl) {
            sourceEl.className = `hifi-playline-source hifi-playline-source-${activeSource || 'none'}`;
            // Render icon + label; updatePlaylineTransport handles the
            // play/pause distinction based on current state.
            updatePlaylineTransport();
            // Bind the click-to-toggle handler once per element.
            if (!sourceEl._toggleBound) {
                sourceEl.addEventListener('click', () => { togglePlaylineTransport(); });
                sourceEl._toggleBound = true;
            }
        }
        const total = getActiveDurationSecs(lesson);
        const totalEl = line.querySelector('#hifiPlaylineTotal');
        if (totalEl) totalEl.textContent = fmtSecs(total);
        line.style.display = '';

        // Click-to-seek on the progress bar
        const trackEl = line.querySelector('#hifiPlaylineTrack');
        if (trackEl && !trackEl._seekBound) {
            trackEl.addEventListener('click', async (e) => {
                if (activeSource === null) return;
                const rect = trackEl.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const dur = getActiveDurationSecs(lesson);
                if (!dur) return;
                await seekActiveTo(ratio * dur);
            });
            trackEl._seekBound = true;
        }
    }

    function hidePlayline() {
        const line = containerEl?.querySelector('#hifiPlayline');
        if (line) line.style.display = 'none';
    }

    function updatePlayline(lesson, currentTimeSecs) {
        const line = containerEl?.querySelector('#hifiPlayline');
        if (!line || line.style.display === 'none') return;
        const total = getActiveDurationSecs(lesson);
        const fill = line.querySelector('#hifiPlaylineFill');
        const cur = line.querySelector('#hifiPlaylineCurrent');
        const totalEl = line.querySelector('#hifiPlaylineTotal');
        if (cur) cur.textContent = fmtSecs(currentTimeSecs);
        if (totalEl && total) totalEl.textContent = fmtSecs(total);
        if (fill && total > 0) {
            fill.style.width = `${Math.min(100, (currentTimeSecs / total) * 100)}%`;
        }
        // Keep the play/pause icon synced with the current source state.
        // For Spotify the player_state_changed listener also pushes here, but
        // for Plex/Local this is the cheapest sync path.
        updatePlaylineTransport();
    }

    function checkDurationMismatch(audioEl, lesson) {
        const warnEl = containerEl.querySelector('#hifiDurationWarning');
        if (!warnEl) return;
        const expected = parseDurationStr(lesson.track?.duration);
        const actual = audioEl.duration;
        if (!expected || !actual || !isFinite(actual)) {
            warnEl.style.display = 'none';
            return;
        }
        const delta = Math.round(actual) - expected;
        if (Math.abs(delta) <= 5) {
            warnEl.style.display = 'none';
            return;
        }
        warnEl.innerHTML = `
            ${HiFiBuddyIcons.warningCompact({ size: 14 })}
            <span><strong>Different version loaded.</strong>
            Expected ${lesson.track.duration}, got ${fmtSecs(actual)} (${delta > 0 ? '+' : ''}${delta}s).
            The lesson timestamps may not line up with this cut.</span>`;
        warnEl.style.display = '';
    }

    function updateAlbumArt(thumbUrl) {
        const artEl = containerEl.querySelector('.hifi-album-art');
        if (artEl) {
            artEl.src = thumbUrl;
            artEl.style.display = 'block';
            // Hide vinyl placeholder when real art loads
            const vinyl = containerEl.querySelector('.hifi-album-vinyl');
            if (vinyl) vinyl.style.display = 'none';
        }
    }

    async function fetchAlbumArt(lesson) {
        // 1. Try Plex library match first
        if (typeof HiFiBuddyPlex !== 'undefined' && HiFiBuddyPlex.isConnected?.()) {
            const match = HiFiBuddyPlex.matchAlbum(lesson.album.title, lesson.album.artist);
            if (match?.thumb) {
                const thumbUrl = HiFiBuddyPlex.getThumbUrl(match.thumb);
                if (thumbUrl) { updateAlbumArt(thumbUrl); return; }
            }
        }

        // 2. Try MusicBrainz Cover Art Archive
        try {
            const query = encodeURIComponent(`"${lesson.album.title}" AND artist:"${lesson.album.artist}"`);
            const mbResp = await fetch(`https://musicbrainz.org/ws/2/release-group?query=${query}&limit=1&fmt=json`, {
                headers: { 'User-Agent': 'HiFiBuddy/1.0 (music-genre-explorer)' }
            });
            if (mbResp.ok) {
                const mbData = await mbResp.json();
                const rg = mbData?.['release-groups']?.[0];
                if (rg?.id) {
                    const coverUrl = `https://coverartarchive.org/release-group/${rg.id}/front-250`;
                    // Test if cover exists (HEAD request)
                    const testResp = await fetch(coverUrl, { method: 'HEAD' });
                    if (testResp.ok || testResp.redirected) {
                        updateAlbumArt(coverUrl);
                        return;
                    }
                }
            }
        } catch (e) {
            // MusicBrainz not available — ignore
        }
    }

    function scoreAudioQuality(quality) {
        if (!quality) return { score: 0, label: 'Unknown', color: '#5a5a78' };
        let score = 0;
        const reasons = [];

        // Codec scoring (0-40 points)
        const codec = quality.codec.toLowerCase();
        if (['flac', 'alac', 'wav', 'aiff', 'dsd'].includes(codec)) {
            score += 40;
            reasons.push('Lossless codec');
        } else if (['aac', 'ogg', 'opus'].includes(codec)) {
            score += 25;
            reasons.push('Lossy (good)');
        } else if (codec === 'mp3') {
            score += quality.bitrate >= 320 ? 20 : quality.bitrate >= 256 ? 15 : 10;
            reasons.push(`MP3 ${quality.bitrate}kbps`);
        } else {
            score += 10;
        }

        // Bit depth scoring (0-25 points)
        if (quality.bitDepth >= 24) {
            score += 25;
            reasons.push('Hi-Res (24-bit)');
        } else if (quality.bitDepth === 16) {
            score += 15;
            reasons.push('CD quality (16-bit)');
        }

        // Sample rate scoring (0-25 points)
        if (quality.sampleRate >= 96000) {
            score += 25;
            reasons.push(`${quality.sampleRate / 1000}kHz`);
        } else if (quality.sampleRate >= 48000) {
            score += 18;
            reasons.push('48kHz');
        } else if (quality.sampleRate >= 44100) {
            score += 15;
            reasons.push('44.1kHz');
        }

        // Bitrate bonus for lossless (0-10 points)
        if (['flac', 'alac', 'wav', 'aiff'].includes(codec) && quality.bitrate > 1000) {
            score += 10;
            reasons.push(`${Math.round(quality.bitrate / 1000 * 10) / 10} Mbps`);
        }

        // Determine label and color
        let label, color, stars;
        if (score >= 85) {
            label = 'Audiophile'; color = '#2ecc71'; stars = 5;
        } else if (score >= 70) {
            label = 'Hi-Res'; color = '#667eea'; stars = 4;
        } else if (score >= 50) {
            label = 'CD Quality'; color = '#e6a817'; stars = 3;
        } else if (score >= 30) {
            label = 'Good'; color = '#e67e22'; stars = 2;
        } else {
            label = 'Compressed'; color = '#e05555'; stars = 1;
        }
        const STAR_FILLED = HiFiBuddyIcons.starFilled5({ size: 11 });
        const STAR_EMPTY = HiFiBuddyIcons.starOutline5({ size: 11 });
        const icon = STAR_FILLED.repeat(stars) + STAR_EMPTY.repeat(5 - stars);

        return { score, label, color, icon, reasons, codec: quality.codec, bitDepth: quality.bitDepth, sampleRate: quality.sampleRate };
    }

    // Spotify-specific source/quality info card. Shown when SDK playback starts.
    // Tells the user the bitrate cap and recommends Plex when lossless matters.
    function showSpotifyQualityInfo(deviceLabel) {
        containerEl.querySelector('.hifi-quality-card')?.remove();

        const onWebSDK = !deviceLabel || deviceLabel === 'HiFi Buddy';
        const heading = onWebSDK ? 'Source: Spotify Web Player' : `Source: Spotify · ${deviceLabel}`;
        // Web SDK is hard-capped at 256kbps Ogg; transferred devices may be higher (320kbps Premium / HiFi)
        const detail = onWebSDK
            ? 'Premium · ~256 kbps Ogg Vorbis (Web SDK cap)'
            : 'Streaming via Spotify Connect (quality controlled by the target device)';
        const meterPct = onWebSDK ? 50 : 65;
        const color = '#e6a817'; // amber — lossy
        const STAR_F_S = HiFiBuddyIcons.starFilled5({ size: 10 });
        const lossyStars = STAR_F_S.repeat(3);
        const icon = onWebSDK ? `${lossyStars} Lossy` : `${lossyStars} Lossy/Connect`;
        const WARN_INLINE = HiFiBuddyIcons.warning({ size: 13, style: 'vertical-align:-2px;margin-right:4px' });
        const warn = onWebSDK
            ? `<span class="hifi-quality-warn">${WARN_INLINE}Spotify Web SDK is capped at ~256 kbps. For lossless critical listening on this lesson, use Plex (FLAC) — or transfer playback to your Spotify desktop app for up to 320 kbps.</span>`
            : `<span class="hifi-quality-warn">${WARN_INLINE}Quality depends on the target device. For lossless, Plex (FLAC) remains the reference source.</span>`;

        const badge = document.createElement('div');
        badge.className = 'hifi-quality-card hifi-quality-spotify';
        badge.innerHTML = `
            <div class="hifi-quality-header">
                ${HiFiBuddyIcons.spotify({ size: 18 })}
                <span class="hifi-quality-label">${heading}</span>
                <span class="hifi-quality-score" style="background: ${color}20; color: ${color}">${icon}</span>
                <button class="hifi-spotify-devices-btn" id="hifiSpotifyDevices" title="Transfer playback to another Spotify device" aria-label="Choose Spotify device" aria-expanded="false" aria-controls="hifiSpotifyDeviceList">
                    ${HiFiBuddyIcons.devices({ size: 14 })}
                    Devices
                </button>
            </div>
            <div class="hifi-quality-details">${detail}</div>
            <div class="hifi-quality-meter">
                <div class="hifi-quality-meter-fill" style="width: ${meterPct}%; background: ${color}"></div>
            </div>
            ${warn}
            <div class="hifi-spotify-device-list" id="hifiSpotifyDeviceList" style="display:none"></div>
        `;
        const trackCard = containerEl.querySelector('.hifi-track-card');
        if (trackCard) trackCard.after(badge);

        // Wire device picker
        badge.querySelector('#hifiSpotifyDevices')?.addEventListener('click', async () => {
            const listEl = badge.querySelector('#hifiSpotifyDeviceList');
            const btn = badge.querySelector('#hifiSpotifyDevices');
            if (listEl.style.display !== 'none') {
                listEl.style.display = 'none';
                btn?.setAttribute('aria-expanded', 'false');
                return;
            }
            listEl.style.display = 'block';
            btn?.setAttribute('aria-expanded', 'true');
            listEl.innerHTML = '<div class="hifi-spotify-devices-loading"><span class="hifi-play-spinner"></span> Loading devices…</div>';
            const devices = await HiFiBuddySpotify.listDevices();
            const currentId = HiFiBuddySpotify.getCurrentDeviceId();
            if (!devices.length) {
                listEl.innerHTML = '<div class="hifi-spotify-devices-empty">No other devices online. Open the Spotify desktop app, mobile app, or a Spotify Connect speaker on the same account to see them here.</div>';
                return;
            }
            listEl.innerHTML = devices.map(d => {
                const isThis = d.id === currentId || d.name === 'HiFi Buddy';
                const cls = isThis ? 'hifi-spotify-device hifi-device-active' : 'hifi-spotify-device';
                const ICON_COMPUTER = HiFiBuddyIcons.computer({ size: 16 });
                const ICON_PHONE = HiFiBuddyIcons.phone({ size: 16 });
                const ICON_SPEAKER = HiFiBuddyIcons.speaker({ size: 16 });
                const ICON_TV = HiFiBuddyIcons.tv({ size: 16 });
                const ICON_HEADPHONES = HiFiBuddyIcons.headphones({ size: 16 });
                const icon = d.type === 'Computer' ? ICON_COMPUTER : d.type === 'Smartphone' ? ICON_PHONE : d.type === 'Speaker' ? ICON_SPEAKER : d.type === 'TV' ? ICON_TV : ICON_HEADPHONES;
                const note = isThis ? '<span class="hifi-device-tag">Active (this browser)</span>' :
                              d.is_active ? '<span class="hifi-device-tag">Currently active</span>' : '';
                return `<button class="${cls}" data-device-id="${d.id}" ${isThis ? 'disabled' : ''}>
                    <span class="hifi-device-icon">${icon}</span>
                    <span class="hifi-device-name">${d.name}</span>
                    <span class="hifi-device-type">${d.type}</span>
                    ${note}
                </button>`;
            }).join('');

            listEl.querySelectorAll('.hifi-spotify-device[data-device-id]').forEach(btn => {
                if (btn.disabled) return;
                btn.addEventListener('click', async () => {
                    const targetId = btn.dataset.deviceId;
                    const targetName = btn.querySelector('.hifi-device-name')?.textContent || 'device';
                    btn.innerHTML = `<span class="hifi-play-spinner"></span> Transferring to ${targetName}…`;
                    const ok = await HiFiBuddySpotify.transferPlayback(targetId, true);
                    if (ok) {
                        if (typeof HiFiBuddyToast !== 'undefined') {
                            HiFiBuddyToast.success(`Playback transferred to ${targetName}`);
                        }
                        // Refresh the source label/quality info
                        showSpotifyQualityInfo(targetName);
                    } else {
                        if (typeof HiFiBuddyToast !== 'undefined') {
                            HiFiBuddyToast.error('Transfer failed');
                        }
                    }
                });
            });
        });
    }

    function showQualityBadge(quality) {
        const existing = containerEl.querySelector('.hifi-quality-card');
        if (existing) existing.remove();

        const scored = scoreAudioQuality(quality);
        const formatStr = [
            quality.codec,
            quality.bitDepth ? `${quality.bitDepth}-bit` : '',
            quality.sampleRate ? `${quality.sampleRate / 1000}kHz` : '',
            quality.channels > 2 ? `${quality.channels}ch` : 'Stereo',
            quality.bitrate ? `${quality.bitrate}kbps` : '',
        ].filter(Boolean).join(' · ');

        const isBest = scored.score >= 70;
        const CHECK_INLINE = HiFiBuddyIcons.check({ size: 13, strokeWidth: 2.5, style: 'vertical-align:-2px;margin-right:4px' });
        const WARN_INLINE2 = HiFiBuddyIcons.warning({ size: 13, style: 'vertical-align:-2px;margin-right:4px' });
        const bestNote = isBest
            ? `<span class="hifi-quality-best">${CHECK_INLINE}Great source for this lesson</span>`
            : `<span class="hifi-quality-warn">${WARN_INLINE2}For best results, use lossless (FLAC/ALAC) at 16-bit/44.1kHz or higher</span>`;

        const badge = document.createElement('div');
        badge.className = 'hifi-quality-card';
        badge.innerHTML = `
            <div class="hifi-quality-header">
                <span style="color:${scored.color};display:inline-flex">${HiFiBuddyIcons.music({ size: 18 })}</span>
                <span class="hifi-quality-label">Source Quality</span>
                <span class="hifi-quality-score" style="background: ${scored.color}20; color: ${scored.color}">
                    ${scored.icon} ${scored.label}
                </span>
            </div>
            <div class="hifi-quality-details">${formatStr}</div>
            <div class="hifi-quality-meter">
                <div class="hifi-quality-meter-fill" style="width: ${scored.score}%; background: ${scored.color}"></div>
            </div>
            ${bestNote}
        `;

        // Insert after the track card
        const trackCard = containerEl.querySelector('.hifi-track-card');
        if (trackCard) trackCard.after(badge);
    }

    // ==================== INTERACTIVE PLAYBACK ====================

    function parseTimestamp(ts) {
        // Parse "M:SS" or "MM:SS" to seconds
        const parts = ts.split(':');
        if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
        if (parts.length === 3) return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
        return 0;
    }

    function parseTimeRange(timeStr) {
        // Parse "0:00-0:30" or "3:15-4:00" to { start, end } in seconds
        const parts = timeStr.split('-');
        return {
            start: parseTimestamp(parts[0].trim()),
            end: parts[1] ? parseTimestamp(parts[1].trim()) : parseTimestamp(parts[0].trim()) + 30
        };
    }

    function startPlaybackTracking(lesson) {
        stopPlaybackTracking();

        const items = containerEl.querySelectorAll('.hifi-listen-item');
        if (!items.length) return;

        // Parse time ranges for each listen item — honoring user overrides.
        const ranges = lesson.guide.listenFor.map(item => parseTimeRange(getDisplayTime(lesson, item)));

        showPlayline(lesson);

        playbackTracker = setInterval(async () => {
            // Refresh Spotify state before reading
            if (activeSource === 'spotify' && typeof HiFiBuddySpotify !== 'undefined') {
                try { spotifyState = await HiFiBuddySpotify.getCurrentState(); } catch { /* ignore */ }
            }
            if (isActivePaused()) return;

            const currentTime = getCurrentTimeSecs();
            updatePlayline(lesson, currentTime);

            // Update playback indicator
            const indicator = containerEl.querySelector('.hifi-playback-time');
            if (indicator) {
                const min = Math.floor(currentTime / 60);
                const sec = Math.floor(currentTime % 60);
                indicator.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
                indicator.classList.add('visible');
            }

            // Highlight the active listen-for item
            let activeIdx = -1;
            for (let i = 0; i < ranges.length; i++) {
                if (currentTime >= ranges[i].start && currentTime <= ranges[i].end) {
                    activeIdx = i;
                    break;
                }
                // Also highlight if we're between this item's start and the next item's start
                if (currentTime >= ranges[i].start && (i === ranges.length - 1 || currentTime < ranges[i + 1].start)) {
                    activeIdx = i;
                    break;
                }
            }

            items.forEach((item, idx) => {
                const wasActive = item.classList.contains('hifi-active');
                item.classList.toggle('hifi-active', idx === activeIdx);

                // Auto-scroll to newly active item
                if (idx === activeIdx && !wasActive) {
                    item.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            });
        }, 500);
    }

    function stopPlaybackTracking() {
        if (playbackTracker) {
            clearInterval(playbackTracker);
            playbackTracker = null;
        }
        // Remove active states
        containerEl?.querySelectorAll('.hifi-listen-item.hifi-active').forEach(el => {
            el.classList.remove('hifi-active');
        });
        const indicator = containerEl?.querySelector('.hifi-playback-time');
        if (indicator) indicator.classList.remove('visible');
    }

    // ==================== LISTENING COACH ====================

    async function sendCoachMessage(lesson) {
        const input = containerEl.querySelector('#hifiCoachInput');
        const msgContainer = containerEl.querySelector('#hifiCoachMessages');
        if (!input || !msgContainer) return;

        const text = input.value.trim();
        if (!text) return;
        input.value = '';

        // Add user message
        coachMessages.push({ role: 'user', content: text });
        const userBubble = document.createElement('div');
        userBubble.className = 'hifi-coach-msg hifi-coach-user';
        userBubble.textContent = text;
        msgContainer.appendChild(userBubble);

        // Typing indicator
        const typing = document.createElement('div');
        typing.className = 'hifi-coach-msg hifi-coach-assistant hifi-coach-typing';
        typing.innerHTML = '<span></span><span></span><span></span>';
        msgContainer.appendChild(typing);
        msgContainer.scrollTop = msgContainer.scrollHeight;

        // Build context
        const audioEl = document.querySelector('audio');
        const currentPos = audioEl && !audioEl.paused ? `${Math.floor(audioEl.currentTime / 60)}:${Math.floor(audioEl.currentTime % 60).toString().padStart(2, '0')}` : 'not playing';

        const skillNames = lesson.skills.map(sid => guideData.skills.find(s => s.id === sid)?.name || sid).join(', ');
        const listenPoints = lesson.guide.listenFor.map(l => `[${l.time}] ${l.skill}: ${l.note}`).join('\n');
        const userSkills = Object.entries(progress.skillScores).map(([k, v]) => `${k}: ${v} lessons`).join(', ') || 'none yet';

        const systemPrompt = `You are a friendly, expert audiophile listening coach embedded in a lesson about "${lesson.track.title}" by ${lesson.album.artist} (album: ${lesson.album.title}).

Current lesson focus: ${skillNames}
Track position: ${currentPos}
User's skill progress: ${userSkills}

Lesson listening guide:
${listenPoints}

Lesson intro: ${lesson.guide.intro}
Takeaway: ${lesson.guide.takeaway}
Equipment note: ${lesson.equipment.source}

Guidelines:
- Keep responses concise (2-4 sentences), practical and encouraging
- Reference specific moments in THIS track when relevant
- If the user asks about what they're hearing right now, use the current track position (${currentPos}) to reference the nearest listening guide point
- Suggest concrete listening techniques ("try closing your eyes", "focus on the left channel", "compare the attack of the snare")
- You can reference other classic audiophile recordings for comparison
- Be warm and supportive — critical listening is a skill that develops over time`;

        try {
            const response = await callAI(systemPrompt, coachMessages.slice(-8));
            typing.remove();

            coachMessages.push({ role: 'assistant', content: response });
            const aiBubble = document.createElement('div');
            aiBubble.className = 'hifi-coach-msg hifi-coach-assistant';
            aiBubble.innerHTML = response.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
            msgContainer.appendChild(aiBubble);
        } catch (e) {
            typing.remove();
            const errBubble = document.createElement('div');
            errBubble.className = 'hifi-coach-msg hifi-coach-error';
            // Surface the actual reason so users can act on it, not a generic
            // "check settings" prompt.
            const detail = e?.message || String(e) || 'unknown error';
            const strong = document.createElement('strong');
            strong.textContent = 'Coach unavailable. ';
            const detailSpan = document.createElement('span');
            detailSpan.textContent = detail;
            const hint = document.createElement('em');
            hint.textContent = 'Check Ollama URL / Claude API key in Settings, or try again.';
            errBubble.appendChild(strong);
            errBubble.appendChild(detailSpan);
            errBubble.appendChild(document.createElement('br'));
            errBubble.appendChild(hint);
            msgContainer.appendChild(errBubble);
            if (typeof HiFiBuddyToast !== 'undefined') {
                HiFiBuddyToast.show({
                    type: 'error',
                    message: 'AI coach failed: ' + detail,
                    details: e?.stack || detail,
                    action: { label: 'Open Settings', onClick: () => document.getElementById('settingsBtn')?.click() },
                });
            }
        }

        msgContainer.scrollTop = msgContainer.scrollHeight;
    }

    // ==================== A/B QUALITY COMPARISON ====================

    function activateABMode(losslessUrl, ratingKey, quality) {
        if (!ratingKey || typeof HiFiBuddyPlex === 'undefined') return;

        const lossyUrl = HiFiBuddyPlex.getTranscodeUrl(ratingKey);
        if (!lossyUrl) return;

        abMode = true;
        abSources = { lossless: losslessUrl, lossy: lossyUrl };
        abCurrent = 'lossless';

        // Show the A/B button and format info
        const abBtn = containerEl.querySelector('#hifiABToggle');
        if (abBtn) abBtn.style.display = '';

        const formatEl = containerEl.querySelector('#hifiABLosslessFormat');
        if (formatEl && quality) {
            formatEl.textContent = `${quality.codec} ${quality.bitDepth ? quality.bitDepth + '-bit' : ''} ${quality.sampleRate ? (quality.sampleRate / 1000) + 'kHz' : ''}`.trim();
        }
    }

    function switchABSource(source) {
        if (!abMode || !abSources[source]) return;

        const audioEl = document.querySelector('audio');
        if (!audioEl) return;

        const wasPlaying = !audioEl.paused;
        const pos = audioEl.currentTime;
        abCurrent = source;

        // Swap source
        audioEl.src = abSources[source];
        audioEl.currentTime = pos;
        if (wasPlaying) audioEl.play().catch(() => {});

        // Update UI
        const losslessBtn = containerEl.querySelector('#hifiABLossless');
        const lossyBtn = containerEl.querySelector('#hifiABLossy');
        if (losslessBtn) losslessBtn.classList.toggle('hifi-ab-active', source === 'lossless');
        if (lossyBtn) lossyBtn.classList.toggle('hifi-ab-active', source === 'lossy');

        // Flash indicator
        const panel = containerEl.querySelector('#hifiABPanel');
        if (panel) {
            panel.classList.add('hifi-ab-flash');
            setTimeout(() => panel.classList.remove('hifi-ab-flash'), 300);
        }
    }

    function stopABMode() {
        abMode = false;
        abSources = { lossless: null, lossy: null };
        abCurrent = 'lossless';
    }

    // ==================== SHARED AI HELPER ====================

    // opts.jsonMode (default false): set to true ONLY when the caller is going
    // to JSON.parse the result. Forces Ollama into strict-JSON mode and tells
    // the model to skip prose. The Listening Coach wants chat prose, NOT JSON,
    // so it must NOT pass jsonMode.
    async function callAI(systemPrompt, messagesOrText, opts = {}) {
        const S = (typeof HiFiBuddySettings !== 'undefined') ? HiFiBuddySettings : null;
        const ollamaUrl = S?.getOllamaUrl?.() || '';
        const ollamaModel = S?.getOllamaModel?.() || 'gemma2:9b';
        const claudeKey = S?.getClaudeApiKey?.() || '';

        const messages = typeof messagesOrText === 'string'
            ? [{ role: 'user', content: messagesOrText }]
            : Array.isArray(messagesOrText)
                ? messagesOrText
                : [{ role: 'user', content: String(messagesOrText) }];

        let data;
        if (ollamaUrl) {
            const body = {
                ollamaUrl, model: ollamaModel,
                system: systemPrompt, messages,
            };
            if (opts.jsonMode) body.format = 'json';
            let res;
            try {
                res = await fetch('/api/ollama', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
            } catch (e) {
                throw new Error(`Ollama unreachable at ${ollamaUrl}: ${e?.message || e}`);
            }
            if (!res.ok) {
                let bodyText = '';
                try { bodyText = (await res.text()).slice(0, 500); } catch { /* ignore */ }
                throw new Error(`Ollama returned ${res.status} (${bodyText || 'no body'}). Verify the URL and that model "${ollamaModel}" is pulled.`);
            }
            data = await res.json();
        } else if (claudeKey) {
            let res;
            try {
                res = await fetch('/api/claude', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiKey: claudeKey, model: 'claude-sonnet-4-6', max_tokens: 1024, system: systemPrompt, messages })
                });
            } catch (e) {
                throw new Error(`Claude API unreachable: ${e?.message || e}`);
            }
            if (!res.ok) {
                let bodyText = '';
                try { bodyText = (await res.text()).slice(0, 500); } catch { /* ignore */ }
                throw new Error(`Claude returned ${res.status} (${bodyText || 'no body'}). Check your API key in Settings.`);
            }
            data = await res.json();
        } else {
            throw new Error('No AI backend configured. Set up Ollama or Claude API key in Settings.');
        }

        // Handle both backends:
        //   Claude: { content: [{type: "text", text: "..."}], ... }
        //   Ollama: { message: { role: "assistant", content: "..." }, ... }
        return data.content?.[0]?.text
            || data.message?.content
            || data.response
            || '';
    }

    // ==================== HELPERS ====================

    function getSkillsLearned() {
        return Object.keys(progress.skillScores).length;
    }

    return { init, render };
})();

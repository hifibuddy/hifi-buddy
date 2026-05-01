/**
 * HiFi Buddy Timing Feedback
 *
 * Lets users correct timestamp drift in lesson "listenFor" segments and
 * persist those corrections per-user in localStorage. Corrections are
 * exportable as JSON for upstream submission to the lesson maintainer.
 *
 * Storage shape (localStorage.hifibuddy_timing_overrides):
 *   {
 *     "lesson-001": {
 *       "0:15-0:55": "1:30-2:00",
 *       "0:55-1:15": "2:00-2:30"
 *     },
 *     ...
 *   }
 *
 * Keys are the canonical M:SS-M:SS strings from data/hifi-guide.json.
 * Values are user-corrected M:SS-M:SS strings. Validation enforces
 * end > start and (when track duration is supplied) end <= duration.
 */
window.HiFiBuddyTimingFeedback = (() => {
    'use strict';

    const STORAGE_KEY = 'hifibuddy_timing_overrides';
    const EDIT_MODE_KEY = 'hifibuddy_timing_edit_mode';
    const EXPORT_VERSION = 1;

    let overrides = {};      // { lessonId: { originalTime: correctedTime } }
    let editMode = false;
    const subscribers = new Set();
    let initialized = false;

    // ---------- helpers ----------

    function loadOverrides() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    function persistOverrides() {
        // Local mirror — keeps reads fast and survives offline use.
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
        } catch (e) {
            console.warn('[TimingFeedback] Failed to persist overrides:', e);
        }
        // Durable copy on the server. Whole-replace POST since the dataset
        // is small (one entry per edited lesson) and merging diffs is more
        // error-prone than just sending the full state we have in memory.
        fetch('/api/timing/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(overrides),
        }).catch(() => { /* offline — localStorage has it; init() will sync on next boot */ });
    }

    function loadEditMode() {
        try {
            return localStorage.getItem(EDIT_MODE_KEY) === '1';
        } catch {
            return false;
        }
    }

    function persistEditMode() {
        try {
            localStorage.setItem(EDIT_MODE_KEY, editMode ? '1' : '0');
        } catch { /* ignore */ }
    }

    function notify() {
        subscribers.forEach(fn => {
            try { fn(editMode); } catch (e) { console.warn('[TimingFeedback] subscriber error:', e); }
        });
    }

    // Parse a single "M:SS" or "MM:SS" timestamp. Returns seconds, or null on failure.
    function parseTimestamp(s) {
        if (typeof s !== 'string') return null;
        const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
        if (!m) return null;
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        if (sec >= 60) return null;
        return min * 60 + sec;
    }

    // Parse "M:SS-M:SS" range. Returns { start, end } in seconds, or null.
    function parseRange(rangeStr) {
        if (typeof rangeStr !== 'string') return null;
        const parts = rangeStr.split('-');
        if (parts.length !== 2) return null;
        const start = parseTimestamp(parts[0]);
        const end = parseTimestamp(parts[1]);
        if (start === null || end === null) return null;
        return { start, end };
    }

    // Validate a candidate corrected M:SS-M:SS string.
    // Throws Error with a friendly message on failure.
    function validateRange(rangeStr, opts = {}) {
        const r = parseRange(rangeStr);
        if (!r) {
            throw new Error('Invalid format. Use M:SS-M:SS (e.g. 1:30-2:00).');
        }
        if (r.end <= r.start) {
            throw new Error('End must be after start.');
        }
        if (typeof opts.durationSecs === 'number' && opts.durationSecs > 0) {
            if (r.end > Math.ceil(opts.durationSecs)) {
                throw new Error('End is past track duration.');
            }
        }
        return r;
    }

    function formatTimestamp(secs) {
        const s = Math.max(0, Math.floor(secs));
        const min = Math.floor(s / 60);
        const sec = s % 60;
        return `${min}:${sec.toString().padStart(2, '0')}`;
    }

    function formatRange(startSecs, endSecs) {
        return `${formatTimestamp(startSecs)}-${formatTimestamp(endSecs)}`;
    }

    function isValidRangeString(rangeStr) {
        try {
            validateRange(rangeStr);
            return true;
        } catch {
            return false;
        }
    }

    // ---------- public API ----------

    async function init() {
        if (initialized) return;
        overrides = loadOverrides();   // start from localStorage (fast)
        editMode = loadEditMode();

        // Reconcile with the server's view at ~/.hifi-buddy/timing_feedback.json:
        // server is durable, so anything it has trumps local on a per-key basis.
        // Anything localStorage has that the server doesn't gets pushed up.
        let serverOverrides = null;
        try {
            const res = await fetch('/api/timing/feedback', { cache: 'no-store' });
            if (res.ok) serverOverrides = await res.json();
        } catch { /* server unreachable — keep localStorage */ }

        if (serverOverrides && typeof serverOverrides === 'object') {
            let needPush = false;
            const merged = { ...serverOverrides };
            for (const lid of Object.keys(overrides || {})) {
                const localMap = overrides[lid] || {};
                if (!merged[lid]) {
                    merged[lid] = { ...localMap };
                    needPush = true;
                    continue;
                }
                for (const orig of Object.keys(localMap)) {
                    if (!(orig in merged[lid])) {
                        merged[lid][orig] = localMap[orig];
                        needPush = true;
                    }
                }
            }
            overrides = merged;
            // Mirror back to localStorage so synchronous readers see the
            // merged set immediately.
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)); }
            catch { /* quota — leave it */ }
            if (needPush) {
                try {
                    await fetch('/api/timing/feedback', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(overrides),
                    });
                } catch { /* offline — try again next boot */ }
            }
        }

        initialized = true;
    }

    function isEditMode() {
        return editMode;
    }

    function toggleEditMode(force) {
        editMode = typeof force === 'boolean' ? force : !editMode;
        persistEditMode();
        notify();
        return editMode;
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        subscribers.add(fn);
        return () => subscribers.delete(fn);
    }

    function getOverride(lessonId, originalTime) {
        if (!lessonId || !originalTime) return null;
        const lessonMap = overrides[lessonId];
        if (!lessonMap) return null;
        return lessonMap[originalTime] || null;
    }

    function getOverridesForLesson(lessonId) {
        if (!lessonId) return {};
        return { ...(overrides[lessonId] || {}) };
    }

    function setOverride(lessonId, originalTime, correctedTime, opts = {}) {
        if (!lessonId || !originalTime) {
            throw new Error('lessonId and originalTime required.');
        }
        // Validate the canonical key shape too — silently allow non-standard
        // keys, but at least sanity-check the corrected value.
        validateRange(correctedTime, opts);

        // No-op: corrected matches canonical → treat as clear.
        if (correctedTime === originalTime) {
            clearOverride(lessonId, originalTime);
            return;
        }

        if (!overrides[lessonId]) overrides[lessonId] = {};
        overrides[lessonId][originalTime] = correctedTime;
        persistOverrides();
    }

    function clearOverride(lessonId, originalTime) {
        if (!lessonId || !originalTime) return;
        const lessonMap = overrides[lessonId];
        if (!lessonMap) return;
        if (originalTime in lessonMap) {
            delete lessonMap[originalTime];
            if (Object.keys(lessonMap).length === 0) delete overrides[lessonId];
            persistOverrides();
        }
    }

    function clearAllForLesson(lessonId) {
        if (!lessonId) return;
        if (overrides[lessonId]) {
            delete overrides[lessonId];
            persistOverrides();
        }
    }

    function countOverrides() {
        let n = 0;
        for (const lessonId in overrides) {
            n += Object.keys(overrides[lessonId] || {}).length;
        }
        return n;
    }

    function exportAll() {
        return {
            version: EXPORT_VERSION,
            exportedAt: new Date().toISOString(),
            totalCorrections: countOverrides(),
            lessons: JSON.parse(JSON.stringify(overrides)),
        };
    }

    // Merges imported overrides on top of existing. New value wins on conflict.
    // Returns count of corrections imported (after validation).
    function importAll(payload) {
        let parsed = payload;
        if (typeof parsed === 'string') {
            try { parsed = JSON.parse(parsed); }
            catch (e) { throw new Error('Invalid JSON: ' + e.message); }
        }
        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Import payload must be an object.');
        }
        // Accept either { lessons: {...} } (export shape) or raw {...} (storage shape).
        const lessons = parsed.lessons && typeof parsed.lessons === 'object'
            ? parsed.lessons
            : parsed;

        let imported = 0;
        for (const lessonId in lessons) {
            const lessonMap = lessons[lessonId];
            if (!lessonMap || typeof lessonMap !== 'object') continue;
            for (const originalTime in lessonMap) {
                const correctedTime = lessonMap[originalTime];
                if (typeof correctedTime !== 'string') continue;
                if (!isValidRangeString(correctedTime)) continue;
                if (!overrides[lessonId]) overrides[lessonId] = {};
                overrides[lessonId][originalTime] = correctedTime;
                imported++;
            }
        }
        if (imported > 0) persistOverrides();
        return imported;
    }

    // Auto-init on script load so callers don't have to remember.
    init();

    return {
        init,
        isEditMode,
        toggleEditMode,
        subscribe,
        getOverride,
        getOverridesForLesson,
        setOverride,
        clearOverride,
        clearAllForLesson,
        exportAll,
        importAll,
        countOverrides,
        // Exposed for hifi-buddy.js wiring (formatting/validation reuse):
        _utils: {
            parseRange,
            parseTimestamp,
            validateRange,
            formatTimestamp,
            formatRange,
            isValidRangeString,
        },
    };
})();

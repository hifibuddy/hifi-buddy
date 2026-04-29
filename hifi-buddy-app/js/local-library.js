/**
 * HiFi Buddy Local Library
 *
 * Client wrapper for the /api/local/* endpoints. Builds a normalized lookup
 * index so lessons can be matched to local files by (artist, title) — with a
 * MusicBrainz Recording ID short-circuit when both sides have one.
 *
 * Surface (intentionally small):
 *   loadIndex()                  → fetch /api/local/index, populate cache
 *   rescan(folder)               → POST /api/local/scan, repopulate cache
 *   findTrack(title, artist, mbid?) → matched entry { id, ...meta } or null
 *   getStreamUrl(trackId)        → /api/local/stream/<id>
 *   getTranscodedUrl(trackId, kbps) → /api/local/transcode/<id>?bitrate=N
 *   isAvailable()                → folder configured AND index has entries
 *   isFFmpegAvailable()          → cached probe (refreshed on loadIndex)
 *   probe()                      → manual capability refresh
 */
window.HiFiBuddyLocalLibrary = (() => {
    'use strict';

    let index = null;          // raw array of { id, path, title, artist, album, duration, codec, mbid }
    let folder = '';           // server-known folder path (display only)
    let indexByKey = null;     // Map<"artistnorm|titlenorm", entry>
    let indexByMbid = null;    // Map<mbid, entry>
    let caps = { ffmpeg: false, mutagen: false };
    let loaded = false;

    function normalize(s) {
        return (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function buildLookups(tracks) {
        indexByKey = new Map();
        indexByMbid = new Map();
        for (const t of tracks) {
            const key = `${normalize(t.artist)}|${normalize(t.title)}`;
            // Don't overwrite — first occurrence wins (sorted by artist/album/path,
            // so the earliest album version is used as the canonical match).
            if (!indexByKey.has(key)) indexByKey.set(key, t);
            if (t.mbid) {
                if (!indexByMbid.has(t.mbid)) indexByMbid.set(t.mbid, t);
            }
        }
    }

    async function loadIndex() {
        try {
            const res = await fetch('/api/local/index');
            if (!res.ok) {
                index = []; folder = ''; buildLookups([]);
                loaded = true;
                return { folder: '', tracks: [] };
            }
            const data = await res.json();
            index = Array.isArray(data?.tracks) ? data.tracks : [];
            folder = data?.folder || '';
            buildLookups(index);
            // Refresh capability probe in the background; don't block index use
            probe().catch(() => {});
            loaded = true;
            return data;
        } catch (e) {
            console.warn('[LocalLibrary] loadIndex failed:', e);
            index = []; folder = ''; buildLookups([]);
            loaded = true;
            return { folder: '', tracks: [] };
        }
    }

    async function rescan(folderPath) {
        let res;
        try {
            res = await fetch('/api/local/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder: folderPath }),
            });
        } catch (e) {
            if (typeof HiFiBuddyToast !== 'undefined') {
                HiFiBuddyToast.show({
                    type: 'error',
                    message: 'Cannot reach the local-library server. Is the dev server running?',
                    details: e?.message || String(e),
                });
            }
            throw e;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data?.error || `scan failed (${res.status})`);
            err.status = res.status;
            err.data = data;
            if (typeof HiFiBuddyToast !== 'undefined') {
                HiFiBuddyToast.show({
                    type: 'error',
                    message: `Local library scan failed: ${err.message}`,
                    details: JSON.stringify(data || {}, null, 2),
                });
            }
            throw err;
        }
        index = Array.isArray(data?.tracks) ? data.tracks : [];
        folder = data?.folder || folderPath || '';
        buildLookups(index);
        if (typeof data.ffmpeg === 'boolean') caps.ffmpeg = data.ffmpeg;
        if (typeof data.mutagen === 'boolean') caps.mutagen = data.mutagen;
        loaded = true;

        // Capability nudges — surfaced once per scan so users discover what's
        // missing and how to fix it. ABX requires ffmpeg; tag-based matching
        // requires mutagen. Without these the app silently degrades.
        if (typeof HiFiBuddyToast !== 'undefined') {
            if (caps.ffmpeg === false) {
                HiFiBuddyToast.show({
                    type: 'warning',
                    message: 'ffmpeg not found — ABX needs it for MP3 transcoding. Install with `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Linux).',
                });
            }
            if (caps.mutagen === false) {
                HiFiBuddyToast.show({
                    type: 'info',
                    message: 'mutagen not installed — falling back to filename-based indexing. Run `pip install mutagen` for tag-based matching.',
                });
            }
        }
        return data;
    }

    async function probe() {
        try {
            const res = await fetch('/api/local/probe');
            if (!res.ok) return caps;
            const data = await res.json();
            caps = {
                ffmpeg: !!data.ffmpeg,
                mutagen: !!data.mutagen,
            };
            return caps;
        } catch {
            return caps;
        }
    }

    function findTrack(title, artist, mbid) {
        if (!indexByKey) return null;
        // Perfect match: MBID
        if (mbid && indexByMbid && indexByMbid.has(mbid)) {
            return indexByMbid.get(mbid);
        }
        const key = `${normalize(artist)}|${normalize(title)}`;
        if (indexByKey.has(key)) return indexByKey.get(key);

        // Looser: title-only match scoped to closest artist (handles "feat." / collab cases)
        const titleNorm = normalize(title);
        const artistNorm = normalize(artist);
        if (!titleNorm) return null;
        for (const entry of indexByKey.values()) {
            if (normalize(entry.title) !== titleNorm) continue;
            const ea = normalize(entry.artist);
            if (!ea || !artistNorm) continue;
            if (ea.includes(artistNorm) || artistNorm.includes(ea)) return entry;
        }
        return null;
    }

    // Return EVERY local entry whose normalized (artist, title) matches.
    // Used by the Track Variant Picker so the user can pick which file to
    // play when several rips exist (studio + live + remaster, etc.).
    // Results are unique by entry id and ordered with exact matches first.
    function findAllMatches(title, artist) {
        if (!Array.isArray(index) || index.length === 0) return [];
        const titleNorm = normalize(title);
        const artistNorm = normalize(artist);
        if (!titleNorm) return [];

        const exactMatches = [];
        const looseMatches = [];
        const seen = new Set();

        for (const entry of index) {
            if (!entry || seen.has(entry.id)) continue;
            const et = normalize(entry.title);
            const ea = normalize(entry.artist);
            if (et !== titleNorm) continue;

            const exactArtist = ea === artistNorm;
            const looseArtist = artistNorm && ea && (ea.includes(artistNorm) || artistNorm.includes(ea));
            if (exactArtist) {
                exactMatches.push(entry);
                seen.add(entry.id);
            } else if (looseArtist) {
                looseMatches.push(entry);
                seen.add(entry.id);
            }
        }
        return exactMatches.concat(looseMatches);
    }

    // Lookup by id — used by the picker when honoring a saved override.
    function getById(trackId) {
        if (!Array.isArray(index)) return null;
        const sid = String(trackId);
        return index.find(t => String(t.id) === sid) || null;
    }

    function getStreamUrl(trackId) {
        if (trackId === undefined || trackId === null) return null;
        return `/api/local/stream/${encodeURIComponent(trackId)}`;
    }

    function getTranscodedUrl(trackId, bitrate) {
        if (trackId === undefined || trackId === null) return null;
        const b = Math.max(64, Math.min(parseInt(bitrate, 10) || 192, 320));
        return `/api/local/transcode/${encodeURIComponent(trackId)}?bitrate=${b}`;
    }

    function isAvailable() {
        return loaded && Array.isArray(index) && index.length > 0;
    }

    function isFFmpegAvailable() {
        return !!caps.ffmpeg;
    }

    function getFolder() { return folder; }
    function getTrackCount() { return Array.isArray(index) ? index.length : 0; }

    function init() {
        // Self-init at app startup (app.js is on the do-not-modify list).
        loadIndex().catch(() => {});
    }

    // Auto-bootstrap once the page is loaded (covers both pre- and post-DOMContentLoaded).
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        // Run async on next tick so the IIFE return value is published first
        setTimeout(init, 0);
    }

    return {
        init, loadIndex, rescan, probe,
        findTrack, findAllMatches, getById,
        getStreamUrl, getTranscodedUrl,
        isAvailable, isFFmpegAvailable,
        getFolder, getTrackCount,
    };
})();

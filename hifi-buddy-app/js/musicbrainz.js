/**
 * HiFi Buddy MusicBrainz Integration
 * Free album covers + artist metadata (no API key needed)
 * Rate limit: 1 request/sec — uses queue + cache
 */
window.HiFiBuddyMB = (() => {
    'use strict';

    const BASE = 'https://musicbrainz.org/ws/2';
    const COVER_BASE = 'https://coverartarchive.org';
    const CACHE_KEY = 'hifibuddy_mb_cache';
    const cache = new Map();
    let lastRequest = 0;
    const RATE_MS = 1100; // 1.1s between requests

    async function throttledFetch(url) {
        const now = Date.now();
        const wait = Math.max(0, RATE_MS - (now - lastRequest));
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastRequest = Date.now();

        try {
            const res = await fetch(url, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'HiFiBuddy/1.0 (music-genre-explorer)' }
            });
            if (!res.ok) return null;
            return await res.json();
        } catch { return null; }
    }

    // === Album Cover Art ===
    async function getAlbumCover(title, artist) {
        const key = `cover:${artist.toLowerCase()}|${title.toLowerCase()}`;
        if (cache.has(key)) return cache.get(key);

        // Search MusicBrainz for the release
        const q = encodeURIComponent(`release:"${title}" AND artist:"${artist}"`);
        const data = await throttledFetch(`${BASE}/release/?query=${q}&limit=1&fmt=json`);
        const release = data?.releases?.[0];
        if (!release) { cache.set(key, null); return null; }

        // Get cover art from Cover Art Archive
        const mbid = release.id;
        try {
            const coverRes = await fetch(`${COVER_BASE}/release/${mbid}`, {
                headers: { 'Accept': 'application/json' }
            });
            if (!coverRes.ok) { cache.set(key, null); return null; }
            const coverData = await coverRes.json();
            const front = coverData.images?.find(img => img.front) || coverData.images?.[0];
            const url = front?.thumbnails?.small || front?.thumbnails?.['250'] || front?.image || null;
            cache.set(key, url);
            saveCache();
            return url;
        } catch {
            cache.set(key, null);
            return null;
        }
    }

    // === Artist Info ===
    async function getArtistInfo(name) {
        const key = `artist:${name.toLowerCase()}`;
        if (cache.has(key)) return cache.get(key);

        const q = encodeURIComponent(`artist:"${name}"`);
        const data = await throttledFetch(`${BASE}/artist/?query=${q}&limit=1&fmt=json`);
        const artist = data?.artists?.[0];
        if (!artist) { cache.set(key, null); return null; }

        const info = {
            mbid: artist.id,
            name: artist.name,
            type: artist.type || 'Unknown', // Person, Group, Orchestra, etc.
            country: artist.country || artist.area?.name || 'Unknown',
            beginYear: artist['life-span']?.begin?.substring(0, 4) || null,
            endYear: artist['life-span']?.ended ? (artist['life-span']?.end?.substring(0, 4) || 'Disbanded') : null,
            tags: (artist.tags || []).sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 5).map(t => t.name),
            disambiguation: artist.disambiguation || '',
        };
        cache.set(key, info);
        saveCache();
        return info;
    }

    // === Artist Image (via Wikipedia/Wikidata) ===
    async function getArtistImage(name) {
        const key = `artist-img:${name.toLowerCase()}`;
        if (cache.has(key)) return cache.get(key);

        // Try Wikipedia API for artist image
        const q = encodeURIComponent(name);
        try {
            const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${q}`);
            if (!res.ok) { cache.set(key, null); return null; }
            const data = await res.json();
            const url = data?.thumbnail?.source || null;
            cache.set(key, url);
            return url;
        } catch {
            cache.set(key, null);
            return null;
        }
    }

    function init() {
        // Load persistent cache
        try {
            const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
            for (const [k, v] of Object.entries(stored)) cache.set(k, v);
        } catch { /* ignore */ }
    }

    function saveCache() {
        try {
            const obj = {};
            let count = 0;
            for (const [k, v] of cache) {
                if (count++ >= 300) break;
                obj[k] = v;
            }
            localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
        } catch { /* ignore */ }
    }

    return { init, getAlbumCover, getArtistInfo, getArtistImage };
})();

/**
 * HiFi Buddy Plex Integration
 * Library matching and collection tracking
 */
window.HiFiBuddyPlex = (() => {
    'use strict';

    let artistIndex = new Map(); // normalized name → plex data
    let albumIndex = new Map();  // "artist|album" normalized → plex data
    let albumsByArtist = new Map(); // normalized artist → [album data]
    let connected = false;
    let libraryLoaded = false;
    let _cachedSectionId = null;
    let _lastSuccessAt = 0;

    // Per-(status:endpoint) toast suppression. Errors that surface every few
    // seconds (e.g. failed `searchTrack` polling) shouldn't blast the UI.
    // We re-enable a key after 60s so the user can still see new instances.
    const _errToastSeen = new Map(); // key -> last shown timestamp
    const ERR_TOAST_TTL_MS = 60_000;

    function _markErrToast(key) {
        _errToastSeen.set(key, Date.now());
    }
    function _shouldShowErrToast(key) {
        const last = _errToastSeen.get(key);
        if (!last) return true;
        return Date.now() - last > ERR_TOAST_TTL_MS;
    }

    // Open settings modal (used as toast action). Falls back to clicking
    // the gear if the API isn't loaded yet.
    function _openSettings() {
        try {
            if (typeof HiFiBuddySettings !== 'undefined' && HiFiBuddySettings.show) {
                HiFiBuddySettings.show();
                return;
            }
        } catch { /* ignore */ }
        document.getElementById('settingsBtn')?.click();
    }

    /**
     * Centralized response inspector. Call this whenever a /api/plex/...
     * fetch completes (successfully or not). Surfaces a clear, actionable
     * toast for known failure modes; rate-limited per (status:endpoint).
     *
     * Returns true when the response is OK and callers should proceed,
     * false when the caller should bail.
     *
     * Usage:
     *   const res = await fetch(url);
     *   if (!handlePlexResponse(res, { endpoint: 'search' })) return [];
     */
    function handlePlexResponse(res, opts = {}) {
        const endpoint = opts.endpoint || 'plex';
        if (!res) return false;
        if (res.ok) {
            _lastSuccessAt = Date.now();
            try { localStorage.setItem('hifibuddy_plex_last_ok', String(_lastSuccessAt)); } catch { /* ignore */ }
            return true;
        }
        const key = `${res.status}:${endpoint}`;
        if (!_shouldShowErrToast(key)) return false;
        _markErrToast(key);

        if (typeof HiFiBuddyToast === 'undefined') return false;

        switch (res.status) {
            case 401:
                HiFiBuddyToast.show({
                    type: 'error',
                    message: 'Plex token expired or invalid. Refresh in Settings → Plex.',
                    action: { label: 'Open Settings', onClick: _openSettings },
                });
                break;
            case 403:
                HiFiBuddyToast.show({
                    type: 'error',
                    message: 'Plex denied access. Token may be from a different account or library.',
                    action: { label: 'Open Settings', onClick: _openSettings },
                });
                break;
            case 404:
                HiFiBuddyToast.show({
                    type: 'error',
                    message: 'Plex endpoint not found. Server URL may be wrong.',
                    action: { label: 'Open Settings', onClick: _openSettings },
                });
                break;
            case 502:
            case 503:
                HiFiBuddyToast.show({
                    type: 'error',
                    message: 'Plex server unreachable. Check it is running and the URL.',
                    action: { label: 'Open Settings', onClick: _openSettings },
                });
                break;
            default:
                HiFiBuddyToast.show({
                    type: 'error',
                    message: `Plex error ${res.status} on ${endpoint}.`,
                    action: { label: 'Open Settings', onClick: _openSettings },
                });
        }
        return false;
    }

    /**
     * Surface a network-layer failure (no response — DNS, CORS, offline, etc.).
     * Treated separately from HTTP error codes because there is no status.
     */
    function handlePlexNetworkError(err, opts = {}) {
        const endpoint = opts.endpoint || 'plex';
        const key = `network:${endpoint}`;
        if (!_shouldShowErrToast(key)) return;
        _markErrToast(key);
        if (typeof HiFiBuddyToast === 'undefined') return;
        HiFiBuddyToast.show({
            type: 'error',
            message: 'Cannot reach Plex server. Network or VPN may be blocking.',
            details: err && err.message ? String(err.message) : '',
            action: { label: 'Open Settings', onClick: _openSettings },
        });
    }

    function getLastSuccessAt() {
        if (_lastSuccessAt) return _lastSuccessAt;
        try {
            const v = parseInt(localStorage.getItem('hifibuddy_plex_last_ok') || '0', 10);
            return isFinite(v) ? v : 0;
        } catch { return 0; }
    }

    function init() {
        window.addEventListener('hifibuddy-settings-changed', () => {
            connected = false;
            libraryLoaded = false;
            _cachedSectionId = null;
            artistIndex.clear();
            albumIndex.clear();
            albumsByArtist.clear();
            _errToastSeen.clear();
        });
    }

    function isConnected() { return connected && libraryLoaded; }

    async function connect() {
        const url = HiFiBuddySettings.getPlexUrl();
        const token = HiFiBuddySettings.getPlexToken();
        if (!url || !token) return false;

        let res;
        try {
            res = await fetch(`/api/plex/identity?plexUrl=${enc(url)}&plexToken=${enc(token)}`);
        } catch (e) {
            handlePlexNetworkError(e, { endpoint: 'identity' });
            return false;
        }
        if (!handlePlexResponse(res, { endpoint: 'identity' })) return false;
        connected = true;
        if (typeof HiFiBuddyToast !== 'undefined') HiFiBuddyToast.success('Plex connected');
        await loadLibrary();
        return true;
    }

    async function loadLibrary() {
        const url = HiFiBuddySettings.getPlexUrl();
        const token = HiFiBuddySettings.getPlexToken();
        if (!url || !token) return;

        try {
            // Find music library sections
            let sectionsRes;
            try {
                sectionsRes = await fetch(`/api/plex/library/sections?plexUrl=${enc(url)}&plexToken=${enc(token)}`);
            } catch (e) {
                handlePlexNetworkError(e, { endpoint: 'library/sections' });
                return;
            }
            if (!handlePlexResponse(sectionsRes, { endpoint: 'library/sections' })) return;
            const sectionsData = await sectionsRes.json();
            const sections = sectionsData?.MediaContainer?.Directory || [];
            const musicSection = sections.find(s => s.type === 'artist');
            if (!musicSection) {
                console.warn('[Plex] No music library found. Sections:', sections.map(s => s.type));
                return;
            }

            const sectionId = musicSection.key;
            console.log(`[Plex] Loading music library section ${sectionId}...`);

            // Fetch all artists
            const artistsRes = await fetch(`/api/plex/library/sections/${sectionId}/all?type=8&plexUrl=${enc(url)}&plexToken=${enc(token)}`);
            if (artistsRes.ok) {
                const artistsData = await artistsRes.json();
                const artists = artistsData?.MediaContainer?.Metadata || [];
                for (const a of artists) {
                    artistIndex.set(normalize(a.title), {
                        title: a.title,
                        ratingKey: a.ratingKey,
                        thumb: a.thumb,
                    });
                }
                console.log(`[Plex] Loaded ${artists.length} artists`);
            }

            // Fetch all albums
            const albumsRes = await fetch(`/api/plex/library/sections/${sectionId}/all?type=9&plexUrl=${enc(url)}&plexToken=${enc(token)}`);
            if (albumsRes.ok) {
                const albumsData = await albumsRes.json();
                const albums = albumsData?.MediaContainer?.Metadata || [];
                for (const a of albums) {
                    // Exact key: artist|album
                    const key = normalize(a.parentTitle) + '|' + normalize(a.title);
                    const albumData = {
                        title: a.title,
                        artist: a.parentTitle,
                        ratingKey: a.ratingKey,
                        thumb: a.thumb,
                        year: a.year,
                    };
                    albumIndex.set(key, albumData);

                    // Also index by normalized title alone (for fuzzy matching)
                    const titleKey = normalize(a.title);
                    if (!albumIndex.has('title:' + titleKey)) {
                        albumIndex.set('title:' + titleKey, albumData);
                    }

                    // Index by artist for browsing
                    const artistKey = normalize(a.parentTitle);
                    if (!albumsByArtist.has(artistKey)) albumsByArtist.set(artistKey, []);
                    albumsByArtist.get(artistKey).push(albumData);
                }
                console.log(`[Plex] Loaded ${albums.length} albums`);
            }

            if (!libraryLoaded) {
                libraryLoaded = true;
                console.log(`[Plex] Library ready: ${artistIndex.size} artists, ${albumIndex.size} album entries`);
                // Notify app to re-render current view with Plex badges (only once)
                window.dispatchEvent(new CustomEvent('hifibuddy-plex-loaded'));
            }
        } catch (e) {
            console.error('[Plex] Error loading library:', e);
        }
    }

    function matchArtist(name) {
        if (!libraryLoaded) return null;
        return artistIndex.get(normalize(name)) || null;
    }

    function matchAlbum(title, artist) {
        if (!libraryLoaded) return null;

        // 1. Exact match: artist + title
        const exactKey = normalize(artist) + '|' + normalize(title);
        if (albumIndex.has(exactKey)) return albumIndex.get(exactKey);

        // 2. Try title-only match (handles artist name differences)
        const titleKey = 'title:' + normalize(title);
        if (albumIndex.has(titleKey)) return albumIndex.get(titleKey);

        // 3. Fuzzy: check if Plex album title CONTAINS our title or vice versa
        // e.g., "Nevermind" matches "Nevermind (Remastered)" or "Nevermind [Deluxe Edition]"
        const normTitle = normalize(title);
        const normArtist = normalize(artist);
        const artistAlbums = albumsByArtist.get(normArtist);
        if (artistAlbums) {
            for (const a of artistAlbums) {
                const plexTitle = normalize(a.title);
                if (plexTitle.includes(normTitle) || normTitle.includes(plexTitle)) {
                    return a;
                }
            }
        }

        // 4. Last resort: check all albums by title substring (slower but catches edge cases)
        for (const [key, val] of albumIndex) {
            if (key.startsWith('title:')) continue;
            const plexNormTitle = key.split('|')[1] || '';
            if (plexNormTitle && (plexNormTitle.includes(normTitle) || normTitle.includes(plexNormTitle))) {
                // Verify the artist is at least similar
                const plexNormArtist = key.split('|')[0] || '';
                if (plexNormArtist.includes(normArtist) || normArtist.includes(plexNormArtist)) {
                    return val;
                }
            }
        }

        return null;
    }

    function getCollectionStats(subgenre) {
        if (!libraryLoaded || !subgenre) return null;
        const albums = subgenre.albums || [];
        let owned = 0;
        const details = albums.map(a => {
            const match = matchAlbum(a.title, a.artist);
            if (match) owned++;
            return { ...a, inLibrary: !!match };
        });
        return { total: albums.length, owned, details };
    }

    // UI helpers
    function renderPlexBadge(inLibrary) {
        if (!libraryLoaded) return '';
        if (inLibrary) {
            return `<span class="plex-badge plex-owned" title="In your Plex library">${HiFiBuddyIcons.check({ size: 14, strokeWidth: 3 })} Plex</span>`;
        }
        return '<span class="plex-badge plex-missing" title="Not in your Plex library">Plex</span>';
    }

    function renderCoverageBar(stats) {
        if (!stats || !libraryLoaded) return '';
        const pct = stats.total > 0 ? Math.round((stats.owned / stats.total) * 100) : 0;
        return `
            <div class="plex-coverage">
                <div class="plex-coverage-header">
                    <span>Plex Collection</span>
                    <span>${stats.owned}/${stats.total} albums</span>
                </div>
                <div class="plex-coverage-bar">
                    <div class="plex-coverage-fill" style="width:${pct}%"></div>
                </div>
            </div>
        `;
    }

    // Debug helper — call from console: HiFiBuddyPlex.debug('Nirvana', 'Nevermind')
    // === Track Search & Playback (for Quiz) ===

    async function searchTrack(title, artist) {
        // The "best match" for active playback. Always enriched so the Source
        // Quality card has accurate bit-depth + sample-rate info (search
        // results often omit the Stream array; only /library/metadata returns it).
        const all = await searchTrackAll(title, artist, { enrich: true, enrichLimit: 1 });
        return Array.isArray(all) && all.length > 0 ? all[0] : null;
    }

    // Per-(URL, ratingKey) cache of full metadata. Survives across calls but
    // resets on Plex URL change. Avoids re-fetching during a session.
    const _enrichCache = new Map();

    // Fetch /library/metadata/<ratingKey> and merge bitDepth + samplingRate
    // (and any other Stream-only details) into the partial quality object.
    async function enrichQuality(ratingKey, partialQuality) {
        if (!ratingKey) return partialQuality;
        if (_enrichCache.has(ratingKey)) {
            return { ...partialQuality, ...(_enrichCache.get(ratingKey) || {}) };
        }
        const url = HiFiBuddySettings.getPlexUrl();
        const token = HiFiBuddySettings.getPlexToken();
        if (!url || !token) return partialQuality;
        try {
            const res = await fetch(`/api/plex/library/metadata/${ratingKey}?plexUrl=${enc(url)}&plexToken=${enc(token)}`);
            if (!res.ok) return partialQuality;
            const data = await res.json();
            const t = data?.MediaContainer?.Metadata?.[0];
            const media = t?.Media?.[0];
            const stream = media?.Part?.[0]?.Stream?.find(s => s.streamType === 2) || media?.Part?.[0]?.Stream?.[0];
            if (!media) return partialQuality;
            const enriched = {
                codec: (media.audioCodec || media.codec || partialQuality?.codec || '').toUpperCase(),
                bitrate: media.bitrate || partialQuality?.bitrate || 0,
                sampleRate: stream?.samplingRate || media.sampleRate || partialQuality?.sampleRate || 0,
                bitDepth: stream?.bitDepth || partialQuality?.bitDepth || 0,
                channels: media.audioChannels || stream?.channels || partialQuality?.channels || 2,
                container: (media.container || partialQuality?.container || '').toUpperCase(),
            };
            _enrichCache.set(ratingKey, enriched);
            return enriched;
        } catch {
            return partialQuality;
        }
    }

    // Returns ALL plausible matches for (title, artist), best-match first.
    // The Track Variant Picker uses this to surface studio/live/remaster
    // versions; the heuristic in searchTrack just picks the first entry.
    //
    // opts.enrich (default false): fetch /library/metadata for each result so
    //   bitDepth + samplingRate are populated. Adds N round-trips.
    // opts.enrichLimit: enrich only the first N results (search returns ~20).
    async function searchTrackAll(title, artist, opts = {}) {
        const url = HiFiBuddySettings.getPlexUrl();
        const token = HiFiBuddySettings.getPlexToken();
        if (!url || !token) return [];

        try {
            // Use cached section ID, or find it once
            if (!_cachedSectionId) {
                let sectionsRes;
                try {
                    sectionsRes = await fetch(`/api/plex/library/sections?plexUrl=${enc(url)}&plexToken=${enc(token)}`);
                } catch (e) {
                    handlePlexNetworkError(e, { endpoint: 'library/sections' });
                    return [];
                }
                if (!handlePlexResponse(sectionsRes, { endpoint: 'library/sections' })) return [];
                const sectionsData = await sectionsRes.json();
                const musicSection = (sectionsData?.MediaContainer?.Directory || []).find(s => s.type === 'artist');
                if (!musicSection) return [];
                _cachedSectionId = musicSection.key;
            }

            const sid = _cachedSectionId;
            const normTitle = normalize(title);
            const normArtist = normalize(artist);

            // Single search by track title — limit=20 so we capture variants
            let searchRes;
            try {
                searchRes = await fetch(`/api/plex/library/sections/${sid}/search?type=10&query=${enc(title)}&limit=20&plexUrl=${enc(url)}&plexToken=${enc(token)}`);
            } catch (e) {
                handlePlexNetworkError(e, { endpoint: 'library/sections/search' });
                return [];
            }
            if (!handlePlexResponse(searchRes, { endpoint: 'library/sections/search' })) return [];
            const searchData = await searchRes.json();
            const tracks = searchData?.MediaContainer?.Metadata || [];

            // Score each track. Higher = better match.
            //   4 = exact title  + exact artist            (best)
            //   3 = exact title  + artist substring
            //   2 = title substring (extended) + artist match  (e.g., "Money for Nothing (single edit)" by the same artist)
            //   1 = REJECTED — title-only matches let "Hallelujah Money" by Gorillaz
            //       impersonate "Hallelujah" by Jeff Buckley. Always require artist match.
            const scored = [];
            for (const t of tracks) {
                const tTitle = normalize(t.title);
                const tArtist = normalize(t.grandparentTitle || t.originalTitle || '');
                if (!tTitle || !tArtist || !normArtist) continue;
                const exactTitle  = tTitle === normTitle;
                const titleSubstr = !exactTitle && (tTitle.includes(normTitle) || normTitle.includes(tTitle));
                const exactArtist  = tArtist === normArtist;
                const artistSubstr = !exactArtist && (tArtist.includes(normArtist) || normArtist.includes(tArtist));
                if (!exactArtist && !artistSubstr) continue;  // wrong artist — reject
                let score = 0;
                if (exactTitle  && exactArtist)  score = 4;
                else if (exactTitle  && artistSubstr) score = 3;
                else if (titleSubstr && (exactArtist || artistSubstr)) score = 2;
                if (score > 0) scored.push({ t, score });
            }
            scored.sort((a, b) => b.score - a.score);
            const ranked = scored.map(s => s.t);
            if (ranked.length === 0) return [];

            // Build a normalized result for each ranked track from the search
            // response. Quality may be partial here (Stream array is often
            // missing). If opts.enrich is true, we fan out to /library/metadata
            // afterwards to fill in bitDepth + samplingRate.
            const results = [];
            for (const bestTrack of ranked) {
                const fullTrack = bestTrack;
                const media = fullTrack.Media?.[0];
                const part = media?.Part?.[0];
                const stream = part?.Stream?.find(s => s.streamType === 2) || part?.Stream?.[0];
                const quality = media ? {
                    codec: (media.audioCodec || media.codec || '').toUpperCase(),
                    bitrate: media.bitrate || 0,
                    sampleRate: stream?.samplingRate || media.sampleRate || 0,
                    bitDepth: stream?.bitDepth || 0,
                    channels: media.audioChannels || stream?.channels || 2,
                    container: (media.container || '').toUpperCase(),
                } : null;

                let streamUrl = getStreamUrl(fullTrack, part);
                if (!streamUrl && bestTrack.ratingKey) {
                    const transcodePath = `music/:/transcode/universal/start.mp3?path=${enc('/library/metadata/' + bestTrack.ratingKey)}&mediaIndex=0&partIndex=0&protocol=http`;
                    streamUrl = `/api/plex-stream/${transcodePath}&plexUrl=${enc(url)}&plexToken=${enc(token)}`;
                }

                results.push({
                    title: fullTrack.title || bestTrack.title,
                    artist: fullTrack.grandparentTitle || bestTrack.grandparentTitle || artist,
                    album: fullTrack.parentTitle || bestTrack.parentTitle || '',
                    albumYear: fullTrack.parentYear || fullTrack.year || null,
                    ratingKey: bestTrack.ratingKey,
                    duration: fullTrack.duration || bestTrack.duration,
                    thumb: fullTrack.parentThumb || fullTrack.thumb || bestTrack.parentThumb || bestTrack.thumb,
                    streamUrl,
                    quality,
                });
            }

            // Optional enrichment pass — fetch full metadata in parallel so the
            // picker / Source Quality card show real bit-depth + sample-rate.
            if (opts.enrich) {
                const limit = Math.max(0, opts.enrichLimit || results.length);
                const targets = results.slice(0, limit);
                await Promise.all(targets.map(async r => {
                    const enriched = await enrichQuality(r.ratingKey, r.quality);
                    if (enriched) r.quality = enriched;
                }));
            }
            return results;
        } catch (e) {
            console.warn('[Plex] Track search error:', e);
            return [];
        }
    }

    // Lookup a single Plex track directly by ratingKey. Used by the Track
    // Variant Picker to honor user overrides without re-searching.
    async function getTrackByRatingKey(ratingKey) {
        const url = HiFiBuddySettings.getPlexUrl();
        const token = HiFiBuddySettings.getPlexToken();
        if (!url || !token || !ratingKey) return null;
        try {
            let res;
            try {
                res = await fetch(`/api/plex/library/metadata/${ratingKey}?plexUrl=${enc(url)}&plexToken=${enc(token)}`);
            } catch (e) {
                handlePlexNetworkError(e, { endpoint: 'library/metadata' });
                return null;
            }
            if (!handlePlexResponse(res, { endpoint: 'library/metadata' })) return null;
            const data = await res.json();
            const t = data?.MediaContainer?.Metadata?.[0];
            if (!t) return null;
            const media = t.Media?.[0];
            const part = media?.Part?.[0];
            const stream = part?.Stream?.find(s => s.streamType === 2) || part?.Stream?.[0];
            const quality = media ? {
                codec: (media.audioCodec || media.codec || '').toUpperCase(),
                bitrate: media.bitrate || 0,
                sampleRate: stream?.samplingRate || media.sampleRate || 0,
                bitDepth: stream?.bitDepth || 0,
                channels: media.audioChannels || stream?.channels || 2,
                container: (media.container || '').toUpperCase(),
            } : null;
            let streamUrl = getStreamUrl(t, part);
            if (!streamUrl && t.ratingKey) {
                const transcodePath = `music/:/transcode/universal/start.mp3?path=${enc('/library/metadata/' + t.ratingKey)}&mediaIndex=0&partIndex=0&protocol=http`;
                streamUrl = `/api/plex-stream/${transcodePath}&plexUrl=${enc(url)}&plexToken=${enc(token)}`;
            }
            return {
                title: t.title,
                artist: t.grandparentTitle || '',
                album: t.parentTitle || '',
                albumYear: t.parentYear || t.year || null,
                ratingKey: t.ratingKey,
                duration: t.duration,
                thumb: t.parentThumb || t.thumb,
                streamUrl,
                quality,
            };
        } catch (e) {
            console.warn('[Plex] getTrackByRatingKey error:', e);
            return null;
        }
    }

    function getStreamUrl(track, part) {
        const url = HiFiBuddySettings.getPlexUrl();
        const token = HiFiBuddySettings.getPlexToken();
        if (!url || !token || !track) return null;

        const ratingKey = track.ratingKey;

        // Prefer direct play through our proxy (avoids CORS, preserves quality)
        // Chrome natively supports: FLAC, WAV, MP3, AAC, OGG, OPUS
        if (part?.key) {
            const codec = (track.Media?.[0]?.audioCodec || '').toLowerCase();
            const webPlayable = ['flac', 'mp3', 'aac', 'ogg', 'opus', 'wav', 'alac'];
            if (webPlayable.includes(codec)) {
                return `/api/plex-stream/${part.key.replace(/^\//, '')}?plexUrl=${enc(url)}&plexToken=${enc(token)}`;
            }
        }

        // Fallback: transcode to MP3 via proxy
        const transcodePath = `music/:/transcode/universal/start.mp3?path=${enc('/library/metadata/' + ratingKey)}&mediaIndex=0&partIndex=0&protocol=http`;
        return `/api/plex-stream/${transcodePath}&plexUrl=${enc(url)}&plexToken=${enc(token)}`;
    }

    function getThumbUrl(thumbPath) {
        if (!thumbPath) return null;
        const url = HiFiBuddySettings.getPlexUrl();
        const token = HiFiBuddySettings.getPlexToken();
        return `${url}${thumbPath}?X-Plex-Token=${token}`;
    }

    function getTranscodeUrl(ratingKey) {
        const url = HiFiBuddySettings.getPlexUrl();
        const token = HiFiBuddySettings.getPlexToken();
        if (!url || !token || !ratingKey) return null;
        const transcodePath = `music/:/transcode/universal/start.mp3?path=${enc('/library/metadata/' + ratingKey)}&mediaIndex=0&partIndex=0&protocol=http`;
        return `/api/plex-stream/${transcodePath}&plexUrl=${enc(url)}&plexToken=${enc(token)}`;
    }

    // Force-transcoded stream URL at a specific MP3 bitrate (used by ABX testing).
    // Bitrate is in kbps. Plex's universal transcoder accepts audioBitrate as a hint.
    function getTranscodedMp3Url(ratingKey, bitrateKbps) {
        const url = HiFiBuddySettings.getPlexUrl();
        const token = HiFiBuddySettings.getPlexToken();
        if (!url || !token || !ratingKey) return null;
        const path = enc('/library/metadata/' + ratingKey);
        // session id forces a fresh transcode (so we don't get cached lossless from a prior request)
        const session = `abx-${ratingKey}-${bitrateKbps}-${Math.random().toString(36).slice(2, 8)}`;
        const transcodePath = `music/:/transcode/universal/start.mp3?path=${path}` +
            `&mediaIndex=0&partIndex=0&protocol=http&audioCodec=mp3&audioBitrate=${bitrateKbps}` +
            `&maxAudioBitrate=${bitrateKbps}&session=${session}`;
        return `/api/plex-stream/${transcodePath}&plexUrl=${enc(url)}&plexToken=${enc(token)}`;
    }

    /**
     * Surface a Plex stream failure (used by callers that play /api/plex-stream/...).
     * The server forwards Plex's textual error in the body — typically
     * "Plex returned 400: <reason>" — so we extract <reason> when present
     * and show it. Rate-limited to once per (status:reason) per minute.
     */
    async function reportStreamFailure(res, opts = {}) {
        if (!res || res.ok) return;
        let reason = '';
        try {
            const text = await res.clone().text();
            const m = /Plex returned\s+\d+:\s*([^\n]+)/i.exec(text || '');
            reason = (m && m[1].trim()) || (text || '').slice(0, 240);
        } catch { /* ignore */ }
        const key = `stream:${res.status}:${reason || ''}`.slice(0, 200);
        if (!_shouldShowErrToast(key)) return;
        _markErrToast(key);
        if (typeof HiFiBuddyToast === 'undefined') return;
        const where = opts.label ? ` (${opts.label})` : '';
        if (res.status === 502 || res.status === 503) {
            HiFiBuddyToast.show({
                type: 'error',
                message: `Plex stream failed${where}${reason ? `: ${reason}` : '.'}`,
                details: reason || `HTTP ${res.status}`,
            });
        } else if (res.status === 401 || res.status === 403) {
            HiFiBuddyToast.show({
                type: 'error',
                message: 'Plex denied stream access. Token may have expired.',
                action: { label: 'Open Settings', onClick: _openSettings },
            });
        } else {
            HiFiBuddyToast.show({
                type: 'error',
                message: `Plex stream error ${res.status}${where}${reason ? `: ${reason}` : ''}`,
            });
        }
    }

    function debug(artist, title) {
        console.log('[Plex Debug]');
        console.log('  Normalized artist:', normalize(artist));
        console.log('  Normalized title:', normalize(title));
        console.log('  Exact key:', normalize(artist) + '|' + normalize(title));
        console.log('  Artist found:', artistIndex.has(normalize(artist)));
        console.log('  Artist albums:', albumsByArtist.get(normalize(artist))?.map(a => a.title) || 'none');
        console.log('  Match result:', matchAlbum(title, artist));
        console.log('  Total artists indexed:', artistIndex.size);
        console.log('  Total album entries:', albumIndex.size);
    }

    function normalize(s) {
        return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function enc(s) { return encodeURIComponent(s); }

    return {
        init, isConnected, connect, loadLibrary,
        matchArtist, matchAlbum, getCollectionStats,
        searchTrack, searchTrackAll, getTrackByRatingKey, enrichQuality,
        getThumbUrl, getTranscodeUrl, getTranscodedMp3Url,
        renderPlexBadge, renderCoverageBar, debug,
        // Error-surfacing helpers (also useful to other modules)
        handlePlexResponse, handlePlexNetworkError, reportStreamFailure,
        getLastSuccessAt,
    };
})();

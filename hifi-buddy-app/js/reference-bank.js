/**
 * HiFi Buddy Reference Clip Library
 *
 * A searchable bank of short reference audio clips (3-15s ish, up to ~60s)
 * tagged with audiophile critical-listening concepts. Lets users browse
 * clips by skill, difficulty, characteristic, and play them via Plex
 * (with seek to segment start and an auto-stop "play range" mode).
 *
 * Public API:
 *   init()          — load /data/reference-clips.json once and inject styles
 *   render(container) — render the full reference bank UI into the given element
 */
window.HiFiBuddyRefBank = (() => {
    'use strict';

    const DATA_URL = '/data/reference-clips.json';
    const FAV_KEY = 'hifibuddy_refbank_favorites';
    const STYLE_ID = 'hifibuddy-refbank-styles';
    // Plex match cache (Layer A — long-lived metadata, keyed by Plex URL hash).
    // Layer B (token-scoped streamUrls) is shared with hifi-buddy.js because
    // tokens are global per Plex server.
    const PLEX_MATCHES_KEY = 'hifibuddy_refbank_plex_matches';
    const PLEX_STREAMS_KEY = 'hifibuddy_hifi_plex_streams'; // shared with hifi-buddy

    let clips = null;
    let skills = null;          // { id, name, color } from hifi-guide.json
    let containerEl = null;
    let activeSkillFilters = new Set();
    let activeDifficulty = 'all'; // 'all' | 'beginner' | 'intermediate' | 'advanced'
    let searchQuery = '';
    let favorites = loadFavorites();
    let currentPlayback = null; // { clipId, autoStopTimer }

    // ===== Persistence =====

    function loadFavorites() {
        try {
            return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]'));
        } catch { return new Set(); }
    }

    function saveFavorites() {
        try {
            localStorage.setItem(FAV_KEY, JSON.stringify([...favorites]));
        } catch (e) { console.warn('[RefBank] saveFavorites:', e); }
    }

    // ===== Plex clip-match cache =====
    // Same two-layer pattern as hifi-buddy.js. Layer A is owned here; Layer B
    // is shared with hifi-buddy (one Plex server → one set of stream URLs).

    function _hashStr(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
        return Math.abs(h).toString(36);
    }

    function getPlexUrlHash() {
        const url = HiFiBuddySettings?.getPlexUrl?.() || '';
        return url ? 'pu_' + _hashStr(url) : '';
    }

    function getPlexTokenHash() {
        const token = HiFiBuddySettings?.getPlexToken?.() || '';
        return token ? 'pt_' + _hashStr(token) : '';
    }

    // Pull the partKey out of a streamUrl produced by HiFiBuddyPlex.
    function extractPartKeyFromStreamUrl(streamUrl) {
        if (!streamUrl || typeof streamUrl !== 'string') return null;
        const prefix = '/api/plex-stream/';
        const i = streamUrl.indexOf(prefix);
        if (i < 0) return null;
        let tail = streamUrl.slice(i + prefix.length);
        const cut = tail.search(/[?&]plex(Url|Token)=/);
        if (cut >= 0) tail = tail.slice(0, cut);
        return '/' + tail;
    }

    // Rebuild a stream URL from a Layer A entry + the current token, no network.
    function rebuildStreamUrl(matchEntry, plexUrl, plexToken) {
        if (!matchEntry?.partKey || !plexUrl || !plexToken) return null;
        const path = matchEntry.partKey.replace(/^\//, '');
        const sep = path.includes('?') ? '&' : '?';
        return `/api/plex-stream/${path}${sep}plexUrl=${encodeURIComponent(plexUrl)}&plexToken=${encodeURIComponent(plexToken)}`;
    }

    function loadRefMatches() {
        const urlHash = getPlexUrlHash();
        if (!urlHash) return {};
        try {
            const all = JSON.parse(localStorage.getItem(PLEX_MATCHES_KEY) || '{}');
            return all[urlHash] || {};
        } catch { return {}; }
    }

    function saveRefMatches(bucket) {
        const urlHash = getPlexUrlHash();
        if (!urlHash) return;
        try {
            const all = JSON.parse(localStorage.getItem(PLEX_MATCHES_KEY) || '{}');
            all[urlHash] = bucket;
            localStorage.setItem(PLEX_MATCHES_KEY, JSON.stringify(all));
        } catch (e) { console.warn('[RefBank] saveRefMatches:', e); }
    }

    function loadStreams() {
        const tokenHash = getPlexTokenHash();
        if (!tokenHash) return { tokenHash: '', bucket: {} };
        try {
            const all = JSON.parse(localStorage.getItem(PLEX_STREAMS_KEY) || '{}');
            return { tokenHash, bucket: all[tokenHash] || {} };
        } catch { return { tokenHash, bucket: {} }; }
    }

    function saveStreams(bucket) {
        const tokenHash = getPlexTokenHash();
        if (!tokenHash) return;
        try {
            const all = JSON.parse(localStorage.getItem(PLEX_STREAMS_KEY) || '{}');
            all[tokenHash] = bucket;
            localStorage.setItem(PLEX_STREAMS_KEY, JSON.stringify(all));
        } catch (e) { console.warn('[RefBank] saveStreams:', e); }
    }

    // Returns { streamUrl, title, artist, album, ratingKey, thumb } if cached,
    // else null. Rebuilds a missing streamUrl from the cached partKey + current
    // token (no network call).
    function getCachedClipMatch(clipId) {
        const matches = loadRefMatches();
        const m = matches[clipId];
        if (!m) return null;
        const streams = loadStreams();
        let streamUrl = streams.bucket[clipId];
        if (!streamUrl) {
            const url = HiFiBuddySettings?.getPlexUrl?.() || '';
            const token = HiFiBuddySettings?.getPlexToken?.() || '';
            streamUrl = rebuildStreamUrl(m, url, token);
            if (streamUrl) {
                streams.bucket[clipId] = streamUrl;
                saveStreams(streams.bucket);
            }
        }
        if (!streamUrl) return null;
        return {
            streamUrl,
            title: m.title,
            artist: m.artist,
            album: m.album,
            ratingKey: m.ratingKey,
            thumb: m.thumb,
        };
    }

    function cacheClipMatch(clipId, result) {
        if (!clipId || !result) return;
        const partKey = extractPartKeyFromStreamUrl(result.streamUrl);
        const matches = loadRefMatches();
        matches[clipId] = {
            ratingKey: result.ratingKey || null,
            title:     result.title || '',
            artist:    result.artist || '',
            album:     result.album || '',
            thumb:     result.thumb || '',
            partKey,
            cachedAt:  Date.now(),
        };
        saveRefMatches(matches);
        if (result.streamUrl) {
            const streams = loadStreams();
            if (streams.tokenHash) {
                streams.bucket[clipId] = result.streamUrl;
                saveStreams(streams.bucket);
            }
        }
    }

    // ===== Data loading =====

    async function init() {
        injectStyles();
        if (clips) return;
        try {
            const [clipsRes, guideRes] = await Promise.all([
                fetch(DATA_URL).then(r => r.json()),
                fetch('/data/hifi-guide.json').then(r => r.json()),
            ]);
            clips = clipsRes;
            skills = guideRes.skills.map(s => ({ id: s.id, name: s.name, color: s.color }));
            console.log(`[RefBank] Loaded ${clips.length} reference clips`);
        } catch (e) {
            console.warn('[RefBank] init failed:', e);
            clips = clips || [];
            skills = skills || [];
        }
    }

    function getSkillMeta(skillId) {
        return skills?.find(s => s.id === skillId)
            || { id: skillId, name: skillId, color: '#667eea' };
    }

    // ===== Helpers =====

    function parseSegment(seg) {
        const m = String(seg).match(/^(\d+):(\d{1,2})-(\d+):(\d{1,2})$/);
        if (!m) return { start: 0, end: 30 };
        return {
            start: (+m[1]) * 60 + (+m[2]),
            end:   (+m[3]) * 60 + (+m[4]),
        };
    }

    function segmentDurationSecs(seg) {
        const r = parseSegment(seg);
        return Math.max(0, r.end - r.start);
    }

    function escapeHTML(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    function plexAvailable() {
        return typeof HiFiBuddyPlex !== 'undefined'
            && typeof HiFiBuddySettings !== 'undefined'
            && !!HiFiBuddySettings.getPlexUrl?.()
            && !!HiFiBuddySettings.getPlexToken?.();
    }

    function spotifySearchUrl(track, artist) {
        return 'https://open.spotify.com/search/' +
            encodeURIComponent(`${track} ${artist}`);
    }

    // ===== Filtering =====

    function applyFilters(allClips) {
        const q = searchQuery.trim().toLowerCase();
        return allClips.filter(c => {
            // Difficulty
            if (activeDifficulty !== 'all' && c.difficulty !== activeDifficulty) return false;
            // Skills (multi-select, any-of)
            if (activeSkillFilters.size > 0) {
                const hasAny = c.skills.some(s => activeSkillFilters.has(s));
                if (!hasAny) return false;
            }
            // Search across title/artist/track/characteristic/description
            if (q) {
                const blob = [
                    c.title, c.artist, c.track, c.characteristic, c.description,
                ].join(' ').toLowerCase();
                if (!blob.includes(q)) return false;
            }
            return true;
        });
    }

    function sortClips(filtered) {
        // Favorites first, then keep original order (which is curated)
        const favs = filtered.filter(c => favorites.has(c.id));
        const rest = filtered.filter(c => !favorites.has(c.id));
        return [...favs, ...rest];
    }

    // ===== Rendering =====

    async function render(container) {
        containerEl = container;
        await init();
        renderShell();
        renderClipList();
    }

    function renderShell() {
        const allSkillBtns = (skills || []).map(s => `
            <button class="refbank-skill-pill" data-skill="${s.id}"
                style="--skill-color:${s.color}; ${activeSkillFilters.has(s.id) ? `background:${s.color}25; border-color:${s.color}; color:${s.color};` : ''}">
                ${escapeHTML(s.name)}
            </button>
        `).join('');

        const diffOpts = ['all', 'beginner', 'intermediate', 'advanced'].map(d => `
            <button class="refbank-diff-btn ${activeDifficulty === d ? 'active' : ''}" data-diff="${d}">
                ${d === 'all' ? 'All' : d.charAt(0).toUpperCase() + d.slice(1)}
            </button>
        `).join('');

        containerEl.innerHTML = `
            <div class="refbank-root">
                <div class="refbank-header">
                    <div class="refbank-title-row">
                        <h2 class="refbank-title">Reference Clip Library</h2>
                        <span class="refbank-count" id="refbankCount"></span>
                    </div>
                    <p class="refbank-tagline">Short audio segments tagged by what they teach. Click a card to play the segment.</p>
                </div>

                <div class="refbank-filters">
                    <div class="refbank-search-wrap">
                        ${HiFiBuddyIcons.searchAlt({ size: 16 })}
                        <input type="text" class="refbank-search" id="refbankSearch"
                               placeholder="Search title, artist, characteristic..."
                               aria-label="Search reference clips"
                               value="${escapeHTML(searchQuery)}">
                        ${searchQuery ? `<button class="refbank-search-clear" id="refbankSearchClear" title="Clear" aria-label="Clear search">&times;</button>` : ''}
                    </div>

                    <div class="refbank-diff-row" id="refbankDiffRow">
                        <span class="refbank-filter-label">Difficulty:</span>
                        ${diffOpts}
                    </div>

                    <div class="refbank-skill-row" id="refbankSkillRow">
                        <span class="refbank-filter-label">Skills:</span>
                        ${allSkillBtns}
                        ${activeSkillFilters.size > 0 ? `
                            <button class="refbank-skill-clear" id="refbankSkillClear">Clear all</button>` : ''}
                    </div>
                </div>

                <div class="refbank-status" id="refbankStatus"></div>
                <div class="refbank-grid" id="refbankGrid"></div>
            </div>
        `;

        // Bind events
        const search = containerEl.querySelector('#refbankSearch');
        search?.addEventListener('input', e => {
            searchQuery = e.target.value;
            renderClipList();
            // Toggle clear button without full re-render
            const clearBtn = containerEl.querySelector('#refbankSearchClear');
            if (searchQuery && !clearBtn) {
                renderShell();
                renderClipList();
                containerEl.querySelector('#refbankSearch')?.focus();
            } else if (!searchQuery && clearBtn) {
                clearBtn.remove();
            }
        });

        containerEl.querySelector('#refbankSearchClear')?.addEventListener('click', () => {
            searchQuery = '';
            renderShell();
            renderClipList();
        });

        containerEl.querySelectorAll('.refbank-diff-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                activeDifficulty = btn.dataset.diff;
                renderShell();
                renderClipList();
            });
        });

        containerEl.querySelectorAll('.refbank-skill-pill').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.skill;
                if (activeSkillFilters.has(id)) activeSkillFilters.delete(id);
                else activeSkillFilters.add(id);
                renderShell();
                renderClipList();
            });
        });

        containerEl.querySelector('#refbankSkillClear')?.addEventListener('click', () => {
            activeSkillFilters.clear();
            renderShell();
            renderClipList();
        });
    }

    function renderClipList() {
        const grid = containerEl.querySelector('#refbankGrid');
        const countEl = containerEl.querySelector('#refbankCount');
        if (!grid) return;

        const filtered = applyFilters(clips || []);
        const sorted = sortClips(filtered);

        if (countEl) {
            countEl.textContent = `${sorted.length} of ${(clips || []).length}`;
        }

        if (sorted.length === 0) {
            grid.innerHTML = `
                <div class="refbank-empty">
                    No clips match. Try clearing filters or search.
                </div>`;
            return;
        }

        grid.innerHTML = sorted.map(c => renderClipCard(c)).join('');

        grid.querySelectorAll('.refbank-card').forEach(card => {
            const trigger = (e) => {
                if (e.target.closest('.refbank-fav-btn')) return;
                if (e.target.closest('.refbank-spotify-btn')) return;
                playClip(card.dataset.clipId);
            };
            card.addEventListener('click', trigger);
            // a11y: cards have role="button" + tabindex=0 — wire keyboard.
            card.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    if (e.target.closest('.refbank-fav-btn')) return;
                    if (e.target.closest('.refbank-spotify-btn')) return;
                    e.preventDefault();
                    trigger(e);
                }
            });
        });

        grid.querySelectorAll('.refbank-fav-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const id = btn.dataset.clipId;
                if (favorites.has(id)) favorites.delete(id);
                else favorites.add(id);
                saveFavorites();
                renderClipList();
            });
        });

        grid.querySelectorAll('.refbank-spotify-btn').forEach(btn => {
            btn.addEventListener('click', e => e.stopPropagation());
        });
    }

    function renderClipCard(c) {
        const skillPills = c.skills.map(sid => {
            const meta = getSkillMeta(sid);
            return `<span class="refbank-skill-tag" style="background:${meta.color}18; color:${meta.color}; border-color:${meta.color}40">
                ${escapeHTML(meta.name)}
            </span>`;
        }).join('');

        const isFav = favorites.has(c.id);
        const diffColor = c.difficulty === 'beginner' ? '#2ecc71'
            : c.difficulty === 'intermediate' ? '#e6a817' : '#e05555';
        const dur = segmentDurationSecs(c.segment);
        const isPlaying = currentPlayback?.clipId === c.id;
        const audiophileBadge = c.audiophilePressing
            ? `<span class="refbank-audiophile-badge" title="Audiophile pressing — may not be on Plex/Spotify">audiophile only</span>`
            : '';

        return `
            <div class="refbank-card ${isPlaying ? 'is-playing' : ''}" data-clip-id="${c.id}" role="button" tabindex="0" aria-label="Play clip: ${escapeHTML(c.track)} by ${escapeHTML(c.artist)}, ${escapeHTML(c.segment)}">
                <button class="refbank-fav-btn ${isFav ? 'is-fav' : ''}" data-clip-id="${c.id}"
                    title="${isFav ? 'Remove favorite' : 'Add to favorites'}"
                    aria-label="${isFav ? 'Remove favorite' : 'Add to favorites'}"
                    aria-pressed="${isFav ? 'true' : 'false'}">
                    ${isFav
                        ? HiFiBuddyIcons.starFilled5({ size: 16 })
                        : HiFiBuddyIcons.starOutline5({ size: 16 })}
                </button>

                <div class="refbank-card-header">
                    <span class="refbank-difficulty-dot" style="background:${diffColor}"
                          title="${c.difficulty}"></span>
                    <span class="refbank-segment">${escapeHTML(c.segment)}</span>
                    <span class="refbank-duration">~${Math.round(dur)}s</span>
                    ${audiophileBadge}
                </div>

                <div class="refbank-card-track">${escapeHTML(c.track)}</div>
                <div class="refbank-card-artist">${escapeHTML(c.artist)} &middot; ${escapeHTML(String(c.year))}</div>

                <div class="refbank-skill-tags">${skillPills}</div>

                <div class="refbank-characteristic">${escapeHTML(c.characteristic)}</div>
                <div class="refbank-description">${escapeHTML(c.description)}</div>

                <div class="refbank-card-actions">
                    <span class="refbank-play-hint">
                        ${HiFiBuddyIcons.play({ size: 12 })}
                        ${isPlaying ? 'Playing — click to restart' : 'Click to play segment'}
                    </span>
                    <a class="refbank-spotify-btn"
                       href="${spotifySearchUrl(c.track, c.artist)}"
                       target="_blank" rel="noopener"
                       title="Search on Spotify">
                        ${HiFiBuddyIcons.spotify({ size: 12, brand: false })}
                        Spotify
                    </a>
                </div>
            </div>
        `;
    }

    // ===== Playback =====

    function setStatus(msg, isError) {
        const el = containerEl?.querySelector('#refbankStatus');
        if (!el) return;
        el.textContent = msg || '';
        el.classList.toggle('refbank-status-error', !!isError);
        el.style.display = msg ? 'block' : 'none';
    }

    function clearAutoStop() {
        if (currentPlayback?.autoStopTimer) {
            clearTimeout(currentPlayback.autoStopTimer);
        }
        currentPlayback = null;
    }

    async function playClip(clipId) {
        const clip = (clips || []).find(c => c.id === clipId);
        if (!clip) return;

        // Cancel any prior auto-stop
        clearAutoStop();

        const { start, end } = parseSegment(clip.segment);
        const playRangeSecs = Math.max(2, end - start);

        if (!plexAvailable()) {
            setStatus('Plex not connected — opening Spotify search instead.', true);
            window.open(spotifySearchUrl(clip.track, clip.artist), '_blank', 'noopener');
            return;
        }

        try {
            // Cache hit (Layer A + Layer B, with a synchronous rebuild from
            // partKey + current token if Layer B is empty) → no network call.
            let result = getCachedClipMatch(clipId);

            if (!result) {
                setStatus(`Searching Plex for "${clip.track}"…`);
                const fresh = await HiFiBuddyPlex.searchTrack(clip.track, clip.artist);
                if (!fresh?.streamUrl) {
                    setStatus(`Not found in Plex: "${clip.track}". Try Spotify search.`, true);
                    return;
                }
                cacheClipMatch(clipId, fresh);
                result = fresh;
            }

            if (typeof HiFiBuddyAudio === 'undefined') {
                setStatus('Audio player not available.', true);
                return;
            }

            const thumbUrl = result.thumb ? HiFiBuddyPlex.getThumbUrl?.(result.thumb) : '';
            const ctx = {
                type: 'clip',
                label: `Reference Clip · ${clip.title || clip.track || clip.id}`,
            };
            HiFiBuddyAudio.play(result.streamUrl, result.title, result.artist, thumbUrl, ctx);

            // Seek + auto-stop
            seekAndArm(start, playRangeSecs, clipId);

            setStatus(`Playing ${clip.segment} — ${clip.track}`);
            renderClipList();
        } catch (e) {
            console.warn('[RefBank] play failed:', e);
            setStatus(`Playback failed: ${e.message}`, true);
        }
    }

    // Seek the underlying <audio> to `start`, set up auto-stop after `durationSecs`.
    function seekAndArm(startSecs, durationSecs, clipId) {
        const audioEl = document.querySelector('audio');
        if (!audioEl) return;

        // If already loaded enough, seek now; else wait for canplay/loadedmetadata.
        const doSeek = () => {
            try { audioEl.currentTime = startSecs; } catch { /* ignore */ }
            if (audioEl.paused) audioEl.play().catch(() => {});
        };

        if (audioEl.readyState >= 1 && audioEl.duration) {
            doSeek();
        } else {
            const onMeta = () => {
                audioEl.removeEventListener('loadedmetadata', onMeta);
                doSeek();
            };
            audioEl.addEventListener('loadedmetadata', onMeta);
            // Fallback after 4s
            setTimeout(() => {
                audioEl.removeEventListener('loadedmetadata', onMeta);
                doSeek();
            }, 4000);
        }

        // Auto-stop timer (slightly longer than the seek delay)
        const timer = setTimeout(() => {
            try { audioEl.pause(); } catch { /* ignore */ }
            if (currentPlayback?.clipId === clipId) {
                currentPlayback = null;
                setStatus('');
                renderClipList();
            }
        }, (durationSecs + 0.5) * 1000);

        currentPlayback = { clipId, autoStopTimer: timer };
    }

    // ===== Styles (injected so we don't touch styles.css) =====

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
.refbank-root {
    padding: 24px;
    max-width: 1280px;
    margin: 0 auto;
    color: var(--text-primary, #e8e8ea);
    width: 100%;
    box-sizing: border-box;
}
.refbank-header { margin-bottom: 20px; }
.refbank-title-row { display: flex; align-items: baseline; gap: 12px; }
.refbank-title {
    margin: 0;
    font-size: 28px;
    font-weight: 800;
    background: linear-gradient(135deg, #667eea 0%, #1abc9c 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
}
.refbank-count {
    font-size: 13px;
    color: var(--text-secondary, #999);
    font-weight: 500;
}
.refbank-tagline {
    margin: 6px 0 0;
    color: var(--text-secondary, #aaa);
    font-size: 14px;
}
.refbank-filters {
    background: var(--bg-elev-1, rgba(255,255,255,0.04));
    border: 1px solid var(--border-color, rgba(255,255,255,0.08));
    border-radius: 12px;
    padding: 14px 16px;
    margin-bottom: 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.refbank-search-wrap {
    display: flex; align-items: center; gap: 8px;
    background: var(--bg-elev-2, rgba(0,0,0,0.25));
    border: 1px solid var(--border-color, rgba(255,255,255,0.1));
    border-radius: 8px;
    padding: 8px 12px;
    color: var(--text-secondary, #888);
}
.refbank-search {
    flex: 1; background: transparent; border: 0; outline: none;
    font: inherit; color: var(--text-primary, #fff); font-size: 14px;
}
.refbank-search-clear {
    background: transparent; border: 0; color: var(--text-secondary, #888);
    cursor: pointer; font-size: 18px; line-height: 1; padding: 0 4px;
}
.refbank-search-clear:hover { color: var(--text-primary, #fff); }

.refbank-filter-label {
    font-size: 12px; font-weight: 600; color: var(--text-secondary, #888);
    text-transform: uppercase; letter-spacing: 0.04em; margin-right: 4px;
    align-self: center;
}
.refbank-diff-row, .refbank-skill-row {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
}
.refbank-diff-btn {
    background: transparent;
    border: 1px solid var(--border-color, rgba(255,255,255,0.15));
    color: var(--text-secondary, #aaa);
    padding: 5px 12px; border-radius: 16px; font-size: 12px; font-weight: 500;
    cursor: pointer; transition: all 0.15s ease;
}
.refbank-diff-btn:hover { border-color: #667eea; color: #fff; }
.refbank-diff-btn.active {
    background: rgba(102,126,234,0.18); border-color: #667eea; color: #667eea;
}
.refbank-skill-pill {
    background: transparent;
    border: 1px solid var(--border-color, rgba(255,255,255,0.15));
    color: var(--text-secondary, #aaa);
    padding: 4px 11px; border-radius: 14px; font-size: 12px; font-weight: 500;
    cursor: pointer; transition: all 0.15s ease;
}
.refbank-skill-pill:hover {
    border-color: var(--skill-color, #667eea);
    color: var(--skill-color, #667eea);
}
.refbank-skill-clear {
    background: transparent; border: 0;
    color: var(--text-secondary, #888);
    text-decoration: underline; cursor: pointer; font-size: 12px;
    margin-left: 6px;
}
.refbank-skill-clear:hover { color: #e05555; }

.refbank-status {
    background: rgba(102,126,234,0.12);
    border: 1px solid rgba(102,126,234,0.3);
    border-radius: 8px;
    padding: 8px 12px;
    margin-bottom: 12px;
    font-size: 13px;
    color: #9aa9e0;
    display: none;
}
.refbank-status-error {
    background: rgba(224,85,85,0.1);
    border-color: rgba(224,85,85,0.3);
    color: #e08080;
}

.refbank-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 14px;
}
.refbank-card {
    position: relative;
    background: var(--bg-elev-1, rgba(255,255,255,0.04));
    border: 1px solid var(--border-color, rgba(255,255,255,0.08));
    border-radius: 12px;
    padding: 14px 14px 12px;
    cursor: pointer;
    transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.refbank-card:hover {
    transform: translateY(-2px);
    border-color: rgba(102,126,234,0.5);
    box-shadow: 0 6px 20px rgba(0,0,0,0.25);
}
.refbank-card.is-playing {
    border-color: #2ecc71;
    box-shadow: 0 0 0 1px #2ecc71, 0 6px 20px rgba(46,204,113,0.2);
}
.refbank-card-header {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; color: var(--text-secondary, #888);
}
.refbank-difficulty-dot {
    width: 8px; height: 8px; border-radius: 50%;
    flex-shrink: 0;
}
.refbank-segment {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-weight: 600;
    color: var(--text-primary, #fff);
}
.refbank-duration { color: var(--text-secondary, #888); font-size: 11px; }
.refbank-audiophile-badge {
    margin-left: auto;
    background: rgba(229,160,13,0.15); color: #e5a00d;
    border: 1px solid rgba(229,160,13,0.3);
    border-radius: 4px; padding: 1px 6px;
    font-size: 10px; font-weight: 600; text-transform: uppercase;
}

.refbank-card-track {
    font-size: 15px; font-weight: 700; color: var(--text-primary, #fff);
    line-height: 1.3;
}
.refbank-card-artist {
    font-size: 12px; color: var(--text-secondary, #aaa);
}

.refbank-skill-tags {
    display: flex; flex-wrap: wrap; gap: 4px;
}
.refbank-skill-tag {
    border: 1px solid;
    border-radius: 10px;
    padding: 2px 8px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
}

.refbank-characteristic {
    font-size: 12px;
    font-style: italic;
    color: var(--text-secondary, #bbb);
    line-height: 1.4;
}
.refbank-description {
    font-size: 13px;
    color: var(--text-primary, #ddd);
    line-height: 1.5;
}

.refbank-card-actions {
    display: flex; align-items: center; justify-content: space-between;
    margin-top: 6px;
    padding-top: 8px;
    border-top: 1px solid var(--border-color, rgba(255,255,255,0.06));
}
.refbank-play-hint {
    display: flex; align-items: center; gap: 5px;
    font-size: 11px; color: var(--text-secondary, #888);
    font-weight: 500;
}
.refbank-spotify-btn {
    display: inline-flex; align-items: center; gap: 4px;
    background: rgba(30,215,96,0.12); color: #1ed760;
    border: 1px solid rgba(30,215,96,0.3);
    border-radius: 4px; padding: 3px 8px;
    font-size: 11px; font-weight: 600;
    text-decoration: none;
    transition: background 0.15s ease;
}
.refbank-spotify-btn:hover { background: rgba(30,215,96,0.22); }

.refbank-fav-btn {
    position: absolute;
    top: 8px; right: 8px;
    background: transparent; border: 0;
    cursor: pointer; padding: 4px;
    font-size: 18px; line-height: 1;
    color: var(--text-secondary, #666);
    transition: color 0.15s ease, transform 0.15s ease;
    z-index: 1;
}
.refbank-fav-btn:hover {
    color: #f1c40f; transform: scale(1.15);
}
.refbank-fav-btn.is-fav { color: #f1c40f; }

.refbank-empty {
    grid-column: 1 / -1;
    text-align: center; padding: 60px 20px;
    color: var(--text-secondary, #888);
    background: var(--bg-elev-1, rgba(255,255,255,0.03));
    border: 1px dashed var(--border-color, rgba(255,255,255,0.1));
    border-radius: 12px;
}
[data-theme="light"] .refbank-card { background: rgba(0,0,0,0.03); }
[data-theme="light"] .refbank-card:hover { background: rgba(0,0,0,0.05); }
[data-theme="light"] .refbank-filters { background: rgba(0,0,0,0.03); }
[data-theme="light"] .refbank-search-wrap { background: rgba(0,0,0,0.05); }
        `;
        document.head.appendChild(style);
    }

    return { init, render };
})();

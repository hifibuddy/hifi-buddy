/**
 * HiFi Buddy Track Variant Picker
 *
 * When Plex (or local library) has multiple matches for a lesson's track —
 * studio + live + remaster + compilation, etc. — the heuristic in
 * HiFiBuddyPlex.searchTrack picks one. This module surfaces every match so
 * the user can pin the lesson to an exact track. The choice is persisted in
 * localStorage and consulted by hifi-buddy.js's playFromPlex / playFromLocal.
 *
 * Storage shape:
 *   localStorage['hifibuddy_track_overrides'] = {
 *     "lesson-001": { source: 'plex'|'local', id: '<ratingKey or local id>' },
 *     ...
 *   }
 *
 * Public API:
 *   open(lesson)              — show modal, populated from Plex + local
 *   getOverride(lessonId)     — returns { source, id } | null
 *   setOverride(lessonId, o)  — persist
 *   clearOverride(lessonId)   — remove
 */
window.HiFiBuddyTrackPicker = (() => {
    'use strict';

    const STORAGE_KEY = 'hifibuddy_track_overrides';

    // ===== Persistence =====

    function loadAll() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
        } catch { return {}; }
    }

    function saveAll(map) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
        } catch (e) { console.warn('[TrackPicker] save failed:', e); }
    }

    function getOverride(lessonId) {
        if (!lessonId) return null;
        const all = loadAll();
        const o = all[lessonId];
        if (!o || !o.source || !o.id) return null;
        return { source: o.source, id: String(o.id) };
    }

    function setOverride(lessonId, override) {
        if (!lessonId || !override?.source || !override?.id) return;
        const all = loadAll();
        all[lessonId] = { source: override.source, id: String(override.id) };
        saveAll(all);
    }

    function clearOverride(lessonId) {
        if (!lessonId) return;
        const all = loadAll();
        if (all[lessonId]) {
            delete all[lessonId];
            saveAll(all);
        }
    }

    // ===== Helpers =====

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function fmtMs(ms) {
        if (!ms || ms < 0) return '';
        const total = Math.floor(ms / 1000);
        const m = Math.floor(total / 60);
        const s = total % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function fmtQuality(q) {
        if (!q) return '';
        const codec = (q.codec || '').toUpperCase();
        const isLossless = ['FLAC', 'ALAC', 'WAV', 'AIFF', 'DSD'].includes(codec);
        const bits = [];
        if (codec) bits.push(codec);
        if (q.bitDepth) bits.push(`${q.bitDepth}-bit`);
        if (q.sampleRate) bits.push(`${(q.sampleRate / 1000).toFixed(1)}kHz`);
        if (q.bitrate) {
            // For lossless show bitrate too (signals compressed-FLAC vs uncompressed);
            // for lossy it's the only quality marker that matters.
            if (isLossless && q.bitDepth && q.sampleRate) bits.push(`${Math.round(q.bitrate)}kbps`);
            else if (!isLossless) bits.push(`${Math.round(q.bitrate)}kbps`);
        }
        return bits.join(' / ');
    }

    // ===== Match collection =====

    async function collectPlexMatches(lesson) {
        if (typeof HiFiBuddyPlex === 'undefined') return [];
        if (typeof HiFiBuddyPlex.searchTrackAll !== 'function') return [];
        try {
            const all = await HiFiBuddyPlex.searchTrackAll(
                lesson.track.title, lesson.album.artist,
                { enrich: true, enrichLimit: 12 }   // pull bitDepth + samplingRate per variant
            );
            return (all || []).map(r => ({
                source: 'plex',
                id: String(r.ratingKey),
                title: r.title,
                artist: r.artist,
                album: r.album,
                year: r.albumYear,
                durationLabel: fmtMs(r.duration),
                qualityLabel: fmtQuality(r.quality),
                streamUrl: r.streamUrl,
                thumb: r.thumb,
                _raw: r,
            }));
        } catch (e) {
            console.warn('[TrackPicker] Plex collect failed:', e);
            return [];
        }
    }

    function collectLocalMatches(lesson) {
        if (typeof HiFiBuddyLocalLibrary === 'undefined') return [];
        if (typeof HiFiBuddyLocalLibrary.findAllMatches !== 'function') return [];
        const list = HiFiBuddyLocalLibrary.findAllMatches(
            lesson.track.title, lesson.album.artist
        ) || [];
        return list.map(t => ({
            source: 'local',
            id: String(t.id),
            title: t.title,
            artist: t.artist,
            album: t.album || '',
            year: t.year || null,
            // Local index reports duration in seconds; Plex reports ms.
            durationLabel: fmtMs((t.duration || 0) > 1000 ? t.duration : (t.duration || 0) * 1000),
            qualityLabel: (t.codec || '').toUpperCase(),
            mbid: t.mbid || '',
        }));
    }

    function dedupe(rows) {
        const seen = new Set();
        const out = [];
        for (const r of rows) {
            const k = `${r.source}|${r.id}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(r);
        }
        return out;
    }

    // ===== Modal =====

    function ensureModalRoot() {
        let root = document.getElementById('trackPickerOverlay');
        if (root) return root;
        root = document.createElement('div');
        root.id = 'trackPickerOverlay';
        root.className = 'modal-overlay track-picker-overlay';
        root.style.display = 'none';
        document.body.appendChild(root);
        return root;
    }

    function closeModal() {
        const root = document.getElementById('trackPickerOverlay');
        if (root) root.style.display = 'none';
    }

    async function open(lesson) {
        if (!lesson?.id) return;
        const root = ensureModalRoot();
        root.style.display = 'flex';
        root.innerHTML = `
            <div class="modal track-picker-modal">
                <div class="modal-header">
                    <h3>Choose track variant</h3>
                    <button class="modal-close" id="tpClose" title="Close">
                        ${HiFiBuddyIcons.close({ size: 18 })}
                    </button>
                </div>
                <div class="modal-body">
                    <div class="tp-target">
                        <div class="tp-target-title">${escHtml(lesson.track.title)}</div>
                        <div class="tp-target-meta">${escHtml(lesson.album.artist)} &middot; ${escHtml(lesson.album.title)}</div>
                    </div>
                    <div class="tp-list" id="tpList">
                        <div class="tp-loading">
                            <span class="tp-spinner"></span> Searching Plex and local library…
                        </div>
                    </div>
                    <div class="tp-actions">
                        <button class="tp-clear-btn" id="tpClear">Clear override (use heuristic)</button>
                    </div>
                </div>
            </div>
        `;

        root.querySelector('#tpClose')?.addEventListener('click', closeModal);
        root.addEventListener('click', e => { if (e.target === root) closeModal(); });
        root.querySelector('#tpClear')?.addEventListener('click', () => {
            clearOverride(lesson.id);
            if (typeof HiFiBuddyToast !== 'undefined') {
                HiFiBuddyToast.success('Track override cleared.');
            }
            closeModal();
            window.dispatchEvent(new CustomEvent('hifibuddy-track-override-changed', {
                detail: { lessonId: lesson.id }
            }));
        });

        // Fetch Plex + local in parallel
        const [plexMatches, localMatches] = await Promise.all([
            collectPlexMatches(lesson),
            Promise.resolve(collectLocalMatches(lesson)),
        ]);

        const rows = dedupe([...plexMatches, ...localMatches]);
        renderRows(root, lesson, rows);
    }

    function renderRows(root, lesson, rows) {
        const listEl = root.querySelector('#tpList');
        if (!listEl) return;

        if (rows.length === 0) {
            listEl.innerHTML = `
                <div class="tp-empty">
                    No variants found in Plex or local library for
                    <strong>${escHtml(lesson.track.title)}</strong>.
                </div>
            `;
            return;
        }

        const mbid = lesson.track?.musicbrainzRecordingId || '';
        const current = getOverride(lesson.id);

        listEl.innerHTML = rows.map(r => {
            // Auto-select badge: local entry whose MBID matches the lesson's recording
            const isMbidMatch = mbid && r.source === 'local' && r.mbid && r.mbid === mbid;
            const isCurrent = current && current.source === r.source && String(current.id) === String(r.id);
            const badges = [];
            if (isMbidMatch) badges.push('<span class="tp-row-badge tp-badge-mbid">Best match by MBID</span>');
            if (isCurrent) badges.push('<span class="tp-row-badge tp-badge-current">Current</span>');
            const sourceLabel = r.source === 'plex' ? 'Plex' : 'Local';
            const sourceClass = r.source === 'plex' ? 'tp-src-plex' : 'tp-src-local';
            const metaBits = [
                r.album,
                r.year,
                r.durationLabel,
                r.qualityLabel,
            ].filter(Boolean).map(escHtml).join(' &middot; ');

            return `
                <button class="tp-row ${isCurrent ? 'tp-row-current' : ''}"
                        data-source="${escHtml(r.source)}"
                        data-id="${escHtml(r.id)}">
                    <span class="tp-row-source ${sourceClass}">${sourceLabel}</span>
                    <span class="tp-row-main">
                        <span class="tp-row-title">${escHtml(r.title)} ${badges.join(' ')}</span>
                        <span class="tp-row-meta">${metaBits}</span>
                    </span>
                    <span class="tp-row-pick">
                        ${HiFiBuddyIcons.chevronRight({ size: 16 })}
                    </span>
                </button>
            `;
        }).join('');

        listEl.querySelectorAll('.tp-row').forEach(rowEl => {
            rowEl.addEventListener('click', () => {
                const source = rowEl.dataset.source;
                const id = rowEl.dataset.id;
                if (!source || !id) return;
                setOverride(lesson.id, { source, id });
                if (typeof HiFiBuddyToast !== 'undefined') {
                    HiFiBuddyToast.success('Track variant saved for this lesson.');
                }
                closeModal();
                window.dispatchEvent(new CustomEvent('hifibuddy-track-override-changed', {
                    detail: { lessonId: lesson.id, source, id }
                }));
            });
        });
    }

    return { open, getOverride, setOverride, clearOverride };
})();

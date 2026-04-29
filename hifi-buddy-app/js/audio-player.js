/**
 * HiFi Buddy Audio Player
 * Mini player bar for Spotify 30-second previews
 */
window.HiFiBuddyAudio = (() => {
    'use strict';

    let audio = null;
    let currentTrack = null;
    let currentContext = null; // { type, label }
    let progressInterval = null;

    // Color map for context badges. Keep in sync with .ap-context-* classes.
    const CONTEXT_COLORS = {
        lesson:       '#9b59b6',
        clip:         '#e67e22',
        local:        '#1abc9c',
        'plex-direct':'#e5a00d',
        spotify:      '#1db954',
        custom:       '#7a7a90',
    };

    function init() {
        audio = new Audio();
        audio.volume = 0.7;
        // CROSS-BROWSER: set crossOrigin BEFORE the first src is assigned. Once
        // the element has loaded media without `crossOrigin` set, a downstream
        // MediaElementAudioSourceNode (used by the visualizer) will silently
        // produce 0-amplitude data because the audio is treated as "tainted".
        // Our same-origin proxy already sends Access-Control-Allow-Origin: *,
        // so 'anonymous' is the safe choice that works for both same-origin
        // assets and CORS-enabled URLs.
        audio.crossOrigin = 'anonymous';
        // Add to DOM so other modules can find it via document.querySelector('audio')
        audio.style.display = 'none';
        document.body.appendChild(audio);
        audio.addEventListener('ended', () => updateUI(false));
        audio.addEventListener('error', () => updateUI(false));
    }

    function play(url, title, artist, imageUrl, context) {
        if (!audio) init();
        if (currentTrack?.url === url && !audio.paused) {
            pause();
            return;
        }
        audio.preload = 'auto';
        audio.src = url;
        audio.play().catch(() => {});
        currentTrack = { url, title, artist, imageUrl };
        currentContext = sanitizeContext(context);
        showBar();
        updateUI(true);
        startProgress();
    }

    // Validate and normalize an optional context object passed to play().
    // Returns null when no usable context is provided.
    function sanitizeContext(ctx) {
        if (!ctx || typeof ctx !== 'object') return null;
        const type = String(ctx.type || '').trim();
        const label = String(ctx.label || '').trim();
        if (!label) return null;
        const known = Object.prototype.hasOwnProperty.call(CONTEXT_COLORS, type);
        return { type: known ? type : 'custom', label };
    }

    // Update the context badge for the currently playing track without
    // restarting playback. Pass null to clear.
    function setContext(ctx) {
        currentContext = sanitizeContext(ctx);
        renderContextBadge();
    }

    function getContext() {
        return currentContext;
    }

    function preload(url) {
        if (!audio) init();
        audio.preload = 'auto';
        audio.src = url;
        audio.load();
    }

    function pause() {
        if (audio) audio.pause();
        updateUI(false);
        stopProgress();
    }

    function toggle() {
        if (!audio || !currentTrack) return;
        if (audio.paused) {
            audio.play().catch(() => {});
            updateUI(true);
            startProgress();
        } else {
            pause();
        }
    }

    function setVolume(v) {
        if (audio) audio.volume = Math.max(0, Math.min(1, v));
    }

    function isPlaying() {
        return audio && !audio.paused;
    }

    function getCurrentTrack() {
        return currentTrack;
    }

    function showBar() {
        const bar = document.getElementById('audioPlayerBar');
        if (!bar) return;
        bar.style.display = 'flex';
        bar.innerHTML = `
            <div class="ap-track-info">
                ${currentTrack.imageUrl ? `<img src="${currentTrack.imageUrl}" class="ap-cover" alt="">` : `<div class="ap-cover-placeholder" aria-hidden="true">${HiFiBuddyIcons.music({ size: 14 })}</div>`}
                <div class="ap-text">
                    ${renderContextBadgeHtml()}
                    <div class="ap-title">${escHtml(currentTrack.title)}</div>
                    <div class="ap-artist">${escHtml(currentTrack.artist)}</div>
                </div>
            </div>
            <div class="ap-controls">
                <button class="ap-play-btn" id="apToggle" aria-label="Play or pause">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true"><path id="apIcon" d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>
                </button>
            </div>
            <div class="ap-progress-container">
                <div class="ap-progress-bar" id="apProgressBar" role="progressbar" aria-label="Playback progress"><div class="ap-progress-fill" id="apProgressFill"></div></div>
                <span class="ap-time" id="apTime">0:00</span>
            </div>
            <button class="ap-close-btn" id="apClose" aria-label="Close player">
                ${HiFiBuddyIcons.close({ size: 16 })}
            </button>
        `;
        document.getElementById('apToggle')?.addEventListener('click', toggle);
        document.getElementById('apClose')?.addEventListener('click', () => {
            stop();
            bar.style.display = 'none';
        });
    }

    function stop() {
        if (audio) { audio.pause(); audio.src = ''; }
        currentTrack = null;
        stopProgress();
    }

    function updateUI(playing) {
        const icon = document.getElementById('apIcon');
        if (icon) {
            icon.setAttribute('d', playing
                ? 'M6 4h4v16H6zM14 4h4v16h-4z' // pause
                : 'M8 5v14l11-7z' // play
            );
        }
    }

    function startProgress() {
        stopProgress();
        progressInterval = setInterval(() => {
            if (!audio || audio.paused) return;
            const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
            const fill = document.getElementById('apProgressFill');
            const time = document.getElementById('apTime');
            if (fill) fill.style.width = pct + '%';
            if (time) {
                const totalSec = Math.floor(audio.currentTime);
                const min = Math.floor(totalSec / 60);
                const sec = totalSec % 60;
                time.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
            }
        }, 200);
    }

    function stopProgress() {
        if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
    }

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    // Build the context badge HTML for the player bar. Returns '' when no
    // context is set so the player layout collapses cleanly.
    function renderContextBadgeHtml() {
        if (!currentContext) return '';
        const color = CONTEXT_COLORS[currentContext.type] || CONTEXT_COLORS.custom;
        return `<div class="ap-context ap-context-${escAttr(currentContext.type)}"`
            + ` style="--ap-ctx-color:${color}">${escHtml(currentContext.label)}</div>`;
    }

    // Update only the badge in-place (used by setContext when bar is already
    // rendered). Falls back to a full re-render if the slot isn't found.
    function renderContextBadge() {
        const bar = document.getElementById('audioPlayerBar');
        if (!bar || bar.style.display === 'none' || !currentTrack) return;
        const text = bar.querySelector('.ap-text');
        if (!text) return;
        const existing = text.querySelector('.ap-context');
        if (currentContext) {
            const html = renderContextBadgeHtml();
            if (existing) existing.outerHTML = html;
            else text.insertAdjacentHTML('afterbegin', html);
        } else if (existing) {
            existing.remove();
        }
    }

    function escAttr(s) {
        return String(s || '').replace(/[^a-z0-9_-]/gi, '');
    }

    return {
        init, play, pause, toggle, stop, setVolume,
        isPlaying, getCurrentTrack, preload,
        setContext, getContext,
    };
})();

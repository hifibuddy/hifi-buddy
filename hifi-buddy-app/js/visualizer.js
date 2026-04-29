/**
 * HiFi Buddy Frequency Visualizer
 *
 * Real-time spectrum analyzer for the active audio source.
 *
 * Public API:
 *   HiFiBuddyVisualizer.init()
 *   HiFiBuddyVisualizer.attach(audioEl)  -> Promise
 *   HiFiBuddyVisualizer.detach()
 *   HiFiBuddyVisualizer.show() / hide() / toggle()
 *
 * Integration in hifi-buddy.js:
 *   1. Call init() once on first lesson render
 *   2. After HiFiBuddyAudio.play(), grab document.querySelector('audio') and call attach(el)
 *   3. Optionally add a "Spectrum" toggle button in the lesson UI that calls toggle()
 *
 * Limitations:
 *   - Spotify Web Playback SDK output is NOT accessible (Spotify CORS restriction).
 *     The module gracefully shows an "unavailable for Spotify SDK" message in that case.
 *   - First attach to an <audio> element must happen BEFORE the source URL is set,
 *     for crossOrigin='anonymous' to take effect. If attached after, sound still plays
 *     but the spectrum will be silent.
 */
window.HiFiBuddyVisualizer = (() => {
    'use strict';

    // ===== Config =====

    const FFT_SIZE = 4096;
    const SMOOTHING = 0.7;
    const DEFAULT_BAR_COUNT = 64;
    const TARGET_FPS = 30;
    const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
    const PEAK_DECAY_MS = 500;          // peak hold decay duration
    const F_MIN = 30;                   // Hz — start of log frequency range
    const F_MAX = 18000;                // Hz — end of log frequency range
    const STORAGE_KEY = 'hifibuddy_visualizer_settings';
    const FR_OVERLAY_KEY = 'hifibuddy_visualizer_fr_overlay';
    const FR_DATA_URL = 'data/headphones-fr.json';
    const FR_DB_RANGE = 15;             // ±15 dB maps to ±half-height of the canvas

    // ===== State =====

    let initialized = false;
    let audioCtx = null;
    let analyser = null;
    let mediaSource = null;
    let attachedEl = null;
    let freqData = null;          // Uint8Array of FFT magnitudes
    let peaks = null;             // Float32Array, current peak heights (0..1)
    let peakTimes = null;         // Float64Array of last update timestamps
    let rafId = null;
    let lastFrameAt = 0;
    let canvas = null;
    let ctx = null;
    let container = null;
    let labelEl = null;
    let unsupportedMode = false;  // true → render the "Spotify unsupported" message instead of bars

    // The Web Audio spec forbids creating two MediaElementAudioSourceNode for the
    // same <audio> element. Cache so re-attach is a no-op.
    const sourceCache = new WeakMap();

    // User-tunable settings (persisted in localStorage)
    let settings = {
        barCount: DEFAULT_BAR_COUNT,
        colorScheme: 'gradient',  // 'single' | 'gradient' | 'skill'
        peakHold: true,
    };

    // Headphone FR overlay state (loaded once, lazily, in background)
    let headphonesFR = null;          // Array<{id,name,type,fr,notes}> | null
    let headphonesFRLoading = false;
    let frOverlayEnabled = true;      // toggle, persisted separately

    // ===== Settings persistence =====

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) Object.assign(settings, JSON.parse(raw));
        } catch { /* ignore */ }
        ensurePeakBuffers();
    }

    function saveSettings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
        catch { /* ignore */ }
    }

    function loadFROverlayPref() {
        try {
            const raw = localStorage.getItem(FR_OVERLAY_KEY);
            if (raw != null) frOverlayEnabled = raw === 'true' || raw === '1';
        } catch { /* ignore */ }
    }

    function saveFROverlayPref() {
        try { localStorage.setItem(FR_OVERLAY_KEY, frOverlayEnabled ? 'true' : 'false'); }
        catch { /* ignore */ }
    }

    // ===== Headphone FR data loading & matching =====

    function loadHeadphoneFR() {
        if (headphonesFR || headphonesFRLoading) return;
        headphonesFRLoading = true;
        // Lazy, non-blocking. Failures are silent.
        try {
            fetch(FR_DATA_URL, { cache: 'force-cache' })
                .then((r) => (r && r.ok ? r.json() : null))
                .then((data) => {
                    if (Array.isArray(data) && data.length > 0) {
                        headphonesFR = data;
                    }
                })
                .catch(() => { /* silent */ })
                .finally(() => { headphonesFRLoading = false; });
        } catch {
            headphonesFRLoading = false;
        }
    }

    // Strip non-alphanumerics, lowercase, for fuzzy comparison.
    function normalizeName(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    /**
     * Find the best matching headphone FR entry for a user-typed name.
     * - Lowercased & alphanumeric-only fuzzy match.
     * - Picks the most specific match (longest matched substring).
     * Returns the entry object or null.
     */
    function findHeadphoneFR(name) {
        if (!headphonesFR || !name) return null;
        const q = normalizeName(name);
        if (!q) return null;
        let best = null;
        let bestLen = 0;
        for (const h of headphonesFR) {
            const candidates = [h.name, h.id];
            for (const c of candidates) {
                const n = normalizeName(c);
                if (!n) continue;
                // Bidirectional substring match — user query contains entry, or vice versa
                if (q.includes(n) || n.includes(q)) {
                    // Score by the length of the shorter matched form (more specific wins)
                    const matchLen = Math.min(n.length, q.length);
                    if (matchLen > bestLen) {
                        bestLen = matchLen;
                        best = h;
                    }
                }
            }
        }
        return best;
    }

    function ensurePeakBuffers() {
        peaks = new Float32Array(settings.barCount);
        peakTimes = new Float64Array(settings.barCount);
    }

    // ===== CSS injection =====

    const CSS = `
        .vis-container {
            position: fixed;
            left: 0;
            right: 0;
            bottom: 64px; /* sits directly above #audioPlayerBar */
            height: 140px;
            z-index: 1100;
            background: linear-gradient(180deg, rgba(8,10,14,0.96) 0%, rgba(4,5,8,0.98) 100%);
            border-top: 1px solid rgba(255,255,255,0.06);
            box-shadow: 0 -6px 24px rgba(0,0,0,0.55);
            display: none;
            overflow: hidden;
        }
        .vis-container.vis-visible { display: block; }
        .vis-canvas {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            display: block;
        }
        .vis-label {
            position: absolute;
            top: 6px;
            left: 10px;
            font: 600 10px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: rgba(255,255,255,0.55);
            pointer-events: none;
            user-select: none;
            text-shadow: 0 1px 2px rgba(0,0,0,0.6);
        }
        .vis-btn {
            position: absolute;
            top: 4px;
            width: 22px;
            height: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            color: rgba(255,255,255,0.7);
            border-radius: 4px;
            cursor: pointer;
            font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
            padding: 0;
            transition: background 120ms ease, color 120ms ease;
        }
        .vis-btn:hover {
            background: rgba(255,255,255,0.12);
            color: #fff;
        }
        .vis-close { right: 6px; }
        .vis-cog { right: 32px; }
        .vis-popover {
            position: absolute;
            top: 32px;
            right: 6px;
            background: rgba(18,20,26,0.97);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px;
            padding: 10px 12px;
            font: 11px/1.4 ui-sans-serif, system-ui, sans-serif;
            color: rgba(255,255,255,0.85);
            box-shadow: 0 8px 24px rgba(0,0,0,0.6);
            display: none;
            min-width: 180px;
            z-index: 2;
        }
        .vis-popover.vis-open { display: block; }
        .vis-popover label {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
            margin: 6px 0;
            cursor: pointer;
        }
        .vis-popover select,
        .vis-popover input[type="checkbox"] {
            background: rgba(255,255,255,0.05);
            color: #fff;
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 4px;
            font-size: 11px;
            padding: 2px 4px;
        }
        .vis-popover h5 {
            margin: 0 0 6px 0;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            color: rgba(255,255,255,0.5);
        }
        @media (max-width: 640px) {
            .vis-container { height: 110px; }
        }
    `;

    function injectCss() {
        if (document.getElementById('visualizer-style')) return;
        const style = document.createElement('style');
        style.id = 'visualizer-style';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    // ===== DOM =====

    function ensureContainer() {
        if (container) return container;

        container = document.createElement('div');
        container.className = 'vis-container';
        container.id = 'visualizerContainer';
        container.setAttribute('role', 'region');
        container.setAttribute('aria-label', 'Frequency spectrum visualizer');

        canvas = document.createElement('canvas');
        canvas.className = 'vis-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        ctx = canvas.getContext('2d');
        container.appendChild(canvas);

        labelEl = document.createElement('div');
        labelEl.className = 'vis-label';
        labelEl.textContent = 'Spectrum';
        container.appendChild(labelEl);

        const cog = document.createElement('button');
        cog.type = 'button';
        cog.className = 'vis-btn vis-cog';
        cog.title = 'Visualizer settings';
        cog.setAttribute('aria-label', 'Visualizer settings');
        cog.setAttribute('aria-haspopup', 'true');
        cog.setAttribute('aria-expanded', 'false');
        cog.setAttribute('aria-controls', 'visualizerPopover');
        cog.innerHTML = '&#9881;';
        container.appendChild(cog);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'vis-btn vis-close';
        close.title = 'Hide visualizer';
        close.setAttribute('aria-label', 'Hide visualizer');
        close.innerHTML = '&times;';
        close.addEventListener('click', hide);
        container.appendChild(close);

        const popover = buildPopover();
        popover.id = 'visualizerPopover';
        container.appendChild(popover);
        cog.addEventListener('click', (e) => {
            e.stopPropagation();
            const opened = popover.classList.toggle('vis-open');
            cog.setAttribute('aria-expanded', opened ? 'true' : 'false');
        });
        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) {
                popover.classList.remove('vis-open');
                cog.setAttribute('aria-expanded', 'false');
            }
        });

        document.body.appendChild(container);

        // Resize canvas backing store to match CSS size with DPR
        const resize = () => {
            if (!canvas) return;
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const rect = canvas.getBoundingClientRect();
            canvas.width = Math.max(1, Math.floor(rect.width * dpr));
            canvas.height = Math.max(1, Math.floor(rect.height * dpr));
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        window.addEventListener('resize', resize);
        // Run once now and on next frame to catch initial layout
        setTimeout(resize, 0);
        canvas._resize = resize;

        return container;
    }

    function buildPopover() {
        const pop = document.createElement('div');
        pop.className = 'vis-popover';
        pop.innerHTML = `
            <h5>Spectrum Settings</h5>
            <label>Bars
                <select class="vis-bars">
                    <option value="32">32</option>
                    <option value="64">64</option>
                    <option value="128">128</option>
                    <option value="256">256</option>
                </select>
            </label>
            <label>Colors
                <select class="vis-color">
                    <option value="single">Single</option>
                    <option value="gradient">Gradient</option>
                    <option value="skill">Skill-tinted</option>
                </select>
            </label>
            <label>Peak hold
                <input type="checkbox" class="vis-peak">
            </label>
            <label>FR overlay
                <input type="checkbox" class="vis-fr-overlay">
            </label>
        `;
        const barsSel = pop.querySelector('.vis-bars');
        const colorSel = pop.querySelector('.vis-color');
        const peakCb = pop.querySelector('.vis-peak');
        const frCb = pop.querySelector('.vis-fr-overlay');

        barsSel.value = String(settings.barCount);
        colorSel.value = settings.colorScheme;
        peakCb.checked = !!settings.peakHold;
        frCb.checked = !!frOverlayEnabled;

        barsSel.addEventListener('change', () => {
            settings.barCount = parseInt(barsSel.value, 10) || DEFAULT_BAR_COUNT;
            ensurePeakBuffers();
            saveSettings();
        });
        colorSel.addEventListener('change', () => {
            settings.colorScheme = colorSel.value;
            saveSettings();
        });
        peakCb.addEventListener('change', () => {
            settings.peakHold = peakCb.checked;
            saveSettings();
        });
        frCb.addEventListener('change', () => {
            frOverlayEnabled = frCb.checked;
            saveFROverlayPref();
        });
        return pop;
    }

    // ===== Source detection =====

    function detectSource(audioEl) {
        if (typeof window.HiFiBuddyActiveSource === 'string' && window.HiFiBuddyActiveSource) {
            return window.HiFiBuddyActiveSource;
        }
        const src = audioEl?.currentSrc || audioEl?.src || '';
        if (!src) return 'Unknown';
        if (src.startsWith('blob:') || src.startsWith('data:')) return 'Local';
        try {
            const u = new URL(src, window.location.href);
            if (u.origin === window.location.origin) {
                if (u.pathname.includes('plex-stream') || u.pathname.includes('plex')) return 'Plex';
                return 'Local';
            }
            if (/spotify|scdn\.co/i.test(u.hostname)) return 'Spotify';
            return u.hostname;
        } catch {
            return 'Unknown';
        }
    }

    function isLikelyLocal(audioEl) {
        if (!audioEl) return false;
        const src = audioEl.currentSrc || audioEl.src || '';
        if (!src) return false;
        if (src.startsWith('blob:') || src.startsWith('data:')) return true;
        try {
            const u = new URL(src, window.location.href);
            return u.origin === window.location.origin;
        } catch {
            return false;
        }
    }

    // ===== Web Audio wiring =====

    function ensureAudioCtx() {
        if (audioCtx) return audioCtx;
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        try {
            audioCtx = new Ctor();
        } catch (e) {
            console.warn('[Visualizer] AudioContext create failed:', e);
            return null;
        }
        return audioCtx;
    }

    async function attach(audioEl) {
        try {
            init();
            ensureContainer();

            // Update the corner label
            if (labelEl) {
                labelEl.textContent = detectSource(audioEl);
            }

            // No usable element, or it's clearly not local — show unsupported overlay
            if (!audioEl || !(audioEl instanceof HTMLAudioElement)) {
                unsupportedMode = true;
                attachedEl = null;
                show();
                startLoop();
                return;
            }

            if (!isLikelyLocal(audioEl)) {
                // Spotify SDK / cross-origin: graceful unsupported overlay
                unsupportedMode = true;
                attachedEl = audioEl;
                show();
                startLoop();
                return;
            }

            unsupportedMode = false;

            // Set crossOrigin defensively BEFORE the source loads, if possible
            if (audioEl.crossOrigin == null) {
                if (!audioEl.src && !audioEl.currentSrc) {
                    audioEl.crossOrigin = 'anonymous';
                } else if (audioEl.readyState === 0) {
                    audioEl.crossOrigin = 'anonymous';
                } else {
                    console.warn('[Visualizer] audio element already loading; crossOrigin not set — spectrum may be silent.');
                }
            }

            // No-op when re-attaching the same element
            if (attachedEl === audioEl && analyser) {
                show();
                startLoop();
                return;
            }

            // If we're switching elements, clean up prior wiring first
            if (attachedEl && attachedEl !== audioEl) {
                detachInternal({ keepCanvas: true });
            }

            const ctxA = ensureAudioCtx();
            if (!ctxA) {
                unsupportedMode = true;
                show();
                startLoop();
                return;
            }
            if (ctxA.state === 'suspended') {
                try { await ctxA.resume(); } catch { /* ignore */ }
            }

            // Spec: only one MediaElementAudioSourceNode per element. Reuse from cache.
            let src = sourceCache.get(audioEl);
            if (!src) {
                try {
                    src = ctxA.createMediaElementSource(audioEl);
                    sourceCache.set(audioEl, src);
                } catch (e) {
                    console.warn('[Visualizer] createMediaElementSource failed:', e);
                    unsupportedMode = true;
                    show();
                    startLoop();
                    return;
                }
            }
            mediaSource = src;

            const an = ctxA.createAnalyser();
            an.fftSize = FFT_SIZE;
            an.smoothingTimeConstant = SMOOTHING;
            analyser = an;

            // Wire: source → analyser → destination. The analyser is a passive tap;
            // also keep source → destination via the analyser's pass-through (Analyser
            // node passes audio through unchanged).
            try {
                mediaSource.connect(analyser);
                analyser.connect(ctxA.destination);
            } catch (e) {
                console.warn('[Visualizer] node connect failed:', e);
            }

            freqData = new Uint8Array(an.frequencyBinCount);
            attachedEl = audioEl;

            show();
            startLoop();
        } catch (e) {
            console.warn('[Visualizer] attach error:', e);
            unsupportedMode = true;
            try { show(); startLoop(); } catch { /* ignore */ }
        }
    }

    // Internal: tear down nodes WITHOUT removing the cached MediaElementSource.
    // We disconnect analyser from destination and re-route source straight to
    // destination so audio keeps playing — disconnecting a MediaElementSource's
    // only path to destination silences the <audio> element.
    function detachInternal({ keepCanvas } = {}) {
        stopLoop();
        try {
            if (analyser) {
                try { analyser.disconnect(); } catch { /* ignore */ }
            }
            if (mediaSource && audioCtx) {
                try { mediaSource.disconnect(); } catch { /* ignore */ }
                // Re-route source directly to destination so playback keeps working
                try { mediaSource.connect(audioCtx.destination); } catch { /* ignore */ }
            }
        } catch (e) {
            console.warn('[Visualizer] detach cleanup warning:', e);
        }
        analyser = null;
        mediaSource = null;
        attachedEl = null;
        freqData = null;
        if (!keepCanvas && container) {
            container.classList.remove('vis-visible');
        }
    }

    function detach() {
        detachInternal({ keepCanvas: false });
    }

    // ===== Render loop =====

    function startLoop() {
        if (rafId != null) return;
        const tick = (now) => {
            rafId = requestAnimationFrame(tick);
            if (!container || !container.classList.contains('vis-visible')) return;
            if (now - lastFrameAt < FRAME_INTERVAL_MS) return;
            lastFrameAt = now;
            draw(now);
        };
        rafId = requestAnimationFrame(tick);
    }

    function stopLoop() {
        if (rafId != null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    }

    // Map a display bar index → [binStart, binEnd] in the FFT bins, log-spaced.
    function logBinRange(barIdx, barCount, sampleRate, binCount) {
        const fLo = F_MIN * Math.pow(F_MAX / F_MIN, barIdx / barCount);
        const fHi = F_MIN * Math.pow(F_MAX / F_MIN, (barIdx + 1) / barCount);
        const nyquist = sampleRate / 2;
        let binLo = Math.floor(fLo / nyquist * binCount);
        let binHi = Math.floor(fHi / nyquist * binCount);
        if (binHi <= binLo) binHi = binLo + 1;
        binLo = Math.max(0, Math.min(binCount - 1, binLo));
        binHi = Math.max(0, Math.min(binCount, binHi));
        return [binLo, binHi];
    }

    // Color for bar at fraction f in [0..1] (low-freq = 0, high-freq = 1)
    function barColor(f, amp) {
        if (settings.colorScheme === 'single') {
            const a = 0.55 + 0.4 * amp;
            return `rgba(120, 200, 255, ${a})`;
        }
        if (settings.colorScheme === 'skill') {
            // Tinted purple → cyan, app-aligned
            const h = 280 - 180 * f;       // 280 (purple) → 100 (greenish cyan)
            const s = 70;
            const l = 35 + 30 * amp;
            return `hsl(${h}, ${s}%, ${l}%)`;
        }
        // 'gradient' — cool low → warm high
        // Hue map: 250 (deep blue) at f=0 → 0 (red) at f=1, with amber pivot
        const h = 250 - 250 * f;
        const s = 80;
        const l = 38 + 28 * amp;
        return `hsl(${h}, ${s}%, ${l}%)`;
    }

    function draw(now) {
        const W = canvas.clientWidth || canvas.width;
        const H = canvas.clientHeight || canvas.height;

        // Background with subtle vignette
        ctx.clearRect(0, 0, W, H);
        const bg = ctx.createRadialGradient(W / 2, H * 0.6, 30, W / 2, H * 0.6, Math.max(W, H));
        bg.addColorStop(0, 'rgba(20,24,34,0.85)');
        bg.addColorStop(1, 'rgba(2,3,6,0.95)');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        if (unsupportedMode || !analyser || !freqData) {
            drawUnsupportedMessage(W, H);
            return;
        }

        // CROSS-BROWSER: getByteFrequencyData is broadly supported, but Firefox/Safari can throw
        // "InvalidStateError" if the analyser has been disconnected mid-frame (e.g. during teardown
        // races). Swallow and skip the frame so the rAF loop survives.
        try {
            analyser.getByteFrequencyData(freqData);
        } catch (e) {
            console.warn('[Visualizer] getByteFrequencyData failed; skipping frame:', e);
            return;
        }

        const sr = audioCtx.sampleRate;
        const binCount = analyser.frequencyBinCount;
        const N = settings.barCount;
        const bottomMargin = 16; // leave room for freq labels
        const topMargin = 4;
        const usableH = Math.max(10, H - bottomMargin - topMargin);
        const barGap = N <= 64 ? 2 : 1;
        const barW = Math.max(1, (W - barGap * (N + 1)) / N);

        for (let i = 0; i < N; i++) {
            const [bLo, bHi] = logBinRange(i, N, sr, binCount);
            // Take peak across the bins assigned to this bar (keeps narrow features visible)
            let peakBin = 0;
            for (let b = bLo; b < bHi; b++) {
                if (freqData[b] > peakBin) peakBin = freqData[b];
            }
            const lin = peakBin / 255;            // 0..1
            const amp = Math.sqrt(lin);           // perceptual sqrt scaling
            const h = amp * usableH;

            const x = barGap + i * (barW + barGap);
            const y = topMargin + (usableH - h);
            const f = i / (N - 1);

            ctx.fillStyle = barColor(f, amp);
            ctx.fillRect(x, y, barW, h);

            // Peak hold
            if (settings.peakHold) {
                const tNow = now;
                if (amp >= peaks[i]) {
                    peaks[i] = amp;
                    peakTimes[i] = tNow;
                } else {
                    const dt = tNow - peakTimes[i];
                    if (dt > 0) {
                        const decay = Math.max(0, 1 - dt / PEAK_DECAY_MS);
                        peaks[i] = Math.max(0, peaks[i] * decay);
                    }
                }
                const peakH = peaks[i] * usableH;
                if (peakH > 1.5) {
                    const py = topMargin + (usableH - peakH) - 1;
                    ctx.fillStyle = 'rgba(255,255,255,0.85)';
                    ctx.fillRect(x, py, barW, 1.5);
                }
            }
        }

        drawFreqLabels(W, H, bottomMargin);
        drawFROverlay(W, H, topMargin, usableH);
    }

    // ===== FR overlay rendering =====

    /**
     * Resolve the user's currently configured headphones (from Settings) to
     * a FR entry, or return null. Quietly returns null if anything is missing.
     */
    function getActiveHeadphoneFR() {
        if (!frOverlayEnabled) return null;
        if (!headphonesFR) return null;
        const S = window.HiFiBuddySettings;
        if (!S || typeof S.getEquipmentHeadphones !== 'function') return null;
        let name = '';
        try { name = S.getEquipmentHeadphones() || ''; } catch { return null; }
        if (!name) return null;
        return findHeadphoneFR(name);
    }

    /**
     * Map a frequency (Hz) to canvas X using the same log mapping as the bars.
     * Returns a numeric x in CSS pixels; values outside [F_MIN, F_MAX] are
     * extrapolated (and the polyline is clipped at the canvas edges anyway).
     */
    function freqToX(hz, W) {
        if (hz <= 0) return 0;
        const f = Math.log(hz / F_MIN) / Math.log(F_MAX / F_MIN);
        return f * W;
    }

    /**
     * Map dB deviation to Y, with 0 dB centered vertically and ±FR_DB_RANGE
     * mapping to ±half of the usable area. Clamped to the usable strip.
     */
    function dbToY(db, topMargin, usableH) {
        const mid = topMargin + usableH / 2;
        const half = usableH / 2;
        const clamped = Math.max(-FR_DB_RANGE, Math.min(FR_DB_RANGE, db));
        return mid - (clamped / FR_DB_RANGE) * half;
    }

    /**
     * Draw the headphone FR curve as a smooth translucent polyline on top of
     * the spectrum bars. Renders a small bottom-right label naming the cans.
     * Quietly no-ops when no headphone is configured or no match was found.
     */
    function drawFROverlay(W, H, topMargin, usableH) {
        const entry = getActiveHeadphoneFR();
        if (!entry || !Array.isArray(entry.fr) || entry.fr.length < 2) return;

        const pts = entry.fr;
        ctx.save();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255, 200, 100, 0.65)';
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        // Build a smooth path using quadratic curves between midpoints —
        // gives a clean visual approximation without needing a spline lib.
        ctx.beginPath();
        const x0 = freqToX(pts[0][0], W);
        const y0 = dbToY(pts[0][1], topMargin, usableH);
        ctx.moveTo(x0, y0);
        for (let i = 1; i < pts.length - 1; i++) {
            const xc = freqToX(pts[i][0], W);
            const yc = dbToY(pts[i][1], topMargin, usableH);
            const xn = freqToX(pts[i + 1][0], W);
            const yn = dbToY(pts[i + 1][1], topMargin, usableH);
            const mx = (xc + xn) / 2;
            const my = (yc + yn) / 2;
            ctx.quadraticCurveTo(xc, yc, mx, my);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(freqToX(last[0], W), dbToY(last[1], topMargin, usableH));
        ctx.stroke();

        // Tiny 0 dB reference tick on the right edge for orientation
        const midY = topMargin + usableH / 2;
        ctx.strokeStyle = 'rgba(255, 200, 100, 0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(W, midY);
        ctx.setLineDash([2, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Bottom-right name + type label
        const label = `${entry.name} (${entry.type})`;
        ctx.font = '10px ui-sans-serif, system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(255, 200, 100, 0.85)';
        ctx.fillText(label, W - 6, H - 3);

        ctx.restore();
    }

    function drawFreqLabels(W, H, bottomMargin) {
        const labels = [
            { hz: 100, text: '100 Hz' },
            { hz: 1000, text: '1 kHz' },
            { hz: 10000, text: '10 kHz' },
        ];
        ctx.font = '9px ui-sans-serif, system-ui, -apple-system, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.textBaseline = 'bottom';
        for (const l of labels) {
            // Same log mapping as the bars
            const f = Math.log(l.hz / F_MIN) / Math.log(F_MAX / F_MIN);
            if (f < 0 || f > 1) continue;
            const x = f * W;
            ctx.textAlign = x < 30 ? 'left' : x > W - 30 ? 'right' : 'center';
            ctx.fillText(l.text, x, H - 3);
        }
    }

    function drawUnsupportedMessage(W, H) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '600 13px ui-sans-serif, system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Spectrum unavailable for Spotify Web Playback', W / 2, H / 2 - 12);
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText('(CORS-restricted by Spotify SDK).', W / 2, H / 2 + 4);
        ctx.fillText('Play via Plex or transfer to Spotify desktop app to see the live spectrum.', W / 2, H / 2 + 20);
    }

    // ===== Visibility =====

    function show() {
        if (!container) ensureContainer();
        container.classList.add('vis-visible');
        document.body.classList.add('vis-active');
        // Force a resize after display:block so the canvas gets correct dimensions
        if (canvas && canvas._resize) setTimeout(canvas._resize, 0);
        if (analyser || unsupportedMode) startLoop();
    }

    function hide() {
        if (container) container.classList.remove('vis-visible');
        document.body.classList.remove('vis-active');
        // Keep nodes attached so re-show is instant; just stop drawing.
        stopLoop();
    }

    function toggle() {
        if (isShowing()) hide(); else show();
    }

    function isShowing() {
        return !!(container && container.classList.contains('vis-visible'));
    }

    // ===== Init =====

    function init() {
        if (initialized) return;
        initialized = true;
        try {
            loadSettings();
            loadFROverlayPref();
            injectCss();
            // Lazy, non-blocking fetch of headphone FR dataset
            loadHeadphoneFR();
        } catch (e) {
            console.warn('[Visualizer] init warning:', e);
        }
    }

    return { init, attach, detach, show, hide, toggle, isShowing };
})();

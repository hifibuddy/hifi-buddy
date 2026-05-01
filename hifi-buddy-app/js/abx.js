/**
 * HiFi Buddy ABX Tester
 *
 * Web Audio gapless A/B/X comparator with RMS level matching, 16-trial loop,
 * and binomial p-value reporting. Sources are two URLs (typically the lessons'
 * Plex FLAC stream + a Plex MP3 transcode at the chosen bitrate).
 *
 * Public API:
 *   open(opts) — show modal, load sources, begin trials
 *     opts: {
 *       lesson: lesson object (from hifi-guide.json),
 *       segment: "M:SS-M:SS" or { start, end } in seconds,
 *       trackResult: { ratingKey } (Plex search result),
 *       bitrate: 192,  // kbps for the lossy side
 *       onClose: fn
 *     }
 *   close()
 *
 *   getResults(lessonId?) — read persisted ABX results
 */
window.HiFiBuddyABX = (() => {
    'use strict';

    const TRIAL_COUNT = 16;
    const RESULTS_KEY = 'hifibuddy_abx_results';
    const SEGMENT_BUFFER_SECS = 1.5; // pad each side of the segment so we don't catch silence

    let audioCtx = null;
    let buffers = { lossless: null, lossy: null };
    let gains = { lossless: null, lossy: null };
    let level = { lossless: 1, lossy: 1 }; // RMS-matching gain
    let activeSources = [];
    let isPlaying = false;
    let currentSelection = null; // 'A' | 'B' | 'X' | null — which button shows as active
    let modalEl = null;
    let trials = [];
    let trialIdx = 0;
    let xIsA = true; // true means X plays the "A" side (lossless)
    let opts = null;
    let segmentRange = null;
    let revealMode = false;

    // ===== AudioContext / decode / level matching =====

    function ensureCtx() {
        if (!audioCtx) {
            // CROSS-BROWSER: Safari (incl. iOS) only exposes AudioContext as webkitAudioContext on older versions.
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) throw new Error('Web Audio API not supported in this browser');
            try {
                audioCtx = new Ctor();
            } catch (e) {
                console.warn('[ABX] AudioContext create failed:', e);
                throw e;
            }
        }
        // CROSS-BROWSER: Safari requires resume() to be called from within a user-gesture event handler.
        // ensureCtx() is invoked from click handlers, so this is fine — but resume() is async and we
        // intentionally do not await it here (synchronous return path is needed for playback ramps).
        // If the resume fails (e.g. ABX modal opened programmatically), the next user click will
        // succeed because all play* paths re-enter ensureCtx().
        if (audioCtx.state === 'suspended') {
            try {
                const p = audioCtx.resume();
                if (p && typeof p.catch === 'function') p.catch(() => { /* ignore — retry on next gesture */ });
            } catch { /* ignore */ }
        }
        return audioCtx;
    }

    async function fetchAndDecode(url, label) {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
        const arrBuf = await res.arrayBuffer();
        // Capture byteLength up front. decodeAudioData detaches whatever
        // ArrayBuffer we hand it (even on failure), so reading byteLength
        // afterwards would throw "detached".
        const byteLength = arrBuf.byteLength;
        const contentType = res.headers.get('Content-Type') || '(none)';
        const ctx = ensureCtx();
        // CROSS-BROWSER: Safari < 14.1 only exposes the legacy callback form of decodeAudioData.
        // The promise form throws/returns undefined there. Try the promise form first; if it
        // returns a non-Promise (or throws synchronously about the signature), fall back to callbacks.
        //
        // We always pass a fresh slice instead of arrBuf directly. Reason: any
        // failed decodeAudioData call still detaches its input, which means
        // the fallback path used to throw "Cannot perform slice on a detached
        // ArrayBuffer" — masking the real codec error from the first attempt.
        let buffer;
        try {
            buffer = await ctx.decodeAudioData(arrBuf.slice(0));
        } catch (e) {
            // Fall back to the legacy callback-style API on browsers that reject the promise
            // form or where the FLAC/MP3 codec isn't wired into decodeAudioData (rare on
            // current iOS Safari but historically a gotcha — surface a clearer error).
            try {
                buffer = await new Promise((resolve, reject) => {
                    ctx.decodeAudioData(arrBuf.slice(0), resolve, reject);
                });
            } catch (e2) {
                // Surface BOTH errors when both paths fail — the second is
                // often more informative (codec name, file size mismatch).
                const primary = e?.message || 'unknown';
                const secondary = e2?.message || 'unknown';
                throw new Error(
                    primary === secondary
                        ? `decodeAudioData failed: ${primary} (content-type: ${contentType}, size: ${byteLength}B)`
                        : `decodeAudioData failed: ${secondary} (initial: ${primary}; content-type: ${contentType}, size: ${byteLength}B)`
                );
            }
        }
        console.log(`[ABX] ${label}: ${(byteLength / 1024).toFixed(0)} KB, ${buffer.duration.toFixed(2)}s, ${buffer.sampleRate} Hz, content-type=${contentType}`);
        return { buffer, byteLength, contentType };
    }

    // RMS over the audible window, all channels averaged. Returns linear gain.
    function rms(buffer, startSec, endSec) {
        const sr = buffer.sampleRate;
        const start = Math.max(0, Math.floor(startSec * sr));
        const end = Math.min(buffer.length, Math.floor(endSec * sr));
        if (end <= start) return 0;
        let sumSq = 0;
        let n = 0;
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = start; i < end; i++) {
                sumSq += data[i] * data[i];
                n++;
            }
        }
        return Math.sqrt(sumSq / Math.max(1, n));
    }

    // Returns { gainA, gainB } — multipliers to apply so both sources have equal RMS.
    function computeLevelMatch(bufA, bufB, segStart, segEnd) {
        const rmsA = rms(bufA, segStart, segEnd);
        const rmsB = rms(bufB, segStart, segEnd);
        if (!rmsA || !rmsB) return { gainA: 1, gainB: 1, dbA: 0, dbB: 0 };
        // Bring both to the louder one's level (avoid clipping by capping at 1.0)
        const ref = Math.max(rmsA, rmsB);
        const gainA = Math.min(1, ref / rmsA);
        const gainB = Math.min(1, ref / rmsB);
        const dbA = 20 * Math.log10(gainA);
        const dbB = 20 * Math.log10(gainB);
        return { gainA, gainB, dbA, dbB };
    }

    // ===== Playback control =====

    function stopAllSources() {
        activeSources.forEach(s => { try { s.stop(); s.disconnect(); } catch { /* ignore */ } });
        activeSources = [];
        isPlaying = false;
        currentSelection = null;
    }

    // Play one of: 'A' (lossless), 'B' (lossy), or 'X' (whichever xIsA dictates).
    // Both buffers are launched in parallel; gain nodes mute whichever isn't selected.
    // Switching = adjust gain envelopes; the underlying nodes keep playing in lockstep.
    function playSelection(which) {
        const ctx = ensureCtx();
        if (!buffers.lossless || !buffers.lossy) return;

        // If a prior pair is still running, just adjust gains (gapless switch).
        const target = which === 'X' ? (xIsA ? 'lossless' : 'lossy')
                     : which === 'A' ? 'lossless'
                     : 'lossy';

        if (isPlaying) {
            const t = ctx.currentTime;
            // 8ms ramp avoids zipper noise on switch
            gains.lossless.gain.cancelScheduledValues(t);
            gains.lossy.gain.cancelScheduledValues(t);
            gains.lossless.gain.setValueAtTime(gains.lossless.gain.value, t);
            gains.lossy.gain.setValueAtTime(gains.lossy.gain.value, t);
            gains.lossless.gain.linearRampToValueAtTime(target === 'lossless' ? level.lossless : 0, t + 0.008);
            gains.lossy.gain.linearRampToValueAtTime(target === 'lossy' ? level.lossy : 0, t + 0.008);
            currentSelection = which;
            updateUISelection();
            return;
        }

        // Fresh start — kick off both sources in lockstep
        stopAllSources();
        const startAt = ctx.currentTime + 0.05;
        const offset = segmentRange.start;
        const duration = segmentRange.end - segmentRange.start;

        for (const side of ['lossless', 'lossy']) {
            const src = ctx.createBufferSource();
            src.buffer = buffers[side];
            const g = ctx.createGain();
            const initial = side === target ? level[side] : 0;
            g.gain.setValueAtTime(initial, startAt);
            src.connect(g).connect(ctx.destination);
            src.start(startAt, offset, duration);
            src.onended = () => { isPlaying = false; currentSelection = null; updateUISelection(); };
            activeSources.push(src);
            gains[side] = g;
        }
        isPlaying = true;
        currentSelection = which;
        updateUISelection();
    }

    function stop() {
        stopAllSources();
        updateUISelection();
    }

    // ===== Trial state machine =====

    function newTrial() {
        xIsA = Math.random() < 0.5;
    }

    function recordGuess(guess) {
        const correct = (guess === 'A' && xIsA) || (guess === 'B' && !xIsA);
        trials.push({ guess, xIsA, correct, at: Date.now() });
        trialIdx = trials.length;
        stop();
        if (trialIdx < TRIAL_COUNT) {
            newTrial();
            renderTrialState();
        } else {
            persistResult();
            renderFinalResult();
        }
    }

    // ===== Stats =====

    // Binomial CDF — P(X >= k | n, p=0.5). One-tailed.
    function binomialPValue(correct, n) {
        // P(X >= correct) = sum_{i=correct..n} C(n,i) * 0.5^n
        const log2n = -n * Math.log(2);
        let sum = 0;
        for (let i = correct; i <= n; i++) {
            // log( C(n,i) ) + log(2^-n)
            sum += Math.exp(logBinomial(n, i) + log2n);
        }
        return Math.min(1, sum);
    }

    function logBinomial(n, k) {
        // log(n! / (k! (n-k)!)) via lgamma
        return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
    }

    function logGamma(x) {
        // Stirling approximation good enough for n ≤ 16
        const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
            -1.231739572450155, 0.001208650973866179, -5.395239384953e-6];
        let y = x;
        let tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
        let ser = 1.000000000190015;
        for (let j = 0; j < 6; j++) ser += c[j] / ++y;
        return -tmp + Math.log(2.5066282746310005 * ser / x);
    }

    // ===== Persistence =====

    function persistResult() {
        const lessonId = opts.lesson.id;
        const correct = trials.filter(t => t.correct).length;
        const result = {
            bitrate: opts.bitrate,
            trials: TRIAL_COUNT,
            correct,
            pValue: binomialPValue(correct, TRIAL_COUNT),
            segment: typeof opts.segment === 'string' ? opts.segment : null,
            completedAt: Date.now(),
        };
        // Local mirror — keeps reads fast and keeps the result alive even
        // when the server is briefly unreachable.
        try {
            const all = JSON.parse(localStorage.getItem(RESULTS_KEY) || '{}');
            if (!all[lessonId]) all[lessonId] = [];
            all[lessonId].push(result);
            localStorage.setItem(RESULTS_KEY, JSON.stringify(all));
        } catch (e) {
            console.warn('[ABX] localStorage persist failed:', e);
        }
        // Durable copy. Survives "Clear site data" and browser switches.
        fetch('/api/abx/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...result, lessonId }),
        }).catch(() => { /* offline — localStorage has it; init() will retry on next boot */ });
    }

    function getResults(lessonId) {
        try {
            const all = JSON.parse(localStorage.getItem(RESULTS_KEY) || '{}');
            return lessonId ? (all[lessonId] || []) : all;
        } catch { return lessonId ? [] : {}; }
    }

    // ===== Server bootstrap =====
    //
    // Called from app.js on app boot. Reconciles localStorage with the
    // server-side ~/.hifi-buddy/abx_results.jsonl:
    //   - Pulls the server's view down (it's the durable source of truth).
    //   - Pushes any localStorage-only entries up via /api/abx/import,
    //     which dedupes on (lessonId, completedAt) so re-running is safe.
    //   - Writes the merged set back to localStorage so subsequent sync
    //     reads (getResults / abx-stats readResults) see everything.
    async function init() {
        let serverResults = {};
        try {
            const res = await fetch('/api/abx/results', { cache: 'no-store' });
            if (res.ok) serverResults = await res.json();
        } catch { /* server unreachable — keep localStorage */ }

        let localResults = {};
        try { localResults = JSON.parse(localStorage.getItem(RESULTS_KEY) || '{}'); }
        catch { localResults = {}; }

        const merged = JSON.parse(JSON.stringify(serverResults || {}));
        const seen = new Set();
        for (const lid of Object.keys(merged)) {
            for (const r of (merged[lid] || [])) seen.add(`${lid}|${r.completedAt}`);
        }
        const toUpload = {};
        let unsynced = 0;
        for (const lid of Object.keys(localResults || {})) {
            for (const r of (localResults[lid] || [])) {
                const key = `${lid}|${r?.completedAt}`;
                if (seen.has(key)) continue;
                (merged[lid] = merged[lid] || []).push(r);
                (toUpload[lid] = toUpload[lid] || []).push(r);
                seen.add(key);
                unsynced++;
            }
        }
        if (unsynced > 0) {
            try {
                await fetch('/api/abx/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(toUpload),
                });
                console.log(`[ABX] Migrated ${unsynced} result(s) from localStorage to ~/.hifi-buddy/abx_results.jsonl`);
            } catch (e) {
                console.warn('[ABX] Server migration failed (will retry next boot):', e?.message || e);
            }
        }
        try { localStorage.setItem(RESULTS_KEY, JSON.stringify(merged)); }
        catch { /* quota — leave localStorage as-is */ }
    }

    // ===== Modal UI =====

    function ensureModal() {
        let m = document.getElementById('abxModal');
        if (m) return m;
        m = document.createElement('div');
        m.id = 'abxModal';
        m.className = 'modal-overlay abx-overlay';
        m.style.display = 'none';
        m.setAttribute('role', 'dialog');
        m.setAttribute('aria-modal', 'true');
        m.setAttribute('aria-labelledby', 'abxTitle');
        m.innerHTML = `
            <div class="modal abx-modal">
                <div class="modal-header">
                    <h3 id="abxTitle">ABX Test</h3>
                    <button class="modal-close" id="abxClose" aria-label="Close ABX test">
                        ${HiFiBuddyIcons.close({ size: 20 })}
                    </button>
                </div>
                <div class="modal-body abx-body" id="abxBody"></div>
            </div>`;
        document.body.appendChild(m);
        m.querySelector('#abxClose').addEventListener('click', close);
        return m;
    }

    function renderLoading(msg) {
        const body = modalEl.querySelector('#abxBody');
        body.innerHTML = `<div class="abx-loading"><span class="hifi-play-spinner"></span> ${msg}</div>`;
    }

    function renderError(msg) {
        const body = modalEl.querySelector('#abxBody');
        body.innerHTML = `<div class="abx-error">${msg}</div>`;
    }

    function renderTrialState() {
        const body = modalEl.querySelector('#abxBody');
        const correct = trials.filter(t => t.correct).length;
        const done = trials.length;
        const pSoFar = done > 0 ? binomialPValue(correct, done) : 1;
        const pStr = done > 0 ? pSoFar.toFixed(3) : '—';
        const sigSoFar = done > 0 && pSoFar < 0.05;
        const segStr = typeof opts.segment === 'string' ? opts.segment : `${opts.segment.start}s-${opts.segment.end}s`;

        body.innerHTML = `
            <div class="abx-meta">
                <div><strong>Lesson:</strong> ${opts.lesson.track.title} — ${opts.lesson.album.artist}</div>
                <div><strong>Segment:</strong> ${segStr} <span class="abx-skill">${opts.lesson.abx?.skill || ''}</span></div>
                <div><strong>Comparing:</strong> FLAC (lossless) vs ${opts.bitrate} kbps MP3</div>
                <div><strong>Trial ${done + 1} of ${TRIAL_COUNT}</strong></div>
            </div>
            <div class="abx-leveling abx-leveling-${(level.dbDelta < 0.5) ? 'ok' : 'warn'}">
                Level-matched: ΔRMS ≈ ${(level.dbDelta || 0).toFixed(2)} dB
            </div>
            <div class="abx-controls" role="group" aria-label="Play A, B, or X">
                <button class="abx-source-btn" data-src="A" aria-label="Play A (FLAC lossless)">${HiFiBuddyIcons.play({ size: 12 })} A <span>FLAC</span></button>
                <button class="abx-source-btn" data-src="B" aria-label="Play B (MP3 ${opts.bitrate} kilobit)">${HiFiBuddyIcons.play({ size: 12 })} B <span>MP3 ${opts.bitrate}</span></button>
                <button class="abx-source-btn abx-x-btn" data-src="X" aria-label="Play X (unknown)">${HiFiBuddyIcons.play({ size: 12 })} X <span>?</span></button>
            </div>
            <div class="abx-instructions">
                Listen as long as you want. Switch freely between A, B, and X. When you're sure, choose:
            </div>
            <div class="abx-guesses" role="group" aria-label="Guess whether X matches A or B">
                <button class="abx-guess-btn" data-guess="A" aria-label="X is A">X is A</button>
                <button class="abx-guess-btn" data-guess="B" aria-label="X is B">X is B</button>
            </div>
            <div class="abx-progress">
                <div class="abx-progress-bar"><div class="abx-progress-fill" style="width:${(done/TRIAL_COUNT)*100}%"></div></div>
                <div class="abx-progress-stats">
                    <span>${correct} / ${done} correct</span>
                    <span class="${sigSoFar ? 'abx-stat-sig' : 'abx-stat-ns'}">p = ${pStr}${sigSoFar ? ` ${HiFiBuddyIcons.check({ size: 12, strokeWidth: 2.5, style: 'vertical-align:-2px' })} significant` : ''}</span>
                </div>
            </div>
            <div class="abx-toggles">
                <label class="abx-toggle-label"><input type="checkbox" id="abxRevealToggle" ${revealMode ? 'checked' : ''}> Reveal answer after each guess (training mode)</label>
            </div>
        `;

        body.querySelectorAll('.abx-source-btn').forEach(b => {
            b.addEventListener('click', () => playSelection(b.dataset.src));
        });
        body.querySelectorAll('.abx-guess-btn').forEach(b => {
            b.addEventListener('click', () => {
                if (revealMode) {
                    const wasCorrect = (b.dataset.guess === 'A' && xIsA) || (b.dataset.guess === 'B' && !xIsA);
                    setTimeout(() => recordGuess(b.dataset.guess), 0);
                    setTimeout(() => alert(wasCorrect
                        ? `Correct — X was ${xIsA ? 'A (FLAC)' : 'B (MP3)'}.`
                        : `Wrong — X was ${xIsA ? 'A (FLAC)' : 'B (MP3)'}.`), 30);
                } else {
                    recordGuess(b.dataset.guess);
                }
            });
        });
        body.querySelector('#abxRevealToggle')?.addEventListener('change', e => {
            revealMode = e.target.checked;
        });
    }

    function updateUISelection() {
        modalEl?.querySelectorAll('.abx-source-btn').forEach(b => {
            const isActive = isPlaying && b.dataset.src === currentSelection;
            b.classList.toggle('abx-playing', isActive);
        });
    }

    function renderFinalResult() {
        const body = modalEl.querySelector('#abxBody');
        const correct = trials.filter(t => t.correct).length;
        const p = binomialPValue(correct, TRIAL_COUNT);
        const significant = p < 0.05;

        // Blunt messaging — user asked for this tone explicitly.
        let verdict, color, detail;
        if (significant) {
            color = '#2ecc71';
            verdict = `Statistically significant — you can reliably distinguish FLAC from ${opts.bitrate} kbps MP3 on this passage.`;
            detail = `${correct}/${TRIAL_COUNT} correct, p = ${p.toFixed(4)}. The probability of getting this many right by chance is ${(p * 100).toFixed(2)}%.`;
        } else if (correct >= TRIAL_COUNT * 0.5) {
            color = '#e6a817';
            verdict = `Not significant. You can't reliably distinguish FLAC from ${opts.bitrate} kbps MP3 on this passage.`;
            detail = `${correct}/${TRIAL_COUNT} correct, p = ${p.toFixed(3)}. That's not better than guessing. Doesn't mean the formats sound identical — it means the difference is below your discrimination threshold here.`;
        } else {
            color = '#e05555';
            verdict = `Below chance. ${correct}/${TRIAL_COUNT} correct.`;
            detail = `Either you guessed inverted, the level-matching was off, or you genuinely can't tell. p = ${p.toFixed(3)}.`;
        }

        body.innerHTML = `
            <div class="abx-result-card" style="border-left-color: ${color}">
                <div class="abx-result-score">${correct}/${TRIAL_COUNT}</div>
                <div class="abx-result-verdict">${verdict}</div>
                <div class="abx-result-detail">${detail}</div>
            </div>
            <div class="abx-trial-history">
                ${trials.map((t, i) => {
                    const cellSvg = t.correct
                        ? HiFiBuddyIcons.check({ size: 14, strokeWidth: 3 })
                        : HiFiBuddyIcons.x({ size: 14, strokeWidth: 3 });
                    return `<span class="abx-trial-cell ${t.correct ? 'abx-trial-correct' : 'abx-trial-wrong'}" title="Trial ${i+1}: guessed ${t.guess}, X was ${t.xIsA ? 'A' : 'B'}">${cellSvg}</span>`;
                }).join('')}
            </div>
            <div class="abx-result-actions">
                <button class="abx-action-btn" id="abxRetry">Run Another 16 Trials</button>
                <button class="abx-action-btn" id="abxDone">Done</button>
            </div>
            <div class="abx-prior-results" id="abxPriorResults"></div>
        `;
        renderPriorResults();
        body.querySelector('#abxRetry')?.addEventListener('click', () => {
            trials = []; trialIdx = 0; newTrial();
            renderTrialState();
        });
        body.querySelector('#abxDone')?.addEventListener('click', close);
    }

    function renderPriorResults() {
        const list = modalEl.querySelector('#abxPriorResults');
        if (!list) return;
        const prior = getResults(opts.lesson.id);
        if (!prior.length) return;
        // Show only at this bitrate, last 10
        const matching = prior.filter(r => r.bitrate === opts.bitrate).slice(-10);
        if (!matching.length) return;
        list.innerHTML = `
            <h4>Prior runs at ${opts.bitrate} kbps</h4>
            <div class="abx-prior-list">
                ${matching.map(r => `
                    <div class="abx-prior-row ${r.pValue < 0.05 ? 'abx-prior-sig' : ''}">
                        <span>${r.correct}/${r.trials}</span>
                        <span>p = ${r.pValue.toFixed(3)}</span>
                        <span>${new Date(r.completedAt).toLocaleString()}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    // ===== Lifecycle =====

    function parseSegment(seg) {
        if (typeof seg === 'object' && seg) return { start: seg.start || 0, end: seg.end || seg.start + 30 };
        if (typeof seg === 'string') {
            const m = seg.match(/^(\d+):(\d{1,2})-(\d+):(\d{1,2})$/);
            if (m) return { start: +m[1] * 60 + +m[2], end: +m[3] * 60 + +m[4] };
        }
        return { start: 0, end: 30 };
    }

    async function open(o) {
        opts = o;
        modalEl = ensureModal();
        modalEl.style.display = 'flex';
        const seg = parseSegment(opts.segment);
        // Pad each side a little for buffering and natural lead-in
        segmentRange = {
            start: Math.max(0, seg.start - SEGMENT_BUFFER_SECS),
            end: seg.end + SEGMENT_BUFFER_SECS,
        };

        document.getElementById('abxTitle').textContent = `ABX: FLAC vs ${opts.bitrate} kbps MP3`;
        renderLoading('Loading lossless source…');

        try {
            const losslessUrl = opts.losslessUrl;
            const lossyUrl = opts.lossyUrl;
            if (!losslessUrl && !lossyUrl) {
                throw new Error('Missing both lossless and lossy source URLs. Check Plex / local library configuration in Settings.');
            }
            if (!losslessUrl) {
                throw new Error('Missing lossless source URL — the original FLAC/ALAC track could not be located. Make sure the lesson track exists in Plex (or a local FLAC library) before launching ABX.');
            }
            if (!lossyUrl) {
                throw new Error('Missing lossy source URL — the MP3 transcode could not be built. Plex needs to be reachable, or the local server needs ffmpeg installed for local transcoding.');
            }

            const [a, b] = await Promise.all([
                fetchAndDecode(losslessUrl, 'A (lossless)'),
                fetchAndDecode(lossyUrl, `B (MP3 ${opts.bitrate})`),
            ]);
            buffers.lossless = a.buffer;
            buffers.lossy = b.buffer;

            // Sanity check: if byte sizes are within 5% of each other, the transcoder almost
            // certainly didn't transcode (FLAC and 192kbps MP3 should differ ~5-8x in size).
            const sizeRatio = a.byteLength / Math.max(1, b.byteLength);
            if (sizeRatio < 1.5) {
                console.warn(`[ABX] WARNING: lossless and lossy bytes are too similar (ratio ${sizeRatio.toFixed(2)}x). ` +
                    `Plex transcoder may be passing through. Content-Types: A=${a.contentType}, B=${b.contentType}`);
            }

            const lm = computeLevelMatch(a.buffer, b.buffer, segmentRange.start, segmentRange.end);
            level.lossless = lm.gainA;
            level.lossy = lm.gainB;
            level.dbDelta = Math.abs(20 * Math.log10(rms(a.buffer, segmentRange.start, segmentRange.end) /
                                                   rms(b.buffer, segmentRange.start, segmentRange.end)));

            trials = []; trialIdx = 0; newTrial();
            renderTrialState();
        } catch (e) {
            console.warn('[ABX] open error:', e);
            // If the lossy URL was a local-transcode endpoint, the most likely cause is
            // missing ffmpeg on the server. Surface that hint explicitly.
            const usingLocal = (opts?.lossyUrl || '').includes('/api/local/transcode/');
            if (usingLocal && /503|ffmpeg/i.test(String(e.message || ''))) {
                renderError('Local FLAC is available, but ABX needs ffmpeg for MP3 transcoding. Install ffmpeg (brew install ffmpeg / apt install ffmpeg) and rescan the library.');
            } else {
                renderError(`Could not load sources: ${e.message}. Make sure your source (Plex or local library) is reachable and the track is in your library.`);
            }
        }
    }

    function close() {
        stop();
        if (modalEl) modalEl.style.display = 'none';
        if (typeof opts?.onClose === 'function') opts.onClose();
    }

    return { init, open, close, getResults };
})();

/**
 * HiFi Buddy Onboarding Wizard
 *
 * 5-step first-run flow for HiFi Buddy. Asks the user to pick a music source
 * (Plex / Spotify / Local FLAC / Skip), drops the relevant API keys into
 * HiFiBuddySettings.KEYS, and records a "completed" flag in localStorage.
 *
 * Public API:
 *   init()        — boot from app.js. Auto-launches start() if not completed.
 *   start()       — show the wizard regardless of completion state.
 *   isCompleted() — boolean
 *
 * URL helpers (handled in init):
 *   ?onboarding=1        → force-launch wizard (testing)
 *   ?reset_onboarding=1  → clear completed flag and re-launch
 */
window.HiFiBuddyOnboarding = (() => {
    'use strict';

    const COMPLETED_KEY = 'hifibuddy_onboarding_completed';
    const TOTAL_STEPS = 5;

    // Mutable wizard state lives for the lifetime of one open session.
    let state = null;
    let overlayEl = null;
    let cardEl = null;

    function isCompleted() {
        return localStorage.getItem(COMPLETED_KEY) === '1';
    }

    function markCompleted() {
        localStorage.setItem(COMPLETED_KEY, '1');
    }

    function reset() {
        localStorage.removeItem(COMPLETED_KEY);
    }

    function settingsKey(name) {
        // Defensive: if HiFiBuddySettings.KEYS is missing a field, fall back to
        // the documented hifibuddy_* names.
        const fallback = {
            spotifyClientId: 'hifibuddy_spotify_client_id',
            plexUrl: 'hifibuddy_plex_url',
            plexToken: 'hifibuddy_plex_token',
            equipmentHeadphones: 'hifibuddy_equip_headphones',
            equipmentHeadphoneType: 'hifibuddy_equip_headphone_type',
            localLibraryPath: 'hifibuddy_local_library_path',
        };
        const KEYS = (window.HiFiBuddySettings && window.HiFiBuddySettings.KEYS) || {};
        return KEYS[name] || fallback[name];
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function ensureScaffold() {
        overlayEl = document.getElementById('onboardingOverlay');
        cardEl = document.getElementById('onboardingCard');
        if (overlayEl && cardEl) return true;
        // Fallback: build scaffold if index.html didn't ship it.
        overlayEl = document.createElement('div');
        overlayEl.className = 'onboarding-overlay';
        overlayEl.id = 'onboardingOverlay';
        overlayEl.style.display = 'none';
        cardEl = document.createElement('div');
        cardEl.className = 'onboarding-card';
        cardEl.id = 'onboardingCard';
        overlayEl.appendChild(cardEl);
        document.body.appendChild(overlayEl);
        return true;
    }

    // ===== Render =====

    function progressBar(stepIdx) {
        const pct = Math.round((stepIdx / TOTAL_STEPS) * 100);
        return `
            <div class="ob-progress">
                <div class="ob-progress-track">
                    <div class="ob-progress-fill" style="width:${pct}%"></div>
                </div>
                <div class="ob-progress-text">Step ${stepIdx} of ${TOTAL_STEPS}</div>
            </div>
        `;
    }

    function renderStep(html) {
        cardEl.classList.remove('ob-fade-in');
        // Force reflow so the animation re-triggers.
        void cardEl.offsetWidth;
        cardEl.innerHTML = html;
        cardEl.classList.add('ob-fade-in');
    }

    function show() {
        ensureScaffold();
        overlayEl.style.display = 'flex';
        document.body.classList.add('ob-locked');
    }

    function hide() {
        if (overlayEl) overlayEl.style.display = 'none';
        document.body.classList.remove('ob-locked');
    }

    function finish() {
        markCompleted();
        hide();
        // Make sure the lessons view is showing.
        const lessonsBtn = document.querySelector('.hb-nav-btn[data-view="lessons"]');
        if (lessonsBtn) lessonsBtn.click();
    }

    // ===== Steps =====

    function step1() {
        state.step = 1;
        renderStep(`
            ${progressBar(1)}
            <div class="ob-wave" aria-hidden="true">${buildWaveBars(48)}</div>
            <div class="ob-body">
                <h2 class="ob-title">Welcome to HiFi Buddy</h2>
                <p class="ob-lead">A critical-listening tutor that trains your ears on real recordings.</p>
                <p class="ob-copy">We're going to spend about 60 seconds setting things up. You can skip and configure later in Settings.</p>
            </div>
            <div class="ob-actions">
                <button class="ob-btn ob-btn-ghost" data-act="skip-all">Skip for now</button>
                <button class="ob-btn ob-btn-primary" data-act="next">Let's go</button>
            </div>
        `);
        cardEl.querySelector('[data-act="next"]').addEventListener('click', step2);
        cardEl.querySelector('[data-act="skip-all"]').addEventListener('click', () => {
            state.source = 'skip';
            finish();
        });
    }

    // Deterministic-feeling soundwave: a sine envelope plus two harmonics so
    // every render gets the same shape (no Math.random — keeps the welcome
    // visual stable across reloads). Pattern matches the marketing site's
    // hero waveform so the app feels visually coherent with hifibuddy.net.
    function buildWaveBars(count) {
        const bars = [];
        for (let i = 0; i < count; i++) {
            const envelope = Math.sin((i / count) * Math.PI) * 0.55 + 0.35;
            const noise = Math.sin(i * 1.7) * 0.18 + Math.cos(i * 0.6) * 0.12;
            const h = Math.max(0.18, Math.min(1, envelope + noise));
            // animation-delay staggers neighbors so the wave appears to
            // travel across the bar field rather than pulse uniformly.
            const delay = (i % 12) * 0.08;
            const dur = 1.8 + (i % 5) * 0.18;
            bars.push(
                `<span class="ob-wave-bar" style="height:${Math.round(h * 100)}%;animation-delay:${delay}s;animation-duration:${dur}s"></span>`
            );
        }
        return bars.join('');
    }

    function step2() {
        state.step = 2;
        const opt = (val, title, sub) => `
            <label class="ob-radio">
                <input type="radio" name="ob-source" value="${val}" ${state.source === val ? 'checked' : ''}>
                <div class="ob-radio-body">
                    <div class="ob-radio-title">${title}</div>
                    <div class="ob-radio-sub">${sub}</div>
                </div>
            </label>
        `;
        renderStep(`
            ${progressBar(2)}
            <div class="ob-body">
                <h2 class="ob-title">Where will you play music from?</h2>
                <p class="ob-copy">HiFi Buddy needs a source for FLAC streams and ABX comparisons.</p>
                <div class="ob-radio-group">
                    ${opt('plex', 'Plex Media Server', 'Recommended. Streams your own FLAC and transcodes lossy on demand for ABX.')}
                    ${opt('spotify', 'Spotify Premium', 'Lossy preview. ABX limited; useful for discovery and listening.')}
                    ${opt('local', 'Local FLAC folder', 'Point to a folder of files. Library mode is in development.')}
                    ${opt('skip', "I'll set this up later", 'Skip ahead. You can configure sources in Settings.')}
                </div>
            </div>
            <div class="ob-actions">
                <button class="ob-btn ob-btn-ghost" data-act="back">Back</button>
                <button class="ob-btn ob-btn-primary" data-act="next">Next</button>
            </div>
        `);
        cardEl.querySelector('[data-act="back"]').addEventListener('click', step1);
        cardEl.querySelector('[data-act="next"]').addEventListener('click', () => {
            const checked = cardEl.querySelector('input[name="ob-source"]:checked');
            state.source = checked ? checked.value : 'skip';
            if (state.source === 'skip') step5();
            else step3();
        });
    }

    function step3() {
        state.step = 3;
        if (state.source === 'plex') return step3Plex();
        if (state.source === 'spotify') return step3Spotify();
        if (state.source === 'local') return step3Local();
        return step5();
    }

    function step3Plex() {
        const curUrl = localStorage.getItem(settingsKey('plexUrl')) || '';
        const curToken = localStorage.getItem(settingsKey('plexToken')) || '';
        renderStep(`
            ${progressBar(3)}
            <div class="ob-body">
                <h2 class="ob-title">Connect Plex</h2>
                <p class="ob-copy">Enter your server URL and an X-Plex-Token. The token never leaves your machine.</p>
                <label class="ob-field">
                    <span>Plex server URL</span>
                    <input type="text" id="obPlexUrl" placeholder="http://your-server:32400" value="${escapeHtml(curUrl)}">
                </label>
                <label class="ob-field">
                    <span>Plex token <a href="https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/" target="_blank" rel="noopener">how to find it</a></span>
                    <input type="password" id="obPlexToken" placeholder="xxxxxxxxxxxxxxxxxxxx" value="${escapeHtml(curToken)}">
                </label>
                <div class="ob-test-row">
                    <button class="ob-btn ob-btn-secondary" data-act="test">Test connection</button>
                    <span class="ob-test-status" id="obPlexStatus"></span>
                </div>
            </div>
            <div class="ob-actions">
                <button class="ob-btn ob-btn-ghost" data-act="back">Back</button>
                <button class="ob-btn ob-btn-primary" data-act="next">Save & continue</button>
            </div>
        `);
        cardEl.querySelector('[data-act="back"]').addEventListener('click', step2);
        cardEl.querySelector('[data-act="test"]').addEventListener('click', testPlex);
        cardEl.querySelector('[data-act="next"]').addEventListener('click', () => {
            const url = cardEl.querySelector('#obPlexUrl').value.trim();
            const token = cardEl.querySelector('#obPlexToken').value.trim();
            if (settingsKey('plexUrl')) localStorage.setItem(settingsKey('plexUrl'), url);
            if (settingsKey('plexToken')) localStorage.setItem(settingsKey('plexToken'), token);
            window.dispatchEvent(new CustomEvent('hifibuddy-settings-changed'));
            step4();
        });
    }

    async function testPlex() {
        const statusEl = cardEl.querySelector('#obPlexStatus');
        const url = cardEl.querySelector('#obPlexUrl').value.trim();
        const token = cardEl.querySelector('#obPlexToken').value.trim();
        if (!url || !token) {
            statusEl.textContent = 'Enter URL and token first.';
            statusEl.className = 'ob-test-status ob-test-fail';
            return;
        }
        statusEl.textContent = 'Testing…';
        statusEl.className = 'ob-test-status ob-test-pending';
        try {
            const res = await fetch(`/api/plex/library/sections?plexUrl=${encodeURIComponent(url)}&plexToken=${encodeURIComponent(token)}`);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const count = (data && data.MediaContainer && data.MediaContainer.Directory && data.MediaContainer.Directory.length) || 0;
            statusEl.textContent = count > 0 ? `OK — ${count} library section${count === 1 ? '' : 's'} found.` : 'OK — connected (no sections).';
            statusEl.className = 'ob-test-status ob-test-ok';
        } catch (err) {
            statusEl.textContent = 'Failed: ' + (err && err.message ? err.message : err);
            statusEl.className = 'ob-test-status ob-test-fail';
        }
    }

    function step3Spotify() {
        const cur = localStorage.getItem(settingsKey('spotifyClientId')) || '';
        renderStep(`
            ${progressBar(3)}
            <div class="ob-body">
                <h2 class="ob-title">Connect Spotify</h2>
                <p class="ob-copy">PKCE flow only — no client secret stored. Register the redirect URI exactly:</p>
                <code class="ob-code">http://127.0.0.1:8090/</code>
                <label class="ob-field">
                    <span>Client ID</span>
                    <input type="text" id="obSpotifyClientId" placeholder="32-char hex from Spotify dashboard" value="${escapeHtml(cur)}">
                </label>
                <p class="ob-hint">
                    <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">Open Spotify Dashboard</a>
                    — create an app, copy the Client ID, add the redirect URI above.
                </p>
            </div>
            <div class="ob-actions">
                <button class="ob-btn ob-btn-ghost" data-act="back">Back</button>
                <button class="ob-btn ob-btn-primary" data-act="next">Save & continue</button>
            </div>
        `);
        cardEl.querySelector('[data-act="back"]').addEventListener('click', step2);
        cardEl.querySelector('[data-act="next"]').addEventListener('click', () => {
            const id = cardEl.querySelector('#obSpotifyClientId').value.trim();
            if (settingsKey('spotifyClientId')) localStorage.setItem(settingsKey('spotifyClientId'), id);
            window.dispatchEvent(new CustomEvent('hifibuddy-settings-changed'));
            step4();
        });
    }

    function step3Local() {
        const cur = localStorage.getItem(settingsKey('localLibraryPath')) || '';
        renderStep(`
            ${progressBar(3)}
            <div class="ob-body">
                <h2 class="ob-title">Local FLAC folder</h2>
                <p class="ob-copy">Absolute path to a folder containing your FLAC files. Library mode is built separately — for now, this just gets remembered.</p>
                <label class="ob-field">
                    <span>Folder path</span>
                    <input type="text" id="obLocalPath" placeholder="/Users/you/Music/FLAC" value="${escapeHtml(cur)}">
                </label>
            </div>
            <div class="ob-actions">
                <button class="ob-btn ob-btn-ghost" data-act="back">Back</button>
                <button class="ob-btn ob-btn-primary" data-act="next">Save & continue</button>
            </div>
        `);
        cardEl.querySelector('[data-act="back"]').addEventListener('click', step2);
        cardEl.querySelector('[data-act="next"]').addEventListener('click', () => {
            const p = cardEl.querySelector('#obLocalPath').value.trim();
            localStorage.setItem(settingsKey('localLibraryPath'), p);
            step4();
        });
    }

    function step4() {
        state.step = 4;
        const curName = localStorage.getItem(settingsKey('equipmentHeadphones')) || '';
        const curType = localStorage.getItem(settingsKey('equipmentHeadphoneType')) || 'unknown';
        const types = [
            ['open-back', 'Open-back'],
            ['closed-back', 'Closed-back'],
            ['iem', 'IEM'],
            ['planar', 'Planar magnetic'],
            ['unknown', 'Unknown / not sure'],
        ];
        renderStep(`
            ${progressBar(4)}
            <div class="ob-body">
                <h2 class="ob-title">Your headphones</h2>
                <p class="ob-copy">Optional. Helps personalize lesson notes (e.g. "your closed-backs may roll off the air band").</p>
                <label class="ob-field">
                    <span>Model</span>
                    <input type="text" id="obHpName" list="obHpList" placeholder="e.g. Sennheiser HD 600" value="${escapeHtml(curName)}">
                    <datalist id="obHpList"></datalist>
                </label>
                <label class="ob-field">
                    <span>Type</span>
                    <select id="obHpType">
                        ${types.map(([v, t]) => `<option value="${v}" ${v === curType ? 'selected' : ''}>${t}</option>`).join('')}
                    </select>
                </label>
            </div>
            <div class="ob-actions">
                <button class="ob-btn ob-btn-ghost" data-act="skip">Skip</button>
                <button class="ob-btn ob-btn-primary" data-act="next">Save & continue</button>
            </div>
        `);
        // Try to populate datalist if a headphones-fr.json ships in /data.
        loadHeadphoneSuggestions();
        cardEl.querySelector('[data-act="skip"]').addEventListener('click', step5);
        cardEl.querySelector('[data-act="next"]').addEventListener('click', () => {
            const name = cardEl.querySelector('#obHpName').value.trim();
            const type = cardEl.querySelector('#obHpType').value;
            if (settingsKey('equipmentHeadphones')) localStorage.setItem(settingsKey('equipmentHeadphones'), name);
            if (settingsKey('equipmentHeadphoneType')) localStorage.setItem(settingsKey('equipmentHeadphoneType'), type);
            window.dispatchEvent(new CustomEvent('hifibuddy-settings-changed'));
            step5();
        });
    }

    async function loadHeadphoneSuggestions() {
        const list = cardEl.querySelector('#obHpList');
        if (!list) return;
        try {
            const res = await fetch('data/headphones-fr.json', { cache: 'force-cache' });
            if (!res.ok) return; // file is optional
            const data = await res.json();
            const names = Array.isArray(data) ? data : (data.headphones || []);
            list.innerHTML = names.slice(0, 200)
                .map(n => `<option value="${escapeHtml(typeof n === 'string' ? n : (n.name || n.model || ''))}">`)
                .join('');
        } catch { /* silent — free-text input still works */ }
    }

    function step5() {
        state.step = 5;
        // CROSS-BROWSER: iOS Safari ITP can wipe localStorage after 7 days of
        // inactivity for non-PWA contexts. Service-worker capable browsers can
        // install as PWA to survive that. Show only if SW is supported.
        const swCapable = ('serviceWorker' in navigator);
        const pwaTip = swCapable
            ? '<p class="ob-hint">Tip: install HiFi Buddy as a PWA (Share &rarr; Add to Home Screen on iOS) for storage that survives Safari ITP.</p>'
            : '';
        renderStep(`
            ${progressBar(5)}
            <div class="ob-body">
                <h2 class="ob-title">You're set.</h2>
                <p class="ob-lead">Try Lesson 1: <strong>Money for Nothing</strong>.</p>
                <p class="ob-copy">It's a short sit-down with the most-quoted soundstage in rock. We'll teach you what to listen for, then ABX you against a 192 kbps copy.</p>
                ${pwaTip}
            </div>
            <div class="ob-actions">
                <button class="ob-btn ob-btn-ghost" data-act="close">Close</button>
                <button class="ob-btn ob-btn-primary" data-act="start">Start lesson</button>
            </div>
        `);
        cardEl.querySelector('[data-act="close"]').addEventListener('click', finish);
        cardEl.querySelector('[data-act="start"]').addEventListener('click', finish);
    }

    // ===== Public =====

    function start() {
        state = { step: 0, source: null };
        ensureScaffold();
        show();
        step1();
    }

    function init() {
        try {
            const params = new URLSearchParams(window.location.search);
            if (params.get('reset_onboarding') === '1') {
                reset();
            }
            if (params.get('onboarding') === '1' || !isCompleted()) {
                // Defer one tick so other modules finish init.
                setTimeout(start, 0);
            }
        } catch (e) {
            console.warn('[Onboarding] init failed:', e);
        }
    }

    return { init, start, isCompleted, reset };
})();

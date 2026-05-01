/**
 * HiFi Buddy Settings Module
 *
 * Manages user settings split across two stores:
 *
 *   1. Durable config — credentials, equipment, library paths.
 *      Lives server-side at ~/.hifi-buddy/config.json. Survives any
 *      browser-side wipe ("Clear site data", profile reset, browser switch).
 *      Accessed via /api/config; cached in memory after one fetch at boot.
 *
 *   2. Ephemeral UI state — theme, visualizer prefs, OAuth tokens (short-lived),
 *      lesson progress, current view. Stays in localStorage where it belongs.
 *
 * Callers don't need to know which is which: get()/set()/remove() route
 * transparently based on the CONFIG_KEY_MAP below. The contract: by the time
 * HiFiBuddySettings.init() resolves, the in-memory cache is populated and
 * any pre-existing Tier A keys in localStorage have been migrated to the
 * server (one-shot, idempotent).
 */
window.HiFiBuddySettings = (() => {
    'use strict';

    const KEYS = {
        spotifyClientId: 'hifibuddy_spotify_client_id',
        spotifyClientSecret: 'hifibuddy_spotify_client_secret',
        spotifyAuthMethod: 'hifibuddy_spotify_auth_method',
        spotifyAccessToken: 'hifibuddy_spotify_access_token',
        spotifyRefreshToken: 'hifibuddy_spotify_refresh_token',
        spotifyTokenExpiry: 'hifibuddy_spotify_token_expiry',
        spotifyTokenScopes: 'hifibuddy_spotify_token_scopes',
        claudeApiKey: 'hifibuddy_claude_api_key',
        plexUrl: 'hifibuddy_plex_url',
        plexToken: 'hifibuddy_plex_token',
        localFolder: 'hifibuddy_local_folder',
        ollamaUrl: 'hifibuddy_ollama_url',
        ollamaModel: 'hifibuddy_ollama_model',
        equipmentHeadphones: 'hifibuddy_equip_headphones',
        equipmentHeadphoneType: 'hifibuddy_equip_headphone_type',
        equipmentDac: 'hifibuddy_equip_dac',
        equipmentAmp: 'hifibuddy_equip_amp',
        equipmentFormatPref: 'hifibuddy_equip_format_pref',
    };

    // Localstorage key  →  server config key. Anything in this map is durable
    // (Tier A); anything else stays in localStorage. Server matches the
    // CONFIG_ALLOWED_KEYS whitelist in server.py — keep the two in sync.
    const CONFIG_KEY_MAP = {
        [KEYS.spotifyClientId]:     'spotify_client_id',
        [KEYS.spotifyClientSecret]: 'spotify_client_secret',
        [KEYS.spotifyAuthMethod]:   'spotify_auth_method',
        [KEYS.claudeApiKey]:        'claude_api_key',
        [KEYS.plexUrl]:             'plex_url',
        [KEYS.plexToken]:           'plex_token',
        [KEYS.localFolder]:         'local_folder',
        [KEYS.ollamaUrl]:           'ollama_url',
        [KEYS.ollamaModel]:         'ollama_model',
    };

    // ===== Server-backed config cache =====
    //
    // _configCache: in-memory mirror of server config. Populated at boot.
    // _configReady: true after loadConfigFromServer() resolves (success or
    //               graceful failure). Until then, get() falls back to
    //               localStorage so the app degrades cleanly if init hasn't
    //               run yet.
    // _writeQueue:  serializes POSTs so two rapid set() calls don't race.
    const _configCache = {};
    let _configReady = false;
    let _writeQueue = Promise.resolve();

    async function loadConfigFromServer() {
        try {
            const res = await fetch('/api/config', { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            for (const [k, v] of Object.entries(data || {})) {
                if (typeof v === 'string') _configCache[k] = v;
            }
        } catch (e) {
            console.warn('[HiFi Buddy] Could not load /api/config — falling back to localStorage:', e.message);
        } finally {
            _configReady = true;
        }
    }

    // Wait until every pending server write has finished. Use this before
    // doing anything that interrupts the page lifecycle (OAuth redirect,
    // navigation) — otherwise an in-flight write might never reach the
    // server.
    function flushConfig() { return _writeQueue; }

    function queueConfigWrite(serverKey, value) {
        // Single-key partial update; server merges. Writes are queued so the
        // order matches the order set() was called in.
        const body = JSON.stringify({ [serverKey]: value == null ? '' : value });
        _writeQueue = _writeQueue.then(async () => {
            try {
                const res = await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            } catch (e) {
                console.warn(`[HiFi Buddy] Failed to persist ${serverKey} to server:`, e.message);
            }
        });
        return _writeQueue;
    }

    // ===== Public get/set/remove (transparent) =====

    function get(key) {
        const serverKey = CONFIG_KEY_MAP[key];
        if (serverKey) {
            // Cache is the primary source. Fall back to localStorage if the
            // cache is empty — covers three real-world cases:
            //   (a) boot before loadConfigFromServer() resolves
            //   (b) server unreachable, or running an older server.py without
            //       the /api/config endpoint
            //   (c) user just upgraded and migration hasn't run yet
            // The fallback means settings never appear "lost" even if the
            // server is down.
            return _configCache[serverKey] || localStorage.getItem(key) || '';
        }
        return localStorage.getItem(key) || '';
    }

    function set(key, val) {
        const serverKey = CONFIG_KEY_MAP[key];
        if (serverKey) {
            const v = val == null ? '' : String(val);
            if (v === '') delete _configCache[serverKey];
            else _configCache[serverKey] = v;
            queueConfigWrite(serverKey, v);
            // Tier A keys no longer get written to localStorage. Any stale
            // value left from a pre-migration build will be cleaned up by
            // migrateLocalStorageToServer() at boot, or simply ignored here
            // since get() returns the cache first.
            return;
        }
        localStorage.setItem(key, val);
    }

    function remove(key) {
        const serverKey = CONFIG_KEY_MAP[key];
        if (serverKey) {
            delete _configCache[serverKey];
            queueConfigWrite(serverKey, '');
            // Also clear any pre-migration mirror so the localStorage
            // fallback in get() doesn't resurrect a value the user
            // explicitly removed.
            try { localStorage.removeItem(key); } catch { /* ignore */ }
            return;
        }
        localStorage.removeItem(key);
    }

    // Public getters
    const getSpotifyClientId = () => get(KEYS.spotifyClientId);
    const getSpotifyClientSecret = () => get(KEYS.spotifyClientSecret);
    const getSpotifyAuthMethod = () => get(KEYS.spotifyAuthMethod) || 'credentials';
    const getSpotifyAccessToken = () => get(KEYS.spotifyAccessToken);
    const getSpotifyRefreshToken = () => get(KEYS.spotifyRefreshToken);
    const getSpotifyTokenScopes = () => get(KEYS.spotifyTokenScopes);
    const getClaudeApiKey = () => get(KEYS.claudeApiKey);
    const getPlexUrl = () => get(KEYS.plexUrl).replace(/\/+$/, '');
    const getPlexToken = () => get(KEYS.plexToken);
    const getLocalFolder = () => get(KEYS.localFolder);
    const getEquipmentHeadphones = () => get(KEYS.equipmentHeadphones);
    const getEquipmentHeadphoneType = () => get(KEYS.equipmentHeadphoneType) || 'unknown';
    const getEquipmentDac = () => get(KEYS.equipmentDac);
    const getEquipmentAmp = () => get(KEYS.equipmentAmp);
    const getEquipmentFormatPref = () => get(KEYS.equipmentFormatPref) || 'unknown';
    const getOllamaUrl = () => get(KEYS.ollamaUrl);
    const getOllamaModel = () => get(KEYS.ollamaModel);
    const setSpotifyAuthMethod = (m) => set(KEYS.spotifyAuthMethod, m);

    function saveEquipment({ headphones, headphoneType, dac, amp, formatPref } = {}) {
        if (headphones !== undefined) set(KEYS.equipmentHeadphones, headphones);
        if (headphoneType !== undefined) set(KEYS.equipmentHeadphoneType, headphoneType);
        if (dac !== undefined) set(KEYS.equipmentDac, dac);
        if (amp !== undefined) set(KEYS.equipmentAmp, amp);
        if (formatPref !== undefined) set(KEYS.equipmentFormatPref, formatPref);
    }

    // Public setters
    function saveSpotifyTokens(access, refresh, expiresIn, scopes) {
        set(KEYS.spotifyAccessToken, access);
        if (refresh) set(KEYS.spotifyRefreshToken, refresh);
        set(KEYS.spotifyTokenExpiry, Date.now() + (expiresIn * 1000));
        if (scopes !== undefined) set(KEYS.spotifyTokenScopes, scopes || '');
    }

    function isSpotifyTokenValid() {
        const expiry = parseInt(get(KEYS.spotifyTokenExpiry));
        return expiry && Date.now() < expiry && !!get(KEYS.spotifyAccessToken);
    }

    function clearSpotifyTokens() {
        remove(KEYS.spotifyAccessToken);
        remove(KEYS.spotifyRefreshToken);
        remove(KEYS.spotifyTokenExpiry);
        remove(KEYS.spotifyTokenScopes);
    }

    // Settings modal
    function show() {
        let modal = document.getElementById('settingsModal');
        if (!modal) return;
        document.getElementById('settingsBody').innerHTML = renderForm();
        modal.style.display = 'flex';
        bindFormEvents();
    }

    function hide() {
        const modal = document.getElementById('settingsModal');
        if (modal) modal.style.display = 'none';
    }

    function renderForm() {
        const authMethod = getSpotifyAuthMethod();
        return `
            <div class="settings-section">
                <h4 class="settings-section-title">
                    ${HiFiBuddyIcons.circle({ size: 18, style: 'color:#1DB954' })}
                    Spotify
                </h4>
                <div class="settings-field">
                    <label>Client ID</label>
                    <input type="text" id="setSpotifyClientId" value="${escHtml(getSpotifyClientId())}" placeholder="Your Spotify Client ID">
                </div>
                <div class="settings-field">
                    <label>Auth Method</label>
                    <div class="settings-radio-group">
                        <label class="settings-radio"><input type="radio" name="spotifyAuth" value="credentials" ${authMethod === 'credentials' ? 'checked' : ''}> Client Credentials</label>
                        <label class="settings-radio"><input type="radio" name="spotifyAuth" value="pkce" ${authMethod === 'pkce' ? 'checked' : ''}> PKCE (User Login)</label>
                    </div>
                </div>
                <div class="settings-field" id="secretField" style="display:${authMethod === 'credentials' ? 'block' : 'none'}">
                    <label>Client Secret</label>
                    <input type="password" id="setSpotifyClientSecret" value="${escHtml(getSpotifyClientSecret())}" placeholder="Your Spotify Client Secret">
                </div>
                <div class="settings-backup-row">
                    <button class="settings-test-btn" id="connectSpotifyBtn">${isSpotifyTokenValid() ? 'Reconnect' : 'Connect to Spotify'}</button>
                    <button class="settings-test-btn" id="disconnectSpotifyBtn" style="display:${isSpotifyTokenValid() ? 'inline-block' : 'none'}">Disconnect</button>
                </div>
                <div class="settings-status" id="spotifyStatus">
                    ${isSpotifyTokenValid() ? '<span class="status-ok">Connected</span>' : '<span class="status-off">Not connected — paste your Client ID, choose an auth method, then click Connect.</span>'}
                </div>
            </div>

            <div class="settings-section">
                <h4 class="settings-section-title">
                    ${HiFiBuddyIcons.circle({ size: 18, style: 'color:#D97706' })}
                    Claude AI
                </h4>
                <div class="settings-field">
                    <label>API Key</label>
                    <input type="password" id="setClaudeApiKey" value="${escHtml(getClaudeApiKey())}" placeholder="sk-ant-...">
                </div>
                <div class="settings-status" id="claudeStatus">
                    ${getClaudeApiKey() ? '<span class="status-ok">Key set</span>' : '<span class="status-off">Not configured</span>'}
                </div>
            </div>

            <div class="settings-section">
                <h4 class="settings-section-title">
                    ${HiFiBuddyIcons.circle({ size: 18, style: 'color:#00d4aa' })}
                    Ollama (Local AI)
                </h4>
                <div class="settings-field">
                    <label>Server URL</label>
                    <input type="text" id="setOllamaUrl" value="${escHtml(get(KEYS.ollamaUrl))}" placeholder="http://localhost:11434">
                </div>
                <div class="settings-field">
                    <label>Model</label>
                    <div style="display:flex;gap:8px;align-items:center">
                        <input type="text" id="setOllamaModel" value="${escHtml(get(KEYS.ollamaModel) || 'gemma2:9b')}" placeholder="gemma2:9b" style="flex:1">
                        <button class="settings-test-btn" id="loadOllamaModels" style="margin:0;white-space:nowrap">Load Models</button>
                    </div>
                    <div id="ollamaModelList" style="margin-top:6px"></div>
                </div>
                <div class="settings-status" id="ollamaStatus">
                    ${get(KEYS.ollamaUrl) ? '<span class="status-ok">Configured</span>' : '<span class="status-off">Not configured — runs locally, no API key needed</span>'}
                </div>
            </div>

            <div class="settings-section">
                <h4 class="settings-section-title">
                    ${HiFiBuddyIcons.circle({ size: 18, style: 'color:#E5A00D' })}
                    Plex Media Server
                </h4>
                <div class="settings-field">
                    <label>Server URL</label>
                    <input type="text" id="setPlexUrl" value="${escHtml(getPlexUrl())}" placeholder="http://192.168.1.100:32400">
                </div>
                <div class="settings-field">
                    <label>Auth Token</label>
                    <input type="password" id="setPlexToken" value="${escHtml(getPlexToken())}" placeholder="Your Plex token">
                </div>
                <button class="settings-test-btn" id="testPlexBtn">Test Connection</button>
                <div class="settings-status" id="plexStatus">
                    ${getPlexUrl() && getPlexToken() ? '<span class="status-pending">Not tested</span>' : '<span class="status-off">Not configured</span>'}
                </div>
            </div>

            <div class="settings-section">
                <h4 class="settings-section-title">
                    ${HiFiBuddyIcons.folder({ size: 18, style: 'color:#7AC74F' })}
                    Local FLAC Library
                </h4>
                <p class="settings-help">Point to a folder of audio files. The server scans, indexes by tag, and matches to lessons. ABX uses ffmpeg for MP3 transcoding (install via <code>brew install ffmpeg</code>).</p>
                <div class="settings-field">
                    <label>Folder Path</label>
                    <input type="text" id="setLocalFolder" value="${escHtml(getLocalFolder())}" placeholder="/Users/you/Music or /home/you/Music">
                </div>
                <button class="settings-test-btn" id="scanLocalLibrary">Scan Library</button>
                <div class="settings-status" id="localLibraryStatus">
                    ${getLocalFolder() ? '<span class="status-pending">Configured — click Scan to index</span>' : '<span class="status-off">Not configured</span>'}
                </div>
            </div>

            <div class="settings-section">
                <h4 class="settings-section-title">Audio Equipment</h4>
                <p class="settings-help">Tell us your gear so HiFi Buddy can personalize lesson notes. Optional — affects only how lessons are annotated.</p>
                <div class="settings-field">
                    <label>Headphones</label>
                    <input type="text" id="setEquipHeadphones" value="${escHtml(getEquipmentHeadphones())}" placeholder="e.g. Sennheiser HD 600">
                </div>
                <div class="settings-field">
                    <label>Headphone Type</label>
                    <select id="setEquipHeadphoneType">
                        <option value="unknown" ${getEquipmentHeadphoneType() === 'unknown' ? 'selected' : ''}>Unknown / Not specified</option>
                        <option value="open-back" ${getEquipmentHeadphoneType() === 'open-back' ? 'selected' : ''}>Open-back</option>
                        <option value="closed-back" ${getEquipmentHeadphoneType() === 'closed-back' ? 'selected' : ''}>Closed-back</option>
                        <option value="iem" ${getEquipmentHeadphoneType() === 'iem' ? 'selected' : ''}>IEM (in-ear monitor)</option>
                        <option value="planar" ${getEquipmentHeadphoneType() === 'planar' ? 'selected' : ''}>Planar magnetic</option>
                    </select>
                </div>
                <div class="settings-field">
                    <label>DAC</label>
                    <input type="text" id="setEquipDac" value="${escHtml(getEquipmentDac())}" placeholder="e.g. Topping E30">
                </div>
                <div class="settings-field">
                    <label>Amplifier</label>
                    <input type="text" id="setEquipAmp" value="${escHtml(getEquipmentAmp())}" placeholder="e.g. JDS Atom">
                </div>
                <div class="settings-field">
                    <label>Preferred Source Format</label>
                    <select id="setEquipFormatPref">
                        <option value="unknown" ${getEquipmentFormatPref() === 'unknown' ? 'selected' : ''}>Unknown / Not specified</option>
                        <option value="flac" ${getEquipmentFormatPref() === 'flac' ? 'selected' : ''}>FLAC / Lossless</option>
                        <option value="mp3-320" ${getEquipmentFormatPref() === 'mp3-320' ? 'selected' : ''}>MP3 320 kbps</option>
                        <option value="mp3-192" ${getEquipmentFormatPref() === 'mp3-192' ? 'selected' : ''}>MP3 192 kbps</option>
                        <option value="streaming" ${getEquipmentFormatPref() === 'streaming' ? 'selected' : ''}>Streaming (mixed)</option>
                    </select>
                </div>
            </div>

            <div class="settings-section" id="diagnosticsSection">
                <h4 class="settings-section-title">Diagnostics</h4>
                <p class="settings-help">Live state of subsystems. Use this when something silently breaks.</p>
                <div class="diagnostics-panel" id="diagnosticsPanel">
                    <div class="diagnostics-loading">Gathering diagnostics…</div>
                </div>
                <div class="settings-backup-row">
                    <button class="settings-test-btn" id="diagForceUpdateBtn">Force Update</button>
                    <button class="settings-test-btn" id="diagUnregisterBtn">Unregister &amp; Reload</button>
                    <button class="settings-test-btn" id="diagRefreshBtn">Refresh</button>
                </div>
            </div>

            <div class="settings-section">
                <h4 class="settings-section-title">Config &amp; Backup</h4>
                <p class="settings-help">Your credentials, equipment, and ABX history live in <code>~/.hifi-buddy/</code> on this machine. Back it up by copying that folder. To move to another machine, copy the folder over.</p>
                <div class="settings-backup-row">
                    <button class="settings-test-btn" id="revealConfigBtn">Reveal config folder</button>
                </div>
                <div class="settings-status" id="configStatus"></div>
            </div>

            <button class="settings-save-btn" id="saveSettingsBtn">Save Settings</button>
        `;
    }

    function bindFormEvents() {
        // Auth method toggle
        document.querySelectorAll('input[name="spotifyAuth"]').forEach(r => {
            r.addEventListener('change', () => {
                document.getElementById('secretField').style.display = r.value === 'credentials' ? 'block' : 'none';
            });
        });

        // Connect to Spotify — saves whatever the user has typed in the form,
        // waits for the server to acknowledge the write (otherwise the PKCE
        // redirect would race the POST and lose the Client ID), then triggers
        // the appropriate auth flow:
        //   - PKCE → page redirects to accounts.spotify.com
        //   - Client Credentials → background token fetch, no redirect
        document.getElementById('connectSpotifyBtn')?.addEventListener('click', async () => {
            const status = document.getElementById('spotifyStatus');
            const clientId = document.getElementById('setSpotifyClientId')?.value.trim() || '';
            const clientSecret = document.getElementById('setSpotifyClientSecret')?.value.trim() || '';
            const method = document.querySelector('input[name="spotifyAuth"]:checked')?.value || 'credentials';
            if (!clientId) {
                if (status) status.innerHTML = '<span class="status-off">Paste your Spotify Client ID first.</span>';
                return;
            }
            if (method === 'credentials' && !clientSecret) {
                if (status) status.innerHTML = '<span class="status-off">Client Credentials needs a Client Secret. Or switch to PKCE.</span>';
                return;
            }
            if (status) status.innerHTML = '<span class="status-pending">Saving credentials…</span>';
            // Persist current form values so they survive the redirect.
            set(KEYS.spotifyClientId, clientId);
            set(KEYS.spotifyClientSecret, clientSecret);
            set(KEYS.spotifyAuthMethod, method);
            try {
                await flushConfig();
            } catch { /* non-fatal — proceed with auth anyway */ }

            if (typeof HiFiBuddySpotify === 'undefined') {
                if (status) status.innerHTML = '<span class="status-off">Spotify module not loaded — reload the page.</span>';
                return;
            }
            if (method === 'pkce') {
                if (status) status.innerHTML = '<span class="status-pending">Redirecting to Spotify…</span>';
                try { await HiFiBuddySpotify.startPKCEAuth(); }
                catch (e) {
                    if (status) status.innerHTML = `<span class="status-off">Auth failed: ${escHtml(e?.message || e)}</span>`;
                }
            } else {
                if (status) status.innerHTML = '<span class="status-pending">Authenticating…</span>';
                try {
                    const ok = await HiFiBuddySpotify.connectClientCredentials();
                    if (ok) {
                        if (status) status.innerHTML = '<span class="status-ok">Connected (search-only — no Premium playback)</span>';
                        const dc = document.getElementById('disconnectSpotifyBtn');
                        if (dc) dc.style.display = 'inline-block';
                        document.getElementById('connectSpotifyBtn').textContent = 'Reconnect';
                    } else {
                        if (status) status.innerHTML = '<span class="status-off">Auth failed. Double-check Client ID and Secret.</span>';
                    }
                } catch (e) {
                    if (status) status.innerHTML = `<span class="status-off">Auth failed: ${escHtml(e?.message || e)}</span>`;
                }
            }
        });

        // Disconnect — clears tokens locally. Doesn't revoke them on Spotify's
        // side (no API for that without re-auth); they expire naturally in ~1h.
        document.getElementById('disconnectSpotifyBtn')?.addEventListener('click', () => {
            clearSpotifyTokens();
            const status = document.getElementById('spotifyStatus');
            if (status) status.innerHTML = '<span class="status-off">Disconnected.</span>';
            const btn = document.getElementById('connectSpotifyBtn');
            if (btn) btn.textContent = 'Connect to Spotify';
            const dc = document.getElementById('disconnectSpotifyBtn');
            if (dc) dc.style.display = 'none';
        });

        // Save
        document.getElementById('saveSettingsBtn')?.addEventListener('click', () => {
            set(KEYS.spotifyClientId, document.getElementById('setSpotifyClientId').value.trim());
            set(KEYS.spotifyClientSecret, document.getElementById('setSpotifyClientSecret').value.trim());
            set(KEYS.spotifyAuthMethod, document.querySelector('input[name="spotifyAuth"]:checked')?.value || 'credentials');
            set(KEYS.claudeApiKey, document.getElementById('setClaudeApiKey').value.trim());
            set(KEYS.ollamaUrl, (document.getElementById('setOllamaUrl')?.value || '').trim());
            set(KEYS.ollamaModel, (document.getElementById('setOllamaModel')?.value || 'gemma2').trim());
            set(KEYS.plexUrl, document.getElementById('setPlexUrl').value.trim());
            set(KEYS.plexToken, document.getElementById('setPlexToken').value.trim());
            set(KEYS.localFolder, (document.getElementById('setLocalFolder')?.value || '').trim());
            set(KEYS.equipmentHeadphones, (document.getElementById('setEquipHeadphones')?.value || '').trim());
            set(KEYS.equipmentHeadphoneType, document.getElementById('setEquipHeadphoneType')?.value || 'unknown');
            set(KEYS.equipmentDac, (document.getElementById('setEquipDac')?.value || '').trim());
            set(KEYS.equipmentAmp, (document.getElementById('setEquipAmp')?.value || '').trim());
            set(KEYS.equipmentFormatPref, document.getElementById('setEquipFormatPref')?.value || 'unknown');

            // Notify other modules
            window.dispatchEvent(new CustomEvent('hifibuddy-settings-changed'));
            if (typeof HiFiBuddyToast !== 'undefined') HiFiBuddyToast.success('Settings saved');
            hide();
        });

        // Close modal
        document.getElementById('closeSettings')?.addEventListener('click', hide);
        document.getElementById('settingsModal')?.addEventListener('click', e => {
            if (e.target.id === 'settingsModal') hide();
        });

        // Test Plex
        document.getElementById('testPlexBtn')?.addEventListener('click', async () => {
            const status = document.getElementById('plexStatus');
            const url = document.getElementById('setPlexUrl').value.trim().replace(/\/+$/, '');
            const token = document.getElementById('setPlexToken').value.trim();
            if (!url || !token) { status.innerHTML = '<span class="status-off">Enter URL and token first</span>'; return; }
            status.innerHTML = '<span class="status-pending">Testing...</span>';
            try {
                const res = await fetch(`/api/plex/identity?plexUrl=${encodeURIComponent(url)}&plexToken=${encodeURIComponent(token)}`);
                if (res.ok) {
                    const data = await res.json();
                    status.innerHTML = `<span class="status-ok">Connected: ${escHtml(data.name || 'Plex Server')}</span>`;
                } else {
                    status.innerHTML = '<span class="status-off">Connection failed</span>';
                }
            } catch {
                status.innerHTML = '<span class="status-off">Connection failed</span>';
            }
        });

        // Diagnostics panel — fire and forget
        try { bindDiagnostics(); } catch (e) { console.warn('[Diagnostics] bind failed:', e); }

        // Local Library — show live status
        (async () => {
            const status = document.getElementById('localLibraryStatus');
            if (!status || typeof HiFiBuddyLocalLibrary === 'undefined') return;
            try {
                const data = await HiFiBuddyLocalLibrary.loadIndex();
                const caps = await HiFiBuddyLocalLibrary.probe();
                renderLocalStatus(status, data, caps);
            } catch { /* ignore */ }
        })();

        // Local Library — Scan button
        document.getElementById('scanLocalLibrary')?.addEventListener('click', async () => {
            const status = document.getElementById('localLibraryStatus');
            const folderInput = document.getElementById('setLocalFolder');
            const folder = (folderInput?.value || '').trim();
            if (!folder) {
                status.innerHTML = '<span class="status-off">Enter a folder path first</span>';
                return;
            }
            // Persist immediately so it survives if user closes without Save
            set(KEYS.localFolder, folder);
            status.innerHTML = '<span class="status-pending">Scanning…</span>';
            try {
                if (typeof HiFiBuddyLocalLibrary === 'undefined') {
                    status.innerHTML = '<span class="status-off">Local Library module not loaded</span>';
                    return;
                }
                const data = await HiFiBuddyLocalLibrary.rescan(folder);
                const caps = await HiFiBuddyLocalLibrary.probe();
                renderLocalStatus(status, data, caps);
                window.dispatchEvent(new CustomEvent('hifibuddy-local-library-changed'));
            } catch (e) {
                status.innerHTML = `<span class="status-off">Scan failed: ${escHtml(e.message || 'unknown error')}</span>`;
            }
        });

        // Reveal config folder — opens ~/.hifi-buddy/ in Finder/Explorer
        document.getElementById('revealConfigBtn')?.addEventListener('click', async () => {
            const status = document.getElementById('configStatus');
            try {
                const res = await fetch('/api/config/reveal', { method: 'POST' });
                const data = await res.json();
                const path = data?.path || '~/.hifi-buddy/';
                if (status) {
                    status.innerHTML = data?.opened
                        ? `<span class="status-ok">Opened <code>${escHtml(path)}</code></span>`
                        : `<span class="status-pending">Folder is at <code>${escHtml(path)}</code> (couldn't open automatically)</span>`;
                }
            } catch (e) {
                if (status) status.innerHTML = `<span class="status-off">Could not reach server: ${escHtml(e.message || 'unknown')}</span>`;
            }
        });

        // Load Ollama models
        document.getElementById('loadOllamaModels')?.addEventListener('click', async () => {
            const list = document.getElementById('ollamaModelList');
            const urlInput = document.getElementById('setOllamaUrl');
            const modelInput = document.getElementById('setOllamaModel');
            const ollamaUrl = (urlInput?.value || 'http://localhost:11434').trim();
            if (!list) return;
            list.innerHTML = '<span class="status-pending">Loading...</span>';
            try {
                const res = await fetch(`/api/ollama/models?url=${encodeURIComponent(ollamaUrl)}`);
                const data = await res.json();
                if (data.models?.length) {
                    list.innerHTML = data.models.map(m =>
                        `<button class="ollama-model-btn" data-model="${m.name}" style="margin:2px 4px 2px 0;padding:4px 10px;border-radius:12px;border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-secondary);font-size:0.75rem;cursor:pointer;font-family:inherit">${m.name}</button>`
                    ).join('');
                    list.querySelectorAll('.ollama-model-btn').forEach(btn => {
                        btn.addEventListener('click', () => {
                            if (modelInput) modelInput.value = btn.dataset.model;
                            list.querySelectorAll('.ollama-model-btn').forEach(b => b.style.borderColor = '');
                            btn.style.borderColor = 'var(--accent-color)';
                        });
                    });
                    document.getElementById('ollamaStatus').innerHTML = `<span class="status-ok">${data.models.length} models available</span>`;
                } else {
                    list.innerHTML = '<span class="status-off">No models found</span>';
                }
            } catch {
                list.innerHTML = '<span class="status-off">Cannot reach Ollama</span>';
            }
        });
    }

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    // Programmatic reveal — used by anything that wants to deep-link to the
    // config folder (e.g., a future "Where's my config?" button on an error
    // toast). Resolves with {opened, path} from the server.
    async function revealConfigFolder() {
        try {
            const res = await fetch('/api/config/reveal', { method: 'POST' });
            return await res.json();
        } catch (e) {
            return { opened: false, path: '~/.hifi-buddy/', error: String(e) };
        }
    }

    function renderLocalStatus(el, data, caps) {
        if (!el) return;
        const indexed = data?.indexed ?? (data?.tracks?.length || 0);
        const folder = data?.folder || '';
        const ff = caps?.ffmpeg ? '<span class="status-ok">ffmpeg available</span>' : '<span class="status-off">ffmpeg missing — install for ABX</span>';
        const mt = caps?.mutagen ? '<span class="status-ok">tag-based indexing</span>' : '<span class="status-pending">filename indexing (install mutagen for tags)</span>';
        if (!folder && !indexed) {
            el.innerHTML = '<span class="status-off">Not configured</span>';
            return;
        }
        const warn = data?.warning ? `<div class="status-pending" style="margin-top:4px">${escHtml(data.warning)}</div>` : '';
        el.innerHTML = `
            <div><span class="status-ok">${indexed} tracks indexed</span>${folder ? ` <span style="opacity:0.7">(${escHtml(folder)})</span>` : ''}</div>
            <div style="margin-top:4px">${ff} &middot; ${mt}</div>
            ${warn}
        `;
    }

    // ===== Diagnostics panel =====
    //
    // Probes a handful of subsystems and renders a compact live-state table
    // in the Settings modal. The goal: turn "I think the SW is stale" /
    // "I think my Plex token expired" into something the user can SEE.

    function diagOk(label, detail)   { return `<span class="diag-ok">${escHtml(label)}</span>${detail ? ` <span class="diag-detail">${escHtml(detail)}</span>` : ''}`; }
    function diagWarn(label, detail) { return `<span class="diag-warn">${escHtml(label)}</span>${detail ? ` <span class="diag-detail">${escHtml(detail)}</span>` : ''}`; }
    function diagOff(label, detail)  { return `<span class="diag-off">${escHtml(label)}</span>${detail ? ` <span class="diag-detail">${escHtml(detail)}</span>` : ''}`; }

    function relTime(ts) {
        if (!ts) return 'never';
        const ms = Date.now() - ts;
        if (ms < 0) return 'in the future';
        if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
        if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
        if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
        return `${Math.floor(ms / 86_400_000)}d ago`;
    }

    function parseBrowser(ua) {
        ua = ua || '';
        let name = 'Unknown', ver = '';
        if (/Edg\//.test(ua))         { name = 'Edge';    ver = (ua.match(/Edg\/([\d.]+)/) || [])[1] || ''; }
        else if (/Chrome\//.test(ua)) { name = 'Chrome';  ver = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || ''; }
        else if (/Firefox\//.test(ua)) { name = 'Firefox'; ver = (ua.match(/Firefox\/([\d.]+)/) || [])[1] || ''; }
        else if (/Safari\//.test(ua)) { name = 'Safari';  ver = (ua.match(/Version\/([\d.]+)/) || [])[1] || ''; }
        let os = 'Unknown';
        if (/Macintosh|Mac OS/.test(ua)) os = 'macOS';
        else if (/Windows/.test(ua))     os = 'Windows';
        else if (/Linux/.test(ua))       os = 'Linux';
        else if (/Android/.test(ua))     os = 'Android';
        else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
        return { name, ver: ver.split('.')[0] || '', os };
    }

    function isLoopbackOrSecure(origin) {
        try {
            const u = new URL(origin);
            if (u.protocol === 'https:') return { ok: true, label: 'HTTPS' };
            if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]') {
                return { ok: true, label: 'loopback' };
            }
            return { ok: false, label: 'plain http to non-loopback' };
        } catch { return { ok: false, label: 'unparseable' }; }
    }

    async function probeServiceWorker() {
        const out = { scriptURL: '', activeState: '', waitingState: '', cacheName: '' };
        if (!('serviceWorker' in navigator)) return out;
        try {
            const reg = await navigator.serviceWorker.getRegistration();
            out.scriptURL = navigator.serviceWorker.controller?.scriptURL || reg?.active?.scriptURL || '';
            out.activeState = reg?.active?.state || '';
            out.waitingState = reg?.waiting?.state || '';
        } catch { /* ignore */ }
        // Best-effort cache-name read from the SW source — gracefully degrade if
        // the SW file isn't fetchable (offline, blocked, etc).
        try {
            const r = await fetch('/service-worker.js', { cache: 'no-store' });
            if (r.ok) {
                const t = await r.text();
                const m = t.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
                if (m) out.cacheName = m[1];
            }
        } catch { /* ignore */ }
        return out;
    }

    async function probeStorage() {
        if (!navigator.storage || !navigator.storage.estimate) return null;
        try {
            const est = await navigator.storage.estimate();
            return { usage: est.usage || 0, quota: est.quota || 0 };
        } catch { return null; }
    }

    function fmtBytes(n) {
        if (!n && n !== 0) return '?';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
        return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }

    async function probePlex() {
        const url = getPlexUrl();
        const token = getPlexToken();
        if (!url || !token) return { state: 'off', detail: 'Not configured' };
        const lastOk = (typeof HiFiBuddyPlex !== 'undefined' && HiFiBuddyPlex.getLastSuccessAt)
            ? HiFiBuddyPlex.getLastSuccessAt() : 0;
        const t0 = Date.now();
        try {
            const res = await fetch(`/api/plex/identity?plexUrl=${encodeURIComponent(url)}&plexToken=${encodeURIComponent(token)}`);
            const dt = Date.now() - t0;
            if (res.ok) {
                return { state: 'ok', detail: `responded in ${dt} ms · last ok ${relTime(Date.now())}` };
            }
            const lastOkStr = lastOk ? ` · last ok ${relTime(lastOk)}` : '';
            return { state: 'warn', detail: `HTTP ${res.status}${lastOkStr}` };
        } catch (e) {
            const lastOkStr = lastOk ? ` · last ok ${relTime(lastOk)}` : '';
            return { state: 'off', detail: `unreachable${lastOkStr}` };
        }
    }

    function probeSpotifyDiag() {
        if (!isSpotifyTokenValid()) return { state: 'off', detail: 'Not connected' };
        const scopes = getSpotifyTokenScopes();
        const hasStreaming = scopes.split(/\s+/).includes('streaming');
        if (!hasStreaming) {
            return { state: 'warn', detail: "Connected, missing 'streaming' scope" };
        }
        return { state: 'ok', detail: 'Connected with streaming scope' };
    }

    async function probeLocal() {
        let probe = { ffmpeg: false, mutagen: false };
        try {
            const r = await fetch('/api/local/probe');
            if (r.ok) probe = await r.json();
        } catch { /* ignore */ }
        let index = { tracks: [], folder: '' };
        try {
            const r = await fetch('/api/local/index');
            if (r.ok) index = await r.json();
        } catch { /* ignore */ }
        return {
            tracks: Array.isArray(index.tracks) ? index.tracks.length : 0,
            folder: index.folder || '',
            ffmpeg: !!probe.ffmpeg,
            mutagen: !!probe.mutagen,
            ffmpegPath: probe.ffmpegPath || '',
        };
    }

    async function renderDiagnostics() {
        const panel = document.getElementById('diagnosticsPanel');
        if (!panel) return;
        panel.innerHTML = '<div class="diagnostics-loading">Gathering diagnostics…</div>';

        const [sw, storage, plex, local] = await Promise.all([
            probeServiceWorker(),
            probeStorage(),
            probePlex(),
            probeLocal(),
        ]);
        const spotify = probeSpotifyDiag();
        const browser = parseBrowser(navigator.userAgent || '');
        const origin = window.location.origin || '';
        const originInfo = isLoopbackOrSecure(origin);

        const swLine = sw.scriptURL
            ? `${sw.cacheName || 'unknown cache'} (${sw.activeState || 'no active'}${sw.waitingState ? `, waiting=${sw.waitingState}` : ''})`
            : 'not registered';
        const swState = sw.scriptURL && sw.activeState === 'activated'
            ? (sw.waitingState ? diagWarn('update pending', swLine) : diagOk(swLine))
            : diagWarn(swLine);

        const storageStr = storage
            ? `${fmtBytes(storage.usage)} / ${fmtBytes(storage.quota)}`
            : 'estimate unavailable';

        const plexStr = plex.state === 'ok' ? diagOk('Connected', plex.detail)
            : plex.state === 'warn' ? diagWarn('Issue', plex.detail)
            : diagOff('Not configured', plex.detail);

        const spotifyStr = spotify.state === 'ok' ? diagOk('Connected', spotify.detail)
            : spotify.state === 'warn' ? diagWarn('Connected', spotify.detail)
            : diagOff('Not connected', spotify.detail);

        const localStr = (local.folder || local.tracks)
            ? `${local.tracks} tracks indexed${local.folder ? ` · ${local.folder}` : ''}`
            : 'Not configured';

        const ffmpegLine = local.ffmpeg
            ? diagOk(local.ffmpegPath || 'present')
            : diagOff('not installed', 'install to enable ABX MP3 transcoding');
        const mutagenLine = local.mutagen
            ? diagOk('present')
            : diagOff('not installed', 'install for tag-based indexing');

        const originLine = originInfo.ok
            ? diagOk(origin, `(${originInfo.label})`)
            : diagWarn(origin, `(${originInfo.label} — Spotify PKCE will fail here)`);

        panel.innerHTML = `
            <table class="diagnostics-table">
                <tr><th>Service Worker</th><td>${swState}</td></tr>
                <tr><th>Storage</th><td>${escHtml(storageStr)}</td></tr>
                <tr><th>Plex</th><td>${plexStr}</td></tr>
                <tr><th>Spotify</th><td>${spotifyStr}</td></tr>
                <tr><th>Local FLAC</th><td>${escHtml(localStr)}</td></tr>
                <tr><th>ffmpeg</th><td>${ffmpegLine}</td></tr>
                <tr><th>mutagen</th><td>${mutagenLine}</td></tr>
                <tr><th>Origin</th><td>${originLine}</td></tr>
                <tr><th>Browser</th><td>${escHtml(`${browser.name}${browser.ver ? ' ' + browser.ver : ''} on ${browser.os}`)}</td></tr>
            </table>
        `;
    }

    function bindDiagnostics() {
        renderDiagnostics();
        document.getElementById('diagRefreshBtn')?.addEventListener('click', renderDiagnostics);
        document.getElementById('diagForceUpdateBtn')?.addEventListener('click', async () => {
            const status = document.getElementById('diagnosticsPanel');
            if (!('serviceWorker' in navigator)) {
                if (typeof HiFiBuddyToast !== 'undefined') HiFiBuddyToast.warning('Service Worker API unavailable in this browser.');
                return;
            }
            try {
                const reg = await navigator.serviceWorker.getRegistration();
                if (!reg) {
                    if (typeof HiFiBuddyToast !== 'undefined') HiFiBuddyToast.warning('No service worker is registered.');
                    return;
                }
                await reg.update();
                if (typeof HiFiBuddyToast !== 'undefined') HiFiBuddyToast.info('Update check requested. Reloading…');
                setTimeout(() => location.reload(), 600);
            } catch (e) {
                if (typeof HiFiBuddyToast !== 'undefined') HiFiBuddyToast.error('Force update failed: ' + (e?.message || e));
            }
        });
        document.getElementById('diagUnregisterBtn')?.addEventListener('click', async () => {
            if (!confirm('Unregister the service worker and clear caches? The page will reload.')) return;
            try {
                if ('serviceWorker' in navigator) {
                    const regs = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(regs.map(r => r.unregister()));
                }
                if (typeof caches !== 'undefined' && caches.keys) {
                    const keys = await caches.keys();
                    await Promise.all(keys.map(k => caches.delete(k)));
                }
                if (typeof HiFiBuddyToast !== 'undefined') HiFiBuddyToast.info('Service worker and caches cleared. Reloading…');
                setTimeout(() => location.reload(), 600);
            } catch (e) {
                if (typeof HiFiBuddyToast !== 'undefined') HiFiBuddyToast.error('Unregister failed: ' + (e?.message || e));
            }
        });
    }

    // ===== Legacy-key migration =====
    //
    // Earlier builds of this app (when it lived inside a parent project) wrote
    // settings under the `musictrip_*` localStorage prefix. This app now uses
    // `hifibuddy_*`. On first run after the rename, copy any leftover
    // `musictrip_*` keys to their `hifibuddy_*` equivalents, then remove the
    // originals so we don't keep two copies in sync. Idempotent — once the
    // legacy keys are gone, this loop is a no-op.
    function migrateLegacyKeys() {
        let migrated = 0;
        // Scan a snapshot of keys (we mutate localStorage during iteration).
        const allKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k) allKeys.push(k);
        }
        for (const k of allKeys) {
            if (!k.startsWith('musictrip_')) continue;
            const newKey = 'hifibuddy_' + k.slice('musictrip_'.length);
            // Only copy across if the new slot is empty — never overwrite a
            // value the user has already set under the new prefix.
            if (localStorage.getItem(newKey) == null) {
                try { localStorage.setItem(newKey, localStorage.getItem(k)); }
                catch { /* quota exceeded — leave the legacy key in place */ continue; }
            }
            try { localStorage.removeItem(k); } catch { /* ignore */ }
            migrated++;
        }
        if (migrated > 0) {
            console.log(`[HiFi Buddy] Migrated ${migrated} legacy musictrip_* keys to hifibuddy_*.`);
        }
    }

    // ===== One-shot localStorage → server migration =====
    //
    // After loadConfigFromServer() runs, walk the CONFIG_KEY_MAP and for any
    // Tier A keys still sitting in localStorage (because this is the first
    // boot after upgrading from a pre-config version), POST them to the
    // server, then remove from localStorage. Idempotent: subsequent boots are
    // a no-op because localStorage no longer has the values.
    //
    // Conflict policy: if BOTH localStorage and server have a value for the
    // same key, server wins (the server is the durable source of truth).
    // localStorage gets cleared either way.
    async function migrateLocalStorageToServer() {
        const toMigrate = {};
        let count = 0;
        for (const [lsKey, serverKey] of Object.entries(CONFIG_KEY_MAP)) {
            const lsValue = localStorage.getItem(lsKey);
            if (lsValue == null) continue;
            // Server already has it → just clear localStorage
            if (_configCache[serverKey]) {
                try { localStorage.removeItem(lsKey); } catch { /* ignore */ }
                continue;
            }
            // Migrate
            toMigrate[serverKey] = lsValue;
            _configCache[serverKey] = lsValue;
            count++;
        }
        if (!count) return;
        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(toMigrate),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            // Server accepted — now safe to clear from localStorage
            for (const lsKey of Object.keys(CONFIG_KEY_MAP)) {
                if (toMigrate[CONFIG_KEY_MAP[lsKey]] !== undefined) {
                    try { localStorage.removeItem(lsKey); } catch { /* ignore */ }
                }
            }
            console.log(`[HiFi Buddy] Migrated ${count} keys from localStorage to ~/.hifi-buddy/config.json`);
        } catch (e) {
            // Migration failed — leave localStorage values in place; the
            // get() fallback will still return them next boot.
            console.warn('[HiFi Buddy] localStorage→server migration failed (will retry next boot):', e.message);
        }
    }

    async function init() {
        // 1. Legacy musictrip_* → hifibuddy_* (sync, predates the config split).
        try { migrateLegacyKeys(); } catch (e) { console.warn('[HiFi Buddy] Legacy-key migration failed:', e); }
        // 2. Pull current config from the server. Populates _configCache.
        await loadConfigFromServer();
        // 3. Move any leftover Tier A values out of localStorage. One-shot.
        await migrateLocalStorageToServer();
        // 4. Bind the settings gear in the header.
        document.getElementById('settingsBtn')?.addEventListener('click', show);
    }

    return {
        init, show, hide, KEYS,
        getSpotifyClientId, getSpotifyClientSecret, getSpotifyAuthMethod,
        getSpotifyAccessToken, getSpotifyRefreshToken, getSpotifyTokenScopes,
        getClaudeApiKey, getPlexUrl, getPlexToken, getLocalFolder,
        getOllamaUrl, getOllamaModel, setSpotifyAuthMethod,
        getEquipmentHeadphones, getEquipmentHeadphoneType, getEquipmentDac,
        getEquipmentAmp, getEquipmentFormatPref, saveEquipment,
        saveSpotifyTokens, isSpotifyTokenValid, clearSpotifyTokens,
        revealConfigFolder, flushConfig,
    };
})();

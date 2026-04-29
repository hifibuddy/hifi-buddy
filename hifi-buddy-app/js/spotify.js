/**
 * HiFi Buddy Spotify Integration
 * PKCE auth + Client Credentials, search, previews
 */
window.HiFiBuddySpotify = (() => {
    'use strict';

    const REDIRECT_URI = window.location.origin + window.location.pathname;
    const SCOPES = 'user-read-private user-read-email streaming user-modify-playback-state user-read-playback-state';
    const PREMIUM_SCOPE = 'streaming';
    const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
    const SPOTIFY_CACHE_KEY = 'hifibuddy_spotify_cache';
    let searchCache = new Map();

    // Web Playback SDK state
    let sdkLoaded = false;
    let sdkLoading = false;
    let player = null;
    let deviceId = null;
    let playerReady = false;
    const playerListeners = new Set();

    function loadCache() {
        try {
            const stored = JSON.parse(localStorage.getItem(SPOTIFY_CACHE_KEY) || '{}');
            for (const [k, v] of Object.entries(stored)) searchCache.set(k, v);
        } catch { /* ignore */ }
    }

    function saveCache() {
        try {
            const obj = {};
            let count = 0;
            for (const [k, v] of searchCache) {
                if (count++ >= 300) break;
                obj[k] = v;
            }
            localStorage.setItem(SPOTIFY_CACHE_KEY, JSON.stringify(obj));
        } catch { /* ignore */ }
    }

    function init() {
        loadCache();
        // Handle OAuth callback
        const params = new URLSearchParams(window.location.search);
        const code = params.get('code');
        if (code) {
            handleCallback(code);
            // Clean URL
            window.history.replaceState({}, '', window.location.pathname);
        }
    }

    function isConnected() {
        return HiFiBuddySettings.isSpotifyTokenValid();
    }

    // === Client Credentials Auth ===
    async function connectClientCredentials() {
        const clientId = HiFiBuddySettings.getSpotifyClientId();
        const clientSecret = HiFiBuddySettings.getSpotifyClientSecret();
        if (!clientId || !clientSecret) return false;

        try {
            const res = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + btoa(clientId + ':' + clientSecret),
                },
                body: 'grant_type=client_credentials',
            });
            if (!res.ok) return false;
            const data = await res.json();
            // Client Credentials grant cannot include streaming scope (no user context)
            HiFiBuddySettings.saveSpotifyTokens(data.access_token, '', data.expires_in, '');
            window.dispatchEvent(new CustomEvent('hifibuddy-spotify-connected'));
            return true;
        } catch {
            return false;
        }
    }

    // === PKCE Auth ===
    async function startPKCEAuth() {
        const clientId = HiFiBuddySettings.getSpotifyClientId();
        if (!clientId) return;

        const verifier = generateRandomString(128);
        let challenge;
        try {
            challenge = await sha256Base64url(verifier);
        } catch (e) {
            // sha256Base64url throws when crypto.subtle is unavailable
            // (non-secure origins like http:// to a LAN IP). Surface a clear
            // toast instead of failing silently.
            _toastIfNew('pkce:no-crypto', {
                type: 'error',
                message: "Spotify auth needs HTTPS or 127.0.0.1 — http:// to a non-loopback address won't work.",
                details: e?.message || String(e),
            });
            return;
        }
        sessionStorage.setItem('spotify_pkce_verifier', verifier);

        const params = new URLSearchParams({
            client_id: clientId,
            response_type: 'code',
            redirect_uri: REDIRECT_URI,
            scope: SCOPES,
            code_challenge_method: 'S256',
            code_challenge: challenge,
        });
        window.location.href = 'https://accounts.spotify.com/authorize?' + params;
    }

    async function handleCallback(code) {
        const verifier = sessionStorage.getItem('spotify_pkce_verifier');
        const clientId = HiFiBuddySettings.getSpotifyClientId();
        if (!verifier || !clientId) return;

        try {
            const res = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: clientId,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: REDIRECT_URI,
                    code_verifier: verifier,
                }),
            });
            if (!res.ok) return;
            const data = await res.json();
            HiFiBuddySettings.saveSpotifyTokens(data.access_token, data.refresh_token, data.expires_in, data.scope || '');
            sessionStorage.removeItem('spotify_pkce_verifier');
            window.dispatchEvent(new CustomEvent('hifibuddy-spotify-connected'));
            const scopes = data.scope || '';
            // Surface scope drift early — Spotify silently grants fewer scopes
            // than requested if the user's account doesn't qualify (Free tier,
            // app not approved, etc). Without this the user sees a generic
            // "redirect_uri" error later.
            if (!scopes.split(/\s+/).includes(PREMIUM_SCOPE)) {
                _toastIfNew('scope:drift', {
                    type: 'info',
                    message: "Reconnect Spotify with Premium scopes — current token is missing 'streaming'.",
                    action: { label: 'Reconnect', onClick: () => { try { startPKCEAuth(); } catch { /* ignore */ } } },
                    details: `granted: "${scopes}"`,
                });
            }
            // If we just got a token with streaming scope, kick off the SDK
            if (scopes.includes(PREMIUM_SCOPE)) {
                ensureSDK().then(() => initPlayer()).catch(() => {});
            }
        } catch { /* silent */ }
    }

    function hasStreamingScope() {
        const granted = HiFiBuddySettings.getSpotifyTokenScopes?.() || '';
        return granted.split(/\s+/).includes(PREMIUM_SCOPE);
    }

    // === Auto-connect on settings change ===
    async function autoConnect() {
        if (isConnected()) return true;
        const method = HiFiBuddySettings.getSpotifyAuthMethod();
        if (method === 'credentials') {
            return await connectClientCredentials();
        }
        return false;
    }

    let apiAvailable = true;
    let lastApiCheck = 0;

    // Per-error-key toast suppression so we don't blast the user with
    // the same Spotify failure on every poll.
    const _spotErrSeen = new Map();
    const _SPOT_ERR_TTL = 60_000;
    function _shouldToastSpotErr(key) {
        const last = _spotErrSeen.get(key);
        if (!last) return true;
        return Date.now() - last > _SPOT_ERR_TTL;
    }
    function _markSpotErr(key) { _spotErrSeen.set(key, Date.now()); }
    function _openSettings() {
        try {
            if (typeof HiFiBuddySettings !== 'undefined' && HiFiBuddySettings.show) {
                HiFiBuddySettings.show();
                return;
            }
        } catch { /* ignore */ }
        document.getElementById('settingsBtn')?.click();
    }
    function _toastIfNew(key, opts) {
        if (typeof HiFiBuddyToast === 'undefined') return;
        if (!_shouldToastSpotErr(key)) return;
        _markSpotErr(key);
        HiFiBuddyToast.show(opts);
    }

    // === API Calls ===
    async function apiCall(endpoint) {
        const token = HiFiBuddySettings.getSpotifyAccessToken();
        if (!token) return null;

        // If API was previously unavailable, retry every 60 seconds
        if (!apiAvailable) {
            if (Date.now() - lastApiCheck < 60000) return null;
            lastApiCheck = Date.now();
            console.log('[Spotify] Retrying API...');
        }

        try {
            const res = await fetch(`https://api.spotify.com/v1${endpoint}`, {
                headers: { 'Authorization': `Bearer ${token}` },
            });
            if (res.status === 401) {
                HiFiBuddySettings.clearSpotifyTokens();
                return null;
            }
            if (res.status === 403) {
                console.warn('[Spotify] API returned 403 — premium required or app not yet activated.');
                _toastIfNew('api:403', {
                    type: 'error',
                    message: 'Spotify API denied. App activation may be pending — check developer.spotify.com.',
                    action: { label: 'Open Settings', onClick: _openSettings },
                });
                apiAvailable = false;
                lastApiCheck = Date.now();
                return null;
            }
            // If we get here and apiAvailable was false, it's recovered!
            if (!apiAvailable) {
                console.log('[Spotify] API is now available!');
                apiAvailable = true;
            }
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        }
    }

    function isApiAvailable() { return apiAvailable && isConnected(); }

    // Generate Spotify search URLs as fallback when API is restricted
    function getSpotifySearchUrl(type, query) {
        return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
    }

    function getSpotifyTrackUrl(title, artist) {
        return `https://open.spotify.com/search/${encodeURIComponent(title + ' ' + artist)}`;
    }

    function getSpotifyAlbumUrl(title, artist) {
        return `https://open.spotify.com/search/${encodeURIComponent(title + ' ' + artist)}`;
    }

    async function searchArtist(name) {
        const key = `artist:${name.toLowerCase()}`;
        if (searchCache.has(key)) return searchCache.get(key);
        const data = await apiCall(`/search?type=artist&q=${encodeURIComponent(name)}&limit=1`);
        const result = data?.artists?.items?.[0] || null;
        if (result) { searchCache.set(key, result); saveCache(); }
        return result;
    }

    async function searchTrack(title, artist, album) {
        const albumKey = album ? `:${album.toLowerCase()}` : '';
        const key = `track:${title.toLowerCase()}:${artist.toLowerCase()}${albumKey}`;
        if (searchCache.has(key)) return searchCache.get(key);
        const parts = [`track:${title}`, `artist:${artist}`];
        if (album) parts.push(`album:${album}`);
        const q = parts.join(' ');
        const data = await apiCall(`/search?type=track&q=${encodeURIComponent(q)}&limit=1`);
        const result = data?.tracks?.items?.[0] || null;
        if (result) { searchCache.set(key, result); saveCache(); }
        return result;
    }

    async function searchAlbum(title, artist) {
        const key = `album:${title.toLowerCase()}:${artist.toLowerCase()}`;
        if (searchCache.has(key)) return searchCache.get(key);
        const q = `album:${title} artist:${artist}`;
        const data = await apiCall(`/search?type=album&q=${encodeURIComponent(q)}&limit=1`);
        const result = data?.albums?.items?.[0] || null;
        if (result) { searchCache.set(key, result); saveCache(); }
        return result;
    }

    async function getRelatedArtists(artistId) {
        return await apiCall(`/artists/${artistId}/related-artists`);
    }

    async function getArtistTopTracks(artistId, market = 'US') {
        const data = await apiCall(`/artists/${artistId}/top-tracks?market=${market}`);
        return data?.tracks || [];
    }

    async function getAudioFeatures(trackIds) {
        if (!trackIds?.length) return null;
        const ids = trackIds.slice(0, 100).join(',');
        const data = await apiCall(`/audio-features?ids=${ids}`);
        return data?.audio_features || null;
    }

    // === UI Helpers ===
    function renderSpotifyLink(spotifyUrl, label) {
        if (!spotifyUrl) return '';
        return `<a href="${spotifyUrl}" target="_blank" rel="noopener" class="spotify-link" title="Open in Spotify">
            ${HiFiBuddyIcons.spotify({ size: 16 })}
            ${label || ''}
        </a>`;
    }

    function renderPlayButton(previewUrl, title, artist, imageUrl) {
        if (!previewUrl) return '';
        return `<button class="spotify-play-btn" data-preview="${escAttr(previewUrl)}" data-title="${escAttr(title)}" data-artist="${escAttr(artist)}" data-image="${escAttr(imageUrl || '')}">
            ${HiFiBuddyIcons.play({ size: 14 })}
        </button>`;
    }

    function bindPlayButtons(container) {
        container.querySelectorAll('.spotify-play-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                HiFiBuddyAudio.play(btn.dataset.preview, btn.dataset.title, btn.dataset.artist, btn.dataset.image);
            });
        });
    }

    // === Utilities ===
    function generateRandomString(length) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        const values = crypto.getRandomValues(new Uint8Array(length));
        for (const v of values) result += chars[v % chars.length];
        return result;
    }

    async function sha256Base64url(plain) {
        // CROSS-BROWSER: crypto.subtle is only available in secure contexts (https / localhost).
        // On a plain http:// LAN dev URL Firefox/Safari will throw; surface a clearer error so
        // the user knows why PKCE auth fails (Spotify requires PKCE for user-context tokens).
        if (typeof crypto === 'undefined' || !crypto.subtle) {
            throw new Error('Spotify PKCE requires a secure context (https:// or localhost). Use Client Credentials auth or serve over HTTPS.');
        }
        const encoder = new TextEncoder();
        const data = encoder.encode(plain);
        const hash = await crypto.subtle.digest('SHA-256', data);
        // CROSS-BROWSER: spread on Uint8Array can blow the stack on some engines for very large arrays;
        // SHA-256 is 32 bytes so this is fine, but use an explicit loop as a defensive note.
        let bin = '';
        const arr = new Uint8Array(hash);
        for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
        return btoa(bin)
            .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    }

    function escAttr(s) {
        return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    // === Web Playback SDK ===

    function ensureSDK() {
        if (sdkLoaded) return Promise.resolve();
        if (sdkLoading) {
            return new Promise(resolve => {
                const check = () => sdkLoaded ? resolve() : setTimeout(check, 100);
                check();
            });
        }
        sdkLoading = true;
        return new Promise((resolve, reject) => {
            // The SDK calls this global hook when ready
            window.onSpotifyWebPlaybackSDKReady = () => {
                sdkLoaded = true;
                sdkLoading = false;
                resolve();
            };
            const script = document.createElement('script');
            script.src = SDK_URL;
            script.async = true;
            script.onerror = () => {
                sdkLoading = false;
                _toastIfNew('sdk:load-fail', {
                    type: 'error',
                    message: 'Spotify Web SDK failed to load. Check your network and any ad-blockers.',
                    details: SDK_URL,
                });
                reject(new Error('SDK failed to load'));
            };
            document.head.appendChild(script);
        });
    }

    // CROSS-BROWSER: The Spotify Web Playback SDK is officially desktop-only (Chrome, Firefox,
    // Edge, Safari >= 11). It will load on iOS/Android but typically fails to acquire a device
    // because mobile browsers block its EME/protected-media path. Detect the obvious mobile
    // signatures up-front so we surface a clean fallback instead of a silent timeout.
    function isLikelyMobile() {
        try {
            const ua = (navigator.userAgent || '').toLowerCase();
            // iOS / iPadOS (newer iPads spoof "Macintosh" UA — also check touch + maxTouchPoints)
            const iOSLike = /iphone|ipad|ipod/.test(ua) ||
                (ua.includes('macintosh') && (navigator.maxTouchPoints || 0) > 1);
            const androidLike = /android/.test(ua);
            return iOSLike || androidLike;
        } catch { return false; }
    }

    function isPlaybackSDKSupported() {
        // Quick win: the SDK relies on EME / MSE for protected playback. If MediaSource isn't
        // present at all, bail out fast.
        if (typeof window.MediaSource === 'undefined' && typeof window.WebKitMediaSource === 'undefined') {
            return false;
        }
        if (isLikelyMobile()) return false;
        return true;
    }

    async function initPlayer() {
        if (player) return player;
        if (!isConnected() || !hasStreamingScope()) return null;
        // CROSS-BROWSER: bail gracefully on mobile / SDK-unsupported environments.
        if (!isPlaybackSDKSupported()) {
            console.warn('[Spotify SDK] Web Playback SDK is not supported on this browser/device. Use a desktop browser or transfer playback via the Spotify app.');
            _toastIfNew('sdk:unsupported', {
                type: 'warning',
                message: isLikelyMobile()
                    ? 'Spotify Web Playback is desktop-only. Transfer to the Spotify app from your device list.'
                    : 'Spotify Web Playback unsupported on this browser. Try Chrome, Firefox, or Edge.',
            });
            return null;
        }
        try { if (!window.Spotify?.Player) await ensureSDK(); }
        catch (e) { console.warn('[Spotify SDK] ensureSDK failed:', e); return null; }
        if (!window.Spotify?.Player) return null;

        player = new window.Spotify.Player({
            name: 'HiFi Buddy',
            getOAuthToken: cb => {
                const t = HiFiBuddySettings.getSpotifyAccessToken();
                if (t) cb(t);
            },
            volume: 0.85,
        });

        player.addListener('ready', ({ device_id }) => {
            deviceId = device_id;
            playerReady = true;
            console.log('[Spotify SDK] Player ready, device:', device_id);
            window.dispatchEvent(new CustomEvent('hifibuddy-spotify-player-ready'));
        });
        player.addListener('not_ready', ({ device_id }) => {
            console.log('[Spotify SDK] Device offline:', device_id);
            playerReady = false;
        });
        player.addListener('initialization_error', e => {
            console.warn('[Spotify SDK] init error:', e.message);
            _toastIfNew('sdk:init', {
                type: 'error',
                message: 'Spotify player failed to initialize. Try a different browser or disable ad-blockers.',
                details: e?.message || '',
            });
        });
        player.addListener('authentication_error', e => {
            console.warn('[Spotify SDK] auth error:', e.message);
            // Token is stale — clear so user can re-auth
            HiFiBuddySettings.clearSpotifyTokens();
            playerReady = false;
            _toastIfNew('sdk:auth', {
                type: 'error',
                message: 'Spotify token rejected. Reconnect Spotify in Settings.',
                action: { label: 'Open Settings', onClick: _openSettings },
                details: e?.message || '',
            });
        });
        player.addListener('account_error', e => {
            console.warn('[Spotify SDK] account error (Premium required?):', e.message);
            _toastIfNew('sdk:account', {
                type: 'error',
                message: 'Spotify Premium required for in-browser playback. Free tier will not work.',
                details: e?.message || '',
            });
        });
        player.addListener('playback_error', e => {
            console.warn('[Spotify SDK] playback error:', e.message);
            _toastIfNew('sdk:playback', {
                type: 'error',
                message: 'Spotify playback error. Try another track or restart the player.',
                details: e?.message || '',
            });
        });
        player.addListener('player_state_changed', state => {
            playerListeners.forEach(fn => { try { fn(state); } catch { /* ignore */ } });
        });

        const ok = await player.connect();
        if (!ok) {
            console.warn('[Spotify SDK] connect() returned false');
            return null;
        }
        return player;
    }

    function isPlayerReady() {
        return playerReady && !!deviceId && !!player;
    }

    function isPremiumReady() {
        return isConnected() && hasStreamingScope() && isPlayerReady();
    }

    function addPlayerListener(fn) {
        playerListeners.add(fn);
        return () => playerListeners.delete(fn);
    }

    async function getCurrentState() {
        if (!player) return null;
        try { return await player.getCurrentState(); } catch { return null; }
    }

    // Play a track URI at a specific position. Uses /me/player/play (PUT) targeting our SDK device.
    async function playTrackUri(uri, positionMs = 0) {
        if (!isPremiumReady()) return false;
        const token = HiFiBuddySettings.getSpotifyAccessToken();
        if (!token) return false;
        try {
            const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ uris: [uri], position_ms: positionMs }),
            });
            // 204 No Content = success; 202 = accepted
            if (res.status === 204 || res.status === 202) return true;
            console.warn('[Spotify SDK] play failed:', res.status);
            return false;
        } catch (e) {
            console.warn('[Spotify SDK] play error:', e);
            return false;
        }
    }

    async function seek(positionMs) {
        if (!player) return false;
        try { await player.seek(positionMs); return true; } catch { return false; }
    }

    async function pause() {
        if (!player) return false;
        try { await player.pause(); return true; } catch { return false; }
    }

    async function resume() {
        if (!player) return false;
        try { await player.resume(); return true; } catch { return false; }
    }

    // === Spotify Connect: device list + transfer ===

    async function listDevices() {
        if (!isConnected()) return [];
        const data = await apiCall('/me/player/devices');
        return data?.devices || [];
    }

    async function transferPlayback(targetDeviceId, play = true) {
        if (!isConnected() || !targetDeviceId) return false;
        const token = HiFiBuddySettings.getSpotifyAccessToken();
        try {
            const res = await fetch('https://api.spotify.com/v1/me/player', {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ device_ids: [targetDeviceId], play }),
            });
            return res.status === 204 || res.status === 202;
        } catch (e) {
            console.warn('[Spotify] transferPlayback error:', e);
            return false;
        }
    }

    function getCurrentDeviceId() { return deviceId; }

    return {
        init, isConnected, autoConnect, startPKCEAuth, connectClientCredentials,
        searchArtist, searchTrack, searchAlbum, getRelatedArtists, getArtistTopTracks, getAudioFeatures,
        isApiAvailable, getSpotifyTrackUrl, getSpotifyAlbumUrl, getSpotifySearchUrl,
        renderSpotifyLink, renderPlayButton, bindPlayButtons,
        // SDK
        ensureSDK, initPlayer, isPlayerReady, isPremiumReady, hasStreamingScope,
        addPlayerListener, getCurrentState, playTrackUri, seek, pause, resume,
        listDevices, transferPlayback, getCurrentDeviceId,
        // Cross-browser helpers (exposed for callers that want to surface
        // a fallback message before kicking off OAuth).
        isLikelyMobile, isPlaybackSDKSupported,
        // Diagnostics: read scopes for the diagnostics panel.
        getScopes: () => (typeof HiFiBuddySettings !== 'undefined' && HiFiBuddySettings.getSpotifyTokenScopes?.()) || '',
    };
})();

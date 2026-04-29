/**
 * HiFi Buddy — Service Worker
 *
 * Strategy:
 *   - Network-first for HTML/JS/CSS (fresh code on every reload)
 *   - Cache-first for data files (offline access to lessons + clip library)
 *   - Network-only for /api/ proxy calls
 */
const CACHE_NAME = 'hifibuddy-v5';
const PRECACHE_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/data/hifi-guide.json',
    '/data/reference-clips.json',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(PRECACHE_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

function isCodeAsset(url) {
    return url.pathname === '/'
        || url.pathname.endsWith('.html')
        || url.pathname.endsWith('.js')
        || url.pathname.endsWith('.css');
}

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);

    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(event.request).catch(() => new Response(
                JSON.stringify({ error: 'offline' }),
                { headers: { 'Content-Type': 'application/json' } }
            ))
        );
        return;
    }

    if (isCodeAsset(url) && url.origin === self.location.origin) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
                    return response;
                })
                .catch(() => caches.match(event.request).then(cached => cached || (
                    event.request.mode === 'navigate' ? caches.match('/index.html') : new Response('Offline', { status: 503 })
                )))
        );
        return;
    }

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                if (response.ok && url.origin === self.location.origin) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            });
        }).catch(() => {
            if (event.request.mode === 'navigate') return caches.match('/index.html');
        })
    );
});

self.addEventListener('message', event => {
    if (event.data === 'skipWaiting') self.skipWaiting();
});

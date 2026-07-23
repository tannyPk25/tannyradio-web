/* TannyRadio Service Worker
 * Strategie:
 *  - app shell (same-origin static): cache-first, ca aplicația să pornească instant / offline
 *  - navigare (HTML): network-first cu fallback la cache (updates propagă, dar merge și offline)
 *  - stream-uri, API-uri, logo-uri, CDN, fonturi (cross-origin): fără cache, doar network
 * Bump versiunea ca să invalidezi cache-ul vechi la fiecare release de shell.
 */
const CACHE = 'tannyradio-v1';
const SHELL = ['/', '/index.html', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Cross-origin (stream-uri media, API radio/iptv, logo-uri, hls.js CDN, Google Fonts):
  // lăsăm browserul să gestioneze direct — nu cache-uim conținut dinamic/media.
  if (!sameOrigin) return;

  // Navigare HTML: network-first ca să prindem update-urile, fallback la cache offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // Restul asset-urilor same-origin: cache-first, populăm cache-ul la prima cerere.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
    })
  );
});

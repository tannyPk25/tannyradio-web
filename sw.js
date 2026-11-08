/* TMedia Service Worker
 * Strategie:
 *  - app shell (same-origin static): stale-while-revalidate — pornește instant din cache,
 *    dar se actualizează în fundal (altfel CSS-ul nou nu ajungea la useri până la bump de versiune)
 *  - navigare (HTML): network-first cu fallback la cache (updates propagă, dar merge și offline)
 *  - stream-uri, API-uri, logo-uri, CDN, fonturi (cross-origin): fără cache, doar network
 * Bump versiunea ca să invalidezi cache-ul vechi la fiecare release de shell.
 */
const CACHE = 'tmedia-v11';
const SHELL = [
  '/', '/index.html', '/app.css', '/app.js', '/design-refresh.css', '/manifest.json', '/icon.svg',
  '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
];

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

  // Date care se schimbă des (ghid TV, versiunea aplicației): mereu din rețea, cache doar offline
  if (url.pathname.startsWith('/epg/') || url.pathname === '/version.json') {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Navigare HTML: network-first ca să prindem update-urile, fallback la cache offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Cache-uim doar răspunsuri valide (nu pagini 404/500 ca „index")
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // Restul asset-urilor same-origin: stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        }).catch(() => cached);
        if (cached) { event.waitUntil(network.then(() => {})); return cached; }
        return network;
      })
    )
  );
});

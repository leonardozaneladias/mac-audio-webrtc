/* Mac Audio — service worker (app shell offline; network-first) */
const CACHE = 'ma-v4';
const ASSETS = [
  '/', '/listen', '/broadcast', '/style.css', '/common.js',
  '/listen.js', '/broadcast.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const u = new URL(req.url);
  // Não interfere em métodos não-GET, outras origens, nem no /ice (autenticação).
  if (req.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/ice')) return;
  // Network-first: sempre tenta a rede (conteúdo fresco), cai pro cache se offline.
  e.respondWith(
    fetch(req).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return resp;
    }).catch(() => caches.match(req).then((r) => r || caches.match('/listen')))
  );
});

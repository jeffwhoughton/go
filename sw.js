/* Service worker: precache the whole app (including the 6 MB network) so the
   game works with no connection at all. */
const CACHE = 'go-katago-v4';
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './css/style.css',
  './js/goban.js', './js/features.js', './js/engine.js', './js/ui.js',
  './js/store.js', './js/app.js',
  './js/vendor/tf.min.js', './js/vendor/tf-backend-wasm.min.js',
  './js/vendor/tfjs-backend-wasm.wasm',
  './js/vendor/tfjs-backend-wasm-simd.wasm',
  './js/vendor/tfjs-backend-wasm-threaded-simd.wasm',
  './model/model.json',
  './model/group1-shard1of2.bin',
  './model/group1-shard2of2.bin',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(ASSETS.map(u => c.add(u).catch(err => console.warn('skip', u, err))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith((async () => {
    const hit = await caches.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res && res.ok && new URL(e.request.url).origin === location.origin) {
        const c = await caches.open(CACHE);
        c.put(e.request, res.clone());
      }
      return res;
    } catch (err) {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
      throw err;
    }
  })());
});

// Service worker de Plateau.
// - Application + données : préchargées à l'installation, servies depuis le cache (cache-first).
//   Chaque déploiement change BUILD (remplacé par le workflow) : nouveau cache, anciennes données purgées.
// - CDN (transformers.js, runtime ONNX, polices) : mis en cache à la première utilisation.
// - Poids du modèle (Hugging Face) : non interceptés, transformers.js les met déjà en cache lui-même.
const BUILD = '__BUILD__';
const SHELL_CACHE = `plateau-${BUILD}`;
const CDN_CACHE = 'plateau-cdn-v1';

const REQUIRED = ['./', 'index.html', 'style.css', 'app.js', 'core.js', 'worker.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'data/products.json',
  ...['utensils', 'milk', 'refresh-cw', 'arrow-right', 'arrow-left', 'minus', 'plus', 'search', 'check', 'selection-on', 'selection-off']
    .map((n) => `icons/ui/${n}.svg`)];
const OPTIONAL = ['data/vectors.bin', 'data/vectors.meta.json']; // absents = recherche par mots seulement
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(REQUIRED);
    await Promise.allSettled(OPTIONAL.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== SHELL_CACHE && key !== CDN_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

async function cdnFirst(request) {
  const cache = await caches.open(CDN_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const hit = await caches.match(request, { ignoreSearch: true });
      if (hit) return hit;
      try { return await fetch(request); }
      catch (err) {
        if (request.mode === 'navigate') return (await caches.match('./')) ?? Response.error();
        throw err;
      }
    })());
  } else if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cdnFirst(request));
  }
});

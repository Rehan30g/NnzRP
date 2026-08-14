/**
 * NnzRP service worker - PWA installability + offline app-shell caching for
 * the web/Android build only (never registered inside Electron - see the
 * guarded registration in index.html).
 *
 * Strategy: stale-while-revalidate for every same-origin GET request, rather
 * than a hardcoded precache list. The app has ~40+ ES module files under js/
 * with plain relative imports (no cache-busting query strings on those,
 * unlike the top-level <script>/<link> tags in index.html) - hardcoding all
 * of them here would be a second file-list to keep in sync with js/**, which
 * WILL drift. Caching opportunistically as each file is actually requested
 * means new/renamed modules just work with zero changes to this file.
 *
 * Cross-origin requests (BYOK provider calls, HTTP MCP servers) and non-GET
 * requests are never intercepted - only ever hit the real network.
 */

// Bump only on structural changes (e.g. this file's own strategy changing),
// not per app file edit - stale-while-revalidate already keeps cached files
// fresh on the next load after any change.
const CACHE_NAME = 'nnzrp-shell-v1';

const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      if (cached) {
        // Serve the cached copy instantly; let the network response update
        // the cache in the background for next time.
        event.waitUntil(networkFetch);
        return cached;
      }

      const fresh = await networkFetch;
      if (fresh) return fresh;
      // Offline + never cached (e.g. first-ever load of a route with no
      // connectivity) - fall back to the app shell so navigations don't hard-fail.
      if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return new Response('Offline and not cached.', { status: 503, statusText: 'Offline' });
    })
  );
});

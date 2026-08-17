/**
 * Zero-dependency static file server for running NnzRP as a web app (PWA
 * install target for Android, or plain-browser testing) - no bundler, no
 * backend, mirrors the app's own "100% client-side" design instead of
 * pulling in a package like http-server/serve for this.
 *
 * Usage: npm run serve  (then point a device at http://<this-pc-lan-ip>:8787
 * or a tunnel like `cloudflared tunnel --url http://localhost:8787` for a
 * real HTTPS URL, which the service worker and PWA install both require).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

// These three must never be served from an intermediate cache (browser or
// otherwise) - the service worker and manifest updates, and any fix to
// index.html itself, need to reach the client on the very next request.
const NO_CACHE_FILES = new Set(['/index.html', '/manifest.json', '/sw.js']);

/**
 * Live-reload: this dev server only, never the real GitHub Pages deploy or
 * the Electron/APK builds - just an SSE endpoint + a small watcher, no new
 * dependency, matching this file's own "zero-dependency" design. A connected
 * page gets a `reload` event over `/__livereload` whenever a project file
 * changes on disk, instead of needing a manual pull-to-refresh on the phone
 * after every edit.
 */
const liveReloadClients = new Set();
const LIVE_RELOAD_SCRIPT = `
<script>
(function () {
  var es = new EventSource('/__livereload');
  es.onmessage = function (e) { if (e.data === 'reload') location.reload(); };
})();
</script>
`;

function broadcastReload() {
  for (const res of liveReloadClients) res.write('data: reload\n\n');
}

// Top-level dirs that would otherwise spam the watcher with irrelevant churn
// (VCS internals, build output, native Android project, py tooling venv) -
// see CLAUDE.md's directory sitemap for what each of these actually is.
const WATCH_IGNORE = new Set(['.git', 'node_modules', 'android', 'dist', 'venv']);
let reloadTimer = null;
try {
  fs.watch(ROOT, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    const topLevel = filename.split(/[\\/]/)[0];
    if (WATCH_IGNORE.has(topLevel)) return;
    // Debounced: an editor save can fire several fs events for one logical
    // change, and this would otherwise reload connected clients once per event.
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      console.log(`[live-reload] ${filename} changed - reloading connected clients`);
      broadcastReload();
    }, 150);
  });
} catch (err) {
  // recursive fs.watch isn't available on every platform (reliable on
  // Windows/macOS, not Linux) - live-reload just silently doesn't fire rather
  // than crashing the whole dev server over a QoL feature.
  console.warn('[live-reload] file watching unavailable:', err.message);
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  if (urlPath === '/__livereload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('\n');
    liveReloadClients.add(res);
    req.on('close', () => liveReloadClients.delete(res));
    return;
  }

  const resolved = path.normalize(path.join(ROOT, urlPath));
  // Reject any path that escapes ROOT (e.g. "../../secret").
  if (!resolved.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + urlPath);
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const headers = { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' };
    // DEV_NO_CACHE=1 disables all caching (including for the app's own JS
    // modules, which have no cache-busting query strings - see sw.js's own
    // comment on why not) - for iterating locally without fighting stale
    // browser/HTTP cache on every edit. Never set this for real deployments.
    // `no-store` (not `no-cache`) deliberately - `no-cache` still lets the
    // browser keep a cached copy and merely requires it to revalidate first,
    // which mobile Chrome doesn't always do reliably without a Last-Modified/
    // ETag on the response; `no-store` forbids caching it at all.
    headers['Cache-Control'] = (process.env.DEV_NO_CACHE === '1' || NO_CACHE_FILES.has(urlPath))
      ? 'no-store'
      : 'public, max-age=3600';

    // Only index.html ever gets the live-reload client script injected - it's
    // the one page actually loaded/navigated to; the ES modules and CSS it
    // pulls in don't need their own copy.
    if (urlPath === '/index.html') {
      const html = data.toString('utf8').replace('</body>', `${LIVE_RELOAD_SCRIPT}</body>`);
      res.writeHead(200, headers);
      res.end(html);
      return;
    }

    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NnzRP static server running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://<this-pc-lan-ip>:${PORT}  (for other devices on the same Wi-Fi)`);
  console.log('');
  console.log('Live-reload is on - connected pages auto-refresh whenever a project file changes.');
  console.log('');
  console.log('For a real HTTPS URL an Android phone can install as a PWA over the internet,');
  console.log(`run in another terminal: cloudflared tunnel --url http://localhost:${PORT}`);
});

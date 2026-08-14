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

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

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
    headers['Cache-Control'] = NO_CACHE_FILES.has(urlPath) ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NnzRP static server running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://<this-pc-lan-ip>:${PORT}  (for other devices on the same Wi-Fi)`);
  console.log('');
  console.log('For a real HTTPS URL an Android phone can install as a PWA over the internet,');
  console.log(`run in another terminal: cloudflared tunnel --url http://localhost:${PORT}`);
});

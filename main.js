const { app, BrowserWindow, shell, Menu, ipcMain, nativeTheme, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, fork } = require('child_process');
const { autoUpdater } = require('electron-updater');

// Remove default menu bar for clean custom header app design
Menu.setApplicationMenu(null);

// Convert icon to embedded base64 for instant zero-delay loading in splash screen
let iconBase64 = '';
try {
  const iconPath = path.join(__dirname, 'src', 'icon_256.png');
  if (fs.existsSync(iconPath)) {
    iconBase64 = 'data:image/png;base64,' + fs.readFileSync(iconPath).toString('base64');
  }
} catch (e) {
  console.warn('Failed to load splash icon base64:', e);
}

// Mirrors css/variables.css's light/dark tokens so the MAIN window's own
// backgroundColor never clashes with the theme the renderer is about to boot
// into. nativeTheme is synchronously available in the main process (no
// IndexedDB/localStorage round-trip needed, unlike the renderer's pre-paint
// bootstrap in index.html), so this is a one-time read at launch, not a live
// listener.
//
// The splash window deliberately does NOT follow this: it is a fixed
// near-black, monochrome loading screen (see SPLASH below) whose whole
// identity is a dark full-bleed hero panel with white type over it. A light
// inversion of that would not be the same design, and unlike the main window
// there is nothing behind the splash for it to clash with.
const dark = nativeTheme.shouldUseDarkColors;
const palette = dark
  ? { bg: '#0b1220', surface: '#131c2e', border: '#24304a', text: '#e8ecf3', dim: '#8595ab', from: '#fbbf24', to: '#f59e0b' }
  : { bg: '#f1f5f9', surface: '#ffffff', border: '#e2e8f0', text: '#0f172a', dim: '#64748b', from: '#f59e0b', to: '#d97706' };

// Fixed dark splash palette. `bg` MUST stay in sync with the splash
// BrowserWindow's `backgroundColor` option so there is no flash of a
// different colour before the inline HTML paints.
const SPLASH = {
  bg: '#0b0b0c', // window body - the single flat panel (no nested card)
  text: '#f5f5f5',
  dim: '#8a8a8e'
};

function createSplashWindow() {
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, 'src', 'icon.ico')
    : path.join(__dirname, 'src', 'icon.png');

  const splash = new BrowserWindow({
    // 1.7:1: a full-bleed hero image column on the left, title + loading
    // status on the right. A square-ish 440x360 cannot hold that split
    // without cramping either half.
    width: 680,
    height: 400,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    center: true,
    show: true,
    resizable: false,
    icon: iconPath,
    backgroundColor: SPLASH.bg,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Self-contained inline document - this is a bare data: URL, so it has no
  // access to the app's css/ stylesheets. Everything (including the logo, via
  // the already-embedded iconBase64) must live in this string.
  //
  // Design notes / things previously rejected by the user, do not undo:
  //  - <body> itself is the single flat panel painted in SPLASH.bg (same as
  //    the BrowserWindow backgroundColor). No nested card div with its own
  //    background/border/shadow - in a small opaque frameless window that read
  //    as a "box inside a box". The hero column is full-bleed to the window
  //    edges and fades into the body colour, so it is not a nested box either.
  //  - No heartbeat/pulse (transform: scale) animation anywhere.
  //  - Generous padding; the reference leaves a lot of breathing room.
  const splashHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>NnzRP Loading</title>
      <style>
        * { box-sizing: border-box; }
        html, body { width: 100%; height: 100%; }
        body {
          margin: 0; padding: 0; background: ${SPLASH.bg}; color: ${SPLASH.text};
          font-family: 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', sans-serif;
          display: flex; overflow: hidden;
          user-select: none; -webkit-app-region: drag;
          animation: fadeIn 0.35s ease-out;
        }

        /* ---- Left hero column (the reference's photographic panel) ---- */
        .hero { position: relative; width: 40%; flex: none; overflow: hidden; }
        .hero::before {
          content: ''; position: absolute; inset: -40px;
          background-image: url("${iconBase64}");
          background-size: cover; background-position: center;
          filter: blur(30px) brightness(0.3) saturate(0.65) contrast(1.12);
        }
        .hero::after {
          content: ''; position: absolute; inset: 0;
          background:
            linear-gradient(to bottom, rgba(11,11,12,0.55) 0%, rgba(11,11,12,0) 34%, rgba(11,11,12,0) 62%, rgba(11,11,12,0.6) 100%),
            linear-gradient(100deg, rgba(11,11,12,0.32) 0%, rgba(11,11,12,0.06) 42%, rgba(11,11,12,0.9) 84%, ${SPLASH.bg} 100%);
        }
        .hero-logo {
          position: absolute; top: 50%; left: 50%; margin: -46px 0 0 -52px;
          width: 92px; height: 92px; border-radius: 5px;
          image-rendering: pixelated;
          box-shadow: 0 20px 44px -18px rgba(0,0,0,0.95);
        }

        /* ---- Right content column: purely a loading state, nothing else ---- */
        .panel {
          position: relative; flex: 1 1 auto; min-width: 0;
          padding: 36px 34px 30px 34px;
          display: flex; flex-direction: column; justify-content: center;
        }
        .title {
          margin: 0 0 40px 0; font-size: 30px; font-weight: 800;
          line-height: 1.05; letter-spacing: -0.025em; color: #ffffff;
        }
        .loading-block { display: flex; align-items: center; gap: 18px; }
        .spinner {
          flex: none; width: 30px; height: 30px; border-radius: 50%;
          border: 2.5px solid rgba(255,255,255,0.14); border-top-color: #f0f0f0;
          animation: spin 0.85s linear infinite;
        }
        .loading-text { flex: 1 1 auto; min-width: 0; }
        .loading-title { font-size: 14.5px; font-weight: 700; color: #f2f2f2; letter-spacing: -0.005em; }
        .loading-sub { font-size: 12px; color: ${SPLASH.dim}; margin-top: 4px; }
        .dot { display: inline-block; opacity: 0.2; animation: dotFade 1.4s ease-in-out infinite; }
        .dot:nth-child(2) { animation-delay: 0.2s; }
        .dot:nth-child(3) { animation-delay: 0.4s; }

        /* Thin monochrome loading bar pinned to the very bottom edge. */
        .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,0.07); overflow: hidden; }
        .progress span {
          position: absolute; top: 0; bottom: 0; width: 34%;
          background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.75) 50%, rgba(255,255,255,0) 100%);
          animation: sweep 1.5s ease-in-out infinite;
        }

        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes sweep { 0% { left: -34%; } 100% { left: 100%; } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes dotFade { 0%, 60%, 100% { opacity: 0.2; } 30% { opacity: 1; } }
      </style>
    </head>
    <body>
      <div class="hero">
        <img src="${iconBase64}" class="hero-logo" alt="NnzRP">
      </div>
      <div class="panel">
        <h1 class="title">NnzRP<br>Roleplay Studio</h1>

        <div class="loading-block">
          <div class="spinner"></div>
          <div class="loading-text">
            <div class="loading-title">Memuat Aplikasi<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></div>
            <div class="loading-sub">Menyiapkan modul, tema &amp; database lokal</div>
          </div>
        </div>

        <div class="progress"><span></span></div>
      </div>
    </body>
    </html>
  `;

  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHTML));
  return splash;
}

function createWindow() {
  const splash = createSplashWindow();

  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, 'src', 'icon.ico')
    : path.join(__dirname, 'src', 'icon.png');

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    // Generic fallback for the brief moment before the renderer's first
    // navigate() runs. The real title is "NnzRP - <view / character>", set from
    // js/app.js via document.title (Electron mirrors it to taskbar/alt-tab).
    title: 'NnzRP',
    icon: iconPath,
    frame: false, // Frameless window for custom header titlebar
    autoHideMenuBar: true,
    backgroundColor: palette.bg,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      // Chromium's default background throttling delays requestAnimationFrame
      // and timers heavily once the window loses focus/visibility - exactly
      // when a user alt-tabs away while a chat response is streaming. Without
      // this, streaming text can appear to stall/catch-up in bursts purely
      // from window focus state, unrelated to actual network/provider speed.
      backgroundThrottling: false
    }
  });

  // Handle F11 key shortcut for Fullscreen toggle
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    }
  });

  // Handle external link clicks to open in default OS browser. This only
  // covers window.open()/target="_blank"/middle-click-new-window - a plain
  // <a href> click (or the browser's built-in autolinking of a bare URL in
  // AI/character chat text, e.g. an image link) navigates the CURRENT
  // window instead, which setWindowOpenHandler never sees. See the
  // will-navigate handler right below for that case - both are needed.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Same-window navigation guard. Without this, clicking ANY link rendered
  // inside chat content (a markdown link, an auto-linked bare image URL the
  // AI wrote, etc.) navigates this window itself to that URL - Chromium's
  // default handling of a direct navigation to an image resource is to
  // render it full-page. This is a frameless single-BrowserWindow app with
  // no back/forward/address-bar UI, so that navigation had no way back short
  // of restarting the app. The only legitimate navigation is this window's
  // own initial `loadFile(index.html)` - everything else gets redirected to
  // the OS's default browser instead of replacing the app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://') && url.includes('index.html')) return;
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
  });

  // Smooth transition from Splash window to Main window
  mainWindow.once('ready-to-show', () => {
    setTimeout(() => {
      if (splash && !splash.isDestroyed()) splash.destroy();
      mainWindow.show();
    }, 250);
  });

  // Load local HTML file
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  return mainWindow;
}

/* -----------------------------------------------------------------------
 * Custom MCP (Model Context Protocol) stdio server bridge.
 *
 * Trust boundary: `command`/`args`/`env` here are always the user's own MCP
 * settings-UI configuration (never model output) - the model can only later
 * ask to call an already-listed tool by name with JSON arguments, which get
 * written to this already-running process's stdin, never to spawn().
 * ---------------------------------------------------------------------- */
const mcpProcesses = new Map(); // serverId -> { proc, pending: Map<reqId,{resolve,reject,timer}>, buffer, nextId }
const MCP_REQUEST_TIMEOUT_MS = 15000;
// `tools/call` is the one method that legitimately runs for minutes (browser
// navigation, web search, a long shell task). Handshake/discovery calls keep
// the short timeout so a dead server is still detected quickly.
const MCP_TOOL_CALL_TIMEOUT_MS = 180000;
function timeoutForMethod(method) {
  return method === 'tools/call' ? MCP_TOOL_CALL_TIMEOUT_MS : MCP_REQUEST_TIMEOUT_MS;
}

function startMcpProcess({ id, command, args, env }) {
  if (mcpProcesses.has(id)) return { started: false, alreadyRunning: true };
  if (!command || typeof command !== 'string') throw new Error('MCP server is missing a command to run.');

  const proc = spawn(command, Array.isArray(args) ? args : [], {
    env: { ...process.env, ...(env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    // Resolves .cmd shims (e.g. npx.cmd) on Windows - command/args are always
    // user-authored config from the MCP settings UI, never model output.
    shell: process.platform === 'win32'
  });

  const entry = { proc, pending: new Map(), buffer: '', nextId: 1 };
  mcpProcesses.set(id, entry);

  // A write to a process that died between our map check and the write emits
  // an async 'error' (EPIPE) on this stream. With no listener Node throws an
  // uncaught exception and takes the whole Electron main process down; the
  // pending request is already rejected by the 'exit'/'error' handlers below.
  proc.stdin.on('error', (err) => {
    console.warn(`[MCP:${id}] stdin error:`, err.message);
  });

  proc.stdout.on('data', (chunk) => {
    entry.buffer += chunk.toString('utf-8');
    let newlineIdx;
    while ((newlineIdx = entry.buffer.indexOf('\n')) !== -1) {
      const line = entry.buffer.slice(0, newlineIdx).trim();
      entry.buffer = entry.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON-RPC stdout noise some servers print on startup
      }
      if (msg.id !== undefined && entry.pending.has(msg.id)) {
        const { resolve, reject, timer } = entry.pending.get(msg.id);
        clearTimeout(timer);
        entry.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'MCP server returned an error.'));
        else resolve(msg.result);
      }
      // Messages with unmatched/no id (e.g. server-initiated notifications) are intentionally ignored.
    }
  });

  proc.stderr.on('data', (chunk) => {
    console.warn(`[MCP:${id}] stderr:`, chunk.toString('utf-8').trim());
  });

  proc.on('exit', (code) => {
    console.warn(`[MCP:${id}] process exited (code ${code}).`);
    for (const { reject, timer } of entry.pending.values()) {
      clearTimeout(timer);
      reject(new Error('MCP server process exited before responding.'));
    }
    mcpProcesses.delete(id);
  });

  proc.on('error', (err) => {
    console.error(`[MCP:${id}] failed to start:`, err.message);
    for (const { reject, timer } of entry.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    mcpProcesses.delete(id);
  });

  return { started: true };
}

function stopMcpProcess(id) {
  const entry = mcpProcesses.get(id);
  if (!entry) return;
  for (const { reject, timer } of entry.pending.values()) {
    clearTimeout(timer);
    reject(new Error('MCP server stopped.'));
  }
  // On Windows we spawn through a shell (to resolve npx.cmd shims), so the pid
  // we hold is cmd.exe - killing it leaves the real node/npx server orphaned.
  // taskkill /T walks the whole process tree.
  if (process.platform === 'win32' && entry.proc.pid) {
    try {
      spawn('taskkill', ['/pid', String(entry.proc.pid), '/f', '/t']);
    } catch {
      entry.proc.kill();
    }
  } else {
    entry.proc.kill();
  }
  mcpProcesses.delete(id);
}

function stopAllMcpProcesses() {
  for (const id of Array.from(mcpProcesses.keys())) stopMcpProcess(id);
}

function sendMcpRequest(id, method, params, isNotification) {
  const entry = mcpProcesses.get(id);
  if (!entry) return Promise.reject(new Error('MCP server is not running.'));

  const payload = { jsonrpc: '2.0', method, params: params || {} };
  if (!isNotification) payload.id = entry.nextId++;

  return new Promise((resolve, reject) => {
    if (!isNotification) {
      const timer = setTimeout(() => {
        entry.pending.delete(payload.id);
        reject(new Error('MCP server request timed out.'));
      }, timeoutForMethod(method));
      entry.pending.set(payload.id, { resolve, reject, timer });
    }
    try {
      entry.proc.stdin.write(JSON.stringify(payload) + '\n');
      if (isNotification) resolve(null);
    } catch (err) {
      const pending = entry.pending.get(payload.id);
      if (pending) {
        clearTimeout(pending.timer);
        entry.pending.delete(payload.id);
      }
      reject(err);
    }
  });
}

ipcMain.handle('mcp:start', (event, config) => startMcpProcess(config || {}));
ipcMain.handle('mcp:stop', (event, id) => {
  stopMcpProcess(id);
  return true;
});
ipcMain.handle('mcp:request', (event, { id, method, params, isNotification } = {}) => {
  return sendMcpRequest(id, method, params, isNotification);
});

app.on('before-quit', stopAllMcpProcesses);

/* -----------------------------------------------------------------------
 * Electron-only plugin system.
 *
 * Same trust shape as the MCP stdio bridge above: renderer -> narrow typed
 * pluginHostAPI (preload) -> these ipcMain handlers -> per-permission
 * broker. Nothing here is a generic passthrough. Every filesystem path is
 * scoped to  app.getPath('userData')/plugins/<pluginId>/  and rejects path
 * traversal ('..' / absolute / separators in an id).
 *
 * Installed plugins live EXTRACTED (not zipped) under that directory.
 * Bundled plugin SOURCES ship in the repo at  plugins/<name>/  and are
 * packaged by electron-builder as  resources/bundled-plugins/  (see
 * package.json build.extraResources). seedBundledPlugins() copies each into
 * userData on first launch and NEVER overwrites an existing install;
 * enable-state is the renderer's concern (default disabled).
 * ---------------------------------------------------------------------- */
const PLUGIN_PERMISSIONS = ['network', 'storage', 'child_process', 'fs-read', 'fs-write'];

function getPluginsDir() {
  return path.join(app.getPath('userData'), 'plugins');
}

// A plugin id is reverse-DNS-ish AND is the on-disk directory name, so it
// must never carry a path separator, a '..' segment, or be absolute.
function isValidPluginId(id) {
  if (!id || typeof id !== 'string') return false;
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return false;
  if (path.isAbsolute(id)) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
}

// A manifest-declared relative path (renderer/backend/icon) must stay inside
// the plugin dir - no absolute path, drive letter, or '..' segment.
function isSafeRelPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  return !rel.replace(/\\/g, '/').split('/').includes('..');
}

function validatePluginManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('plugin.json is not a valid object.');
  if (!isValidPluginId(manifest.id)) {
    throw new Error('plugin.json has a missing or invalid "id" (reverse-DNS, no path separators or "..").');
  }
  if (!manifest.name || typeof manifest.name !== 'string') throw new Error('plugin.json is missing a valid "name".');
  if (!manifest.version || typeof manifest.version !== 'string') throw new Error('plugin.json is missing a valid "version".');

  let permissions = [];
  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions)) throw new Error('plugin.json "permissions" must be an array.');
    for (const p of manifest.permissions) {
      if (!PLUGIN_PERMISSIONS.includes(p)) throw new Error('plugin.json "permissions" has an unknown entry: ' + p);
    }
    permissions = manifest.permissions.slice();
  }

  const renderer = manifest.renderer || 'renderer/index.js';
  for (const rel of [renderer, manifest.backend, manifest.icon]) {
    if (rel !== undefined && rel !== null && !isSafeRelPath(rel)) {
      throw new Error('plugin.json has a relative path that escapes the plugin directory: ' + rel);
    }
  }
  return {
    ...manifest,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    permissions,
    renderer
  };
}

// Resolve a real, symlink-followed path and assert it stays inside the
// plugin's own directory. Throws otherwise.
function resolveInsidePlugin(id, relPath) {
  if (!isValidPluginId(id)) throw new Error('Invalid plugin id.');
  const pluginDir = path.join(getPluginsDir(), id);
  let baseReal;
  try {
    baseReal = fs.realpathSync(pluginDir);
  } catch {
    throw new Error('Plugin is not installed: ' + id);
  }
  const joined = path.resolve(baseReal, relPath || '.');
  let targetReal;
  try {
    targetReal = fs.realpathSync(joined);
  } catch {
    throw new Error('File not found in plugin "' + id + '": ' + relPath);
  }
  if (targetReal !== baseReal && !targetReal.startsWith(baseReal + path.sep)) {
    throw new Error('Path escapes the plugin directory.');
  }
  return targetReal;
}

// Per-plugin WRITABLE data directory, kept OUTSIDE plugins/<id>/ so that
// reinstalling / updating a plugin package (which wipes and re-extracts
// plugins/<id>/) never destroys user-created files a plugin stored here
// (e.g. uploaded voice-clone .wav files). Only an explicit uninstall removes it.
function getPluginDataDir(id) {
  if (!isValidPluginId(id)) throw new Error('Invalid plugin id.');
  return path.join(app.getPath('userData'), 'plugin-data', id);
}

// Resolve a path inside a plugin's data dir. Unlike resolveInsidePlugin the
// target need not exist yet (writes), and the base dir is created on demand.
// Still asserts containment against the realpath'd base.
function resolveInsidePluginData(id, relPath, { forWrite = false } = {}) {
  const baseDir = getPluginDataDir(id);
  fs.mkdirSync(baseDir, { recursive: true });
  const baseReal = fs.realpathSync(baseDir);
  if (!isSafeRelPath(relPath)) throw new Error('Invalid asset path.');
  const joined = path.resolve(baseReal, relPath);
  if (joined !== baseReal && !joined.startsWith(baseReal + path.sep)) {
    throw new Error('Asset path escapes the plugin data directory.');
  }
  if (forWrite) fs.mkdirSync(path.dirname(joined), { recursive: true });
  return joined;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data || []);
}

function listInstalledPlugins() {
  const dir = getPluginsDir();
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const pdir = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(pdir, 'plugin.json'), 'utf-8'));
      out.push({ id: parsed.id || name, manifest: validatePluginManifest(parsed), path: pdir });
    } catch (e) {
      out.push({ id: name, manifest: null, path: pdir, error: (e && e.message) || String(e) });
    }
  }
  return out;
}

function installPlugin(zipPath) {
  if (!zipPath || typeof zipPath !== 'string') throw new Error('No plugin archive path was provided.');
  const AdmZip = require('adm-zip');
  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch (e) {
    throw new Error('Could not open plugin archive: ' + ((e && e.message) || e));
  }
  const entries = zip.getEntries();
  if (!entries.length) throw new Error('Plugin archive is empty.');

  const norm = (s) => s.replace(/\\/g, '/');

  // plugin.json at the archive root, or inside a SINGLE top-level folder.
  let manifestEntry = entries.find((e) => norm(e.entryName) === 'plugin.json');
  let prefix = '';
  if (!manifestEntry) {
    const tops = new Set(entries.map((e) => norm(e.entryName).split('/')[0]).filter(Boolean));
    if (tops.size === 1) {
      const folder = Array.from(tops)[0];
      manifestEntry = entries.find((e) => norm(e.entryName) === folder + '/plugin.json');
      prefix = folder + '/';
    }
  }
  if (!manifestEntry) {
    throw new Error('Plugin archive has no plugin.json at its root or inside a single top-level folder.');
  }

  let manifest;
  try {
    manifest = JSON.parse(zip.readAsText(manifestEntry));
  } catch (e) {
    throw new Error('plugin.json is not valid JSON: ' + ((e && e.message) || e));
  }
  const validated = validatePluginManifest(manifest);
  const targetDir = path.join(getPluginsDir(), validated.id);
  const targetBase = path.resolve(targetDir);

  // Validate EVERY entry path before touching disk.
  const files = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    let rel = norm(e.entryName);
    if (prefix) {
      if (!rel.startsWith(prefix)) continue;
      rel = rel.slice(prefix.length);
    }
    if (!rel) continue;
    if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) {
      throw new Error('Plugin archive entry escapes the target directory: ' + e.entryName);
    }
    const dest = path.resolve(targetBase, rel);
    if (dest !== targetBase && !dest.startsWith(targetBase + path.sep)) {
      throw new Error('Plugin archive entry escapes the target directory: ' + e.entryName);
    }
    files.push({ dest, entry: e });
  }

  // Fresh extraction: wipe any prior install of this id first.
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  for (const f of files) {
    fs.mkdirSync(path.dirname(f.dest), { recursive: true });
    fs.writeFileSync(f.dest, f.entry.getData());
  }
  return { id: validated.id, manifest: validated };
}

function uninstallPlugin(id) {
  if (!isValidPluginId(id)) throw new Error('Invalid plugin id.');
  fs.rmSync(path.join(getPluginsDir(), id), { recursive: true, force: true });
  // Explicit uninstall also drops the plugin's stored data (uploads etc.).
  fs.rmSync(getPluginDataDir(id), { recursive: true, force: true });
}

async function pickPluginZip() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  const opts = {
    properties: ['openFile'],
    filters: [{ name: 'NnzRP Plugin', extensions: ['nnzplugin', 'zip'] }]
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  return res.filePaths[0];
}

// Dotted numeric compare, good enough for plugin `version` strings.
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function seedBundledPlugins() {
  const sourceDir = app.isPackaged
    ? path.join(process.resourcesPath, 'bundled-plugins')
    : path.join(__dirname, 'plugins');
  let names;
  try {
    names = fs.readdirSync(sourceDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return; // nothing bundled
  }
  const destRoot = getPluginsDir();
  try { fs.mkdirSync(destRoot, { recursive: true }); } catch { /* ignore */ }
  for (const name of names) {
    const src = path.join(sourceDir, name);
    let id = name;
    let srcVersion = '0';
    try {
      const m = JSON.parse(fs.readFileSync(path.join(src, 'plugin.json'), 'utf-8'));
      if (m && isValidPluginId(m.id)) id = m.id;
      if (m && m.version) srcVersion = m.version;
    } catch { /* fall back to the directory name */ }
    const dest = path.join(destRoot, id);
    if (fs.existsSync(dest)) {
      // Only refresh when the bundled copy is a NEWER version - keeps a
      // shipped plugin current across app updates without disturbing a
      // user-installed one. Package files only; user data
      // (plugin-data/<id>/) and enable-state (renderer registry) are untouched.
      let instVersion = '0';
      try {
        const im = JSON.parse(fs.readFileSync(path.join(dest, 'plugin.json'), 'utf-8'));
        if (im && im.version) instVersion = im.version;
      } catch { /* treat as ancient */ }
      if (compareVersions(srcVersion, instVersion) <= 0) continue;
      try {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(src, dest, { recursive: true });
        console.log('[plugins] updated bundled plugin:', id, instVersion, '->', srcVersion);
      } catch (e) {
        console.warn('[plugins] failed to update bundled plugin', name, (e && e.message) || e);
      }
      continue;
    }
    try {
      fs.cpSync(src, dest, { recursive: true });
      console.log('[plugins] seeded bundled plugin:', id);
    } catch (e) {
      console.warn('[plugins] failed to seed bundled plugin', name, (e && e.message) || e);
    }
  }
}

/* ---- Plugin backend child-process host (mirrors the MCP manager shape:
 * a Map keyed by id, id-correlated pending promises, IPC instead of
 * newline-delimited stdio JSON-RPC since these children are fork()ed). ---- */
const pluginBackends = new Map(); // id -> { child, pending: Map<seq,{resolve,reject}>, nextId }

function startPluginBackend(id, permissions) {
  if (!isValidPluginId(id)) throw new Error('Invalid plugin id.');
  if (pluginBackends.has(id)) return; // already running
  const pluginDir = path.join(getPluginsDir(), id);
  if (!fs.existsSync(path.join(pluginDir, 'plugin.json'))) throw new Error('Plugin is not installed: ' + id);
  const perms = Array.isArray(permissions) ? permissions.filter((p) => PLUGIN_PERMISSIONS.includes(p)) : [];
  const runnerPath = path.join(__dirname, 'js', 'plugins', 'backendRunner.cjs');

  const child = fork(runnerPath, [pluginDir, JSON.stringify(perms)], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  });
  const entry = { child, pending: new Map(), nextId: 1 };
  pluginBackends.set(id, entry);

  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'rpc-reply') {
      const p = entry.pending.get(msg.id);
      if (!p) return;
      entry.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'Plugin backend RPC failed.'));
    } else if (msg.type === 'event') {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send('plugin-backend:event:' + id, { event: msg.event, data: msg.data });
      }
    }
  });

  child.on('exit', (code) => {
    console.warn('[plugin-backend:' + id + '] exited (code ' + code + ').');
    for (const p of entry.pending.values()) p.reject(new Error('Plugin backend exited before responding.'));
    pluginBackends.delete(id);
  });

  child.on('error', (err) => {
    console.error('[plugin-backend:' + id + '] error:', err.message);
    for (const p of entry.pending.values()) p.reject(err);
    pluginBackends.delete(id);
  });
}

function stopPluginBackend(id) {
  const entry = pluginBackends.get(id);
  if (!entry) return;
  for (const p of entry.pending.values()) p.reject(new Error('Plugin backend stopped.'));
  try { entry.child.kill(); } catch { /* already gone */ }
  pluginBackends.delete(id);
}

function stopAllPluginBackends() {
  for (const id of Array.from(pluginBackends.keys())) stopPluginBackend(id);
}

function requestPluginBackend(id, msg) {
  const entry = pluginBackends.get(id);
  if (!entry) return Promise.reject(new Error('Plugin backend is not running: ' + id));
  const seq = entry.nextId++;
  return new Promise((resolve, reject) => {
    entry.pending.set(seq, { resolve, reject });
    try {
      entry.child.send({ type: 'rpc', id: seq, payload: msg });
    } catch (err) {
      entry.pending.delete(seq);
      reject(err);
    }
  });
}

ipcMain.handle('plugin:listInstalled', () => listInstalledPlugins());
ipcMain.handle('plugin:install', (event, zipPath) => installPlugin(zipPath));
ipcMain.handle('plugin:uninstall', (event, id) => { uninstallPlugin(id); });
ipcMain.handle('plugin:pickZip', () => pickPluginZip());
ipcMain.handle('plugin:readFile', (event, { id, relPath } = {}) =>
  fs.readFileSync(resolveInsidePlugin(id, relPath), 'utf-8'));
ipcMain.handle('plugin:getEntryUrl', (event, { id, relPath } = {}) =>
  require('url').pathToFileURL(resolveInsidePlugin(id, relPath)).href);
ipcMain.handle('plugin:seedBundled', () => { seedBundledPlugins(); });

// Plugin data-dir asset store (userData/plugin-data/<id>/). Scoped + contained
// exactly like the plugin dir handlers; no permission gate (a plugin writing
// files into its OWN sandboxed dir is not an escalation, same as host.storage).
ipcMain.handle('plugin:asset:write', (event, { id, relPath, data } = {}) => {
  const target = resolveInsidePluginData(id, relPath, { forWrite: true });
  const buf = toBuffer(data);
  fs.writeFileSync(target, buf);
  return { path: target, size: buf.length };
});
ipcMain.handle('plugin:asset:read', (event, { id, relPath } = {}) => {
  const buf = fs.readFileSync(resolveInsidePluginData(id, relPath));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});
ipcMain.handle('plugin:asset:list', (event, id) => {
  const baseDir = getPluginDataDir(id);
  if (!fs.existsSync(baseDir)) return [];
  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => {
      const st = fs.statSync(path.join(baseDir, d.name));
      return { name: d.name, size: st.size, mtime: st.mtimeMs };
    });
});
ipcMain.handle('plugin:asset:delete', (event, { id, relPath } = {}) => {
  fs.rmSync(resolveInsidePluginData(id, relPath), { force: true });
});
ipcMain.handle('plugin:asset:path', (event, { id, relPath } = {}) =>
  resolveInsidePluginData(id, relPath));
ipcMain.handle('plugin-backend:start', (event, { id, permissions } = {}) => { startPluginBackend(id, permissions); });
ipcMain.handle('plugin-backend:stop', (event, id) => { stopPluginBackend(id); });
ipcMain.handle('plugin-backend:request', (event, { id, msg } = {}) => requestPluginBackend(id, msg));

app.on('before-quit', stopAllPluginBackends);

// IPC Handlers for Custom Titlebar Window Controls
ipcMain.on('window-minimize', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.minimize();
});

ipcMain.on('window-maximize', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.close();
});

ipcMain.handle('window-is-maximized', () => {
  const win = BrowserWindow.getFocusedWindow();
  return win ? win.isMaximized() : false;
});

/* -----------------------------------------------------------------------
 * Auto-update (electron-updater, Windows NSIS installs only - the zip/
 * portable targets have no installed-in-place file to update).
 *
 * Checks the SAME shared "latest" GitHub Release both build-apk.yml and
 * build-windows.yml already publish every build to (see build-windows.yml's
 * own comment on why they share one release). electron-builder always
 * writes dist/latest.yml + each installer's .blockmap locally regardless of
 * --publish (confirmed with a local `npm run build:exe` - files existed
 * with no GH_TOKEN/publish flag in play at all), so build-windows.yml just
 * uploads those two alongside the installer instead of switching to
 * electron-builder's own --publish flow - that would make electron-builder
 * create its OWN version-tagged release, splitting Windows off from
 * Android's shared "latest" tag/page. electron-updater's GitHub provider
 * resolves whichever release GitHub reports as "latest" by publish
 * recency, which - since this repo only ever publishes to that one release
 * - is always this one regardless of its literal tag name.
 *
 * Silent background download (autoDownload), but NOT a silent install -
 * this asks before restarting so an update can never yank the app out from
 * under whatever the user is mid-typing in a roleplay session. Declining
 * just defers to `autoInstallOnAppQuit`, so it still installs cleanly the
 * next time the user closes the app on their own.
 * ---------------------------------------------------------------------- */
function setupAutoUpdater(mainWindow) {
  // Unpackaged dev runs (`npm start`) have no packaged update feed to check
  // (no app-update.yml in an unbuilt tree) and electron-updater logs a noisy
  // error if asked anyway - skip entirely rather than suppress that error.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.warn('[auto-update] error:', err?.message || err);
  });

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `NnzRP ${info.version} has been downloaded.`,
      detail: 'Restart now to install it, or it will install automatically the next time you close the app.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  // Never blocks/crashes app boot on a missing release, rate limit, or
  // offline launch - a failed check is silently skipped, same "must never
  // block startup" rule the MCP tool-cache warm-up (js/app.js) follows.
  autoUpdater.checkForUpdates().catch((err) => {
    console.warn('[auto-update] check failed:', err?.message || err);
  });
}

// Single-instance lock. Chromium storage (IndexedDB/LevelDB) is locked per
// userData directory - a second app instance pointing at the same
// %APPDATA%\<name> profile makes the renderer's very first `indexedDB.open()`
// fail with "UnknownError: Internal error" (the boot-time fatal screen). With
// the lock, a second launch instead focuses the existing window and exits.
// Must run BEFORE any window/storage is created, not inside whenReady().
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    seedBundledPlugins();
    const mainWindow = createWindow();
    setupAutoUpdater(mainWindow);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

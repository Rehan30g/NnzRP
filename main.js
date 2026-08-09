const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

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

function createSplashWindow() {
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, 'src', 'icon.ico')
    : path.join(__dirname, 'src', 'icon.png');

  const splash = new BrowserWindow({
    width: 400,
    height: 280,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    center: true,
    show: true,
    resizable: false,
    icon: iconPath,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  const splashHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>NnzRP Loading</title>
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; padding: 0; background: #ffffff; font-family: 'Segoe UI', system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; user-select: none; }
        .splash-card { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 1.5rem; }
        .logo-box { width: 64px; height: 64px; background: #f1f5f9; border-radius: 16px; display: flex; align-items: center; justify-content: center; margin-bottom: 1rem; border: 1px solid #e2e8f0; }
        .logo-img { width: 48px; height: 48px; object-fit: contain; }
        .title { font-size: 1.35rem; font-weight: 700; color: #0f172a; margin: 0 0 0.75rem 0; letter-spacing: -0.02em; }
        .spinner { width: 28px; height: 28px; border: 3px solid #e2e8f0; border-top-color: #4f46e5; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 0.75rem; }
        .sub { font-size: 0.82rem; color: #64748b; margin: 0; font-weight: 500; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      </style>
    </head>
    <body>
      <div class="splash-card">
        <div class="logo-box">
          <img src="${iconBase64}" class="logo-img" alt="NnzRP Icon">
        </div>
        <h2 class="title">NnzRP Client</h2>
        <div class="spinner"></div>
        <p class="sub">Memuat Aplikasi Desktop...</p>
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
    backgroundColor: '#f1f5f9',
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
  entry.proc.kill();
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
      }, MCP_REQUEST_TIMEOUT_MS);
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

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

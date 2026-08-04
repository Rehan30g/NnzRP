const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

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
    title: 'NnzRP - BYOK AI Roleplay Client',
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
      webSecurity: true
    }
  });

  // Handle F11 key shortcut for Fullscreen toggle
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    }
  });

  // Handle external link clicks to open in default OS browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
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

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

  // Custom MCP (Model Context Protocol) stdio server bridge - three typed
  // methods only, no generic IPC passthrough. `config`/`method`/`params` here
  // always originate from the user's own MCP settings UI or from an
  // already-listed tool call; the model never controls what gets spawned.
  mcp: {
    start: (config) => ipcRenderer.invoke('mcp:start', config),
    stop: (id) => ipcRenderer.invoke('mcp:stop', id),
    request: (id, method, params, isNotification = false) =>
      ipcRenderer.invoke('mcp:request', { id, method, params, isNotification })
  }
});

// Electron-only plugin system bridge - a NEW namespace, entirely separate
// from electronAPI. Every method is a typed, plugin-scoped call into main's
// per-permission broker (see the plugin system block in main.js); there is
// no generic filesystem/child_process passthrough. All paths are resolved
// inside app.getPath('userData')/plugins/<id>/ in main and reject traversal.
contextBridge.exposeInMainWorld('pluginHostAPI', {
  // -> Array<{ id, manifest, path, error? }>
  listInstalled: () => ipcRenderer.invoke('plugin:listInstalled'),
  // zipPath -> { id, manifest }
  install: (zipPath) => ipcRenderer.invoke('plugin:install', zipPath),
  // id -> void
  uninstall: (id) => ipcRenderer.invoke('plugin:uninstall', id),
  // -> string | null   (native open-file dialog on the main window)
  pickZip: () => ipcRenderer.invoke('plugin:pickZip'),
  // (id, relPath) -> string   utf8 contents of a file inside the plugin dir
  readPluginFile: (id, relPath) => ipcRenderer.invoke('plugin:readFile', { id, relPath }),
  // (id, relPath) -> string   file:// URL for the renderer to import() directly
  getPluginEntryUrl: (id, relPath) => ipcRenderer.invoke('plugin:getEntryUrl', { id, relPath }),
  // -> void   re-run bundled-plugin seeding on demand
  seedBundled: () => ipcRenderer.invoke('plugin:seedBundled'),

  // Per-plugin writable asset store at userData/plugin-data/<id>/ - for files a
  // plugin lets the user add (e.g. uploaded voice-clone .wav). Survives a
  // package reinstall/update; removed only on explicit uninstall.
  assets: {
    // (id, relPath, ArrayBuffer) -> { path, size }
    write: (id, relPath, data) => ipcRenderer.invoke('plugin:asset:write', { id, relPath, data }),
    // (id, relPath) -> ArrayBuffer
    read: (id, relPath) => ipcRenderer.invoke('plugin:asset:read', { id, relPath }),
    // id -> Array<{ name, size, mtime }>
    list: (id) => ipcRenderer.invoke('plugin:asset:list', id),
    // (id, relPath) -> void
    delete: (id, relPath) => ipcRenderer.invoke('plugin:asset:delete', { id, relPath }),
    // (id, relPath) -> string   absolute fs path (a co-located local server can read it)
    path: (id, relPath) => ipcRenderer.invoke('plugin:asset:path', { id, relPath })
  },

  backend: {
    // (id, permissions: string[]) -> void   fork js/plugins/backendRunner.cjs
    start: (id, permissions) => ipcRenderer.invoke('plugin-backend:start', { id, permissions }),
    // id -> void   kill the backend child
    stop: (id) => ipcRenderer.invoke('plugin-backend:stop', id),
    // (id, msg) -> any   RPC round-trip to the backend child
    request: (id, msg) => ipcRenderer.invoke('plugin-backend:request', { id, msg }),
    // (id, cb) -> () => void   subscribe to backend-emitted events; returns unsubscribe
    subscribe: (id, cb) => {
      const channel = 'plugin-backend:event:' + id;
      const listener = (_event, data) => {
        try {
          cb(data);
        } catch (e) {
          console.error('[pluginHostAPI] backend event handler threw:', e);
        }
      };
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  }
});

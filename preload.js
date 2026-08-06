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

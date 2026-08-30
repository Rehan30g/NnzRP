/* js/plugins/pluginManager.js - Renderer-side plugin runtime (singleton)
   ============================================================================
   Electron-only. Owns the lifecycle of installed plugins: discovery, enable/
   disable, activation (dynamic import of each plugin's renderer entry + calling
   its `activate(host)`), and the live extension-point registries the app's
   views read from.

   ISOLATION: a plugin that throws in activate() / a handler / a transform is
   caught, logged as `[plugin:<id>]`, and marked `hasError` - it never breaks
   app boot or another plugin.

   ELECTRON-GATE: `isSupported()` === `!!window.electronAPI`. Every public
   method is a safe no-op off Electron (returns [] / undefined / a resolved
   promise), so callers never have to guard.

   ---------------------------------------------------------------------------
   PUBLIC API (other modules code against these - treat as frozen):

     pluginManager.isSupported() -> boolean

     await pluginManager.init()
        Call ONCE from app.js after initDatabase(). No-op if unsupported or
        already initialised. Seeds bundled plugins, lists installed, loads the
        registry, then activates every plugin whose registry entry is
        `enabled === true`.

     pluginManager.list() -> Array<{ id, name, version, description, author,
                                     enabled, icon, hasError, error }>
        Merge of the on-disk install list and the persisted registry. For the
        plugins-management UI.

     await pluginManager.enable(id) / await pluginManager.disable(id)
        Persist the flag, then activate / deactivate live.

     await pluginManager.install(zipPath) -> manifest | null
        Installs from a .zip path, refreshes the install list, adds a
        registry entry (disabled by default), returns the plugin's manifest.

     await pluginManager.installFromDialog() -> manifest | null
        pickZip() then install(); null if the user cancelled.

     await pluginManager.uninstall(id)
        Deactivates if active, removes files + registry entry, refreshes.

     Extension-point getters (cheap; return the LIVE arrays - do not mutate).
     Every element carries `pluginId` (and `pluginName`):
        pluginManager.getNavTabs()        -> [{ pluginId, pluginName, id, label, icon?, render }]
        pluginManager.getSettingsTabs()   -> [{ pluginId, pluginName, id, label, render }]
        pluginManager.getChatDrawerTabs() -> [{ pluginId, pluginName, id, label, render }]
        pluginManager.getComposerButtons()-> [{ pluginId, pluginName, id, icon, title, onClick }]
        pluginManager.getMessageActions() -> [{ pluginId, pluginName, id, icon, title, visible, onClick }]
                                             (call `visible(msg)` per message;
                                              default hides non-assistant msgs)
        pluginManager.getCharacterFields()    -> [{ pluginId, pluginName, key, label, type, options?, placeholder?, help? }]
        pluginManager.getCharacterFieldDefs() -> alias of getCharacterFields()

     pluginManager.emit(event, payload)
        Fan a global app event out to every active plugin's scoped bus.
        Recognised: 'chat-opened' {chatId,character} (sets activeChatContext),
        'chat-closed' {chatId} (clears it), 'user-message-sent',
        'assistant-message-chunk', 'assistant-message-complete', 'navigate'.
        No-op if unsupported.

     await pluginManager.applyRequestTransforms(payload, ctx)  -> payload'
     await pluginManager.applyResponseTransforms(result, ctx)  -> result'
        Fold the value through each registered transform in order. A transform
        that throws (or returns undefined) is skipped and the prior value
        kept. Returns the input unchanged if unsupported / none registered.

     pluginManager.resolveNavRoute("<pluginId>:<tabId>")
        -> the matching nav-tab entry { pluginId, id, label, render, ... } | null
   ---------------------------------------------------------------------------
   ============================================================================ */
import { PluginStore } from './pluginStore.js';
import { createHost } from './pluginHost.js';
import { Toast } from '../ui/components/toast.js';

class PluginManager {
  constructor() {
    /** Raw entries from window.pluginHostAPI.listInstalled(). */
    this._installed = [];
    /** id -> { id, manifest, mod, host, hasError, error }. */
    this._active = new Map();
    /** Cached copy of PluginStore.getRegistry(). */
    this._registryCache = {};
    this._initialized = false;

    /** { chatId, character } | null - kept in sync from chat-opened/closed. */
    this.activeChatContext = null;

    /* Live extension-point registries (createHost pushes/splices these). */
    this.navTabs = [];
    this.settingsTabs = [];
    this.chatDrawerTabs = [];
    this.composerButtons = [];
    this.messageActions = [];
    this.characterFields = [];
    this.requestTransforms = [];
    this.responseTransforms = [];
  }

  isSupported() {
    return !!window.electronAPI;
  }

  /** The preload bridge, or null when unsupported / not injected. */
  _api() {
    return this.isSupported() && window.pluginHostAPI ? window.pluginHostAPI : null;
  }

  /* --------------------------------------------------------------------- */
  /* Lifecycle                                                            */
  /* --------------------------------------------------------------------- */

  async init() {
    if (this._initialized) return;
    const api = this._api();
    if (!api) return;
    this._initialized = true;

    // Best-effort: copy bundled plugins into the user plugins dir on first run.
    try {
      await api.seedBundled();
    } catch (e) {
      console.warn('[pluginManager] seedBundled failed:', e && e.message);
    }

    try {
      this._installed = (await api.listInstalled()) || [];
    } catch (e) {
      console.error('[pluginManager] listInstalled failed:', e);
      this._installed = [];
    }

    try {
      this._registryCache = (await PluginStore.getRegistry()) || {};
    } catch (e) {
      console.error('[pluginManager] registry load failed:', e);
      this._registryCache = {};
    }

    for (const entry of this._installed) {
      if (!entry || !entry.id || !entry.manifest) continue;
      const reg = this._registryCache[entry.id];
      if (reg && reg.enabled === true) {
        await this._activate(entry);
      }
    }
  }

  /**
   * Import + activate one installed plugin. Refuses a manifest whose
   * `engineApi` major version isn't "1". Any throw is caught, the plugin is
   * marked `hasError`, a toast is shown, and partial registrations are undone.
   */
  async _activate(installedEntry) {
    const api = this._api();
    if (!api || !installedEntry || !installedEntry.id) return;

    const id = installedEntry.id;
    if (this._active.has(id)) return this._active.get(id);

    const manifest = installedEntry.manifest || {};
    const name = manifest.name || id;

    const engineApi = String(manifest.engineApi || '');
    const major = engineApi.split('.')[0];
    if (major !== '1') {
      const msg = `unsupported engineApi "${engineApi || '(none)'}" - need major version 1`;
      console.error(`[plugin:${id}] ${msg}`);
      this._active.set(id, { id, manifest, mod: null, host: null, hasError: true, error: msg });
      return this._active.get(id);
    }

    let host = null;
    try {
      const rel = manifest.renderer || 'renderer/index.js';
      const url = await api.getPluginEntryUrl(id, rel);
      host = createHost(id, manifest, {
        registries: {
          navTabs: this.navTabs,
          settingsTabs: this.settingsTabs,
          chatDrawerTabs: this.chatDrawerTabs,
          composerButtons: this.composerButtons,
          messageActions: this.messageActions,
          characterFields: this.characterFields,
          requestTransforms: this.requestTransforms,
          responseTransforms: this.responseTransforms
        },
        store: PluginStore,
        pluginPath: installedEntry.path,
        getActiveChatContext: () => this.activeChatContext,
        markError: (pid, err) => this._markError(pid, err)
      });

      const record = { id, manifest, mod: null, host, hasError: false, error: null };
      this._active.set(id, record);

      const mod = await import(/* @vite-ignore */ url);
      record.mod = mod;

      if (typeof mod.activate === 'function') {
        await mod.activate(host);
      }
      return record;
    } catch (e) {
      console.error(`[plugin:${id}]`, e);
      // Undo anything the half-activated plugin registered.
      if (host && typeof host._disposeAll === 'function') {
        try { host._disposeAll(); } catch (_) { /* already logged inside */ }
      }
      this._removePluginEntries(id);
      const record = this._active.get(id) || { id, manifest, mod: null, host };
      record.hasError = true;
      record.error = String((e && e.stack) || e);
      this._active.set(id, record);
      try { Toast.error(`Plugin ${name} gagal dimuat`); } catch (_) { /* toast is best-effort */ }
      return record;
    }
  }

  /** Call deactivate(), dispose the host, strip its registry entries. */
  async _deactivate(id) {
    const record = this._active.get(id);
    if (!record) return;
    try {
      if (record.mod && typeof record.mod.deactivate === 'function') {
        await record.mod.deactivate();
      }
    } catch (e) {
      console.error(`[plugin:${id}]`, e);
    }
    try {
      if (record.host && typeof record.host._disposeAll === 'function') {
        record.host._disposeAll();
      }
    } catch (e) {
      console.error(`[plugin:${id}]`, e);
    }
    this._removePluginEntries(id);
    this._active.delete(id);
  }

  /** Belt-and-suspenders: drop every registry element owned by `id`. */
  _removePluginEntries(id) {
    const arrays = [
      this.navTabs, this.settingsTabs, this.chatDrawerTabs, this.composerButtons,
      this.messageActions, this.characterFields, this.requestTransforms, this.responseTransforms
    ];
    for (const arr of arrays) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] && arr[i].pluginId === id) arr.splice(i, 1);
      }
    }
  }

  _markError(id, err) {
    const record = this._active.get(id);
    if (record) {
      record.hasError = true;
      record.error = String((err && err.message) || err);
    }
  }

  /* --------------------------------------------------------------------- */
  /* Management surface                                                   */
  /* --------------------------------------------------------------------- */

  list() {
    if (!this.isSupported()) return [];
    const out = new Map();

    for (const entry of this._installed || []) {
      if (!entry || !entry.id) continue;
      const m = entry.manifest || {};
      const reg = this._registryCache[entry.id] || {};
      const active = this._active.get(entry.id);
      out.set(entry.id, {
        id: entry.id,
        name: m.name || entry.id,
        version: m.version || reg.version || '0.0.0',
        description: m.description || '',
        author: m.author || '',
        enabled: reg.enabled === true,
        icon: m.icon || null,
        hasError: !!(active && active.hasError) || !!entry.error,
        error: (active && active.error) || entry.error || null
      });
    }

    // Registry entries with no matching install (stale) - still surfaced so
    // the UI can show and remove them.
    for (const [id, reg] of Object.entries(this._registryCache || {})) {
      if (out.has(id)) continue;
      out.set(id, {
        id,
        name: id,
        version: (reg && reg.version) || '0.0.0',
        description: '',
        author: '',
        enabled: !!(reg && reg.enabled === true),
        icon: null,
        hasError: false,
        error: null
      });
    }

    return [...out.values()];
  }

  async enable(id) {
    if (!this.isSupported()) return;
    await PluginStore.setEnabled(id, true);
    this._registryCache = await PluginStore.getRegistry();
    // Clear a previously-errored record so a re-enable actually retries the
    // import + activate() rather than returning the stale failed record.
    const existing = this._active.get(id);
    if (existing && existing.hasError) {
      this._removePluginEntries(id);
      this._active.delete(id);
    }
    const entry = (this._installed || []).find((e) => e && e.id === id);
    if (entry) await this._activate(entry);
  }

  async disable(id) {
    if (!this.isSupported()) return;
    await PluginStore.setEnabled(id, false);
    this._registryCache = await PluginStore.getRegistry();
    await this._deactivate(id);
  }

  async install(zipPath) {
    const api = this._api();
    if (!api) return null;

    const result = await api.install(zipPath);

    try {
      this._installed = (await api.listInstalled()) || [];
    } catch (e) {
      console.warn('[pluginManager] listInstalled refresh failed:', e && e.message);
    }

    // pluginHostAPI.install() may hand back a bare manifest or a wrapper
    // { id, manifest, path } - accept either.
    const manifest = (result && result.manifest) || (result && result.id ? result : null) || result || null;
    const newId = (result && result.id) || (manifest && manifest.id) || null;

    if (newId) {
      await PluginStore.upsert(newId, { version: manifest && manifest.version });
      this._registryCache = await PluginStore.getRegistry();
    }

    return manifest;
  }

  async installFromDialog() {
    const api = this._api();
    if (!api) return null;
    let zipPath = null;
    try {
      zipPath = await api.pickZip();
    } catch (e) {
      console.error('[pluginManager] pickZip failed:', e);
      return null;
    }
    if (!zipPath) return null;
    return this.install(zipPath);
  }

  async uninstall(id) {
    const api = this._api();
    if (!api) return;
    if (this._active.has(id)) await this._deactivate(id);
    try {
      await api.uninstall(id);
    } catch (e) {
      console.error('[pluginManager] uninstall failed:', e);
    }
    await PluginStore.removeFromRegistry(id);
    try {
      this._installed = (await api.listInstalled()) || [];
    } catch (e) {
      console.warn('[pluginManager] listInstalled refresh failed:', e && e.message);
    }
    this._registryCache = await PluginStore.getRegistry();
  }

  /* --------------------------------------------------------------------- */
  /* Extension-point getters                                              */
  /* --------------------------------------------------------------------- */

  getNavTabs() { return this.isSupported() ? this.navTabs : []; }
  getSettingsTabs() { return this.isSupported() ? this.settingsTabs : []; }
  getChatDrawerTabs() { return this.isSupported() ? this.chatDrawerTabs : []; }
  getComposerButtons() { return this.isSupported() ? this.composerButtons : []; }
  getMessageActions() { return this.isSupported() ? this.messageActions : []; }
  getCharacterFields() { return this.isSupported() ? this.characterFields : []; }
  getCharacterFieldDefs() { return this.getCharacterFields(); }

  /* --------------------------------------------------------------------- */
  /* Event fan-out                                                        */
  /* --------------------------------------------------------------------- */

  emit(event, payload) {
    if (!this.isSupported()) return;

    if (event === 'chat-opened') {
      this.activeChatContext = payload
        ? { chatId: payload.chatId, character: payload.character }
        : null;
    } else if (event === 'chat-closed') {
      this.activeChatContext = null;
    }

    for (const record of this._active.values()) {
      if (!record || !record.host || !record.host._eventBus) continue;
      try {
        record.host._eventBus.emit(event, payload);
      } catch (e) {
        console.error(`[plugin:${record.id}]`, e);
      }
    }
  }

  /* --------------------------------------------------------------------- */
  /* Pipeline transforms                                                  */
  /* --------------------------------------------------------------------- */

  async applyRequestTransforms(payload, ctx) {
    return this._applyTransforms(this.requestTransforms, payload, ctx);
  }

  async applyResponseTransforms(result, ctx) {
    return this._applyTransforms(this.responseTransforms, result, ctx);
  }

  async _applyTransforms(list, value, ctx) {
    if (!this.isSupported() || !Array.isArray(list) || !list.length) return value;
    let current = value;
    for (const t of [...list]) {
      if (!t || typeof t.fn !== 'function') continue;
      try {
        const next = await t.fn(current, ctx);
        if (next !== undefined) current = next;
      } catch (e) {
        console.error(`[plugin:${t.pluginId}]`, e);
        this._markError(t.pluginId, e);
      }
    }
    return current;
  }

  /* --------------------------------------------------------------------- */
  /* Routing helper                                                       */
  /* --------------------------------------------------------------------- */

  resolveNavRoute(routeStr) {
    if (!this.isSupported() || typeof routeStr !== 'string') return null;
    const sep = routeStr.indexOf(':');
    if (sep === -1) return null;
    const pluginId = routeStr.slice(0, sep);
    const tabId = routeStr.slice(sep + 1);
    return this.navTabs.find((t) => t.pluginId === pluginId && t.id === tabId) || null;
  }
}

export const pluginManager = new PluginManager();
export { PluginManager };

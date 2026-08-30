/* js/plugins/pluginHost.js - The `host` object handed to a plugin's activate()
   ============================================================================
   `createHost(pluginId, manifest, deps)` builds the sole capability surface a
   renderer-side plugin gets. Everything a plugin can do to the app goes
   through here, and every extension point it registers returns a disposer that
   is ALSO tracked internally so pluginManager can call `host._disposeAll()` on
   disable / uninstall / reactivate and leave zero residue.

   Isolation rule (CLAUDE.md): a throwing plugin callback must never break the
   app or another plugin. Every plugin-supplied function stored in a registry
   (render / onClick / visible) is wrapped by `guard()` here, so even the
   consumer views calling them later get try/catch + `console.error('[plugin:
   <id>]', e)` + `hasError` marking for free. Async (promise-returning)
   callbacks are guarded too (their rejections are caught).

   `deps` (supplied by pluginManager, internal contract):
     - registries         : { navTabs, settingsTabs, chatDrawerTabs,
                              composerButtons, messageActions, characterFields,
                              requestTransforms, responseTransforms } - live arrays
     - store              : PluginStore class
     - pluginPath         : absolute plugin dir (from listInstalled())
     - getActiveChatContext : () => { chatId, character } | null
     - markError          : (pluginId, error) => void
   ============================================================================ */
import { EventBus } from './eventBus.js';
import { Toast } from '../ui/components/toast.js';
import { Modal } from '../ui/components/modal.js';
import { CharacterStore } from '../storage/characterStore.js';
import { ChatStore } from '../storage/chatStore.js';
import { ProxyStore } from '../storage/proxyStore.js';
import { PersonaStore } from '../storage/personaStore.js';

const API_VERSION = '1.0';

/** Recursively freeze a plain object (manifest copy handed to the plugin). */
function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
  }
  return obj;
}

export function createHost(pluginId, manifest, deps = {}) {
  const registries = deps.registries || {};
  const store = deps.store;
  const logPrefix = `[plugin:${pluginId}]`;

  const manifestCopy = deepFreeze(JSON.parse(JSON.stringify(manifest || {})));
  const permissions = Array.isArray(manifestCopy.permissions) ? manifestCopy.permissions : [];
  const pluginName = manifestCopy.name || pluginId;

  /* --------------------------------------------------------------------- */
  /* Disposer tracking                                                     */
  /* --------------------------------------------------------------------- */
  /** @type {Set<Function>} */
  const disposers = new Set();

  /** Wrap `fn` so it self-removes from the tracked set and never throws. */
  function track(fn) {
    const wrapped = () => {
      if (!disposers.has(wrapped)) return;
      disposers.delete(wrapped);
      try {
        if (typeof fn === 'function') fn();
      } catch (e) {
        console.error(logPrefix, e);
      }
    };
    disposers.add(wrapped);
    return wrapped;
  }

  /* --------------------------------------------------------------------- */
  /* Plugin-callback isolation wrapper                                     */
  /* --------------------------------------------------------------------- */
  function guard(fn, fallback) {
    if (typeof fn !== 'function') return fn;
    return function guarded(...args) {
      try {
        const result = fn.apply(this, args);
        if (result && typeof result.then === 'function') {
          return result.then(
            (v) => v,
            (e) => {
              console.error(logPrefix, e);
              if (typeof deps.markError === 'function') deps.markError(pluginId, e);
              return fallback;
            }
          );
        }
        return result;
      } catch (e) {
        console.error(logPrefix, e);
        if (typeof deps.markError === 'function') deps.markError(pluginId, e);
        return fallback;
      }
    };
  }

  /** Push a record into a registry array; return a tracked remove-disposer. */
  function registerInto(arr, record) {
    if (!Array.isArray(arr)) return track(() => {});
    const entry = { ...record, pluginId, pluginName };
    arr.push(entry);
    return track(() => {
      const i = arr.indexOf(entry);
      if (i !== -1) arr.splice(i, 1);
    });
  }

  /* --------------------------------------------------------------------- */
  /* Scoped event bus (pluginManager pumps global events into this)        */
  /* --------------------------------------------------------------------- */
  const eventBus = new EventBus(`plugin:${pluginId}`);

  /* --------------------------------------------------------------------- */
  /* host.ui                                                               */
  /* --------------------------------------------------------------------- */
  const ui = {
    registerNavTab({ id, label, icon, render } = {}) {
      return registerInto(registries.navTabs, { id, label, icon, render: guard(render) });
    },
    registerSettingsTab({ id, label, render } = {}) {
      return registerInto(registries.settingsTabs, { id, label, render: guard(render) });
    },
    /**
     * DECLARATIVE settings - the easy path. The plugin describes its fields and
     * the host renders + persists them (each field's value lives at
     * `host.storage[field.key]`), shown as a subtab in the Plugins view. No DOM
     * code. `registerSettingsTab` above stays as the power-user escape hatch.
     *
     * schema = {
     *   title?: string,                       // subtab label (default: plugin name)
     *   sections: [{ title?, description?, fields: [{
     *     key, type: 'text'|'textarea'|'number'|'toggle'|'select',
     *     label, help?, default?, placeholder?, options?: [{value,label}],
     *     min?, max?, step?, rows?
     *   }] }],
     *   actions?: [{ id, label, style?: 'secondary'|'primary'|'danger',
     *                onClick: (ctx) => void|Promise }],
     *   custom?: (el, ctx) => void,           // escape-hatch DOM slot, after the sections
     *   onChange?: (key, value, values) => void   // after a field persists
     * }
     * ctx = { values, get(key), set(key,value), refresh(), host }
     */
    registerSettings(schema) {
      const s = (schema && typeof schema === 'object') ? schema : {};
      const sections = Array.isArray(s.sections) ? s.sections : [];
      const normSections = sections.map((sec) => ({
        title: typeof sec?.title === 'string' ? sec.title : '',
        description: typeof sec?.description === 'string' ? sec.description : '',
        fields: (Array.isArray(sec?.fields) ? sec.fields : [])
          .filter((f) => f && typeof f.key === 'string' && typeof f.type === 'string')
      }));
      const normalized = {
        title: typeof s.title === 'string' && s.title.trim() ? s.title : pluginName,
        sections: normSections,
        actions: (Array.isArray(s.actions) ? s.actions : [])
          .filter((a) => a && typeof a.onClick === 'function')
          .map((a) => ({ id: a.id, label: a.label, style: a.style, onClick: guard(a.onClick) })),
        custom: typeof s.custom === 'function' ? guard(s.custom) : null,
        onChange: typeof s.onChange === 'function' ? guard(s.onChange) : null
      };
      return registerInto(registries.settingsSchemas, { schema: normalized });
    },
    registerChatDrawerTab({ id, label, render } = {}) {
      return registerInto(registries.chatDrawerTabs, { id, label, render: guard(render) });
    },
    registerComposerButton({ id, icon, title, onClick } = {}) {
      return registerInto(registries.composerButtons, { id, icon, title, onClick: guard(onClick) });
    },
    registerMessageAction({ id, icon, title, visible, onClick } = {}) {
      // Default: no `visible` supplied => show only on assistant messages.
      // A supplied `visible` is guarded and its throw defaults to `false`
      // (a broken predicate hides the action rather than showing a bad one).
      const resolvedVisible = typeof visible === 'function'
        ? guard(visible, false)
        : (msg) => !!msg && msg.role === 'assistant';
      return registerInto(registries.messageActions, {
        id, icon, title,
        visible: resolvedVisible,
        onClick: guard(onClick)
      });
    },
    registerCharacterFields(fields) {
      const list = Array.isArray(fields) ? fields : [];
      const arr = registries.characterFields;
      if (!Array.isArray(arr)) return track(() => {});
      const entries = list.map((f) => ({ ...f, pluginId, pluginName }));
      for (const e of entries) arr.push(e);
      return track(() => {
        for (const e of entries) {
          const i = arr.indexOf(e);
          if (i !== -1) arr.splice(i, 1);
        }
      });
    },
    toast: {
      success: (msg) => { try { Toast.success(msg); } catch (e) { console.error(logPrefix, e); } },
      error: (msg) => { try { Toast.error(msg); } catch (e) { console.error(logPrefix, e); } },
      info: (msg) => { try { Toast.info(msg); } catch (e) { console.error(logPrefix, e); } }
    },
    modal: Modal,
    /**
     * Promise<boolean> OK/Cancel dialog built on the app Modal. `message` is
     * plugin-supplied text - injected via textContent (never innerHTML) into a
     * placeholder node, since Modal.open() does not escape contentHTML.
     */
    confirm(message) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
        let overlay;
        try {
          overlay = Modal.open({
            title: 'Confirm',
            contentHTML: '<p class="plugin-confirm-text" style="margin:0; color:var(--text-main);"></p>',
            closeOnBackdropClick: true,
            onClose: () => finish(false),
            buttons: [
              { label: 'Cancel', className: 'btn-secondary', onClick: (ov) => { Modal.closeOverlay(ov); finish(false); } },
              { label: 'OK', className: 'btn-primary', onClick: (ov) => { Modal.closeOverlay(ov); finish(true); } }
            ]
          });
        } catch (e) {
          console.error(logPrefix, e);
          finish(false);
          return;
        }
        const textEl = overlay && overlay.querySelector('.plugin-confirm-text');
        if (textEl) textEl.textContent = message == null ? '' : String(message);
      });
    }
  };

  /* --------------------------------------------------------------------- */
  /* host.events (scoped bus)                                              */
  /* --------------------------------------------------------------------- */
  const events = {
    on(event, fn) {
      const off = eventBus.on(event, fn);
      return track(off);
    },
    off(event, fn) {
      eventBus.off(event, fn);
    }
  };

  /* --------------------------------------------------------------------- */
  /* host.pipeline (request/response transforms)                          */
  /* --------------------------------------------------------------------- */
  const pipeline = {
    addRequestTransform(fn) {
      return registerInto(registries.requestTransforms, { fn: guard(fn) });
    },
    addResponseTransform(fn) {
      return registerInto(registries.responseTransforms, { fn: guard(fn) });
    }
  };

  /* --------------------------------------------------------------------- */
  /* host.storage (namespaced KV)                                          */
  /* --------------------------------------------------------------------- */
  const storage = {
    get: (key) => store ? store.pluginGet(pluginId, key) : Promise.resolve(undefined),
    set: (key, value) => store ? store.pluginSet(pluginId, key, value) : Promise.resolve(),
    delete: (key) => store ? store.pluginDelete(pluginId, key) : Promise.resolve(),
    keys: () => store ? store.pluginKeys(pluginId) : Promise.resolve([])
  };

  /* --------------------------------------------------------------------- */
  /* host.assets (per-plugin writable file store, Electron only)           */
  /* --------------------------------------------------------------------- */
  /* Files the plugin lets the user add - e.g. an uploaded voice-clone wav.
     Lives at userData/plugin-data/<pluginId>/, survives a package
     reinstall/update, and `path(relPath)` returns an absolute fs path a
     co-located local server (same machine as the desktop app) can read.
     Ungated, same rationale as host.storage: a plugin's own sandboxed dir. */
  const assetApi = () => (typeof window !== 'undefined' && window.pluginHostAPI && window.pluginHostAPI.assets) || null;
  const assets = {
    write: (relPath, data) => { const a = assetApi(); return a ? a.write(pluginId, relPath, data) : Promise.reject(new Error('assets unavailable')); },
    read: (relPath) => { const a = assetApi(); return a ? a.read(pluginId, relPath) : Promise.reject(new Error('assets unavailable')); },
    list: () => { const a = assetApi(); return a ? a.list(pluginId) : Promise.resolve([]); },
    delete: (relPath) => { const a = assetApi(); return a ? a.delete(pluginId, relPath) : Promise.resolve(); },
    path: (relPath) => { const a = assetApi(); return a ? a.path(pluginId, relPath) : Promise.resolve(null); }
  };

  /* --------------------------------------------------------------------- */
  /* host.data (read-only, async)                                          */
  /* --------------------------------------------------------------------- */
  const data = {
    getCharacter: (id) => id ? CharacterStore.getById(id) : Promise.resolve(null),
    getActiveChat: () => {
      const ctx = typeof deps.getActiveChatContext === 'function' ? deps.getActiveChatContext() : null;
      return ctx ? { chatId: ctx.chatId, character: ctx.character } : null;
    },
    getMessages: (chatId) => chatId ? ChatStore.getMessages(chatId) : Promise.resolve([]),
    getProxy: () => ProxyStore.getDefault(),
    getPersona: () => PersonaStore.getDefault()
  };

  /* --------------------------------------------------------------------- */
  /* Assemble host                                                         */
  /* --------------------------------------------------------------------- */
  const host = {
    apiVersion: API_VERSION,
    pluginId,
    manifest: manifestCopy,
    pluginPath: deps.pluginPath || manifestCopy.pluginPath || '',
    log: (...args) => console.log(logPrefix, ...args),
    ui,
    events,
    pipeline,
    storage,
    assets,
    data,

    /** Internal: pluginManager fans global events in through this. */
    _eventBus: eventBus,

    /** Internal: called by pluginManager on disable/uninstall/reactivate. */
    _disposeAll() {
      for (const d of [...disposers]) {
        try { d(); } catch (e) { console.error(logPrefix, e); }
      }
      disposers.clear();
      eventBus.clear();
    }
  };

  // host.net - only when the plugin declared the 'network' permission.
  if (permissions.includes('network')) {
    host.net = { fetch: window.fetch.bind(window) };
  }

  // host.backend - only when the manifest declares a backend. Delegates to the
  // preload-exposed window.pluginHostAPI.backend.*, bound to this pluginId and
  // passing the manifest's permission list to start().
  if (manifestCopy.backend) {
    const api = window.pluginHostAPI && window.pluginHostAPI.backend;
    host.backend = {
      start: () => api ? api.start(pluginId, permissions) : Promise.resolve(),
      stop: () => api ? api.stop(pluginId) : Promise.resolve(),
      request: (msg) => api ? api.request(pluginId, msg) : Promise.resolve(),
      on: (event, cb) => {
        if (!api || typeof api.subscribe !== 'function') return track(() => {});
        const handler = (payload) => {
          try {
            if (!event || (payload && payload.event === event)) cb(payload);
          } catch (e) {
            console.error(logPrefix, e);
            if (typeof deps.markError === 'function') deps.markError(pluginId, e);
          }
        };
        let unsub = null;
        let disposed = false;
        Promise.resolve(api.subscribe(pluginId, handler))
          .then((fn) => { unsub = fn; if (disposed && typeof fn === 'function') fn(); })
          .catch((e) => console.error(logPrefix, e));
        return track(() => {
          disposed = true;
          if (typeof unsub === 'function') {
            try { unsub(); } catch (e) { console.error(logPrefix, e); }
          }
        });
      }
    };
  }

  return host;
}

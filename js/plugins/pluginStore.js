/* js/plugins/pluginStore.js - Plugin registry + per-plugin key/value persistence
   ============================================================================
   Backed entirely by the EXISTING `settings` object store (DB
   `AetheriaRoleplayDB_v2`, keyPath `key`) via the shared `db` singleton - no
   new store, no DB version bump. Two concerns live here:

     1. The plugin REGISTRY (settings key "plugins.registry"): which plugins
        are installed + enabled, keyed by plugin id.
     2. Namespaced plugin KV: each entry is its own `settings` row keyed
        "plugin:<id>:<key>", so a plugin's data is trivially enumerable and
        removable without touching any other row.

   Same access pattern as js/storage/*Store.js (static methods, `db` from
   ../storage/db.js).
   ============================================================================ */
import { db } from '../storage/db.js';

const REGISTRY_KEY = 'plugins.registry';
const KV_PREFIX = 'plugin:';

export class PluginStore {
  /* ----------------------------------------------------------------------- */
  /* Registry                                                               */
  /* ----------------------------------------------------------------------- */

  /**
   * @returns {Promise<Object<string,{enabled:boolean,installedAt:number,version:*}>>}
   *   the full registry map (empty object if nothing stored / malformed).
   */
  static async getRegistry() {
    const row = await db.get('settings', REGISTRY_KEY);
    const value = row && row.value;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  static async _saveRegistry(registry) {
    await db.put('settings', { key: REGISTRY_KEY, value: registry });
  }

  /**
   * Toggle a plugin's enabled flag, creating its registry entry if absent.
   * @returns {Promise<object>} the updated entry.
   */
  static async setEnabled(id, bool) {
    const registry = await this.getRegistry();
    const entry = registry[id] || { enabled: false, installedAt: Date.now(), version: null };
    entry.enabled = !!bool;
    registry[id] = entry;
    await this._saveRegistry(registry);
    return entry;
  }

  /** Delete a plugin's registry entry (no-op if it isn't there). */
  static async removeFromRegistry(id) {
    const registry = await this.getRegistry();
    if (Object.prototype.hasOwnProperty.call(registry, id)) {
      delete registry[id];
      await this._saveRegistry(registry);
    }
  }

  /**
   * Create-or-update a registry entry. A brand-new entry defaults to
   * `enabled: false` with an `installedAt` stamp; an existing entry keeps its
   * `enabled`/`installedAt` and only has `version` refreshed (when supplied).
   * @returns {Promise<object>} the resulting entry.
   */
  static async upsert(id, { version } = {}) {
    const registry = await this.getRegistry();
    const existing = registry[id];
    if (existing && typeof existing === 'object') {
      if (version !== undefined) existing.version = version;
      registry[id] = existing;
    } else {
      registry[id] = {
        enabled: false,
        installedAt: Date.now(),
        version: version !== undefined ? version : null
      };
    }
    await this._saveRegistry(registry);
    return registry[id];
  }

  /* ----------------------------------------------------------------------- */
  /* Namespaced plugin KV  ("plugin:<id>:<key>" rows in `settings`)          */
  /* ----------------------------------------------------------------------- */

  static _kvKey(id, key) {
    return `${KV_PREFIX}${id}:${key}`;
  }

  /**
   * @returns {Promise<*>} the stored value, or `undefined` if the key was
   *   never set. Values are stored/returned as-is (the `settings` store holds
   *   arbitrary structured-clonable objects).
   */
  static async pluginGet(id, key) {
    const row = await db.get('settings', this._kvKey(id, key));
    return row ? row.value : undefined;
  }

  static async pluginSet(id, key, value) {
    await db.put('settings', { key: this._kvKey(id, key), value });
  }

  static async pluginDelete(id, key) {
    await db.delete('settings', this._kvKey(id, key));
  }

  /**
   * @returns {Promise<string[]>} every KV key this plugin has stored (the
   *   short key, i.e. without the "plugin:<id>:" prefix).
   */
  static async pluginKeys(id) {
    const prefix = `${KV_PREFIX}${id}:`;
    const all = await db.getAll('settings');
    return all
      .map((row) => row && row.key)
      .filter((k) => typeof k === 'string' && k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }

  /**
   * Delete every KV row belonging to a plugin (used on uninstall by callers
   * that want a clean slate - the manager currently leaves data in place so a
   * reinstall keeps settings, but this is here if that policy changes).
   */
  static async pluginClear(id) {
    const prefix = `${KV_PREFIX}${id}:`;
    const all = await db.getAll('settings');
    for (const row of all) {
      if (row && typeof row.key === 'string' && row.key.startsWith(prefix)) {
        await db.delete('settings', row.key);
      }
    }
  }
}

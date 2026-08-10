/* js/storage/proxyStore.js - Multi-Proxy & API Key Config Storage */
import { db } from './db.js';

export class ProxyStore {
  static async getAll() {
    return await db.getAll('proxies');
  }

  static async getById(id) {
    return await db.get('proxies', id);
  }

  static async getDefault() {
    const all = await this.getAll();
    const def = all.find(p => p.isDefault);
    return def || all[0] || null;
  }

  static async save(proxyData) {
    const now = Date.now();
    const id = proxyData.id || `proxy-${now}-${Math.random().toString(36).substr(2, 5)}`;

    if (proxyData.isDefault) {
      const proxies = await db.getAll('proxies');
      for (const p of proxies) {
        if (p.isDefault && p.id !== id) {
          p.isDefault = false;
          await db.put('proxies', p);
        }
      }
    }

    const payload = {
      ...proxyData,
      id,
      updatedAt: now,
      createdAt: proxyData.createdAt || now
    };
    await db.put('proxies', payload);
    return payload;
  }

  static async delete(id) {
    await db.delete('proxies', id);
  }

  /* Global Settings */
  static async getGenerationSettings() {
    const res = await db.get('settings', 'generationSettings');
    return res ? res.value : {};
  }

  static async saveGenerationSettings(settings) {
    await db.put('settings', { key: 'generationSettings', value: settings });
  }

  static async getGlobalSystemPrompt() {
    const res = await db.get('settings', 'globalSystemPrompt');
    return res ? res.value : '';
  }

  static async saveGlobalSystemPrompt(prompt) {
    await db.put('settings', { key: 'globalSystemPrompt', value: prompt });
  }

  static async getSystemPromptPresets() {
    const res = await db.get('settings', 'systemPromptPresets');
    return res ? res.value : (APP_CONFIG.DEFAULT_SYSTEM_PROMPT_PRESETS || []);
  }

  static async saveSystemPromptPresets(presets) {
    await db.put('settings', { key: 'systemPromptPresets', value: presets });
  }
}

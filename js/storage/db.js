/* js/storage/db.js - Native IndexedDB Storage (Zero External Dependencies) */
import { APP_CONFIG } from '../config.js';

class NativeDB {
  constructor(dbName = 'AetheriaRoleplayDB_v2', version = 1) {
    this.dbName = dbName;
    this.version = version;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        if (!db.objectStoreNames.contains('characters')) {
          const charStore = db.createObjectStore('characters', { keyPath: 'id' });
          charStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('chats')) {
          const chatStore = db.createObjectStore('chats', { keyPath: 'id' });
          chatStore.createIndex('characterId', 'characterId', { unique: false });
          chatStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('messages')) {
          const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('chatId', 'chatId', { unique: false });
          msgStore.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('personas')) {
          const personaStore = db.createObjectStore('personas', { keyPath: 'id' });
          personaStore.createIndex('isDefault', 'isDefault', { unique: false });
        }
        if (!db.objectStoreNames.contains('proxies')) {
          const proxyStore = db.createObjectStore('proxies', { keyPath: 'id' });
          proxyStore.createIndex('isDefault', 'isDefault', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        reject(new Error('IndexedDB Open Failed: ' + event.target.error));
      };
    });
  }

  async getStore(storeName, mode = 'readonly') {
    const db = await this.open();
    const tx = db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  async getAll(storeName) {
    const store = await this.getStore(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async get(storeName, key) {
    const store = await this.getStore(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async put(storeName, value) {
    const store = await this.getStore(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(storeName, key) {
    const store = await this.getStore(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async count(storeName) {
    const store = await this.getStore(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    });
  }

  async getByIndex(storeName, indexName, value) {
    const store = await this.getStore(storeName, 'readonly');
    const index = store.index(indexName);
    return new Promise((resolve, reject) => {
      const req = index.getAll(value);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
}

export const db = new NativeDB();

export async function syncToDisk() {
  // Only attempt disk sync if running on local HTTP server (server.py), skip on static file:// Electron
  if (!window.location.protocol.startsWith('http')) return;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 400);
    const data = {
      characters: await db.getAll('characters'),
      chats: await db.getAll('chats'),
      messages: await db.getAll('messages'),
      personas: await db.getAll('personas'),
      proxies: await db.getAll('proxies'),
      settings: await db.getAll('settings')
    };
    await fetch('/api/sync-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
  } catch (err) {
    // Silent catch if offline/static host
  }
}

export async function initDatabase() {
  await db.open();

  // Try loading local project file storage if running on HTTP server (server.py)
  if (window.location.protocol.startsWith('http')) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 400);
      const res = await fetch('/api/sync-data', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const diskData = await res.json();
        if (diskData.characters && diskData.characters.length > 0) {
          console.log('Restoring data from local project storage (data/nnzrp_data.json)...');
          for (const char of diskData.characters) await db.put('characters', char);
          if (diskData.chats) for (const item of diskData.chats) await db.put('chats', item);
          if (diskData.messages) for (const item of diskData.messages) await db.put('messages', item);
          if (diskData.personas) for (const item of diskData.personas) await db.put('personas', item);
          if (diskData.proxies) for (const item of diskData.proxies) await db.put('proxies', item);
          if (diskData.settings) for (const item of diskData.settings) await db.put('settings', item);
        }
      }
    } catch (err) {
      console.warn('Local disk data sync check bypassed:', err);
    }
  }

  const charCount = await db.count('characters');
  if (charCount === 0) {
    console.log('Seeding initial sample characters...');
    for (const char of APP_CONFIG.SAMPLE_CHARACTERS) {
      await db.put('characters', {
        ...char,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }
  }

  const personaCount = await db.count('personas');
  if (personaCount === 0) {
    await db.put('personas', {
      id: 'persona-default',
      ...APP_CONFIG.DEFAULT_PERSONA,
      isDefault: true,
      createdAt: Date.now()
    });
  }

  const proxyCount = await db.count('proxies');
  if (proxyCount === 0) {
    for (const proxy of APP_CONFIG.DEFAULT_PROXIES) {
      await db.put('proxies', {
        ...proxy,
        createdAt: Date.now()
      });
    }
  }

  const genSettings = await db.get('settings', 'generationSettings');
  if (!genSettings) {
    await db.put('settings', {
      key: 'generationSettings',
      value: APP_CONFIG.DEFAULT_GENERATION_SETTINGS
    });
  }

  const globalPrompt = await db.get('settings', 'globalSystemPrompt');
  if (!globalPrompt) {
    await db.put('settings', {
      key: 'globalSystemPrompt',
      value: APP_CONFIG.DEFAULT_GLOBAL_SYSTEM_PROMPT
    });
  }

  const presets = await db.get('settings', 'systemPromptPresets');
  if (!presets) {
    await db.put('settings', {
      key: 'systemPromptPresets',
      value: APP_CONFIG.DEFAULT_SYSTEM_PROMPT_PRESETS
    });
  }

  // Backup current state to local disk JSON file
  syncToDisk();
}

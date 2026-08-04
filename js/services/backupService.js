/* js/services/backupService.js - Complete Full Application Data Backup & Restore */
import { db, syncToDisk } from '../storage/db.js';

export class BackupService {
  /**
   * Export all database stores (characters, chats, messages, personas, proxies with API keys, settings) into a single JSON file download
   */
  static async exportAllData() {
    const backupData = {
      app: 'NnzRP',
      version: '1.0',
      exportedAt: new Date().toISOString(),
      timestamp: Date.now(),
      data: {
        characters: await db.getAll('characters'),
        chats: await db.getAll('chats'),
        messages: await db.getAll('messages'),
        personas: await db.getAll('personas'),
        proxies: await db.getAll('proxies'),
        settings: await db.getAll('settings')
      }
    };

    const jsonString = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `nnzrp_full_backup_${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Import backup JSON file and write all records into IndexedDB stores
   */
  static async importAllData(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const json = JSON.parse(e.target.result);
          const dataObj = json.data ? json.data : json;

          const stats = {
            characters: 0,
            chats: 0,
            messages: 0,
            personas: 0,
            proxies: 0,
            settings: 0
          };

          if (Array.isArray(dataObj.characters)) {
            for (const item of dataObj.characters) {
              const id = item.id || `char-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
              await db.put('characters', { ...item, id });
              stats.characters++;
            }
          }

          if (Array.isArray(dataObj.chats)) {
            for (const item of dataObj.chats) {
              if (item.id) { await db.put('chats', item); stats.chats++; }
            }
          }

          if (Array.isArray(dataObj.messages)) {
            for (const item of dataObj.messages) {
              if (item.id) { await db.put('messages', item); stats.messages++; }
            }
          }

          if (Array.isArray(dataObj.personas)) {
            for (const item of dataObj.personas) {
              const id = item.id || `persona-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
              await db.put('personas', { ...item, id });
              stats.personas++;
            }
          }

          if (Array.isArray(dataObj.proxies)) {
            for (const item of dataObj.proxies) {
              const id = item.id || `proxy-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
              await db.put('proxies', { ...item, id });
              stats.proxies++;
            }
          }

          if (Array.isArray(dataObj.settings)) {
            for (const item of dataObj.settings) {
              const key = item.key || item.id;
              if (key) { await db.put('settings', { ...item, key }); stats.settings++; }
            }
          }

          await syncToDisk();
          resolve(stats);
        } catch (err) {
          reject(new Error('Invalid NnzRP Backup File: ' + err.message));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file.'));
      reader.readAsText(file);
    });
  }
}

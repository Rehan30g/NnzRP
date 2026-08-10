/* js/storage/characterStore.js - AI Character Storage CRUD */
import { db, syncToDisk } from './db.js';

export class CharacterStore {
  static async getAll() {
    const all = await db.getAll('characters');
    return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  static async getById(id) {
    return await db.get('characters', id);
  }

  static async save(characterData) {
    const now = Date.now();
    const id = characterData.id || `char-${now}-${Math.random().toString(36).substr(2, 5)}`;
    const payload = {
      ...characterData,
      id,
      updatedAt: now,
      createdAt: characterData.createdAt || now
    };
    await db.put('characters', payload);
    syncToDisk();
    return payload;
  }

  static async delete(id) {
    const chats = await db.getByIndex('chats', 'characterId', id);
    for (const chat of chats) {
      const msgs = await db.getByIndex('messages', 'chatId', chat.id);
      for (const m of msgs) {
        await db.delete('messages', m.id);
      }
      await db.delete('chats', chat.id);
    }
    await db.delete('characters', id);
    syncToDisk();
  }
}

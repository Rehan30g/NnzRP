/* js/storage/personaStore.js - User Player Persona Storage */
import { db } from './db.js';

export class PersonaStore {
  static async getAll() {
    return await db.getAll('personas');
  }

  static async getById(id) {
    return await db.get('personas', id);
  }

  static async getDefault() {
    const all = await this.getAll();
    const def = all.find(p => p.isDefault);
    return def || all[0] || null;
  }

  static async save(personaData) {
    const now = Date.now();
    const id = personaData.id || `persona-${now}-${Math.random().toString(36).substr(2, 5)}`;

    if (personaData.isDefault) {
      const personas = await db.getAll('personas');
      for (const p of personas) {
        if (p.isDefault && p.id !== id) {
          p.isDefault = false;
          await db.put('personas', p);
        }
      }
    }

    const payload = {
      ...personaData,
      id,
      updatedAt: now,
      createdAt: personaData.createdAt || now
    };
    await db.put('personas', payload);
    return payload;
  }

  static async delete(id) {
    await db.delete('personas', id);
  }
}

/* js/services/cardImporter.js - Character Card V2 JSON Importer & Exporter */
import { BackupService } from './backupService.js';

export class CardImporter {
  /**
   * Parse uploaded JSON character file or full NnzRP backup file
   */
  static async parseJSONFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const json = JSON.parse(e.target.result);
          const dataObj = json.data ? json.data : json;

          // Detect if this is a Full NnzRP Application Backup File
          if (json.app === 'NnzRP' || (dataObj && (dataObj.proxies || dataObj.personas || dataObj.settings))) {
            const stats = await BackupService.importAllData(file);
            resolve({ isFullBackup: true, stats });
            return;
          }

          const character = CardImporter.normalizeCharacterCard(json);
          resolve(character);
        } catch (err) {
          reject(new Error('Invalid JSON file format: ' + err.message));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file.'));
      reader.readAsText(file);
    });
  }

  /**
   * Normalize Character Card V2 or legacy JSON structure into standard internal format
   */
  static normalizeCharacterCard(json) {
    // Check if wrapping inside speculative spec_version V2 data object
    const data = json.data ? json.data : json;

    return {
      name: data.name || 'Unnamed Character',
      tagline: data.creator_notes || data.tagline || 'Custom AI Roleplay Character',
      avatar: data.avatar || data.image || 'https://api.dicebear.com/7.x/bottts/svg?seed=' + encodeURIComponent(data.name || 'AI'),
      description: data.description || '',
      personality: data.personality || '',
      scenario: data.scenario || '',
      first_mes: data.first_mes || data.first_message || data.greeting || '',
      alt_greetings: data.alternate_greetings || data.alt_greetings || [],
      example_dialogue: data.mes_example || data.example_dialogue || '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      lorebooks: CardImporter.extractLorebooks(data)
    };
  }

  static extractLorebooks(data) {
    if (Array.isArray(data.character_book?.entries)) {
      return data.character_book.entries.map(e => ({
        keys: e.keys || [],
        content: e.content || ''
      }));
    }
    if (Array.isArray(data.lorebooks)) {
      return data.lorebooks;
    }
    return [];
  }

  /**
   * Export Character object to downloadable Character Card V2 JSON
   */
  static exportToJSON(character) {
    const cardV2 = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: character.name,
        description: character.description,
        personality: character.personality,
        scenario: character.scenario,
        first_mes: character.first_mes,
        alternate_greetings: character.alt_greetings || [],
        mes_example: character.example_dialogue,
        creator_notes: character.tagline,
        tags: character.tags || [],
        character_book: {
          entries: (character.lorebooks || []).map(l => ({
            keys: typeof l.keys === 'string' ? l.keys.split(',').map(k => k.trim()) : l.keys,
            content: l.content,
            enabled: true
          }))
        }
      }
    };

    const blob = new Blob([JSON.stringify(cardV2, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${character.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_card.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

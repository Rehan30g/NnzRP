/* js/services/lorebookEngine.js - Dynamic World Info & Lorebook Injection Engine */

export class LorebookEngine {
  /**
   * Scans lorebook entries for key triggers present in recent messages.
   * Returns matching lorebook content strings formatted for prompt injection.
   */
  static getMatchingLore(lorebooks = [], messages = [], scanCount = 10) {
    if (!lorebooks || lorebooks.length === 0) return '';

    // Join text from last N messages
    const recentText = messages
      .slice(-scanCount)
      .map(m => m.content)
      .join(' ')
      .toLowerCase();

    const matchedEntries = [];

    for (const entry of lorebooks) {
      if (!entry.keys || !entry.content) continue;

      let keysArray = [];
      if (Array.isArray(entry.keys)) {
        keysArray = entry.keys;
      } else if (typeof entry.keys === 'string') {
        keysArray = entry.keys.split(',').map(k => k.trim());
      }

      // Check if any keyword matches
      const isMatched = keysArray.some(key => {
        const cleanKey = key.toLowerCase().trim();
        return cleanKey.length > 0 && recentText.includes(cleanKey);
      });

      if (isMatched) {
        matchedEntries.push(entry.content.trim());
      }
    }

    if (matchedEntries.length === 0) return '';

    return `\n[World Info / Lorebook Entries:\n${matchedEntries.map(e => `- ${e}`).join('\n')}]\n`;
  }
}

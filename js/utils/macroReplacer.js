/* js/utils/macroReplacer.js - Universal Macro Replacer for {{user}} and {{char}} */

/**
 * Replaces {{user}} and {{char}} (case-insensitive) macros with actual names.
 * @param {string} text - Source text containing macros
 * @param {string} userName - User persona name from UI/API
 * @param {string} charName - Character name
 * @returns {string} Text with macros replaced
 */
export function replaceMacros(text, userName = 'User', charName = 'Character') {
  if (!text || typeof text !== 'string') return text || '';
  const uName = userName || 'User';
  const cName = charName || 'Character';
  return text
    .replace(/\{\{user\}\}/gi, uName)
    .replace(/\{\{char\}\}/gi, cName);
}

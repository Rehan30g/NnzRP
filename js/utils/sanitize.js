/* js/utils/sanitize.js - Untrusted String Escaping Helpers */

/**
 * Escape text for safe insertion as HTML text content (innerHTML between tags).
 * Neutralizes tag/entity breakout (e.g. <script>, </textarea>) from character
 * cards, chat messages, or any other user/import-supplied string.
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape text for safe insertion inside a double-quoted HTML attribute
 * (e.g. value="...", src="...", title="...").
 */
export function escapeAttr(str) {
  return escapeHtml(str)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

/**
 * Reverses escapeHtml(). Needed specifically for syntax-highlighting fenced
 * code blocks (js/utils/syntaxHighlight.js): chatView.js's markdown pipeline
 * escapeHtml()'s the WHOLE message before handing it to marked.parse() (the
 * load-bearing XSS guard for chat content), so by the time marked's code
 * renderer sees a fenced block's text it's already HTML-entity-escaped -
 * the highlighter needs the original characters back to tokenize
 * tags/strings/keywords correctly, then re-escapes as it builds spans.
 */
export function unescapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

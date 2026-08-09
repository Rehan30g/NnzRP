/* js/utils/tokenEstimate.js - Cheap client-side token estimate (~3.8 chars/token,
 * the same ratio chatView.js's thinking-token badge already used). No
 * provider ships a real tokenizer to the browser, so this is a best-effort
 * approximation for UI purposes (the context-capacity gauge, the thinking
 * token badge) - never used to enforce a hard limit, only to inform the user.
 */
export function estimateTokens(text = '') {
  if (!text || !text.trim()) return 0;
  return Math.max(1, Math.ceil(text.trim().length / 3.8));
}

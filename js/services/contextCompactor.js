/* js/services/contextCompactor.js - Automatic request-time context compaction.
 *
 * Modeled on opencode's compaction, simplified for roleplay: when the
 * assembled history is estimated to be eating most of the active model's
 * context window, summarize the middle stretch into a single continuity
 * summary message before the prompt is built. REQUEST-TIME ONLY - nothing
 * here ever writes to IndexedDB or mutates the caller's array; the stored
 * chat history is never touched (that remains Compact Chat's job, see
 * ChatStore.createCompactedChat). Every failure path returns the ORIGINAL
 * messages unchanged - compaction must never break a generation, it can
 * only fail by being skipped.
 */
import { estimateTokens } from '../utils/tokenEstimate.js';
import { getContextWindowSize } from '../utils/contextWindowSize.js';
import { ProviderManager } from './providerManager.js';

// Same flat per-image estimate the chat header's capacity gauge uses
// (chatView.js refreshContextGauge) so both agree on how full a
// heavily image-attached conversation really is.
const TOKENS_PER_IMAGE = 800;

// Compaction only engages once the history is estimated to fill at least
// this fraction of the model's context window - below that, sending the
// full verbatim history is both better for roleplay continuity and free.
const COMPACT_THRESHOLD = 0.7;

// Opening scene kept verbatim / most recent turns kept verbatim. Keeping
// the last 10 intact also preserves triggerAIGeneration's invariant that
// the last stored message is still the user's own latest turn.
const KEEP_FIRST = 2;
const KEEP_LAST = 10;

export class ContextCompactor {
  /**
   * Best-effort token estimate over the history - same heuristic as
   * refreshContextGauge() in chatView.js (chars/3.8 plus ~800 per image).
   */
  static estimateHistoryTokens(messages) {
    let tokens = 0;
    for (const m of messages || []) {
      tokens += estimateTokens(m.content || '');
      if (Array.isArray(m.images)) tokens += m.images.length * TOKENS_PER_IMAGE;
    }
    return tokens;
  }

  /**
   * Flattens the middle stretch into a plain prose transcript for the
   * summarization call. Empty-content messages (shouldn't normally exist,
   * but don't let one produce a bare "[User]:" line) are skipped.
   */
  static buildTranscript(messages) {
    const lines = [];
    for (const m of messages) {
      const text = (m.content || '').trim();
      if (!text) continue;
      lines.push(`[${m.role === 'user' ? 'User' : 'Assistant'}]: ${text}`);
    }
    return lines.join('\n\n');
  }

  /**
   * Returns a possibly-shortened NEW messages array. Fast path: anything
   * under the size threshold (or too short to compact safely) comes back
   * as the exact same reference, untouched.
   */
  static async maybeCompact({ proxy, character, persona, globalSystemPrompt, messages, signal }) {
    try {
      if (!proxy || !Array.isArray(messages)) return messages;
      // Nothing to summarize if the kept windows would cover everything -
      // slicing below already guards against overlap, but skip the whole
      // flow rather than make a summarization call over an empty transcript.
      if (messages.length <= KEEP_FIRST + KEEP_LAST) return messages;

      const windowSize = getContextWindowSize(proxy);
      const estimated = this.estimateHistoryTokens(messages);
      if (estimated < windowSize * COMPACT_THRESHOLD) return messages;

      const lastStart = Math.max(KEEP_FIRST, messages.length - KEEP_LAST);
      const first = messages.slice(0, KEEP_FIRST);
      const last = messages.slice(lastStart);
      const transcript = this.buildTranscript(messages.slice(KEEP_FIRST, lastStart));
      if (!transcript.trim()) return messages;

      const charName = character?.name || 'the characters';
      const userName = persona?.name || 'the user';
      const systemPrompt =
        `You are a continuity summarizer for an ongoing third-person roleplay between ${userName} and ${charName}. ` +
        `Produce a concise continuity summary of the conversation transcript you are given. ` +
        `Preserve names, relationships, locations, promises, unresolved plot threads, emotional states, and ongoing scene details exactly as established. ` +
        `Write in third person, past tense, as neutral narrative notes - not prose fiction. ` +
        `Output ONLY the summary text itself: no commentary, no headings, no meta remarks.`;
      const summaryPayload = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcript }
      ];
      // Low temperature + modest token cap: this is note-taking, not writing.
      const summarySettings = { temperature: 0.3, topP: 0.95, maxTokens: 1024 };

      const result = await ProviderManager.sendChatCompletion(proxy, summaryPayload, summarySettings, { signal });
      const summary = (result?.content || '').trim();
      if (!summary) throw new Error('Summarization call returned empty content.');

      // 'user' role keeps strict alternation safe after an assistant opening;
      // PromptBuilder.buildPromptPayload coerces roles and merges consecutive
      // same-role turns anyway, so this slots cleanly into any shape of history.
      const summaryMessage = {
        role: 'user',
        content: `[Continuity summary of earlier events]\n${summary}\n[End of summary. Continue seamlessly from here.]`
      };

      return [...first, summaryMessage, ...last];
    } catch (err) {
      console.warn('[ContextCompactor] Auto-compaction failed, continuing with full history:', err);
      return messages;
    }
  }
}

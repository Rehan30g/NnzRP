/* js/utils/thinkingParser.js - Splits <think>/<thinking> reasoning blocks out of model output */

// Matches a complete <think>...</think> or <thinking>...</thinking> block (case-insensitive).
// Group 1 captures the tag name so the closing tag is forced to match the opening one.
const FULL_TAG_RE = /<(think|thinking)>([\s\S]*?)<\/\1>/gi;

// Single-tag matchers used by the incremental scanner (no capture needed there).
const OPEN_RE = /<think(?:ing)?>/i;
const CLOSE_RE = /<\/think(?:ing)?>/i;

const OPEN_CANDIDATES = ['<think>', '<thinking>'];
const CLOSE_CANDIDATES = ['</think>', '</thinking>'];

/**
 * Splits a COMPLETE (non-streaming) response string into { thinking, content }.
 * Recognizes <think>...</think> and <thinking>...</thinking> tags (case-insensitive),
 * possibly multiple occurrences. All thinking segments are concatenated (joined by
 * "\n\n") and stripped out of the returned content. Both fields are trimmed.
 */
export function extractThinking(rawText = '') {
  const source = typeof rawText === 'string' ? rawText : String(rawText || '');
  const thinkingParts = [];

  const content = source.replace(FULL_TAG_RE, (_match, _tag, inner) => {
    thinkingParts.push(inner);
    return '';
  });

  return {
    thinking: thinkingParts.join('\n\n').trim(),
    content: content.trim()
  };
}

/**
 * Finds the length of the longest trailing suffix of `text` that is itself a valid
 * prefix of one of `candidates` (i.e. could still grow into a full tag once more
 * text arrives). Returns 0 if no such suffix exists.
 */
function longestPartialTagSuffixLength(text, candidates) {
  const maxCandidateLen = Math.max(...candidates.map(c => c.length));
  const upperBound = Math.min(text.length, maxCandidateLen - 1);

  for (let len = upperBound; len > 0; len--) {
    const suffix = text.slice(text.length - len).toLowerCase();
    if (candidates.some(c => c.toLowerCase().startsWith(suffix))) {
      return len;
    }
  }
  return 0;
}

/**
 * Stateful incremental parser for streaming responses. Feed it raw text deltas as
 * they arrive over the wire (a tag may be split across two calls) and it routes
 * text into onThinkingChunk/onContentChunk based on whether it is currently inside
 * a <think>/<thinking> block.
 */
export class ThinkingStreamParser {
  constructor({ onThinkingChunk, onContentChunk } = {}) {
    this.onThinkingChunk = typeof onThinkingChunk === 'function' ? onThinkingChunk : null;
    this.onContentChunk = typeof onContentChunk === 'function' ? onContentChunk : null;
    this.buffer = '';
    this.insideThinking = false;
  }

  _emit(text) {
    if (!text) return;
    if (this.insideThinking) {
      if (this.onThinkingChunk) this.onThinkingChunk(text);
    } else if (this.onContentChunk) {
      this.onContentChunk(text);
    }
  }

  /**
   * Feed the next raw text delta from the stream.
   */
  push(textDelta) {
    if (!textDelta) return;

    let combined = this.buffer + textDelta;
    this.buffer = '';

    for (;;) {
      const re = this.insideThinking ? CLOSE_RE : OPEN_RE;
      const match = re.exec(combined);
      if (!match) break;

      const before = combined.slice(0, match.index);
      this._emit(before);
      combined = combined.slice(match.index + match[0].length);
      this.insideThinking = !this.insideThinking;
    }

    const candidates = this.insideThinking ? CLOSE_CANDIDATES : OPEN_CANDIDATES;
    const partialLen = longestPartialTagSuffixLength(combined, candidates);

    if (partialLen > 0) {
      this._emit(combined.slice(0, combined.length - partialLen));
      this.buffer = combined.slice(combined.length - partialLen);
    } else {
      this._emit(combined);
      this.buffer = '';
    }
  }

  /**
   * Call when the stream ends; flushes any buffered partial text as content
   * (in case of an unterminated/malformed tag) so nothing is silently dropped.
   */
  end() {
    if (this.buffer) {
      this._emit(this.buffer);
      this.buffer = '';
    }
  }
}

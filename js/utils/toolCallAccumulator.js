/* js/utils/toolCallAccumulator.js - Assembles streamed tool-call deltas (arriving as
 * fragmented JSON-argument strings across many SSE chunks) into finished
 * { id, name, args } calls. One instance per in-flight completion. */

export class ToolCallAccumulator {
  constructor() {
    this.byIndex = new Map(); // index/key -> { id, name, argsStr }
  }

  _entry(index) {
    let entry = this.byIndex.get(index);
    if (!entry) {
      entry = { id: '', name: '', argsStr: '' };
      this.byIndex.set(index, entry);
    }
    return entry;
  }

  /** OpenAI-style: `delta.tool_calls[i]` fragments, `function.arguments` is a partial JSON string. */
  addOpenAIDelta(deltaToolCalls = []) {
    for (const tc of deltaToolCalls) {
      // Some OpenAI-compatible backends omit `index` on parallel tool calls.
      // Falling back to a constant 0 merged two distinct calls into one entry
      // (concatenated names + unparseable concatenated args), so prefer the
      // call id as the key whenever the index really is missing.
      const key = (typeof tc.index === 'number') ? tc.index : (tc.id ? `id_${tc.id}` : 0);
      const entry = this._entry(key);
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name += tc.function.name;
      if (typeof tc.function?.arguments === 'string') entry.argsStr += tc.function.arguments;
    }
  }

  /** Anthropic: `content_block_start` (type tool_use) gives id+name for a block index. */
  startAnthropicBlock(index, { id, name }) {
    const entry = this._entry(index);
    entry.id = id || entry.id;
    entry.name = name || entry.name;
  }

  /** Anthropic: `content_block_delta` (type input_json_delta) fragments `.partial_json`. */
  appendAnthropicJsonDelta(index, partialJson) {
    if (typeof partialJson !== 'string') return;
    this._entry(index).argsStr += partialJson;
  }

  /** Gemini: `functionCall` parts arrive as one complete object, no fragment assembly needed. */
  addComplete({ id, name, args }) {
    const entry = this._entry(`complete_${this.byIndex.size}`);
    entry.id = id || name;
    entry.name = name;
    entry.argsStr = JSON.stringify(args || {});
  }

  hasAny() {
    return this.byIndex.size > 0;
  }

  /** Finalizes all accumulated calls, parsing each one's JSON argument string. */
  finalize() {
    const calls = [];
    for (const entry of this.byIndex.values()) {
      if (!entry.name) continue;
      let args = {};
      let argsError = null;
      try {
        args = entry.argsStr ? JSON.parse(entry.argsStr) : {};
      } catch {
        // Substituting {} used to run the tool with NO arguments, which for a
        // destructive tool is far worse than failing - flag it instead so the
        // caller refuses to execute and tells the model what happened.
        args = {};
        argsError = `Tool arguments were truncated or were not valid JSON: ${entry.argsStr}`;
      }
      calls.push({ id: entry.id || entry.name, name: entry.name, args, argsError });
    }
    return calls;
  }
}

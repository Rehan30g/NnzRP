/* js/services/agentRunner.js - Bounded agentic tool-use loop on top of ProviderManager.
 * This is what lets a character call MCP tools more than once (and in more than
 * one round) before producing the final in-character reply, instead of the old
 * feature's single prompt-only "pretend you have tools" call. */
import { ProviderManager } from './providerManager.js';
import { MCPToolRegistry } from './mcpToolRegistry.js';

export class AgentRunner {
  /**
   * @param {object} opts
   * @param {object} opts.proxy - active AI proxy config
   * @param {Array} opts.initialPayload - PromptBuilder-style payload
   * @param {object} opts.settings - generation settings
   * @param {Array} opts.tools - MCPToolRegistry.getActiveTools() result (may be empty)
   * @param {boolean} opts.streaming
   * @param {AbortSignal} [opts.signal]
   * @param {object} [opts.callbacks] - onContentChunk/onThinkingChunk/onToolExecuting/onToolResult/onRoundComplete
   * @param {(soFar: {content, thinking, toolTrace}) => Promise<void>|void} [opts.callbacks.onRoundComplete] -
   *   fired after each round that called tool(s), with everything the turn has accumulated SO FAR
   *   (all rounds' lead-in text joined by a blank line, same for thinking, plus every tool call
   *   used so far). This is a *live-display re-sync* signal, not a "commit a message" signal:
   *   one user turn always produces exactly ONE assistant message no matter how many tool rounds
   *   it took. Callers use it to re-seed their streaming buffers so the next round's chunks
   *   continue the same message instead of being appended to a stale buffer (which rendered as
   *   duplicated/garbled text) or replacing it (which made the pre-tool narration disappear).
   * @param {number} [opts.maxIterations]
   * @param {(result: {content,thinking,toolCalls}) => {content,thinking}} [opts.transformFirstResult] -
   *   optional post-processing applied only to the very first round's result (before checking for
   *   tool calls) - used by chatView to re-merge response-prefill seed text, which only ever
   *   applies to the first raw model continuation, not to later tool-result-driven rounds.
   * @returns {Promise<{content: string, thinking: string, toolTrace: Array, segments: Array}>} the WHOLE turn:
   *   every round's narration joined with a blank line (not just the final round's text, which
   *   used to silently drop the "let me look that up" lead-in a model writes before calling a
   *   tool), every round's thinking, and every tool call made. `segments` is the same turn broken
   *   down per round instead of joined - `[{ text, tools }, ...]`, one entry per round, in order,
   *   where `tools` is that round's own slice of `toolTrace` (the entries it added) and the LAST
   *   segment (the round that ended the loop with no tool calls) has no `tools`. This is what lets
   *   a caller place an inline "tool used here" marker at the exact point between two rounds'
   *   text instead of only being able to show one note below the whole joined message.
   */
  static async run({ proxy, initialPayload, settings, tools = [], streaming = false, signal, callbacks = {}, maxIterations, transformFirstResult }) {
    const limit = maxIterations || settings.mcpMaxToolIterations || 6;
    let payload = initialPayload;
    const toolTrace = [];
    // Per-round text kept so the caller gets the full turn, not just the last round.
    const contentParts = [];
    const thinkingParts = [];
    // Per-round breakdown ({text, tools}) mirroring contentParts, but keeping each
    // round's OWN slice of toolTrace attached instead of only the flat aggregate -
    // see the `segments` return value in the JSDoc above.
    const segments = [];

    // Single-round (i.e. every tool-less) turn returns its one part byte-for-byte
    // unchanged - the no-MCP path must behave exactly as it did before this loop existed.
    const joinParts = (parts) => {
      if (parts.length <= 1) return parts[0] || '';
      const kept = parts.filter(p => p && p.trim());
      return kept.length ? kept.join('\n\n') : '';
    };

    for (let i = 0; i < limit; i++) {
      let result = streaming
        ? await ProviderManager.streamChatCompletion(proxy, payload, settings, {
            tools,
            signal,
            onContentChunk: callbacks.onContentChunk,
            onThinkingChunk: callbacks.onThinkingChunk
          })
        : await ProviderManager.sendChatCompletion(proxy, payload, settings, { tools, signal });

      if (i === 0 && typeof transformFirstResult === 'function') {
        result = { ...result, ...transformFirstResult(result) };
      }

      const toolCalls = result.toolCalls || [];
      if (toolCalls.length === 0) {
        contentParts.push(result.content || '');
        thinkingParts.push(result.thinking || '');
        // Final round - no tools, so no `tools` key (matches the JSDoc's
        // "last segment has no tools" contract; keeps this segment
        // indistinguishable from old data when a caller checks `.tools?.length`).
        segments.push({ text: result.content || '' });
        return { content: joinParts(contentParts), thinking: joinParts(thinkingParts), toolTrace, segments };
      }

      // Assistant turn that decided to call tool(s) - keep any lead-in text it wrote,
      // both for the next request's payload and for the caller's single final message.
      payload = [...payload, { role: 'assistant', content: result.content || '', toolCalls }];
      contentParts.push(result.content || '');
      thinkingParts.push(result.thinking || '');

      // This round's own slice of toolTrace - kept separate from the flat
      // aggregate so `segments` can attach exactly the tool(s) THIS round
      // called, not everything called so far.
      const roundTrace = [];
      for (const call of toolCalls) {
        callbacks.onToolExecuting?.(call);
        let content;
        try {
          content = await MCPToolRegistry.executeTool(call.name, call.args);
        } catch (err) {
          content = `Error: ${err.message}`;
        }
        const entry = { name: call.name, args: call.args, result: content };
        toolTrace.push(entry);
        roundTrace.push(entry);
        callbacks.onToolResult?.(call, content);
        payload = [...payload, { role: 'tool', toolCallId: call.id, toolName: call.name, content }];
      }

      segments.push({ text: result.content || '', tools: roundTrace });

      // Round boundary: hand the caller everything accumulated so far so it can
      // re-sync its live streaming buffers. This does NOT mean "commit a message" -
      // the whole turn stays one message (see the callback's JSDoc above).
      await callbacks.onRoundComplete?.({
        content: joinParts(contentParts),
        thinking: joinParts(thinkingParts),
        toolTrace: [...toolTrace],
        segments: segments.map(s => ({ ...s, tools: s.tools ? [...s.tools] : undefined }))
      });
      // Loop again - the model gets the tool result(s) and decides whether it
      // needs to call more tools or is ready to write the final reply.
    }

    throw new Error(`MCP tool-use loop exceeded ${limit} iterations without a final response. Check the enabled MCP tools for a loop.`);
  }
}

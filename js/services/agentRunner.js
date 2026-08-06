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
   * @param {object} [opts.callbacks] - onContentChunk/onThinkingChunk/onToolExecuting/onToolResult/onIntermediateMessage
   * @param {(round: {content, thinking, toolTrace}) => Promise<void>|void} [opts.callbacks.onIntermediateMessage] -
   *   fired after each round that called tool(s), with that round's own lead-in text and the
   *   tool(s) it used - lets the caller persist/render it as its own real chat message
   *   (Claude-Code-style interleaved text+tool turns) instead of only ever seeing the final
   *   round's text. Optional - callers that don't care (e.g. swipe-regenerate) can omit it and
   *   just use the aggregated `toolTrace` in the return value instead.
   * @param {number} [opts.maxIterations]
   * @param {(result: {content,thinking,toolCalls}) => {content,thinking}} [opts.transformFirstResult] -
   *   optional post-processing applied only to the very first round's result (before checking for
   *   tool calls) - used by chatView to re-merge response-prefill seed text, which only ever
   *   applies to the first raw model continuation, not to later tool-result-driven rounds.
   * @returns {Promise<{content: string, thinking: string, toolTrace: Array}>}
   */
  static async run({ proxy, initialPayload, settings, tools = [], streaming = false, signal, callbacks = {}, maxIterations, transformFirstResult }) {
    const limit = maxIterations || settings.mcpMaxToolIterations || 6;
    let payload = initialPayload;
    const toolTrace = [];

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
        return { content: result.content, thinking: result.thinking, toolTrace };
      }

      // Assistant turn that decided to call tool(s) - keep any lead-in text it wrote.
      payload = [...payload, { role: 'assistant', content: result.content || '', toolCalls }];

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
        roundTrace.push(entry);
        toolTrace.push(entry);
        callbacks.onToolResult?.(call, content);
        payload = [...payload, { role: 'tool', toolCallId: call.id, toolName: call.name, content }];
      }

      // Claude-Code-style: surface this round's lead-in text + which tools it
      // used as its own visible chat turn (if the caller wants that), instead
      // of only ever showing the FINAL round's text and folding everything
      // else silently into the thinking block.
      await callbacks.onIntermediateMessage?.({ content: result.content || '', thinking: result.thinking || '', toolTrace: roundTrace });
      // Loop again - the model gets the tool result(s) and decides whether it
      // needs to call more tools or is ready to write the final reply.
    }

    throw new Error(`MCP tool-use loop exceeded ${limit} iterations without a final response. Check the enabled MCP tools for a loop.`);
  }
}

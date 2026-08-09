/* js/services/agentRunner.js - Bounded agentic tool-use loop on top of ProviderManager.
 * This is what lets a character call MCP tools more than once (and in more than
 * one round) before producing the final in-character reply, instead of the old
 * feature's single prompt-only "pretend you have tools" call. */
import { ProviderManager } from './providerManager.js';
import { MCPToolRegistry } from './mcpToolRegistry.js';
import { BUILTIN_VIEW_IMAGE_TOOL, executeBuiltinImageTool, BUILTIN_EMBED_HTML_TOOL, executeBuiltinEmbedHtmlTool } from './builtinTools.js';

/**
 * What both the persisted tool trace AND the model itself are told when the
 * user refuses a tool call. It deliberately goes into the `role:'tool'`
 * payload message too: if the model never learns the call didn't happen it
 * either hangs waiting on data that will never arrive or hallucinates a
 * result, instead of reacting in character and continuing the scene.
 */
export const TOOL_DECLINED_NOTICE = 'Declined by user. The tool was NOT executed and returned no data - continue without it.';

export class AgentRunner {
  /**
   * @param {object} opts
   * @param {object} opts.proxy - active AI proxy config
   * @param {Array} opts.initialPayload - PromptBuilder-style payload
   * @param {object} opts.settings - generation settings
   * @param {Array} opts.tools - MCPToolRegistry.getActiveTools() result (may be empty)
   * @param {boolean} opts.streaming
   * @param {AbortSignal} [opts.signal]
   * @param {object} [opts.callbacks] - onContentChunk/onThinkingChunk/onPermissionRequest/onToolExecuting/onToolDeclined/onToolResult/onRoundComplete
   * @param {(call: {id,name,args}) => Promise<'allow'|'decline'>|'allow'|'decline'} [opts.callbacks.onPermissionRequest] -
   *   asked once per tool call, awaited BEFORE the call runs and before
   *   `onToolExecuting` fires. Returning 'decline' means the tool is never
   *   executed; the model is told so via a `TOOL_DECLINED_NOTICE` tool-result
   *   message so it can react in character instead of the turn breaking.
   *   Omitting the callback defaults to 'allow' (an optional callback must not
   *   change behavior for non-UI callers) - the chat UI ALWAYS supplies it, and
   *   its own default for an unconfigured tool is to prompt the user.
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
        // The user pressed stop while an earlier call in this round was
        // running (or while its permission prompt was open) - bail out now
        // instead of running the remaining calls and only failing on the
        // next provider request.
        if (signal?.aborted) throw new DOMException('Generation aborted by user.', 'AbortError');

        // PERMISSION GATE - runs BEFORE onToolExecuting so the "tool is
        // running" live spinner never appears while we're actually still
        // waiting on the user's decision. An absent callback defaults to
        // 'allow' to preserve this file's "optional callback = no behavior
        // change" convention for non-UI callers, but BOTH real chatView call
        // sites always supply it (leaving one unwired would silently restore
        // the old unprompted-execution behavior).
        let decision = 'allow';
        if (typeof callbacks.onPermissionRequest === 'function') {
          try {
            decision = await callbacks.onPermissionRequest(call);
          } catch (err) {
            // A prompt that errored/was torn down is treated as a refusal -
            // failing closed is the only safe direction here.
            decision = 'decline';
          }
        }

        let content;
        // Only set for the builtin view-image tool's successful runs - see
        // the payload-injection comment below for why this rides in as a
        // separate message instead of living inside the tool-result entry.
        let fetchedImages = null;
        // Only set for the builtin embed-html tool's successful runs - unlike
        // fetchedImages this never needs to go back into `payload` (the model
        // gets no pixels/markup back, it's UI-only), it just rides along on
        // the trace entry for chatView.js to persist/render.
        let embeddedHtml = null;
        if (decision === 'decline') {
          // Never touches MCPToolRegistry.executeTool - the tool genuinely
          // does not run. Still traced (exactly like an error result is) so
          // the refusal is visible in the message's tool-trace block rather
          // than the call silently vanishing.
          content = TOOL_DECLINED_NOTICE;
          callbacks.onToolDeclined?.(call);
        } else {
          callbacks.onToolExecuting?.(call);
          try {
            // The builtin image-fetch and embed-html tools
            // (js/services/builtinTools.js) have no MCP server behind them,
            // so they're dispatched here instead of going through
            // MCPToolRegistry.executeTool.
            if (call.name === BUILTIN_VIEW_IMAGE_TOOL) {
              const result = await executeBuiltinImageTool(call.args);
              content = result.text;
              fetchedImages = result.images;
            } else if (call.name === BUILTIN_EMBED_HTML_TOOL) {
              const result = await executeBuiltinEmbedHtmlTool(call.args);
              content = result.text;
              embeddedHtml = { html: result.html, title: result.title };
            } else {
              content = await MCPToolRegistry.executeTool(call.name, call.args);
            }
          } catch (err) {
            content = `Error: ${err.message}`;
          }
        }
        const entry = { name: call.name, args: call.args, result: content };
        if (decision === 'decline') entry.declined = true;
        // Lets chatView.js persist/render the fetched image as part of the
        // final chat message too, not just feed it to the model (see the
        // synthetic payload turn below) - the user should be able to SEE what
        // the character just "looked at".
        if (fetchedImages && fetchedImages.length) entry.images = fetchedImages;
        // Same idea for the embed-html tool: chatView.js's collectToolEmbeds()
        // picks these up to build the persisted message's `embeds` field, so
        // the sandboxed iframe renders once the message commits. Never set
        // when `decision === 'decline'` (embeddedHtml stays null in that
        // branch above) - a declined call must never render anything.
        if (embeddedHtml) {
          entry.html = embeddedHtml.html;
          entry.htmlTitle = embeddedHtml.title;
        }
        toolTrace.push(entry);
        roundTrace.push(entry);
        callbacks.onToolResult?.(call, content);
        payload = [...payload, { role: 'tool', toolCallId: call.id, toolName: call.name, content }];
        if (fetchedImages && fetchedImages.length) {
          // OpenAI tool-role messages must be plain text (no image content
          // blocks allowed there) and Gemini's functionResponse part has no
          // image slot either, so instead of special-casing every provider's
          // tool-result wire format, the fetched image rides in as a normal
          // app-injected user turn right after the tool result. This reuses
          // the exact same `images` field/handling real user-uploaded
          // attachments use in providerManager.js's translators, so it needs
          // no provider-specific code of its own.
          payload = [...payload, {
            role: 'user',
            content: '[System note: the image requested above was fetched successfully and is attached for you to view.]',
            images: fetchedImages
          }];
        }
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

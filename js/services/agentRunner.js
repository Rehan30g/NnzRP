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

// Tool results larger than this are cut before being fed back to the model -
// a single huge MCP output would otherwise blow the context window for the
// rest of the turn. Only the payload copy is capped; the trace entry keeps
// the full text so the UI history stays complete.
const TOOL_OUTPUT_LIMIT = 20000;

const DOOM_LOOP_NOTICE = 'Blocked: this exact tool call has already been made twice with identical arguments. Do not repeat it again; use a different approach or answer directly.';

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
   * @param {string} [opts.characterAvatar] - the active character's own avatar (a URL or a
   *   `data:` URL if it was uploaded locally), forwarded as execution context to the builtin
   *   view-image/embed-html tools (js/services/builtinTools.js) so the model can reference "the
   *   character's own photo" via the `{{char_avatar}}` placeholder instead of needing to know/
   *   retype the real value - which for an uploaded avatar can be a very long base64 string a
   *   model would likely mangle or waste a huge number of tokens reproducing.
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
  static async run({ proxy, initialPayload, settings, tools = [], streaming = false, signal, callbacks = {}, maxIterations, transformFirstResult, characterAvatar }) {
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
    // Doom-loop detection: consecutive identical calls (same qualified name +
    // JSON-equal args) across rounds. The third repeat is refused without
    // executing; any different call resets the counter.
    let lastCallKey = null;
    let repeatCount = 0;

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
      // Image turns are buffered and flushed AFTER the whole round's tool
      // results - every provider requires the results answering one assistant
      // tool-call turn to be contiguous.
      const pendingImageTurns = [];
      for (const call of toolCalls) {
        // The user pressed stop while an earlier call in this round was
        // running (or while its permission prompt was open) - bail out now
        // instead of running the remaining calls and only failing on the
        // next provider request.
        if (signal?.aborted) throw new DOMException('Generation aborted by user.', 'AbortError');

        // DOOM-LOOP GATE - checked before onPermissionRequest so the user is
        // never prompted for a repeat we are about to refuse anyway.
        const callKey = JSON.stringify([call.name, call.args]);
        if (callKey === lastCallKey) repeatCount++;
        else { lastCallKey = callKey; repeatCount = 1; }
        if (repeatCount >= 3) {
          const entry = { name: call.name, args: call.args, result: DOOM_LOOP_NOTICE, blocked: true };
          toolTrace.push(entry);
          roundTrace.push(entry);
          callbacks.onToolResult?.(call, DOOM_LOOP_NOTICE, entry);
          payload = [...payload, { role: 'tool', toolCallId: call.id, toolName: call.name, content: DOOM_LOOP_NOTICE }];
          continue;
        }

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
            const answer = await callbacks.onPermissionRequest(call);
            // Fail CLOSED on anything that is not the exact string 'allow':
            // 'ask', undefined (a callback that forgot to return), null, true,
            // 'ALLOW' etc. must never end up executing the tool. Mirrors
            // MCPStore.normalizePermission()'s whitelist approach.
            decision = answer === 'allow' ? 'allow' : 'decline';
          } catch (err) {
            // A prompt that errored/was torn down is treated as a refusal -
            // failing closed is the only safe direction here.
            decision = 'decline';
          }
        }

        let content;
        // Set for ANY tool call that comes back with viewable images - the
        // builtin view-image tool's fetch, OR (see MCPToolRegistry.executeTool/
        // parseResult) an MCP server tool that returns MCP `image` content
        // blocks itself, e.g. a browser-automation server's screenshot
        // capability. Handled identically either way from here on - see the
        // payload-injection comment below for why this rides in as a
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
        } else if (call.argsError) {
          // Never execute a call whose arguments failed to parse - see
          // ToolCallAccumulator.finalize().
          content = `Error: ${call.argsError}`;
        } else {
          callbacks.onToolExecuting?.(call);
          try {
            // The builtin image-fetch and embed-html tools
            // (js/services/builtinTools.js) have no MCP server behind them,
            // so they're dispatched here instead of going through
            // MCPToolRegistry.executeTool. Both get `characterAvatar` as
            // execution context so the model can reference "the character's
            // own photo" via the `{{char_avatar}}` placeholder.
            if (call.name === BUILTIN_VIEW_IMAGE_TOOL) {
              const result = await executeBuiltinImageTool(call.args, { characterAvatar });
              content = result.text;
              fetchedImages = result.images;
            } else if (call.name === BUILTIN_EMBED_HTML_TOOL) {
              const result = await executeBuiltinEmbedHtmlTool(call.args, { characterAvatar });
              content = result.text;
              embeddedHtml = { html: result.html, title: result.title };
            } else {
              const mcpResult = await MCPToolRegistry.executeTool(call.name, call.args);
              content = mcpResult.text;
              fetchedImages = mcpResult.images && mcpResult.images.length ? mcpResult.images : null;
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
        // Pass the full trace entry too: it carries `images`/`html`/`declined`,
        // which the UI needs for its abort-partial save (otherwise a fetched
        // image or embed is lost when the user presses Stop).
        callbacks.onToolResult?.(call, content, entry);
        // The model gets the capped copy; `entry` above already carries the
        // full text for the UI. Covers the successful and error/argsError
        // paths alike - both funnel through this one push.
        let payloadContent = content;
        if (content.length > TOOL_OUTPUT_LIMIT) {
          payloadContent = content.slice(0, TOOL_OUTPUT_LIMIT)
            + `\n\n[Tool output truncated: omitted ${content.length - TOOL_OUTPUT_LIMIT} characters]`;
        }
        payload = [...payload, { role: 'tool', toolCallId: call.id, toolName: call.name, content: payloadContent }];
        if (fetchedImages && fetchedImages.length) {
          // OpenAI tool-role messages must be plain text (no image content
          // blocks allowed there) and Gemini's functionResponse part has no
          // image slot either, so instead of special-casing every provider's
          // tool-result wire format, the fetched image rides in as a normal
          // app-injected user turn. It is QUEUED, not appended here: putting it
          // between two tool results of the same round breaks the "all tool
          // results immediately follow the assistant tool-call turn" rule on
          // OpenAI, Anthropic and Gemini alike.
          pendingImageTurns.push({
            role: 'user',
            content: '[System note: the image requested above was fetched successfully and is attached for you to view.]',
            images: fetchedImages
          });
        }
      }

      for (const turn of pendingImageTurns) payload = [...payload, turn];

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

    // Throwing here made chatView.js take its generic error path and DISCARD
    // the whole turn - every round's narration and every tool result the user
    // already waited for. Return what was actually produced, flagged so a
    // caller can warn about the truncation instead of losing the work.
    console.warn(`[AgentRunner] Tool-use loop hit its ${limit}-iteration cap without a final response.`);
    return {
      content: joinParts(contentParts),
      thinking: joinParts(thinkingParts),
      toolTrace,
      segments,
      limitReached: true
    };
  }
}

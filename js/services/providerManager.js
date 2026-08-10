/* js/services/providerManager.js - Multi-Proxy AI Provider API Abstraction */

import { extractThinking, ThinkingStreamParser } from '../utils/thinkingParser.js';
import { ToolCallAccumulator } from '../utils/toolCallAccumulator.js';
import { parseDataUrl } from '../utils/imageUtils.js';

// "Unlimited" can't literally mean infinite - every provider still requires
// (or effectively caps at) some numeric max_tokens value. When the user picks
// Unlimited (settings.unlimitedTokens, set in Settings -> Model Configurations)
// this sends the highest value that works WITHOUT extra opt-in headers/beta
// flags across the current model lineup, instead of the low default that was
// silently truncating thinking + reply together. Anthropic REQUIRES
// max_tokens outright and most current Claude models cap a standard
// (non-extended-output-beta) response around 8192; OpenAI-compatible and
// Gemini endpoints tolerate a much higher requested value fine.
const UNLIMITED_MAX_TOKENS = { anthropic: 8192, default: 16384 };

function resolveMaxTokens(provider, settings) {
  if (settings.unlimitedTokens) {
    return provider === 'anthropic' ? UNLIMITED_MAX_TOKENS.anthropic : UNLIMITED_MAX_TOKENS.default;
  }
  return settings.maxTokens ? parseInt(settings.maxTokens) : 1024;
}

function safeParseJSON(str) {
  if (!str) return {};
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

/**
 * Groups consecutive {role:'tool'} entries into a single {role:'tool-batch', results}
 * marker. Anthropic and Gemini both require every tool result answering one assistant
 * tool-call turn to land in a single subsequent message/turn (unlike OpenAI, which is
 * happy with one `role:'tool'` message per result).
 */
function groupConsecutiveToolMessages(payload) {
  const out = [];
  for (let i = 0; i < payload.length; i++) {
    const msg = payload[i];
    if (msg.role === 'tool') {
      const results = [msg];
      while (i + 1 < payload.length && payload[i + 1].role === 'tool') {
        i++;
        results.push(payload[i]);
      }
      out.push({ role: 'tool-batch', results });
    } else {
      out.push(msg);
    }
  }
  return out;
}

/** Builds the `tools` request field for OpenAI-compatible Chat Completions APIs. */
function buildOpenAIToolsParam(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: { name: t.qualifiedName, description: t.description || '', parameters: t.inputSchema }
  }));
}

// OpenAI's `image_url.url` accepts a base64 `data:` URI directly, so no
// mime/base64 split is needed here (unlike Anthropic/Gemini below) - just a
// sanity check via parseDataUrl that it really is one before sending it.
function buildOpenAIImageParts(images) {
  return (images || [])
    .filter(img => parseDataUrl(img))
    .map(img => ({ type: 'image_url', image_url: { url: img } }));
}

/** Translates the internal payload (role/content + optional toolCalls/tool role) into
 * OpenAI-compatible `messages`. A no-tool-calls, no-images payload maps through unchanged. */
function toOpenAIMessages(payload) {
  return payload.map(m => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) }
        }))
      };
    }
    // Only ever set on a 'user' message (composer upload, or the builtin
    // image-fetch tool's app-injected follow-up turn - see agentRunner.js).
    if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      parts.push(...buildOpenAIImageParts(m.images));
      return { role: 'user', content: parts.length ? parts : m.content };
    }
    return { role: m.role, content: m.content };
  });
}

function buildAnthropicToolsParam(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({ name: t.qualifiedName, description: t.description || '', input_schema: t.inputSchema }));
}

function buildAnthropicImageBlocks(images) {
  const blocks = [];
  for (const img of images || []) {
    const parsed = parseDataUrl(img);
    if (!parsed) continue;
    blocks.push({ type: 'image', source: { type: 'base64', media_type: parsed.mimeType, data: parsed.base64 } });
  }
  return blocks;
}

/** Translates the internal payload into Anthropic `messages` (system messages excluded - caller joins those separately). */
function toAnthropicMessages(payload) {
  const nonSystem = payload.filter(m => m.role !== 'system');
  const grouped = groupConsecutiveToolMessages(nonSystem);

  return grouped.map(m => {
    if (m.role === 'tool-batch') {
      return {
        role: 'user',
        content: m.results.map(r => ({ type: 'tool_result', tool_use_id: r.toolCallId, content: r.content }))
      };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} });
      return { role: 'assistant', content: blocks };
    }
    // Only ever set on a 'user' message - see the matching comment in toOpenAIMessages.
    if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      blocks.push(...buildAnthropicImageBlocks(m.images));
      return { role: 'user', content: blocks.length ? blocks : m.content };
    }
    return { role: m.role, content: m.content };
  })
  // Anthropic requires strictly alternating user/assistant turns. agentRunner
  // appends an extra `role:'user'` image turn after a tool result when a tool
  // returned images, which would otherwise leave two consecutive user messages
  // and get a 400 back. Merge adjacent same-role turns into one instead.
  .reduce((acc, msg) => {
    const prev = acc[acc.length - 1];
    if (!prev || prev.role !== msg.role) {
      acc.push({ ...msg });
      return acc;
    }
    const toBlocks = (c) => (Array.isArray(c) ? c : [{ type: 'text', text: c || '' }]);
    prev.content = [...toBlocks(prev.content), ...toBlocks(msg.content)];
    return acc;
  }, []);
}

function buildGeminiToolsParam(tools) {
  if (!tools || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map(t => ({ name: t.qualifiedName, description: t.description || '', parameters: t.inputSchema }))
  }];
}

function buildGeminiImageParts(images) {
  const parts = [];
  for (const img of images || []) {
    const parsed = parseDataUrl(img);
    if (!parsed) continue;
    parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } });
  }
  return parts;
}

/** Translates the internal payload into Gemini `contents` (system messages excluded - caller joins those into systemInstruction). */
function toGeminiContents(payload) {
  const nonSystem = payload.filter(m => m.role !== 'system');
  const grouped = groupConsecutiveToolMessages(nonSystem);

  return grouped.map(m => {
    if (m.role === 'tool-batch') {
      return {
        role: 'function',
        parts: m.results.map(r => ({ functionResponse: { name: r.toolName, response: { content: r.content } } }))
      };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls) parts.push({ functionCall: { name: tc.name, args: tc.args || {} } });
      return { role: 'model', parts };
    }
    // Only ever set on a 'user' message - see the matching comment in toOpenAIMessages.
    if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      parts.push(...buildGeminiImageParts(m.images));
      return { role: 'user', parts };
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  });
}

export class ProviderManager {
  /**
   * Test connection to a proxy provider
   */
  static async testConnection(proxy) {
    if (!proxy) throw new Error('Proxy configuration invalid.');
    const { provider, baseUrl, apiKey, selectedModel } = proxy;

    try {
      if (provider === 'gemini') {
        const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models?key=${apiKey}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Gemini API Error (${res.status}): ${await res.text()}`);
        return { success: true, message: 'Google Gemini API Connection Successful!' };
      }

      if (provider === 'anthropic') {
        // Anthropic requires specific header
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'dangerously-allow-browser': 'true'
          },
          body: JSON.stringify({
            model: selectedModel || 'claude-3-5-sonnet-20241022',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'ping' }]
          })
        });
        if (!res.ok) throw new Error(`Anthropic Error (${res.status}): ${await res.text()}`);
        return { success: true, message: 'Anthropic Claude API Connection Successful!' };
      }

      // OpenAI / OpenRouter / Custom OpenAI-compatible Proxy
      const endpoint = `${baseUrl.replace(/\/$/, '')}/models`;
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await fetch(endpoint, { headers });
      if (!res.ok) {
        // Try simple chat completion if /models endpoint fails
        const chatRes = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: selectedModel || 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 5
          })
        });
        if (!chatRes.ok) throw new Error(`Proxy Error (${chatRes.status}): ${await chatRes.text()}`);
      }
      return { success: true, message: `${proxy.name} Connection Successful!` };
    } catch (err) {
      console.error('Test connection failed:', err);
      return { success: false, message: err.message };
    }
  }

  /**
   * Send Chat Completion Request to Proxy. `tools` (optional, from MCPToolRegistry.getActiveTools())
   * enables native function-calling; the returned `toolCalls` array is empty when the model
   * didn't call anything, which is the exact existing behavior for tool-less sessions.
   */
  static async sendChatCompletion(proxy, promptPayload, settings, { signal, tools = [] } = {}) {
    if (!proxy) throw new Error('No active AI Proxy selected.');
    const { provider, baseUrl, apiKey, selectedModel } = proxy;
    const model = selectedModel || 'gpt-4o-mini';

    const temp = settings.temperature !== undefined ? parseFloat(settings.temperature) : 0.8;
    const topP = settings.topP !== undefined ? parseFloat(settings.topP) : 0.95;
    const maxTokens = resolveMaxTokens(provider, settings);
    const repPenalty = settings.repetitionPenalty ? parseFloat(settings.repetitionPenalty) : 1.0;
    const reasoningEffort = proxy.reasoningEffort || settings.reasoningEffort || 'off';
    const reasoningMaxTokens = proxy.reasoningMaxTokens || settings.reasoningMaxTokens || 2048;

    /* 1. GOOGLE GEMINI */
    if (provider === 'gemini') {
      const systemMsgs = promptPayload.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const contents = toGeminiContents(promptPayload);

      const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const bodyPayload = {
        contents,
        generationConfig: {
          temperature: temp,
          topP: topP,
          maxOutputTokens: maxTokens
        }
      };
      if (systemMsgs) {
        bodyPayload.systemInstruction = { parts: [{ text: systemMsgs }] };
      }
      const toolsParam = buildGeminiToolsParam(tools);
      if (toolsParam) bodyPayload.tools = toolsParam;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
        signal
      });
      if (!res.ok) throw new Error(`Gemini API Error (${res.status}): ${await res.text()}`);
      const data = await res.json();
      // Gemini "thinking" models (e.g. gemini-2.5-flash) mark reasoning parts
      // with `thought: true` instead of embedding <think> tags in the text.
      const parts = data.candidates?.[0]?.content?.parts || [];
      let rawText = '';
      let nativeThinking = '';
      const toolCalls = [];
      for (const part of parts) {
        if (typeof part.text === 'string' && part.text) {
          if (part.thought) nativeThinking += (nativeThinking ? '\n\n' : '') + part.text;
          else rawText += part.text;
        }
        if (part.functionCall) {
          toolCalls.push({ id: `${part.functionCall.name}_${toolCalls.length}`, name: part.functionCall.name, args: part.functionCall.args || {} });
        }
      }
      const { thinking: tagThinking, content } = extractThinking(rawText);
      return { content, thinking: [nativeThinking, tagThinking].filter(Boolean).join('\n\n'), toolCalls };
    }

    /* 2. ANTHROPIC CLAUDE */
    if (provider === 'anthropic') {
      const systemMsgs = promptPayload.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const messages = toAnthropicMessages(promptPayload);
      const toolsParam = buildAnthropicToolsParam(tools);

      const bodyPayload = {
        model,
        system: systemMsgs,
        messages,
        max_tokens: maxTokens,
        temperature: temp,
        top_p: topP
      };
      if (toolsParam) bodyPayload.tools = toolsParam;

      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'dangerously-allow-browser': 'true'
        },
        body: JSON.stringify(bodyPayload),
        signal
      });
      if (!res.ok) throw new Error(`Anthropic Error (${res.status}): ${await res.text()}`);
      const data = await res.json();
      // Extended-thinking responses interleave `{type:'thinking'}` and
      // `{type:'text'}` content blocks instead of embedding <think> tags.
      const blocks = data.content || [];
      let rawText = '';
      let nativeThinking = '';
      const toolCalls = [];
      for (const block of blocks) {
        if (block.type === 'thinking' && block.thinking) {
          nativeThinking += (nativeThinking ? '\n\n' : '') + block.thinking;
        } else if (block.type === 'text' && block.text) {
          rawText += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, args: block.input || {} });
        }
      }
      const { thinking: tagThinking, content } = extractThinking(rawText);
      return { content, thinking: [nativeThinking, tagThinking].filter(Boolean).join('\n\n'), toolCalls };
    }

    /* 3. OPENAI / OPENROUTER / CUSTOM OPENAI COMPATIBLE */
    const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const bodyPayload = {
      model,
      messages: toOpenAIMessages(promptPayload),
      temperature: temp,
      top_p: topP,
      max_tokens: maxTokens,
      frequency_penalty: repPenalty > 1 ? repPenalty - 1 : 0
    };
    const toolsParam = buildOpenAIToolsParam(tools);
    if (toolsParam) bodyPayload.tools = toolsParam;

    if (reasoningEffort && reasoningEffort !== 'off') {
      if (reasoningEffort === 'budget' || reasoningEffort === 'custom_tokens') {
        bodyPayload.reasoning = {
          max_tokens: parseInt(reasoningMaxTokens || 2048)
        };
      } else {
        bodyPayload.reasoning = {
          effort: reasoningEffort
        };
      }
    }

    if (provider === 'openrouter' && Array.isArray(proxy.openrouterProviders) && proxy.openrouterProviders.length > 0) {
      bodyPayload.provider = {
        order: proxy.openrouterProviders,
        allow_fallbacks: proxy.openrouterAllowFallbacks !== false
      };
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
      signal
    });

    if (!res.ok) throw new Error(`API Proxy Error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    // OpenRouter/DeepSeek-style reasoning models return a separate
    // `reasoning`/`reasoning_content` field instead of embedding <think> tags.
    const message = data.choices?.[0]?.message || {};
    const nativeThinking = message.reasoning || message.reasoning_content || '';
    const { thinking: tagThinking, content } = extractThinking(message.content || '');
    const toolCalls = (message.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function?.name,
      args: safeParseJSON(tc.function?.arguments)
    }));
    return { content, thinking: [nativeThinking, tagThinking].filter(Boolean).join('\n\n'), toolCalls };
  }

  /**
   * Shared SSE line-reading helper. Reads `res.body`, decodes it, splits on
   * newlines (buffering partial lines across reads), and invokes `onLine` for
   * every complete line. Provider-specific parsing lives in `onLine`.
   */
  static async _consumeSSE(res, onLine) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          const stop = onLine(line);
          if (stop === true) {
            await reader.cancel().catch(() => {});
            return;
          }
        }
      }

      // Flush any trailing partial line left in the buffer.
      if (buffer) {
        const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
        onLine(line);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  /**
   * Streaming Chat Completion Request to Proxy.
   * Returns { content, thinking, toolCalls } - the full final accumulated text after the
   * stream completes (toolCalls populated only if the model invoked one/more mid-stream).
   * onContentChunk(deltaText) / onThinkingChunk(deltaText) (both optional) fire incrementally
   * as chunks arrive. Tool-call argument JSON streams in fragments (per provider) and is only
   * surfaced once fully assembled at the end - there is no live "partial tool call" callback.
   */
  static async streamChatCompletion(proxy, promptPayload, settings, { onContentChunk, onThinkingChunk, signal, tools = [] } = {}) {
    if (!proxy) throw new Error('No active AI Proxy selected.');
    const { provider, baseUrl, apiKey, selectedModel } = proxy;
    const model = selectedModel || 'gpt-4o-mini';

    const temp = settings.temperature !== undefined ? parseFloat(settings.temperature) : 0.8;
    const topP = settings.topP !== undefined ? parseFloat(settings.topP) : 0.95;
    const maxTokens = resolveMaxTokens(provider, settings);
    const repPenalty = settings.repetitionPenalty ? parseFloat(settings.repetitionPenalty) : 1.0;
    const reasoningEffort = proxy.reasoningEffort || settings.reasoningEffort || 'off';
    const reasoningMaxTokens = proxy.reasoningMaxTokens || settings.reasoningMaxTokens || 2048;

    let accumulatedContent = '';
    let accumulatedThinking = '';
    const toolAccumulator = new ToolCallAccumulator();
    const parser = new ThinkingStreamParser({
      onContentChunk: (chunk) => {
        accumulatedContent += chunk;
        if (onContentChunk) onContentChunk(chunk);
      },
      onThinkingChunk: (chunk) => {
        accumulatedThinking += chunk;
        if (onThinkingChunk) onThinkingChunk(chunk);
      }
    });

    /* 1. GOOGLE GEMINI */
    if (provider === 'gemini') {
      const systemMsgs = promptPayload.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const contents = toGeminiContents(promptPayload);

      const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
      const bodyPayload = {
        contents,
        generationConfig: {
          temperature: temp,
          topP: topP,
          maxOutputTokens: maxTokens
        }
      };
      if (systemMsgs) {
        bodyPayload.systemInstruction = { parts: [{ text: systemMsgs }] };
      }
      const toolsParam = buildGeminiToolsParam(tools);
      if (toolsParam) bodyPayload.tools = toolsParam;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
        signal
      });
      if (!res.ok) throw new Error(`Gemini API Error (${res.status}): ${await res.text()}`);

      await ProviderManager._consumeSSE(res, (line) => {
        if (!line.startsWith('data: ')) return;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) return;
        let payload;
        try {
          payload = JSON.parse(jsonStr);
        } catch {
          return;
        }
        const parts = payload?.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (typeof part.text === 'string' && part.text) {
            if (part.thought) {
              accumulatedThinking += part.text;
              if (onThinkingChunk) onThinkingChunk(part.text);
            } else {
              parser.push(part.text);
            }
          }
          if (part.functionCall) {
            toolAccumulator.addComplete({ name: part.functionCall.name, args: part.functionCall.args });
          }
        }
      });

      parser.end();
      return { content: accumulatedContent, thinking: accumulatedThinking, toolCalls: toolAccumulator.finalize() };
    }

    /* 2. ANTHROPIC CLAUDE */
    if (provider === 'anthropic') {
      const systemMsgs = promptPayload.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const messages = toAnthropicMessages(promptPayload);
      const toolsParam = buildAnthropicToolsParam(tools);

      const bodyPayload = {
        model,
        system: systemMsgs,
        messages,
        max_tokens: maxTokens,
        temperature: temp,
        top_p: topP,
        stream: true
      };
      if (toolsParam) bodyPayload.tools = toolsParam;

      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'dangerously-allow-browser': 'true'
        },
        body: JSON.stringify(bodyPayload),
        signal
      });
      if (!res.ok) throw new Error(`Anthropic Error (${res.status}): ${await res.text()}`);

      let currentEvent = '';
      await ProviderManager._consumeSSE(res, (line) => {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
          if (currentEvent === 'message_stop') return true; // stop reading
          return;
        }
        if (!line.startsWith('data: ')) return;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) return;
        let payload;
        try {
          payload = JSON.parse(jsonStr);
        } catch {
          return;
        }
        if (currentEvent === 'content_block_start') {
          // A tool_use block announces its id+name here; its input JSON streams
          // in afterward via content_block_delta (input_json_delta) events.
          if (payload.content_block?.type === 'tool_use') {
            toolAccumulator.startAnthropicBlock(payload.index, { id: payload.content_block.id, name: payload.content_block.name });
          }
          return;
        }
        if (currentEvent === 'content_block_delta') {
          // Extended-thinking streams emit `thinking_delta` (field `.thinking`)
          // interleaved with regular `text_delta` (field `.text`) events.
          if (payload.delta?.type === 'thinking_delta' && typeof payload.delta.thinking === 'string') {
            accumulatedThinking += payload.delta.thinking;
            if (onThinkingChunk) onThinkingChunk(payload.delta.thinking);
          } else if (payload.delta?.type === 'input_json_delta') {
            toolAccumulator.appendAnthropicJsonDelta(payload.index, payload.delta.partial_json);
          } else if (typeof payload?.delta?.text === 'string') {
            parser.push(payload.delta.text);
          }
        }
      });

      parser.end();
      return { content: accumulatedContent, thinking: accumulatedThinking, toolCalls: toolAccumulator.finalize() };
    }

    /* 3. OPENAI / OPENROUTER / CUSTOM OPENAI COMPATIBLE */
    const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const bodyPayload = {
      model,
      messages: toOpenAIMessages(promptPayload),
      temperature: temp,
      top_p: topP,
      max_tokens: maxTokens,
      frequency_penalty: repPenalty > 1 ? repPenalty - 1 : 0,
      stream: true
    };
    const toolsParam = buildOpenAIToolsParam(tools);
    if (toolsParam) bodyPayload.tools = toolsParam;

    if (reasoningEffort && reasoningEffort !== 'off') {
      if (reasoningEffort === 'budget' || reasoningEffort === 'custom_tokens') {
        bodyPayload.reasoning = {
          max_tokens: parseInt(reasoningMaxTokens || 2048)
        };
      } else {
        bodyPayload.reasoning = {
          effort: reasoningEffort
        };
      }
    }

    if (provider === 'openrouter' && Array.isArray(proxy.openrouterProviders) && proxy.openrouterProviders.length > 0) {
      bodyPayload.provider = {
        order: proxy.openrouterProviders,
        allow_fallbacks: proxy.openrouterAllowFallbacks !== false
      };
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
      signal
    });
    if (!res.ok) throw new Error(`API Proxy Error (${res.status}): ${await res.text()}`);

    await ProviderManager._consumeSSE(res, (line) => {
      if (!line.startsWith('data: ')) return;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr) return;
      if (jsonStr === '[DONE]') return true; // stop reading
      let payload;
      try {
        payload = JSON.parse(jsonStr);
      } catch {
        return;
      }
      // OpenRouter/DeepSeek-style reasoning models stream a separate
      // `reasoning`/`reasoning_content` delta field alongside `content`.
      const deltaObj = payload?.choices?.[0]?.delta || {};
      const reasoningDelta = deltaObj.reasoning || deltaObj.reasoning_content;
      if (typeof reasoningDelta === 'string' && reasoningDelta) {
        accumulatedThinking += reasoningDelta;
        if (onThinkingChunk) onThinkingChunk(reasoningDelta);
      }
      if (Array.isArray(deltaObj.tool_calls)) {
        toolAccumulator.addOpenAIDelta(deltaObj.tool_calls);
      }
      if (typeof deltaObj.content === 'string' && deltaObj.content) {
        parser.push(deltaObj.content);
      }
    });

    parser.end();
    return { content: accumulatedContent, thinking: accumulatedThinking, toolCalls: toolAccumulator.finalize() };
  }
}

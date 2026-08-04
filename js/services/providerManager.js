/* js/services/providerManager.js - Multi-Proxy AI Provider API Abstraction */

import { extractThinking, ThinkingStreamParser } from '../utils/thinkingParser.js';

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
   * Send Chat Completion Request to Proxy
   */
  static async sendChatCompletion(proxy, promptPayload, settings, { signal } = {}) {
    if (!proxy) throw new Error('No active AI Proxy selected.');
    const { provider, baseUrl, apiKey, selectedModel } = proxy;
    const model = selectedModel || 'gpt-4o-mini';

    const temp = settings.temperature !== undefined ? parseFloat(settings.temperature) : 0.8;
    const topP = settings.topP !== undefined ? parseFloat(settings.topP) : 0.95;
    const maxTokens = settings.maxTokens ? parseInt(settings.maxTokens) : 1024;
    const repPenalty = settings.repetitionPenalty ? parseFloat(settings.repetitionPenalty) : 1.0;
    const reasoningEffort = proxy.reasoningEffort || settings.reasoningEffort || 'off';
    const reasoningMaxTokens = proxy.reasoningMaxTokens || settings.reasoningMaxTokens || 2048;

    /* 1. GOOGLE GEMINI */
    if (provider === 'gemini') {
      const contents = promptPayload.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      }));

      // Combine system messages into systemInstruction
      const systemMsgs = promptPayload.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const nonSystemContents = promptPayload.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

      const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const bodyPayload = {
        contents: nonSystemContents,
        generationConfig: {
          temperature: temp,
          topP: topP,
          maxOutputTokens: maxTokens
        }
      };
      if (systemMsgs) {
        bodyPayload.systemInstruction = { parts: [{ text: systemMsgs }] };
      }

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
      for (const part of parts) {
        if (typeof part.text !== 'string' || !part.text) continue;
        if (part.thought) nativeThinking += (nativeThinking ? '\n\n' : '') + part.text;
        else rawText += part.text;
      }
      const { thinking: tagThinking, content } = extractThinking(rawText);
      return { content, thinking: [nativeThinking, tagThinking].filter(Boolean).join('\n\n') };
    }

    /* 2. ANTHROPIC CLAUDE */
    if (provider === 'anthropic') {
      const systemMsgs = promptPayload.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const messages = promptPayload
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content }));

      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'dangerously-allow-browser': 'true'
        },
        body: JSON.stringify({
          model,
          system: systemMsgs,
          messages,
          max_tokens: maxTokens,
          temperature: temp,
          top_p: topP
        }),
        signal
      });
      if (!res.ok) throw new Error(`Anthropic Error (${res.status}): ${await res.text()}`);
      const data = await res.json();
      // Extended-thinking responses interleave `{type:'thinking'}` and
      // `{type:'text'}` content blocks instead of embedding <think> tags.
      const blocks = data.content || [];
      let rawText = '';
      let nativeThinking = '';
      for (const block of blocks) {
        if (block.type === 'thinking' && block.thinking) {
          nativeThinking += (nativeThinking ? '\n\n' : '') + block.thinking;
        } else if (block.type === 'text' && block.text) {
          rawText += block.text;
        }
      }
      const { thinking: tagThinking, content } = extractThinking(rawText);
      return { content, thinking: [nativeThinking, tagThinking].filter(Boolean).join('\n\n') };
    }

    /* 3. OPENAI / OPENROUTER / CUSTOM OPENAI COMPATIBLE */
    const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const bodyPayload = {
      model,
      messages: promptPayload,
      temperature: temp,
      top_p: topP,
      max_tokens: maxTokens,
      frequency_penalty: repPenalty > 1 ? repPenalty - 1 : 0
    };

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
    return { content, thinking: [nativeThinking, tagThinking].filter(Boolean).join('\n\n') };
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
   * Returns { content, thinking } - the full final accumulated text after the
   * stream completes. onContentChunk(deltaText) / onThinkingChunk(deltaText)
   * (both optional) fire incrementally as chunks arrive.
   */
  static async streamChatCompletion(proxy, promptPayload, settings, { onContentChunk, onThinkingChunk, signal } = {}) {
    if (!proxy) throw new Error('No active AI Proxy selected.');
    const { provider, baseUrl, apiKey, selectedModel } = proxy;
    const model = selectedModel || 'gpt-4o-mini';

    const temp = settings.temperature !== undefined ? parseFloat(settings.temperature) : 0.8;
    const topP = settings.topP !== undefined ? parseFloat(settings.topP) : 0.95;
    const maxTokens = settings.maxTokens ? parseInt(settings.maxTokens) : 1024;
    const repPenalty = settings.repetitionPenalty ? parseFloat(settings.repetitionPenalty) : 1.0;
    const reasoningEffort = proxy.reasoningEffort || settings.reasoningEffort || 'off';
    const reasoningMaxTokens = proxy.reasoningMaxTokens || settings.reasoningMaxTokens || 2048;

    let accumulatedContent = '';
    let accumulatedThinking = '';
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
      const nonSystemContents = promptPayload.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

      const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
      const bodyPayload = {
        contents: nonSystemContents,
        generationConfig: {
          temperature: temp,
          topP: topP,
          maxOutputTokens: maxTokens
        }
      };
      if (systemMsgs) {
        bodyPayload.systemInstruction = { parts: [{ text: systemMsgs }] };
      }

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
          if (typeof part.text !== 'string' || !part.text) continue;
          if (part.thought) {
            accumulatedThinking += part.text;
            if (onThinkingChunk) onThinkingChunk(part.text);
          } else {
            parser.push(part.text);
          }
        }
      });

      parser.end();
      return { content: accumulatedContent, thinking: accumulatedThinking };
    }

    /* 2. ANTHROPIC CLAUDE */
    if (provider === 'anthropic') {
      const systemMsgs = promptPayload.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const messages = promptPayload
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content }));

      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'dangerously-allow-browser': 'true'
        },
        body: JSON.stringify({
          model,
          system: systemMsgs,
          messages,
          max_tokens: maxTokens,
          temperature: temp,
          top_p: topP,
          stream: true
        }),
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
        if (currentEvent === 'content_block_delta') {
          // Extended-thinking streams emit `thinking_delta` (field `.thinking`)
          // interleaved with regular `text_delta` (field `.text`) events.
          if (payload.delta?.type === 'thinking_delta' && typeof payload.delta.thinking === 'string') {
            accumulatedThinking += payload.delta.thinking;
            if (onThinkingChunk) onThinkingChunk(payload.delta.thinking);
          } else if (typeof payload?.delta?.text === 'string') {
            parser.push(payload.delta.text);
          }
        }
      });

      parser.end();
      return { content: accumulatedContent, thinking: accumulatedThinking };
    }

    /* 3. OPENAI / OPENROUTER / CUSTOM OPENAI COMPATIBLE */
    const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const bodyPayload = {
      model,
      messages: promptPayload,
      temperature: temp,
      top_p: topP,
      max_tokens: maxTokens,
      frequency_penalty: repPenalty > 1 ? repPenalty - 1 : 0,
      stream: true
    };

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
      if (typeof deltaObj.content === 'string' && deltaObj.content) {
        parser.push(deltaObj.content);
      }
    });

    parser.end();
    return { content: accumulatedContent, thinking: accumulatedThinking };
  }
}

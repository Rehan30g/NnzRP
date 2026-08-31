/* js/services/promptBuilder.js - Dynamic Prompt Payload Assembler */
import { LorebookEngine } from './lorebookEngine.js';
import { replaceMacros } from '../utils/macroReplacer.js';

// Token-lean caps for the past-tool-call recap folded into history (see
// buildToolHistoryNote). The full raw tool output still lives on the stored
// message for the UI - only this trimmed copy ever re-enters the model's
// context on later turns.
const TOOL_HISTORY_ARGS_CHARS = 180;
const TOOL_HISTORY_RESULT_CHARS = 300;
const TOOL_HISTORY_MAX_CALLS = 8;   // per assistant message

function clip(str, max) {
  const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trim() + '…' : s;
}

// One compact line per past tool call: `name(args) -> result`, heavily
// truncated. Declined/blocked calls show why instead of a result. Returns ''
// when there is nothing worth adding, so callers can append unconditionally.
function buildToolHistoryNote(toolTrace) {
  if (!Array.isArray(toolTrace) || !toolTrace.length) return '';
  const lines = [];
  for (const t of toolTrace.slice(0, TOOL_HISTORY_MAX_CALLS)) {
    if (!t || !t.name) continue;
    let args = '';
    try {
      args = typeof t.args === 'string' ? t.args : JSON.stringify(t.args ?? {});
    } catch (e) {
      args = String(t.args ?? '');
    }
    let outcome;
    if (t.declined) outcome = '(declined by user)';
    else if (t.blocked) outcome = '(blocked: repeated call)';
    else outcome = clip(t.result, TOOL_HISTORY_RESULT_CHARS) || '(no output)';
    lines.push(`- ${t.name}(${clip(args, TOOL_HISTORY_ARGS_CHARS)}) -> ${outcome}`);
  }
  if (toolTrace.length > TOOL_HISTORY_MAX_CALLS) {
    lines.push(`- (+${toolTrace.length - TOOL_HISTORY_MAX_CALLS} more tool call(s))`);
  }
  return lines.length ? `\n\n[Tools you used in this reply]\n${lines.join('\n')}` : '';
}

export class PromptBuilder {
  /**
   * Assembles final prompt payload messages for AI completions
   */
  static buildPromptPayload(options) {
    const payload = [];
    const character = options.character;
    const persona = options.persona;
    const globalSystemPrompt = options.globalSystemPrompt || '';
    const messages = options.messages || [];
    const tools = options.tools || [];
    // Default ON: fold a heavily-truncated recap of each past assistant
    // message's tool calls back into that message's content, so the character
    // still "knows" what it looked up on earlier turns without re-sending the
    // full raw tool results. Only `false` disables it.
    const includeToolHistory = options.includeToolHistory !== false;

    const userName = persona?.name || 'User';
    const charName = character?.name || 'Character';

    // 1. Build System Instruction Block
    let systemContent = globalSystemPrompt ? `${globalSystemPrompt.trim()}\n\n` : '';
    systemContent += `[Character Profile: ${charName}]\n`;
    if (character?.description) systemContent += `Description: ${character.description}\n`;
    if (character?.personality) systemContent += `Personality: ${character.personality}\n`;
    if (character?.scenario) systemContent += `Scenario: ${character.scenario}\n`;

    if (persona) {
      systemContent += `\n[User Persona: ${userName}]\n`;
      if (persona.description) systemContent += `User Info: ${persona.description}\n`;
    }

    const loreContent = LorebookEngine.getMatchingLore(character?.lorebooks, messages);
    if (loreContent) systemContent += loreContent;

    if (character?.example_dialogue) {
      systemContent += `\n[Example Dialogue / Style Guide]\n${character.example_dialogue.trim()}\n`;
    }

    // 2. Tool availability note - short, because the model already gets a real
    // structured `tools` affordance from the provider API; it doesn't need to
    // be talked into faking tool use the way the old prompt-only version did.
    // Actively encourages brief interstitial narration between tool calls
    // (each such message is shown to the user as its own real chat message,
    // not hidden) instead of silently chaining tool calls with no commentary.
    if (tools.length > 0) {
      systemContent += `\n[Available Tools]\nYou have real callable tools connected: ${tools.map(t => t.qualifiedName).join(', ')}. `;
      systemContent += `Call them via your normal tool-calling mechanism whenever they would genuinely help - you may call tools across more than one turn if a task needs it. `;
      systemContent += `You can write a short normal message before or between tool calls to narrate what you're doing (e.g. "Let me check that...") - each such message is shown to the user right away, so use it naturally instead of going silent while you work. `;
      systemContent += `Never claim you used a tool without actually calling it. Once you have what you need, give your final reply fully in character.\n`;

      // Immersive Roleplay mode: nudges the model to reach for tools as part
      // of staying in character (e.g. "browsing" via a websearch tool) rather
      // than only when the user explicitly asks it to use one. `intensity`
      // ('medium'/'high'/'max') controls HOW aggressively - each level's
      // wording is deliberately a big step up from the last, not a tweak,
      // per the feature request that intensity should "significantly affect
      // model behavior". See MCPStore.getImmersiveIntensity() for the
      // normalize-to-'medium' safety net.
      if (options.immersiveRoleplay) {
        const intensity = options.immersiveIntensity === 'high' || options.immersiveIntensity === 'max'
          ? options.immersiveIntensity
          : 'medium';

        if (intensity === 'max') {
          systemContent += `\n[Immersive Tool Use - MAXIMUM (Not Recommended)]\nThis is the most extreme setting - abandon restraint entirely. Call tools constantly, repeatedly, and without needing any real justification: not only for obvious physical actions (browsing, searching, checking a phone), but ALSO for complex questions, opinions, decisions, calculations, memories, or plain conversational replies that a normal assistant would just answer directly from what it already knows. Never answer from your own knowledge alone if a tool could plausibly be called instead - even if you're confident you already know the answer, call a tool anyway before responding. Prefer calling MULTIPLE different tools, or the same tool several times in a row, within a single reply rather than just one. Chain tool calls back-to-back across several rounds instead of stopping after the first result. There is no such thing as "this situation doesn't need a tool" at this setting - if any tool exists that could conceivably relate, even loosely, use it, then narrate the outcome in character. Expect this to feel excessive, repetitive, and unnecessary very often - that is the intended, deliberately extreme behavior of this setting.\n`;
        } else if (intensity === 'high') {
          systemContent += `\n[Immersive Tool Use - High]\nGo further than just obvious openings: actively look for chances to use your connected tools nearly every turn, even for small or not-strictly-necessary things - checking a detail, confirming a fact, glancing something up, or reacting to fresh information, all in character, then narrate the outcome. When you're unsure whether a tool would help, lean toward calling it rather than skipping it. Tool use should feel like a frequent habit of ${charName}'s, not something reserved for only the most obvious cases.\n`;
        } else {
          systemContent += `\n[Immersive Tool Use]\nWeave tool use directly into the roleplay itself, in character, without waiting to be asked. If the scene has ${charName} picking up their phone, browsing the web, searching for something, checking the news/weather, or needing any real/current information to stay believable, just have them do it and call the matching tool - then narrate the outcome in character. Look for these natural openings proactively instead of only using tools when ${userName} explicitly requests it.\n`;
        }
      }
    }

    // 3. Replace Macros & Push System Content
    systemContent = replaceMacros(systemContent, userName, charName);
    payload.push({ role: 'system', content: systemContent.trim() });

    // 4. First Greeting Message Injection
    if (character?.first_mes && messages.length === 0) {
      payload.push({ role: 'assistant', content: replaceMacros(character.first_mes, userName, charName) });
    }

    // 5. Full History - no hard message-count cap. An older cap here silently
    // dropped old turns from the model's context, which read as the character
    // "forgetting" earlier established facts/relationships. Context-window
    // pressure is now surfaced to the user instead (the chat header's
    // capacity gauge, js/utils/contextWindowSize.js) with a Compact Chat
    // recommendation once a session gets long, rather than silently
    // truncating history out from under them.
    const historyPayload = [];
    for (const msg of messages) {
      const entry = {
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: replaceMacros(msg.content, userName, charName)
      };
      // Compact past-tool-call recap, appended to the assistant turn that made
      // the calls. `msg.toolTrace` already mirrors the ACTIVE swipe variation,
      // so swiping restores the right recap for free.
      if (includeToolHistory && entry.role === 'assistant' && Array.isArray(msg.toolTrace) && msg.toolTrace.length) {
        const note = buildToolHistoryNote(msg.toolTrace);
        if (note) entry.content = (entry.content || '') + note;
      }
      // Only a user message can carry image attachments (composer upload) -
      // passed through as-is (already base64 data: URLs, nothing to macro-
      // replace) for providerManager.js's translators to turn into each
      // provider's own multimodal content blocks.
      if (Array.isArray(msg.images) && msg.images.length) entry.images = msg.images;
      historyPayload.push(entry);
    }

    // Merge consecutive same-role turns into one (e.g. ChatStore.createCompactedChat's
    // AI recap message immediately followed by the kept opening/first_mes message,
    // both 'assistant') instead of pushing them as two separate back-to-back
    // turns. Most providers tolerate consecutive same-role messages fine, but
    // Anthropic specifically requires strict user/assistant alternation and
    // errors otherwise - merging keeps every provider happy uniformly, and
    // reads naturally either way (one assistant-authored block instead of two).
    for (const entry of historyPayload) {
      const last = payload[payload.length - 1];
      if (last && last.role === entry.role) {
        last.content = [last.content, entry.content].filter(Boolean).join('\n\n');
        if (entry.images?.length) last.images = [...(last.images || []), ...entry.images];
      } else {
        payload.push(entry);
      }
    }

    return payload;
  }
}

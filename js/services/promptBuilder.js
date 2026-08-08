/* js/services/promptBuilder.js - Dynamic Prompt Payload Assembler */
import { LorebookEngine } from './lorebookEngine.js';
import { replaceMacros } from '../utils/macroReplacer.js';

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
    const contextLimit = options.contextLimit || 25;
    const tools = options.tools || [];

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

    // 5. Slice History Messages
    const recentMessages = messages.slice(-contextLimit);
    for (const msg of recentMessages) {
      payload.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: replaceMacros(msg.content, userName, charName)
      });
    }

    return payload;
  }
}

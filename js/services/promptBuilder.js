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
      // than only when the user explicitly asks it to use one.
      if (options.immersiveRoleplay) {
        systemContent += `\n[Immersive Tool Use]\nWeave tool use directly into the roleplay itself, in character, without waiting to be asked. If the scene has ${charName} picking up their phone, browsing the web, searching for something, checking the news/weather, or needing any real/current information to stay believable, just have them do it and call the matching tool - then narrate the outcome in character. Look for these natural openings proactively instead of only using tools when ${userName} explicitly requests it.\n`;
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

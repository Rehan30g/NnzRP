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
    if (tools.length > 0) {
      systemContent += `\n[Available Tools]\nYou have real callable tools connected: ${tools.map(t => t.qualifiedName).join(', ')}. `;
      systemContent += `Call them via your normal tool-calling mechanism whenever they would genuinely help - you may call tools across more than one turn if a task needs it. `;
      systemContent += `Never narrate pretending to use a tool in prose; either call it for real or don't mention it. Once you have what you need, give your final reply fully in character.\n`;
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

/* js/services/promptBuilder.js - Dynamic Prompt Payload Assembler */
import { LorebookEngine } from './lorebookEngine.js';

export class PromptBuilder {
  /**
   * Assembles final prompt payload messages for AI completions
   */
  static buildPromptPayload({
    character,
    persona,
    globalSystemPrompt = '',
    messages = [],
    contextLimit = 25
  }) {
    const payload = [];

    // 1. Build System Instruction Block
    let systemContent = globalSystemPrompt ? `${globalSystemPrompt.trim()}\n\n` : '';

    // Character Card Definitions
    systemContent += `[Character Profile: ${character.name}]\n`;
    if (character.description) systemContent += `Description: ${character.description}\n`;
    if (character.personality) systemContent += `Personality: ${character.personality}\n`;
    if (character.scenario) systemContent += `Scenario: ${character.scenario}\n`;

    // Active User Persona Definitions
    if (persona) {
      systemContent += `\n[User Persona: ${persona.name}]\n`;
      if (persona.description) systemContent += `User Info: ${persona.description}\n`;
    }

    // Dynamic Lorebook Entries Injection
    const loreContent = LorebookEngine.getMatchingLore(character.lorebooks, messages);
    if (loreContent) {
      systemContent += loreContent;
    }

    // Example Dialogue Injection
    if (character.example_dialogue) {
      systemContent += `\n[Example Dialogue / Style Guide]\n${character.example_dialogue.trim()}\n`;
    }

    // Push system message
    payload.push({ role: 'system', content: systemContent.trim() });

    // First Message (Greeting) injection if history is empty or at the start
    if (character.first_mes) {
      payload.push({ role: 'assistant', content: character.first_mes });
    }

    // Slice recent chat messages according to contextLimit
    const recentMessages = messages.slice(-contextLimit);
    for (const msg of recentMessages) {
      payload.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
      });
    }

    return payload;
  }
}

/* js/services/promptBuilder.js - Dynamic Prompt Payload Assembler */
import { LorebookEngine } from './lorebookEngine.js';
import { replaceMacros } from '../utils/macroReplacer.js';

export class PromptBuilder {
  /**
   * Assembles final prompt payload messages for AI completions
   */
  static buildPromptPayload({
    character,
    persona,
    globalSystemPrompt = '',
    messages = [],
    contextLimit = 25,
    mcpServers = []
  }) {
    const payload = [];
    const userName = persona?.name || 'User';
    const charName = character?.name || 'Character';

    // 1. Build System Instruction Block
    let systemContent = globalSystemPrompt ? `${globalSystemPrompt.trim()}\n\n` : '';

    // Character Card Definitions
    systemContent += `[Character Profile: ${charName}]\n`;
    if (character.description) systemContent += `Description: ${character.description}\n`;
    if (character.personality) systemContent += `Personality: ${character.personality}\n`;
    if (character.scenario) systemContent += `Scenario: ${character.scenario}\n`;

    // Active User Persona Definitions
    if (persona) {
      systemContent += `\n[User Persona: ${userName}]\n`;
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

    // Custom MCP Server Tool Registry Injection (Experimental)
    if (Array.isArray(mcpServers) && mcpServers.length > 0) {
      systemContent += `\n[Active Custom MCP Tools & Extensions]\n`;
      mcpServers.forEach(s => {
        systemContent += `- MCP Server "${s.name}" (Type: ${s.type.toUpperCase()}, Endpoint: ${s.endpointUrl}): ${s.description || 'Custom tool capability'}\n`;
      });
    }

    // Replace {{user}} and {{char}} macros in system content
    systemContent = replaceMacros(systemContent, userName, charName);

    // Push system message
    payload.push({ role: 'system', content: systemContent.trim() });

    // First Message (Greeting) injection if history is empty
    if (character.first_mes && messages.length === 0) {
      payload.push({ role: 'assistant', content: replaceMacros(character.first_mes, userName, charName) });
    }

    // Slice recent chat messages according to contextLimit
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


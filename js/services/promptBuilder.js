/* js/services/promptBuilder.js - Dynamic Prompt Payload Assembler */
import { LorebookEngine } from './lorebookEngine.js';
import { replaceMacros } from '../utils/macroReplacer.js';
import { MCPClient } from './mcpClient.js';

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
    const mcpServers = options.mcpServers || [];

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

    // 2. Custom MCP Server Tool Registry & Execution Authorization
    if (Array.isArray(mcpServers) && mcpServers.length > 0) {
      systemContent += `\n[Active Model Context Protocol (MCP) Tools & Capability Extension]\n`;
      systemContent += `You are connected to the following active MCP tools and servers to fulfill user requests and commands:\n`;
      mcpServers.forEach(s => {
        const details = s.endpointUrl || (s.command ? s.command + ' ' + (s.args || []).join(' ') : 'active');
        systemContent += `- Server "${s.name}" (${(s.type || 'sse').toUpperCase()} @ ${details}): ${s.description || 'Active MCP Extension'}\n`;
      });
      systemContent += `\nINSTRUCTION FOR MCP TOOL EXECUTION:\n`;
      systemContent += `You ARE FULLY AUTHORIZED AND CAPABLE of using your connected MCP tools. Do NOT refuse user requests by claiming you are text-only or cannot open browsers/search/execute commands. When asked to perform an action using a connected MCP tool, execute it and describe the action clearly to the user.\n`;
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

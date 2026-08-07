/* js/services/mcpToolRegistry.js - Aggregates enabled MCP servers into one flat,
 * namespaced tool list for provider function-calling, and dispatches execution
 * back to the correct server. */
import { MCPStore } from '../storage/mcpStore.js';
import { MCPClient } from './mcpClient.js';

const TOOL_CACHE_TTL_MS = 60000;
const toolCache = new Map(); // serverId -> { tools, fetchedAt }
const toolIndex = new Map(); // qualifiedName -> { serverId, toolName }

function sanitizeKey(name) {
  return (name || 'server').toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'server';
}

export class MCPToolRegistry {
  /** Drops cached tool listings for a server (or all servers) - call after editing/deleting one. */
  static invalidate(serverId) {
    if (serverId) toolCache.delete(serverId);
    else toolCache.clear();
  }

  /**
   * Returns the flat, namespaced list of tools currently available across all
   * enabled MCP servers: [{ qualifiedName, description, inputSchema }].
   * A server that errors on discovery is skipped (logged, not fatal) so one
   * broken MCP server can't take down an entire roleplay generation.
   */
  static async getActiveTools() {
    const globalEnabled = await MCPStore.getGlobalEnabled();
    if (!globalEnabled) return [];

    const servers = await MCPStore.getEnabledServers();
    const result = [];

    for (const server of servers) {
      let entry = toolCache.get(server.id);
      if (!entry || Date.now() - entry.fetchedAt > TOOL_CACHE_TTL_MS) {
        try {
          const tools = await MCPClient.listTools(server);
          entry = { tools, fetchedAt: Date.now() };
          toolCache.set(server.id, entry);
        } catch (err) {
          console.warn(`[MCPToolRegistry] Skipping server "${server.name}": ${err.message}`);
          continue;
        }
      }

      const serverKey = sanitizeKey(server.name);
      for (const tool of entry.tools) {
        const qualifiedName = `${serverKey}__${sanitizeKey(tool.name)}`;
        toolIndex.set(qualifiedName, { serverId: server.id, toolName: tool.name });
        result.push({
          qualifiedName,
          description: tool.description || '',
          inputSchema: (tool.inputSchema && typeof tool.inputSchema === 'object')
            ? tool.inputSchema
            : { type: 'object', properties: {} }
        });
      }
    }

    return result;
  }

  /** Resolves a qualified (`server__tool`) name back to `{serverId, toolName}`, or null if unknown. */
  static resolveTool(qualifiedName) {
    return toolIndex.get(qualifiedName) || null;
  }

  /**
   * Permission ('ask' | 'allow' | 'decline') for a qualified tool name.
   *
   * SAFETY: returns the safe default 'ask' when the qualified name isn't in
   * the index at all (server disabled/removed/never listed) - never 'allow'.
   * Every other outcome is delegated to `MCPStore.getToolPermission`, which
   * has the same unset -> 'ask' guarantee.
   */
  static async getToolPermission(qualifiedName) {
    const entry = toolIndex.get(qualifiedName);
    if (!entry) return 'ask';
    return MCPStore.getToolPermission(entry.serverId, entry.toolName);
  }

  /** Persists a permission for a qualified tool name (used by the chat's "Always Allow" button). */
  static async setToolPermission(qualifiedName, permission) {
    const entry = toolIndex.get(qualifiedName);
    if (!entry) return false;
    await MCPStore.setToolPermission(entry.serverId, entry.toolName, permission);
    return true;
  }

  /** Executes a previously-listed qualified tool name against its owning MCP server. */
  static async executeTool(qualifiedName, args) {
    const entry = toolIndex.get(qualifiedName);
    if (!entry) throw new Error(`Unknown tool "${qualifiedName}" (not currently registered/enabled).`);

    const server = await MCPStore.getById(entry.serverId);
    if (!server || !server.enabled) throw new Error(`MCP server for "${qualifiedName}" is no longer available.`);

    const result = await MCPClient.callTool(server, entry.toolName, args || {});
    return this.stringifyResult(result);
  }

  /** Flattens an MCP CallToolResult's content blocks into plain text for the model. */
  static stringifyResult(result) {
    if (!result) return '';
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = blocks
      .map(b => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : (typeof b === 'string' ? b : ''))
      .filter(Boolean)
      .join('\n');
    const finalText = text || (blocks.length ? '[Non-text tool result content omitted]' : JSON.stringify(result));
    return result.isError ? `Error: ${finalText}` : finalText;
  }
}

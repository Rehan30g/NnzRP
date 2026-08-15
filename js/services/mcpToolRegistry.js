/* js/services/mcpToolRegistry.js - Aggregates enabled MCP servers into one flat,
 * namespaced tool list for provider function-calling, and dispatches execution
 * back to the correct server. */
import { MCPStore } from '../storage/mcpStore.js';
import { MCPClient, isTransportUnsupportedHere } from './mcpClient.js';
import { BUILTIN_VIEW_IMAGE_TOOL, BUILTIN_EMBED_HTML_TOOL } from './builtinTools.js';

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
    const usedNames = new Set(); // guards against sanitizeKey() collisions - see below

    for (const server of servers) {
      // A stdio/command server in a non-Electron shell can never answer
      // tools/list (see mcpClient.js). Discovery already degraded gracefully
      // via the catch below - it just contributed zero tools - but it threw
      // and logged a warning on EVERY generation (nothing is cached on
      // failure, so the TTL never kicks in). Skip it up front: same zero-tool
      // outcome, no per-turn console noise, no pointless bridge round trip.
      if (isTransportUnsupportedHere(server)) continue;

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
        let qualifiedName = `${serverKey}__${sanitizeKey(tool.name)}`;
        // sanitizeKey() is lossy ("My Server"/"my-server" -> "my_server",
        // "get-file"/"get_file" -> "get_file"), so two different tools can land
        // on one qualified name. Unhandled, the later one silently hijacks the
        // earlier one's permission lookup AND its execution target, and the
        // provider gets two function declarations with the same name.
        if (usedNames.has(qualifiedName)) {
          let n = 2;
          while (usedNames.has(`${qualifiedName}_${n}`)) n++;
          qualifiedName = `${qualifiedName}_${n}`;
        }
        usedNames.add(qualifiedName);
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
    // The builtin image-fetch and embed-html tools (js/services/builtinTools.js)
    // aren't owned by any MCP server, so neither has a `toolIndex` entry -
    // each gets its own single global permission flag instead of a
    // per-server map entry.
    if (qualifiedName === BUILTIN_VIEW_IMAGE_TOOL) return MCPStore.getBuiltinToolPermission();
    // Deliberately bypasses MCPStore.getEmbedHtmlToolPermission() (still
    // there, just unused by this gate) - the embed-html tool already sits
    // behind its OWN explicit opt-in master toggle (MCPStore.getEmbedHtmlEnabled,
    // default OFF), which is the real gate: once a user has turned the
    // feature on at all, prompting again on every single call read as
    // redundant friction rather than added safety, so every call auto-allows.
    if (qualifiedName === BUILTIN_EMBED_HTML_TOOL) return 'allow';
    const entry = toolIndex.get(qualifiedName);
    if (!entry) return 'ask';
    return MCPStore.getToolPermission(entry.serverId, entry.toolName);
  }

  /** Persists a permission for a qualified tool name (used by the chat's "Always Allow" button). */
  static async setToolPermission(qualifiedName, permission) {
    if (qualifiedName === BUILTIN_VIEW_IMAGE_TOOL) {
      await MCPStore.setBuiltinToolPermission(permission);
      return true;
    }
    if (qualifiedName === BUILTIN_EMBED_HTML_TOOL) {
      await MCPStore.setEmbedHtmlToolPermission(permission);
      return true;
    }
    const entry = toolIndex.get(qualifiedName);
    if (!entry) return false;
    await MCPStore.setToolPermission(entry.serverId, entry.toolName, permission);
    return true;
  }

  /**
   * Executes a previously-listed qualified tool name against its owning MCP
   * server. Returns `{ text, images }` (see parseResult below) - a server
   * like a browser-automation MCP that returns a screenshot as an MCP
   * `image` content block is not just flattened to a "[Non-text tool result
   * content omitted]" placeholder anymore; agentRunner.js handles this
   * identically to the builtin view-image tool's fetched images from here on
   * (same trace/persist/feed-back-to-model path).
   */
  static async executeTool(qualifiedName, args) {
    const entry = toolIndex.get(qualifiedName);
    if (!entry) throw new Error(`Unknown tool "${qualifiedName}" (not currently registered/enabled).`);

    const server = await MCPStore.getById(entry.serverId);
    if (!server || !server.enabled) throw new Error(`MCP server for "${qualifiedName}" is no longer available.`);

    const result = await MCPClient.callTool(server, entry.toolName, args || {});
    return this.parseResult(result);
  }

  /**
   * Splits an MCP CallToolResult's content blocks into flattened text (for
   * the model's tool-result message) and images (base64 `data:` URLs, so a
   * tool that returns an MCP `image` content block - e.g. a browser-
   * automation server's screenshot capability - can actually be SEEN in chat
   * and by the model, instead of being silently discarded). Per the MCP
   * spec a content block is one of `{type:'text', text}` /
   * `{type:'image', data, mimeType}` / other types (resource links etc.)
   * this doesn't specially handle and simply ignores.
   */
  static parseResult(result) {
    if (!result) return { text: '', images: [] };
    const blocks = Array.isArray(result.content) ? result.content : [];
    const textParts = [];
    const images = [];
    for (const block of blocks) {
      if (typeof block === 'string') {
        textParts.push(block);
      } else if (block && typeof block === 'object') {
        if (typeof block.text === 'string') {
          textParts.push(block.text);
        } else if (block.type === 'image' && typeof block.data === 'string' && block.data) {
          const mimeType = (typeof block.mimeType === 'string' && block.mimeType) ? block.mimeType : 'image/png';
          images.push(`data:${mimeType};base64,${block.data}`);
        }
      }
    }
    const text = textParts.filter(Boolean).join('\n');
    const finalText = text
      || (images.length ? `[${images.length} image${images.length > 1 ? 's' : ''} attached]` : '')
      || (blocks.length ? '[Non-text tool result content omitted]' : JSON.stringify(result));
    return { text: result.isError ? `Error: ${finalText}` : finalText, images };
  }
}

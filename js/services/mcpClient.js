/* js/services/mcpClient.js - Model Context Protocol (MCP) Client (HTTP + Stdio transports)
 *
 * Trust boundary: this file only ever calls tools by name with model-supplied
 * JSON arguments against servers the USER configured in the MCP settings UI.
 * It never spawns/points at a server chosen by model output.
 */

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'NnzRP', version: '1.0.0' };

// Per-server-id session state kept only for the lifetime of the app (not persisted).
const sessionIds = new Map(); // serverId -> Mcp-Session-Id header value (HTTP transport)
const initializedServers = new Set(); // serverId - has the initialize handshake succeeded once

function jsonRpcPayload(method, params, id) {
  const payload = { jsonrpc: '2.0', method, params: params || {} };
  if (id !== undefined) payload.id = id;
  return payload;
}

async function httpRpc(server, method, params, { isNotification = false, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (server.apiKey) headers['Authorization'] = `Bearer ${server.apiKey}`;
  const sid = sessionIds.get(server.id);
  if (sid) headers['Mcp-Session-Id'] = sid;

  const id = isNotification ? undefined : Date.now() + Math.floor(Math.random() * 1000);
  const payload = jsonRpcPayload(method, params, id);

  try {
    const res = await fetch(server.endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const newSid = res.headers.get('Mcp-Session-Id');
    if (newSid) sessionIds.set(server.id, newSid);

    if (isNotification) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const contentType = res.headers.get('Content-Type') || '';
    let json;
    if (contentType.includes('text/event-stream')) {
      const raw = await res.text();
      const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) throw new Error('No data event in SSE response.');
      json = JSON.parse(dataLine.slice(5).trim());
    } else {
      json = await res.json();
    }

    if (json.error) throw new Error(json.error.message || 'MCP server returned an error.');
    return json.result;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function commandRpc(server, method, params, { isNotification = false } = {}) {
  if (!window.electronAPI?.mcp) {
    throw new Error('Stdio/command MCP servers require the NnzRP desktop app and are not available in browser mode.');
  }
  await window.electronAPI.mcp.start({ id: server.id, command: server.command, args: server.args || [], env: server.env || {} });
  return window.electronAPI.mcp.request(server.id, method, params || {}, isNotification);
}

async function rpc(server, method, params, opts) {
  return server.transport === 'command'
    ? commandRpc(server, method, params, opts)
    : httpRpc(server, method, params, opts);
}

/** Sends the MCP `initialize` handshake once per server per app session. Tolerant of
 * minimal/non-spec-compliant servers that don't implement it - failure here is not fatal,
 * we just proceed straight to tools/list (matches how many hand-rolled MCP servers behave). */
async function ensureInitialized(server) {
  if (initializedServers.has(server.id)) return;
  try {
    await rpc(server, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    });
    await rpc(server, 'notifications/initialized', {}, { isNotification: true }).catch(() => {});
  } catch (err) {
    console.warn(`[MCPClient] "${server.name}" did not respond to initialize handshake, proceeding without it:`, err.message);
  } finally {
    // Only try once per server per session regardless of outcome - avoids re-handshaking
    // (and re-erroring) on every single tool listing/call.
    initializedServers.add(server.id);
  }
}

export class MCPClient {
  /** Discovers a server's available tools via standard JSON-RPC 2.0 `tools/list`. Throws on failure. */
  static async listTools(server) {
    if (server.transport === 'command' ? !server.command : !server.endpointUrl) {
      throw new Error('MCP server is missing its endpoint/command configuration.');
    }
    await ensureInitialized(server);
    const result = await rpc(server, 'tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /** Executes a tool on the target MCP server via JSON-RPC 2.0 `tools/call`. Throws on failure. */
  static async callTool(server, toolName, toolArguments = {}) {
    await ensureInitialized(server);
    const result = await rpc(server, 'tools/call', { name: toolName, arguments: toolArguments });
    return result;
  }

  /** Lightweight reachability check used by the UI's "Check Status" / "Discover Tools" actions. */
  static async checkStatus(server) {
    try {
      const tools = await this.listTools(server);
      return { online: true, toolCount: tools.length, tools };
    } catch (err) {
      return { online: false, error: err.message };
    }
  }

  /** Drops cached initialize/session state for a server - call after editing its config. */
  static resetSession(serverId) {
    initializedServers.delete(serverId);
    sessionIds.delete(serverId);
  }

  /** Stops a stdio server's backing child process (no-op for HTTP servers). */
  static async stopIfRunning(server) {
    if (server.transport === 'command' && window.electronAPI?.mcp) {
      await window.electronAPI.mcp.stop(server.id).catch(() => {});
    }
    this.resetSession(server.id);
  }
}

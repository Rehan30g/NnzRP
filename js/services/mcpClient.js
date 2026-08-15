/* js/services/mcpClient.js - Model Context Protocol (MCP) Client (HTTP + Stdio transports)
 *
 * Trust boundary: this file only ever calls tools by name with model-supplied
 * JSON arguments against servers the USER configured in the MCP settings UI.
 * It never spawns/points at a server chosen by model output.
 */

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'NnzRP', version: '1.0.0' };

/* Stdio/command MCP servers are spawned as a child process by Electron's main
 * process and reached through preload.js's `window.electronAPI.mcp` bridge.
 * That global only exists in the Electron desktop build - a plain browser tab,
 * the installed PWA and the Capacitor Android APK all run without it (see
 * CLAUDE.md's "browser-mode" bullet), so a `transport: 'command'` server there
 * is not "offline"/misconfigured, it is simply not supported by that shell.
 * Callers use isTransportUnsupportedHere() to say so plainly instead of
 * rendering the same alarming red "Offline" badge a real connection failure
 * gets - there is nothing to retry and nothing for the user to go fix. */
export const UNSUPPORTED_TRANSPORT_REASON =
  'Stdio/command MCP servers only run in the NnzRP desktop app. The browser, PWA and Android builds support HTTP MCP servers only.';

/** True when `server`'s transport cannot work in the shell we are running in right now. */
export function isTransportUnsupportedHere(server) {
  return server?.transport === 'command' && !window.electronAPI?.mcp;
}

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
      // Servers may emit notifications/progress events before the response, so
      // the FIRST data: line is not necessarily ours - correlate by request id,
      // falling back to the first event actually shaped like a JSON-RPC reply.
      const events = raw.split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } })
        .filter(Boolean);
      json = events.find(e => e.id === id) || events.find(e => e.result !== undefined || e.error);
      if (!json) throw new Error('No JSON-RPC response event in SSE response.');
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
    throw new Error(UNSUPPORTED_TRANSPORT_REASON);
  }
  const startInfo = await window.electronAPI.mcp.start({ id: server.id, command: server.command, args: server.args || [], env: server.env || {} });
  // A FRESH process (the previous one crashed and main.js dropped it) has not
  // seen the initialize handshake, but `initializedServers` still remembers the
  // dead one's - redo it before anything else, or spec-compliant servers reject
  // every request for the rest of the session. The nested initialize call
  // re-enters here with `alreadyRunning`, so this cannot recurse.
  if (startInfo && startInfo.started && method !== 'initialize' && method !== 'notifications/initialized') {
    initializedServers.delete(server.id);
    await ensureInitialized(server);
  }
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
    // tools/list is cursor-paginated in the MCP spec; reading only the first
    // page silently hides every tool past it. Bounded so a server that keeps
    // handing back a cursor can't spin here forever.
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await rpc(server, 'tools/list', cursor ? { cursor } : {});
      if (Array.isArray(result?.tools)) tools.push(...result.tools);
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
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

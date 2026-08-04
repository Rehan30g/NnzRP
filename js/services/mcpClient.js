/* js/services/mcpClient.js - Model Context Protocol (MCP) Official Client Service */

export class MCPClient {
  /**
   * Pings an MCP server and discovers its available tools via standard JSON-RPC 2.0 `tools/list`
   */
  static async discoverTools(server) {
    if (!server.endpointUrl) return [];
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);

      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      };

      const headers = { 'Content-Type': 'application/json' };
      if (server.apiKey) headers['Authorization'] = `Bearer ${server.apiKey}`;

      const res = await fetch(server.endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!res.ok) return [];
      const json = await res.json();
      if (json.result && Array.isArray(json.result.tools)) {
        return json.result.tools;
      }
    } catch (err) {
      console.warn(`[MCPClient] Could not fetch tools from ${server.name}:`, err.message);
    }
    return [];
  }

  /**
   * Executes a tool on the target MCP server via JSON-RPC 2.0 `tools/call`
   */
  static async callTool(server, toolName, toolArguments = {}) {
    if (!server.endpointUrl) throw new Error('No endpoint URL for MCP server.');

    const payload = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: toolArguments
      }
    };

    const headers = { 'Content-Type': 'application/json' };
    if (server.apiKey) headers['Authorization'] = `Bearer ${server.apiKey}`;

    const res = await fetch(server.endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`MCP Server HTTP ${res.status}: ${res.statusText}`);
    const json = await res.json();

    if (json.error) {
      throw new Error(json.error.message || 'MCP Tool execution failed.');
    }

    return json.result;
  }
}

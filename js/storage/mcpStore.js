/* js/storage/mcpStore.js - Custom MCP Server Configuration Storage (Experimental) */
import { db } from './db.js';

export class MCPStore {
  /**
   * Get all registered Custom MCP Server configurations. Default is empty array.
   */
  static async getAll() {
    const record = await db.get('settings', 'customMcpServers');
    if (!record || !Array.isArray(record.value)) {
      return [];
    }
    return record.value;
  }

  static async getById(id) {
    const servers = await this.getAll();
    return servers.find(s => s.id === id) || null;
  }

  static async saveAll(servers) {
    await db.put('settings', {
      key: 'customMcpServers',
      value: servers
    });
  }

  static async save(mcpData) {
    const servers = await this.getAll();
    const existingIdx = servers.findIndex(s => s.id === mcpData.id);
    const now = Date.now();

    const mcpObj = {
      transport: 'http',
      endpointUrl: '',
      apiKey: '',
      command: '',
      args: [],
      env: {},
      description: '',
      enabled: true,
      ...mcpData,
      id: mcpData.id || `mcp-${now}-${Math.random().toString(36).substr(2, 4)}`,
      updatedAt: now
    };

    if (existingIdx >= 0) {
      servers[existingIdx] = mcpObj;
    } else {
      servers.push(mcpObj);
    }

    await this.saveAll(servers);
    return mcpObj;
  }

  static async delete(id) {
    const servers = await this.getAll();
    const filtered = servers.filter(s => s.id !== id);
    await this.saveAll(filtered);
  }

  static async toggleEnabled(id, enabled) {
    const server = await this.getById(id);
    if (server) {
      server.enabled = enabled;
      await this.save(server);
    }
  }

  static async getEnabledServers() {
    const servers = await this.getAll();
    return servers.filter(s => s.enabled);
  }

  /**
   * Convert stored MCP servers array into standard mcp_config.json format string.
   * Stdio servers get { command, args, env }; HTTP servers get { url, type: 'http' }
   * - the same shape used by Claude Desktop / Cursor / VS Code mcp.json files.
   */
  static toJSONConfig(servers) {
    const mcpServers = {};
    for (const s of servers) {
      const key = (s.name || s.id).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      const obj = { disabled: !s.enabled };

      if (s.transport === 'command') {
        obj.command = s.command || '';
        if (s.args && s.args.length) obj.args = s.args;
        if (s.env && Object.keys(s.env).length) obj.env = s.env;
      } else {
        obj.url = s.endpointUrl || '';
        obj.type = 'http';
        if (s.apiKey) obj.apiKey = s.apiKey;
      }
      if (s.description) obj.description = s.description;
      mcpServers[key] = obj;
    }
    return JSON.stringify({ mcpServers }, null, 2);
  }

  /**
   * Parse mcp_config.json string format into internal MCP server objects.
   * A `command` field means stdio transport; a `url` field means HTTP transport.
   */
  static parseJSONConfig(jsonString) {
    const json = JSON.parse(jsonString);
    const result = [];
    const now = Date.now();

    if (json.mcpServers && typeof json.mcpServers === 'object') {
      const entries = Object.entries(json.mcpServers);
      entries.forEach(([key, cfg], idx) => {
        const isCommand = !!cfg.command;
        result.push({
          id: `mcp-${now}-${idx}-${Math.random().toString(36).substr(2, 4)}`,
          name: key,
          transport: isCommand ? 'command' : 'http',
          endpointUrl: cfg.url || cfg.endpointUrl || '',
          command: cfg.command || '',
          args: Array.isArray(cfg.args) ? cfg.args : [],
          env: (cfg.env && typeof cfg.env === 'object') ? cfg.env : {},
          apiKey: cfg.apiKey || '',
          enabled: cfg.disabled !== undefined ? !cfg.disabled : (cfg.enabled !== undefined ? cfg.enabled : true),
          description: cfg.description || ''
        });
      });
    } else if (Array.isArray(json)) {
      json.forEach((item, idx) => {
        const isCommand = !!item.command;
        result.push({
          id: item.id || `mcp-${now}-${idx}`,
          name: item.name || `mcp_server_${idx + 1}`,
          transport: item.transport || (isCommand ? 'command' : 'http'),
          endpointUrl: item.endpointUrl || item.url || '',
          command: item.command || '',
          args: Array.isArray(item.args) ? item.args : [],
          env: (item.env && typeof item.env === 'object') ? item.env : {},
          apiKey: item.apiKey || '',
          enabled: item.enabled !== undefined ? item.enabled : true,
          description: item.description || ''
        });
      });
    } else {
      throw new Error('JSON configuration must contain "mcpServers" object or an array of server definitions.');
    }

    return result;
  }
}

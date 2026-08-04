/* js/storage/mcpStore.js - Custom MCP Server Configuration Storage (Experimental) */
import { db } from './db.js';

export class MCPStore {
  /**
   * Get all registered Custom MCP Server configurations
   */
  static async getAll() {
    const record = await db.get('settings', 'customMcpServers');
    if (!record || !Array.isArray(record.value)) {
      const defaultSamples = [
        {
          id: 'mcp-sample-memory',
          name: 'Long-Term Memory MCP',
          type: 'sse',
          endpointUrl: 'http://localhost:3000/mcp/memory',
          apiKey: '',
          enabled: true,
          description: 'Vector & Knowledge Memory Server for active roleplay sessions.'
        },
        {
          id: 'mcp-sample-web',
          name: 'Web Search & Live Info MCP',
          type: 'http',
          endpointUrl: 'http://localhost:3000/mcp/search',
          apiKey: '',
          enabled: false,
          description: 'Live internet search and real-time world knowledge retrieval.'
        }
      ];
      await db.put('settings', {
        key: 'customMcpServers',
        value: defaultSamples
      });
      return defaultSamples;
    }
    return record.value;
  }

  static async getById(id) {
    const servers = await this.getAll();
    return servers.find(s => s.id === id) || null;
  }

  static async save(mcpData) {
    const servers = await this.getAll();
    const existingIdx = servers.findIndex(s => s.id === mcpData.id);
    const now = Date.now();

    const mcpObj = {
      ...mcpData,
      id: mcpData.id || `mcp-${now}-${Math.random().toString(36).substr(2, 4)}`,
      updatedAt: now
    };

    if (existingIdx >= 0) {
      servers[existingIdx] = mcpObj;
    } else {
      servers.push(mcpObj);
    }

    await db.put('settings', {
      key: 'customMcpServers',
      value: servers
    });

    return mcpObj;
  }

  static async delete(id) {
    const servers = await this.getAll();
    const filtered = servers.filter(s => s.id !== id);
    await db.put('settings', {
      key: 'customMcpServers',
      value: filtered
    });
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
}

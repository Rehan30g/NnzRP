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
      // Per-tool Ask/Allow/Decline map - see getToolPermission() below. An
      // absent key (and an absent map entirely) always means 'ask'.
      toolPermissions: {},
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
   * Global master switch for MCP tool-calling, independent of individual
   * server `enabled` flags - lets the user kill all tool use app-wide (from
   * either the home MCP tab or the chat drawer) without having to toggle
   * every server back on again later. Defaults to true so existing setups
   * with servers already configured keep working exactly as before.
   */
  static async getGlobalEnabled() {
    const record = await db.get('settings', 'mcpGlobalEnabled');
    return record && typeof record.value === 'boolean' ? record.value : true;
  }

  static async setGlobalEnabled(enabled) {
    await db.put('settings', { key: 'mcpGlobalEnabled', value: !!enabled });
  }

  /**
   * "Immersive Roleplay" - when on, the prompt tells the model to proactively
   * reach for connected MCP tools as part of staying in character (e.g. using
   * a websearch tool when the character is browsing) instead of only calling
   * tools when explicitly asked. Off by default (opt-in behavior change).
   */
  static async getImmersiveRoleplay() {
    const record = await db.get('settings', 'mcpImmersiveRoleplay');
    return record && typeof record.value === 'boolean' ? record.value : false;
  }

  static async setImmersiveRoleplay(enabled) {
    await db.put('settings', { key: 'mcpImmersiveRoleplay', value: !!enabled });
  }

  /**
   * Immersive Roleplay intensity - how aggressively the model is told to
   * reach for tools once Immersive Roleplay is on. Only meaningful when
   * getImmersiveRoleplay() is true; PromptBuilder ignores it otherwise.
   *   - 'medium' (default): the original Immersive Roleplay behavior - use
   *     tools on natural in-character openings.
   *   - 'high': actively look for excuses to use tools nearly every turn,
   *     even for minor things.
   *   - 'max': NOT RECOMMENDED - tool use becomes the default instinct,
   *     fired even when the scene doesn't call for it at all.
   * Anything else stored (missing key, corrupted value, old data) fails
   * safe to 'medium', same normalize-on-every-read approach as permissions.
   */
  static normalizeImmersiveIntensity(value) {
    return value === 'high' || value === 'max' ? value : 'medium';
  }

  static async getImmersiveIntensity() {
    const record = await db.get('settings', 'mcpImmersiveIntensity');
    return this.normalizeImmersiveIntensity(record?.value);
  }

  static async setImmersiveIntensity(level) {
    await db.put('settings', { key: 'mcpImmersiveIntensity', value: this.normalizeImmersiveIntensity(level) });
  }

  /**
   * Optional custom cap on AgentRunner's tool-use loop (js/services/agentRunner.js),
   * completely independent of Immersive Roleplay/intensity - those only ever
   * affect prompt wording, never this. Off by default: AgentRunner then falls
   * back through its own existing chain (settings.mcpMaxToolIterations, then a
   * hardcoded 6), i.e. behavior for anyone who never touches this control is
   * unchanged. This was deliberately NOT auto-derived from immersive intensity
   * (an earlier version bumped it to 15/30 for High/MAX) - that silently
   * capped the model at a hard wall (AgentRunner throws once the cap is hit),
   * which fought against "use tools massively" instead of enabling it; a
   * manual, explicit, opt-in number the user sets themselves is clearer.
   */
  static async getMaxToolIterations() {
    const record = await db.get('settings', 'mcpCustomMaxIterations');
    const stored = record?.value;
    const enabled = !!(stored && stored.enabled);
    const rawValue = Number(stored?.value);
    const value = Number.isFinite(rawValue) && rawValue > 0 ? Math.floor(rawValue) : 20;
    return { enabled, value };
  }

  static async setMaxToolIterations({ enabled, value }) {
    const rawValue = Number(value);
    const safeValue = Number.isFinite(rawValue) && rawValue > 0 ? Math.floor(rawValue) : 20;
    await db.put('settings', { key: 'mcpCustomMaxIterations', value: { enabled: !!enabled, value: safeValue } });
  }

  /**
   * Permission for the builtin "view image from URL" tool (js/services/builtinTools.js)
   * - it isn't owned by any MCP server, so it can't live in a server's
   * `toolPermissions` map like the rest of this section. Same 'ask'/'allow'/
   * 'decline' semantics and the same 'ask'-is-default safety guarantee,
   * just a single global flag since there is only ever one builtin tool.
   */
  static async getBuiltinToolPermission() {
    const record = await db.get('settings', 'mcpBuiltinImageToolPermission');
    return this.normalizePermission(record?.value);
  }

  static async setBuiltinToolPermission(permission) {
    await db.put('settings', { key: 'mcpBuiltinImageToolPermission', value: this.normalizePermission(permission) });
  }

  /**
   * Global opt-in toggle for the builtin "Embed HTML" tool
   * (js/services/builtinTools.js) - lets the model render a self-contained
   * HTML/CSS/JS snippet in a sandboxed iframe directly in chat. Unlike
   * getGlobalEnabled() (default true), this defaults to FALSE: it's the one
   * builtin tool that actually executes AI-generated script content (even
   * sandboxed), so it must be an explicit opt-in, not an opt-out. Same
   * fail-safe `typeof ... === 'boolean'` pattern as every other boolean
   * setting in this file - an absent/corrupted stored value resolves to the
   * safe OFF state, never accidentally on.
   */
  static async getEmbedHtmlEnabled() {
    const record = await db.get('settings', 'mcpEmbedHtmlEnabled');
    return record && typeof record.value === 'boolean' ? record.value : false;
  }

  static async setEmbedHtmlEnabled(enabled) {
    await db.put('settings', { key: 'mcpEmbedHtmlEnabled', value: !!enabled });
  }

  /**
   * Global opt-in toggle for the builtin "wait" tool (js/services/builtinTools.js)
   * - lets the model pause the tool loop for up to 30s of in-scene pacing.
   * Harmless (no network, no script exec, no UI side effect), but still an
   * explicit opt-in so that flipping the MCP master switch on does not add a
   * tool to every chat and knock a no-tools session off its byte-for-byte
   * passthrough path. Same fail-safe boolean pattern - unset/corrupted => OFF.
   */
  static async getWaitToolEnabled() {
    const record = await db.get('settings', 'mcpWaitToolEnabled');
    return record && typeof record.value === 'boolean' ? record.value : false;
  }

  static async setWaitToolEnabled(enabled) {
    await db.put('settings', { key: 'mcpWaitToolEnabled', value: !!enabled });
  }

  /**
   * Permission for the builtin "Embed HTML" tool - same pattern/safety
   * guarantee as getBuiltinToolPermission()/setBuiltinToolPermission() above
   * (the view-image tool), just its own storage key: it isn't owned by any
   * MCP server either, so it needs its own single global Ask/Allow/Decline
   * flag rather than a per-server toolPermissions entry. Always normalized
   * through normalizePermission(), so an unset/corrupted value is 'ask'.
   */
  static async getEmbedHtmlToolPermission() {
    const record = await db.get('settings', 'mcpEmbedHtmlToolPermission');
    return this.normalizePermission(record?.value);
  }

  static async setEmbedHtmlToolPermission(permission) {
    await db.put('settings', { key: 'mcpEmbedHtmlToolPermission', value: this.normalizePermission(permission) });
  }

  /* ---------------------------------------------------------------------
   * Per-tool execution permissions (Ask / Allow / Decline)
   *
   * Stored per server as `server.toolPermissions`, an object keyed by the
   * tool's OWN raw name within that server (not the `server__tool` qualified
   * name used for provider function-calling) - e.g.
   *   { "browser_navigate": "allow", "browser_click": "decline" }
   *
   * SAFETY: 'ask' is the default for EVERY tool that has no explicit entry,
   * and every read funnels through `normalizePermission()`, which only ever
   * returns 'allow'/'decline' for those two exact literal strings and 'ask'
   * for anything else (missing key, missing map, missing server, corrupted
   * value, undefined, null). There is no code path where an unconfigured
   * tool resolves to 'allow'.
   * ------------------------------------------------------------------- */

  /** The only three valid permission values, in UI display order. */
  static TOOL_PERMISSIONS = ['ask', 'allow', 'decline'];

  /** Coerces any stored/user-supplied value to a valid permission, defaulting to the safe 'ask'. */
  static normalizePermission(permission) {
    return (permission === 'allow' || permission === 'decline') ? permission : 'ask';
  }

  /** Returns 'ask' | 'allow' | 'decline' for one tool of one server. Unset/unknown -> 'ask'. */
  static async getToolPermission(serverId, toolName) {
    const server = await this.getById(serverId);
    if (!server || !toolName) return 'ask';
    const map = server.toolPermissions;
    if (!map || typeof map !== 'object') return 'ask';
    return this.normalizePermission(map[toolName]);
  }

  /** Whole map for one server, normalized. Used by the permission editor UI. */
  static async getToolPermissions(serverId) {
    const server = await this.getById(serverId);
    const map = (server && server.toolPermissions && typeof server.toolPermissions === 'object')
      ? server.toolPermissions
      : {};
    const normalized = {};
    for (const [name, value] of Object.entries(map)) {
      const perm = this.normalizePermission(value);
      if (perm !== 'ask') normalized[name] = perm;
    }
    return normalized;
  }

  static async setToolPermission(serverId, toolName, permission) {
    const server = await this.getById(serverId);
    if (!server || !toolName) return null;
    const perm = this.normalizePermission(permission);
    const map = (server.toolPermissions && typeof server.toolPermissions === 'object')
      ? { ...server.toolPermissions }
      : {};
    // 'ask' is the default, so it's stored as absence rather than a value -
    // keeps the map small and makes "unset" and "explicitly ask" identical.
    if (perm === 'ask') delete map[toolName];
    else map[toolName] = perm;
    return this.save({ ...server, toolPermissions: map });
  }

  /**
   * Bulk one-click "set every tool of this server to X". `toolNames` is the
   * currently-discovered tool list supplied by the caller (this layer has no
   * way to discover tools itself - that's MCPClient/MCPToolRegistry's job).
   */
  static async setAllToolPermissions(serverId, permission, toolNames = []) {
    const server = await this.getById(serverId);
    if (!server) return null;
    const perm = this.normalizePermission(permission);
    if (perm === 'ask') {
      // Reset to default = clear the map entirely (covers tools that are no
      // longer discoverable but still had a stored override).
      return this.save({ ...server, toolPermissions: {} });
    }
    const map = {};
    for (const name of toolNames) {
      if (name) map[name] = perm;
    }
    return this.save({ ...server, toolPermissions: map });
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

/* js/ui/views/mcpView.js - Custom MCP Server Configuration View (Experimental) */
import { MCPStore } from '../../storage/mcpStore.js';
import { MCPClient } from '../../services/mcpClient.js';
import { MCPToolRegistry } from '../../services/mcpToolRegistry.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { dropdownHTML, wireDropdown } from '../components/dropdown.js';
import { toggleSwitchHTML, toggleRowHTML } from '../components/toggle.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

// Shared between this view's own "Tool Use Frequency" segmented control and
// its mirrored copy in the chat drawer's MCP tab (chatView.js imports these
// directly), so the wording can't drift between the two like the toggle rows
// they sit under could if hand-copied.
export const INTENSITY_LABELS = { medium: 'Medium', high: 'High', max: 'MAX' };
export const MCP_INTENSITY_HINTS = {
  medium: 'Default - uses tools on natural in-character openings.',
  high: 'Uses tools more often, even for minor or not-strictly-necessary things.',
  max: 'Not recommended - massively increases tool calls, even for complex questions or situations that clearly don’t need one.'
};

export class MCPView {
  static async render(container) {
    const servers = await MCPStore.getAll();

    container.innerHTML = `
      <div class="view-header-row">
        <div>
          <h2 style="font-size:1.5rem; margin-bottom:0.25rem;">Custom MCP Servers & Tools (Experimental)</h2>
          <p style="color:var(--text-muted); font-size:0.88rem;">Connect Model Context Protocol servers (HTTP or local stdio/command) so AI characters can call real tools mid-roleplay.</p>
        </div>
        <div style="display:flex; gap:0.75rem;">
          <button class="btn btn-secondary btn-sm" id="btn-edit-mcp-json">Edit JSON Config</button>
          <button class="btn btn-primary btn-sm" id="btn-add-mcp">+ Add MCP Server</button>
        </div>
      </div>

      <div class="card card-muted" style="margin-bottom:1.5rem;">
        <p style="color:var(--text-muted); font-size:0.85rem; line-height:1.5; margin:0;">
          Servers you add here are only reachable by name+arguments the model chooses at runtime - the model can never configure or launch a new server itself. Stdio/command servers run as local child processes of this desktop app.
        </p>
      </div>

      <div class="card" style="margin-bottom:1.5rem; display:flex; flex-direction:column; gap:1rem;">
        ${toggleRowHTML({
          id: 'mcp-global-toggle',
          title: 'MCP Tools',
          description: "Master switch - turns all MCP tool-calling on/off across every chat. Same switch is also in the chat drawer's MCP tab.",
          ariaLabel: 'Enable MCP tools globally'
        })}
        <div style="border-top:1px solid var(--border-light); padding-top:1rem;">
          ${toggleRowHTML({
            id: 'mcp-immersive-toggle',
            title: 'Immersive Roleplay',
            description: 'Tells the model to proactively use connected tools in-character (e.g. a websearch tool while a character is browsing, or to pull up-to-date info during the scene) instead of only calling them when explicitly asked.',
            ariaLabel: 'Enable immersive proactive tool use'
          })}
          <div id="mcp-intensity-row" style="margin-top:0.9rem; padding-top:0.9rem; border-top:1px solid var(--border-light);">
            <div class="form-label" style="margin-bottom:0.5rem;">Tool Use Frequency</div>
            <div class="segmented" role="group" id="mcp-intensity-group">
              <button type="button" class="segmented-option" data-value="medium">Medium</button>
              <button type="button" class="segmented-option" data-value="high">High</button>
              <button type="button" class="segmented-option" data-value="max">MAX</button>
            </div>
            <p id="mcp-intensity-hint" style="font-size:0.78rem; color:var(--text-muted); margin:0.5rem 0 0;"></p>
          </div>
        </div>
        <div style="border-top:1px solid var(--border-light); padding-top:1rem;">
          ${toggleRowHTML({
            id: 'mcp-iteration-limit-toggle',
            title: 'Custom Tool Call Limit',
            description: "Caps how many tool-call rounds the model may chain in a single reply before it must give a final answer. Off by default, which keeps the app's original built-in cap of 6 rounds - turn this on to raise (or lower) it yourself.",
            ariaLabel: 'Enable a custom tool call round limit'
          })}
          <div id="mcp-iteration-limit-row" style="margin-top:0.9rem; display:flex; align-items:center; gap:0.6rem;">
            <label class="form-label" for="mcp-iteration-limit-value" style="margin:0;">Max rounds per reply:</label>
            <input class="input" type="number" id="mcp-iteration-limit-value" min="1" max="500" step="1" style="width:90px;">
          </div>
        </div>
      </div>

      <div id="mcp-servers-section">
        ${servers.length === 0 ? `
          <div class="card" style="text-align:center; padding:3rem 1.5rem; color:var(--text-muted);">
            <h3 style="font-size:1.1rem; margin-bottom:0.5rem; color:var(--text-main);">Belum ada MCP Server</h3>
            <p style="font-size:0.88rem; max-width:480px; margin:0 auto 1.25rem;">Tambahkan server MCP baru atau paste konfigurasi <code>mcp_config.json</code> yang sudah ada.</p>
          </div>
        ` : `
          <div class="grid-cards">
            ${servers.map(s => `
              <div class="card" data-id="${s.id}" style="border-color:${s.enabled ? 'var(--accent-primary)' : 'var(--border-light)'};">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.6rem;">
                  <div>
                    <h3 style="font-size:1.05rem; margin-bottom:0.3rem;">${escapeHtml(s.name)}</h3>
                    <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">
                      <span class="badge badge-cyan">${s.transport === 'command' ? 'STDIO' : 'HTTP'}</span>
                      <span class="badge" id="status-badge-${s.id}">Unknown</span>
                    </div>
                  </div>
                  <div style="display:flex; align-items:center; gap:0.4rem;">
                    ${toggleSwitchHTML({
                      inputClass: 'mcp-enabled-check',
                      data: { id: s.id },
                      checked: !!s.enabled,
                      title: 'Enable this server for roleplay sessions'
                    })}
                  </div>
                </div>

                <div style="font-size:0.78rem; color:var(--text-muted); font-family:var(--font-mono); word-break:break-all; margin-bottom:0.6rem;">
                  ${s.transport === 'command'
                    ? escapeHtml(`${s.command || ''} ${(s.args || []).join(' ')}`.trim() || '-')
                    : escapeHtml(s.endpointUrl || '-')}
                </div>

                <p style="color:var(--text-muted); font-size:0.85rem; margin-bottom:1rem;">${escapeHtml(s.description) || 'Tidak ada deskripsi.'}</p>

                <div style="display:flex; flex-direction:column; gap:0.5rem; border-top:1px solid var(--border-light); padding-top:0.8rem;">
                  <div style="display:flex; gap:0.4rem;">
                    <button class="btn btn-secondary btn-sm btn-check-mcp-status" data-id="${s.id}" style="flex:1;">Check Status</button>
                    <button class="btn btn-secondary btn-sm btn-mcp-perms" data-id="${s.id}" style="flex:1;">Tool Permissions</button>
                  </div>
                  <div style="display:flex; gap:0.4rem;">
                    <button class="btn btn-secondary btn-sm btn-edit-mcp" data-id="${s.id}" style="flex:1;">Edit</button>
                    <button class="btn btn-danger btn-sm btn-del-mcp" data-id="${s.id}" style="flex:1;">Delete</button>
                  </div>
                </div>

                <!-- Per-tool Ask/Allow/Decline editor - populated lazily on
                     first expand (it needs a live tools/list round trip). -->
                <div class="mcp-perm-host hidden" id="mcp-perm-host-${s.id}" style="margin-top:0.8rem; border-top:1px solid var(--border-light); padding-top:0.8rem;"></div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    `;

    container.querySelector('#btn-add-mcp').onclick = () => {
      MCPView.openMCPModal(null, () => MCPView.render(container));
    };
    container.querySelector('#btn-edit-mcp-json').onclick = () => {
      MCPView.openJSONEditorModal(() => MCPView.render(container));
    };

    // MCP master switch + Immersive Roleplay toggle - global settings, also
    // mirrored in the chat drawer's MCP tab (chatView.js).
    const globalToggle = container.querySelector('#mcp-global-toggle');
    const immersiveToggle = container.querySelector('#mcp-immersive-toggle');
    const serversSection = container.querySelector('#mcp-servers-section');
    const intensityRow = container.querySelector('#mcp-intensity-row');
    const intensityGroup = container.querySelector('#mcp-intensity-group');
    const intensityHint = container.querySelector('#mcp-intensity-hint');

    const applyMasterVisualState = (enabled) => {
      if (serversSection) {
        serversSection.style.opacity = enabled ? '1' : '0.5';
        serversSection.style.pointerEvents = enabled ? '' : 'none';
      }
      if (immersiveToggle) immersiveToggle.disabled = !enabled;
    };

    // Tool Use Frequency only means anything while Immersive Roleplay itself
    // is on - dimmed/inert otherwise, same visual pattern as the master
    // switch dimming the server list below it.
    const applyIntensityVisualState = (immersiveOn) => {
      if (intensityRow) {
        intensityRow.style.opacity = immersiveOn ? '1' : '0.5';
        intensityRow.style.pointerEvents = immersiveOn ? '' : 'none';
      }
    };

    const setActiveIntensityButton = (value) => {
      if (!intensityGroup) return;
      intensityGroup.querySelectorAll('.segmented-option').forEach(b => {
        b.classList.toggle('active', b.dataset.value === value);
      });
      if (intensityHint) intensityHint.textContent = MCP_INTENSITY_HINTS[value] || '';
    };

    globalToggle.checked = await MCPStore.getGlobalEnabled();
    applyMasterVisualState(globalToggle.checked);
    globalToggle.onchange = async (e) => {
      await MCPStore.setGlobalEnabled(e.target.checked);
      applyMasterVisualState(e.target.checked);
      Toast.info(`MCP Tools ${e.target.checked ? 'diaktifkan' : 'dinonaktifkan'} secara global.`);
    };

    immersiveToggle.checked = await MCPStore.getImmersiveRoleplay();
    immersiveToggle.disabled = !globalToggle.checked;
    applyIntensityVisualState(immersiveToggle.checked);
    immersiveToggle.onchange = async (e) => {
      await MCPStore.setImmersiveRoleplay(e.target.checked);
      applyIntensityVisualState(e.target.checked);
      Toast.info(`Immersive Roleplay ${e.target.checked ? 'diaktifkan' : 'dinonaktifkan'}.`);
    };

    setActiveIntensityButton(await MCPStore.getImmersiveIntensity());
    if (intensityGroup) {
      intensityGroup.querySelectorAll('.segmented-option').forEach(btn => {
        btn.onclick = async () => {
          const value = btn.dataset.value;
          await MCPStore.setImmersiveIntensity(value);
          setActiveIntensityButton(value);
          Toast.info(`Tool Use Frequency diset ke ${INTENSITY_LABELS[value] || value}.`);
        };
      });
    }

    // Custom Tool Call Limit - independent of Immersive Roleplay/intensity,
    // off by default (see MCPStore.getMaxToolIterations()).
    const iterationLimitToggle = container.querySelector('#mcp-iteration-limit-toggle');
    const iterationLimitRow = container.querySelector('#mcp-iteration-limit-row');
    const iterationLimitInput = container.querySelector('#mcp-iteration-limit-value');

    const applyIterationLimitVisualState = (enabled) => {
      if (iterationLimitRow) {
        iterationLimitRow.style.opacity = enabled ? '1' : '0.5';
        iterationLimitRow.style.pointerEvents = enabled ? '' : 'none';
      }
    };

    if (iterationLimitToggle && iterationLimitInput) {
      const storedLimit = await MCPStore.getMaxToolIterations();
      iterationLimitToggle.checked = storedLimit.enabled;
      iterationLimitInput.value = storedLimit.value;
      applyIterationLimitVisualState(storedLimit.enabled);

      iterationLimitToggle.onchange = async (e) => {
        await MCPStore.setMaxToolIterations({ enabled: e.target.checked, value: iterationLimitInput.value });
        applyIterationLimitVisualState(e.target.checked);
        Toast.info(`Custom Tool Call Limit ${e.target.checked ? 'diaktifkan' : 'dinonaktifkan'}.`);
      };
      iterationLimitInput.onchange = async (e) => {
        await MCPStore.setMaxToolIterations({ enabled: iterationLimitToggle.checked, value: e.target.value });
        // Reflect back whatever got clamped/defaulted server-side (e.g. blank or 0 input).
        const saved = await MCPStore.getMaxToolIterations();
        iterationLimitInput.value = saved.value;
      };
    }

    container.querySelectorAll('.mcp-enabled-check').forEach(chk => {
      chk.onchange = async (e) => {
        await MCPStore.toggleEnabled(e.target.dataset.id, e.target.checked);
        MCPToolRegistry.invalidate(e.target.dataset.id);
        Toast.info(`MCP Server ${e.target.checked ? 'diaktifkan' : 'dinonaktifkan'}.`);
      };
    });

    const checkServerStatus = async (server, { silent = false } = {}) => {
      const badgeEl = container.querySelector(`#status-badge-${server.id}`);
      if (!badgeEl) return;
      badgeEl.textContent = 'Checking...';
      badgeEl.className = 'badge';
      const status = await MCPClient.checkStatus(server);
      if (status.online) {
        badgeEl.textContent = `Online (${status.toolCount} tools)`;
        badgeEl.className = 'badge badge-emerald';
        if (!silent) Toast.success(`"${server.name}": ${status.toolCount} tool(s) discovered.`);
      } else {
        badgeEl.textContent = 'Offline';
        badgeEl.className = 'badge badge-rose';
        if (!silent) Toast.error(`"${server.name}" unreachable: ${status.error}`);
      }
    };

    container.querySelectorAll('.btn-check-mcp-status').forEach(btn => {
      btn.onclick = async () => {
        const server = await MCPStore.getById(btn.dataset.id);
        if (server) await checkServerStatus(server);
      };
    });

    // Check every listed server's status as soon as this view opens, so
    // reachability is visible immediately instead of showing "Unknown" until
    // the user clicks each "Check Status" button by hand.
    servers.forEach(s => { checkServerStatus(s, { silent: true }); });

    // Per-server tool permission editor, expanded on demand (loading it for
    // every card up front would fire a tools/list round trip per server on
    // every render of this view).
    container.querySelectorAll('.btn-mcp-perms').forEach(btn => {
      btn.onclick = async () => {
        const hostEl = container.querySelector(`#mcp-perm-host-${btn.dataset.id}`);
        if (!hostEl) return;
        const nowHidden = hostEl.classList.toggle('hidden');
        // The server cards sit in a narrow multi-column grid; a 12-row list of
        // tool names + 3-way controls needs the full row width to stay readable.
        const cardEl = btn.closest('.card');
        if (cardEl) cardEl.style.gridColumn = nowHidden ? '' : '1 / -1';
        if (nowHidden) return;
        if (!hostEl.dataset.loaded) {
          hostEl.dataset.loaded = '1';
          await MCPView.renderToolPermissions(hostEl, btn.dataset.id);
        }
      };
    });

    container.querySelectorAll('.btn-edit-mcp').forEach(btn => {
      btn.onclick = async () => {
        const server = await MCPStore.getById(btn.dataset.id);
        MCPView.openMCPModal(server, () => MCPView.render(container));
      };
    });

    container.querySelectorAll('.btn-del-mcp').forEach(btn => {
      btn.onclick = async () => {
        if (confirm('Hapus profil Custom MCP Server ini?')) {
          const server = await MCPStore.getById(btn.dataset.id);
          if (server) await MCPClient.stopIfRunning(server);
          await MCPStore.delete(btn.dataset.id);
          MCPToolRegistry.invalidate(btn.dataset.id);
          Toast.info('MCP Server dihapus.');
          await MCPView.render(container);
        }
      };
    });
  }

  /**
   * Renders the per-tool Ask / Allow / Decline permission editor for ONE MCP
   * server into `hostEl`, including the one-click "set every tool of this
   * server to X" bulk control.
   *
   * Shared deliberately: this is the primary settings surface (the `#mcp`
   * route's server cards) AND the copy mirrored into the chat right-drawer's
   * MCP tab, the same way the master/immersive switches are duplicated -
   * having one implementation means the two can't drift.
   *
   * 'ask' is the default for anything unset, and is stored as ABSENCE of a
   * key (see MCPStore) - so a tool this UI has never touched, and a tool
   * explicitly set back to Ask, are the same state.
   */
  static async renderToolPermissions(hostEl, serverId) {
    if (!hostEl) return;
    hostEl.innerHTML = `<div style="font-size:0.8rem; color:var(--text-muted);">Memuat daftar tool...</div>`;

    const server = await MCPStore.getById(serverId);
    if (!server) {
      hostEl.innerHTML = `<div style="font-size:0.8rem; color:var(--accent-rose);">Server tidak ditemukan.</div>`;
      return;
    }

    const [status, stored] = await Promise.all([
      MCPClient.checkStatus(server),
      MCPStore.getToolPermissions(serverId)
    ]);

    const discovered = status.online
      ? status.tools.map(t => t && t.name).filter(Boolean)
      : [];
    // Stored-but-not-currently-discoverable tools are still listed so an
    // existing override stays visible/removable even while the server is
    // offline or has dropped a tool from its listing.
    const toolNames = [...new Set([...discovered, ...Object.keys(stored)])];

    const permLabel = { ask: 'Ask', allow: 'Allow', decline: 'Decline' };
    const segHTML = (toolName, current) => `
      <div class="perm-seg" data-tool="${escapeAttr(toolName)}">
        ${['ask', 'allow', 'decline'].map(p => `
          <button type="button" data-perm="${p}" class="perm-seg-${p}${p === current ? ' active' : ''}">${permLabel[p]}</button>
        `).join('')}
      </div>
    `;

    hostEl.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:0.75rem; flex-wrap:wrap; margin-bottom:0.6rem;">
        <div>
          <div style="font-weight:700; font-size:0.85rem;">Tool Permissions</div>
          <div style="font-size:0.75rem; color:var(--text-muted); margin-top:0.1rem;">
            <strong>Ask</strong> (default) menampilkan dialog di atas kolom pesan tiap kali dipanggil. <strong>Allow</strong> jalan langsung, <strong>Decline</strong> selalu ditolak.
          </div>
        </div>
        <div class="perm-bulk" style="display:flex; align-items:center; gap:0.4rem; flex-shrink:0;">
          <span style="font-size:0.75rem; color:var(--text-muted);">Set semua:</span>
          ${['ask', 'allow', 'decline'].map(p => `
            <button type="button" class="btn btn-secondary btn-sm" data-bulk="${p}" style="padding:0.15rem 0.5rem; font-size:0.72rem;">${permLabel[p]}</button>
          `).join('')}
        </div>
      </div>
      ${!status.online ? `
        <div style="font-size:0.75rem; color:var(--accent-rose); margin-bottom:0.5rem;">
          Server offline (${escapeHtml(status.error || 'unknown error')}) - daftar tool tidak bisa dimuat. Tool tanpa pengaturan tersimpan tetap default <strong>Ask</strong>.
        </div>
      ` : ''}
      ${toolNames.length === 0 ? `
        <div style="font-size:0.8rem; color:var(--text-muted);">Tidak ada tool yang terdeteksi.</div>
      ` : `
        <div class="perm-list" style="display:flex; flex-direction:column; gap:0.35rem;">
          ${toolNames.map(name => `
            <div style="display:flex; justify-content:space-between; align-items:center; gap:0.6rem;">
              <span style="font-family:var(--font-mono); font-size:0.78rem; overflow-wrap:anywhere;">${escapeHtml(name)}${discovered.includes(name) ? '' : ' <span style="color:var(--text-muted); font-family:var(--font-family);">(tidak terdeteksi)</span>'}</span>
              ${segHTML(name, stored[name] || 'ask')}
            </div>
          `).join('')}
        </div>
      `}
    `;

    const markActive = (segEl, permission) => {
      segEl.querySelectorAll('button[data-perm]').forEach(b => {
        b.classList.toggle('active', b.dataset.perm === permission);
      });
    };

    hostEl.querySelectorAll('.perm-seg button[data-perm]').forEach(btn => {
      btn.onclick = async () => {
        const segEl = btn.closest('.perm-seg');
        const toolName = segEl.dataset.tool;
        const permission = btn.dataset.perm;
        await MCPStore.setToolPermission(serverId, toolName, permission);
        markActive(segEl, permission);
        Toast.info(`"${toolName}" -> ${permLabel[permission]}`);
      };
    });

    hostEl.querySelectorAll('button[data-bulk]').forEach(btn => {
      btn.onclick = async () => {
        const permission = btn.dataset.bulk;
        await MCPStore.setAllToolPermissions(serverId, permission, toolNames);
        // Update every row in place rather than re-rendering - a re-render
        // would fire another tools/list round trip just to redraw buttons.
        hostEl.querySelectorAll('.perm-seg').forEach(segEl => markActive(segEl, permission));
        Toast.success(`Semua tool "${server.name}" diset ke ${permLabel[permission]}.`);
      };
    });
  }

  /** JSON Config Editor Modal (mcp_config.json format) */
  static async openJSONEditorModal(onSaved) {
    const servers = await MCPStore.getAll();
    const jsonString = MCPStore.toJSONConfig(servers);

    const contentHTML = `
      <div>
        <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.75rem;">
          Edit atau paste konfigurasi <code>mcp_config.json</code> standar (kompatibel dengan format Claude Desktop / Cursor):
        </div>
        <textarea class="textarea" id="mcp-raw-json" rows="14" style="font-family:var(--font-mono); font-size:0.82rem; line-height:1.45;">${escapeHtml(jsonString)}</textarea>
      </div>
    `;

    Modal.open({
      title: 'Edit JSON Config (mcp_config.json)',
      contentHTML,
      buttons: [
        { label: 'Batal', className: 'btn-secondary', onClick: () => Modal.close() },
        {
          label: 'Simpan JSON',
          className: 'btn-primary',
          onClick: async () => {
            const rawText = document.getElementById('mcp-raw-json').value.trim();
            if (!rawText) {
              await MCPStore.saveAll([]);
              Toast.success('Konfigurasi MCP dikosongkan.');
              Modal.close();
              onSaved();
              return;
            }
            try {
              const parsedServers = MCPStore.parseJSONConfig(rawText);
              await MCPStore.saveAll(parsedServers);
              Toast.success(`Berhasil menyimpan ${parsedServers.length} server MCP dari JSON.`);
              Modal.close();
              onSaved();
            } catch (err) {
              Toast.error(`JSON Parse Error: ${err.message}`);
            }
          }
        }
      ]
    });
  }

  /** Single MCP Server Add/Edit Form Modal, with a live "Discover Tools" test. */
  static openMCPModal(server = null, onSaved) {
    const isEdit = !!server;
    const data = server || {
      name: '', transport: 'http', endpointUrl: '', apiKey: '',
      command: '', args: [], env: {}, enabled: true, description: ''
    };

    const contentHTML = `
      <form id="form-mcp" onsubmit="return false;">
        <div class="form-group">
          <label class="form-label">MCP Server Name *</label>
          <input class="input" id="mcp-name" value="${escapeAttr(data.name)}" required placeholder="e.g. filesystem_tools">
        </div>

        <div class="form-group">
          <label class="form-label">Transport</label>
          ${dropdownHTML({
            id: 'mcp-transport',
            value: data.transport === 'command' ? 'command' : 'http',
            options: [
              { value: 'http', label: 'HTTP', hint: 'Streamable JSON-RPC endpoint' },
              { value: 'command', label: 'Local Command / Stdio', hint: 'Spawned child process (e.g. npx)' }
            ]
          })}
        </div>

        <div id="mcp-http-fields" style="${data.transport === 'command' ? 'display:none;' : ''}">
          <div class="form-group">
            <label class="form-label">Server Endpoint URL *</label>
            <input class="input" id="mcp-url" value="${escapeAttr(data.endpointUrl)}" placeholder="https://example.com/mcp">
          </div>
          <div class="form-group">
            <label class="form-label">API Key / Token (Optional)</label>
            <input class="input" type="password" id="mcp-key" value="${escapeAttr(data.apiKey)}" placeholder="sk-...">
          </div>
        </div>

        <div id="mcp-command-fields" style="${data.transport === 'command' ? '' : 'display:none;'}">
          <div class="form-group">
            <label class="form-label">Command *</label>
            <input class="input" id="mcp-command" value="${escapeAttr(data.command)}" placeholder="npx">
          </div>
          <div class="form-group">
            <label class="form-label">Arguments (space separated)</label>
            <input class="input" id="mcp-args" value="${escapeAttr((data.args || []).join(' '))}" placeholder="-y @modelcontextprotocol/server-filesystem C:\\Users\\me\\Documents">
          </div>
          <div class="form-group">
            <label class="form-label">Environment Variables (one KEY=value per line)</label>
            <textarea class="textarea" id="mcp-env" rows="3" placeholder="API_KEY=sk-...">${escapeHtml(Object.entries(data.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'))}</textarea>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Description</label>
          <textarea class="textarea" id="mcp-desc" rows="2" placeholder="Ringkasan fungsi server MCP ini...">${escapeHtml(data.description)}</textarea>
        </div>

        <div style="margin-top:0.5rem; margin-bottom:1.25rem;">
          ${toggleRowHTML({
            id: 'mcp-enabled',
            checked: !!data.enabled,
            title: 'Aktifkan Server MCP ini',
            description: 'Server yang aktif akan didiscover tool-nya saat chat dimulai.'
          })}
        </div>

        <div class="card card-muted" style="padding:1rem;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
            <span style="font-size:0.85rem; font-weight:600;">Test Connection</span>
            <button type="button" class="btn btn-secondary btn-sm" id="mcp-discover-btn">Discover Tools</button>
          </div>
          <div id="mcp-discover-result" style="font-size:0.8rem; color:var(--text-muted);">Belum diuji.</div>
        </div>
      </form>
    `;

    const readFormValues = () => {
      const transport = document.getElementById('mcp-transport').value;
      const env = {};
      document.getElementById('mcp-env').value.split('\n').forEach(line => {
        const idx = line.indexOf('=');
        if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
      return {
        ...data,
        name: document.getElementById('mcp-name').value.trim(),
        transport,
        endpointUrl: document.getElementById('mcp-url').value.trim(),
        apiKey: document.getElementById('mcp-key').value.trim(),
        command: document.getElementById('mcp-command').value.trim(),
        args: document.getElementById('mcp-args').value.trim().split(/\s+/).filter(Boolean),
        env,
        description: document.getElementById('mcp-desc').value.trim(),
        enabled: document.getElementById('mcp-enabled').checked
      };
    };

    const overlay = Modal.open({
      title: isEdit ? `Edit MCP: ${escapeHtml(data.name)}` : 'Add MCP Server',
      contentHTML,
      buttons: [
        ...(isEdit ? [{
          label: 'Hapus MCP',
          className: 'btn-danger',
          onClick: async () => {
            await MCPClient.stopIfRunning(data);
            await MCPStore.delete(data.id);
            MCPToolRegistry.invalidate(data.id);
            Toast.info('MCP Server dihapus.');
            Modal.close();
            onSaved();
          }
        }] : []),
        { label: 'Batal', className: 'btn-secondary', onClick: () => Modal.close() },
        {
          label: 'Simpan Profil',
          className: 'btn-primary',
          onClick: async () => {
            const values = readFormValues();
            if (!values.name) return Toast.error('MCP Name is required.');
            if (values.transport === 'http' && !values.endpointUrl) return Toast.error('Server Endpoint URL is required.');
            if (values.transport === 'command' && !values.command) return Toast.error('Command is required.');

            if (isEdit) MCPClient.resetSession(data.id);
            await MCPStore.save(values);
            MCPToolRegistry.invalidate(values.id || data.id);
            Toast.success('Profil Custom MCP Server berhasil disimpan.');
            Modal.close();
            onSaved();
          }
        }
      ]
    });

    // Transport toggle swaps visible field groups
    wireDropdown(overlay, 'mcp-transport', (value) => {
      const isCommand = value === 'command';
      overlay.querySelector('#mcp-http-fields').style.display = isCommand ? 'none' : '';
      overlay.querySelector('#mcp-command-fields').style.display = isCommand ? '' : 'none';
    });

    // Live "Discover Tools" test using whatever is currently typed in the form.
    // Uses a stable preview id (not saved) so a stdio test process can be found and
    // stopped again afterward instead of leaking a child process per click.
    const previewId = data.id || 'mcp-preview-unsaved';
    overlay.querySelector('#mcp-discover-btn').onclick = async () => {
      const resultEl = overlay.querySelector('#mcp-discover-result');
      const testServer = { ...readFormValues(), id: previewId };
      resultEl.textContent = 'Menghubungkan...';
      resultEl.style.color = 'var(--text-muted)';

      if (testServer.transport === 'http' && !testServer.endpointUrl) {
        resultEl.textContent = 'Isi Server Endpoint URL terlebih dahulu.';
        return;
      }
      if (testServer.transport === 'command' && !testServer.command) {
        resultEl.textContent = 'Isi Command terlebih dahulu.';
        return;
      }

      const status = await MCPClient.checkStatus(testServer);
      if (!isEdit && testServer.transport === 'command') {
        // A brand-new/unsaved server has no other owner - stop the preview
        // process after the one-off test instead of leaking it. An existing
        // (isEdit) server's process is left running since a live chat session
        // may already depend on it.
        await MCPClient.stopIfRunning(testServer);
      }
      if (status.online) {
        resultEl.style.color = 'var(--accent-emerald)';
        resultEl.innerHTML = `Berhasil! ${status.toolCount} tool ditemukan: ${
          status.tools.slice(0, 8).map(t => `<code>${escapeHtml(t.name)}</code>`).join(', ') || '-'
        }`;
      } else {
        resultEl.style.color = 'var(--accent-rose)';
        resultEl.textContent = `Gagal: ${status.error}`;
      }
    };
  }
}

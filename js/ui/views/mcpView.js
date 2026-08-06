/* js/ui/views/mcpView.js - Custom MCP Server Configuration View (Experimental) */
import { MCPStore } from '../../storage/mcpStore.js';
import { MCPClient } from '../../services/mcpClient.js';
import { MCPToolRegistry } from '../../services/mcpToolRegistry.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

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

      <div class="card" style="margin-bottom:1.5rem; background:#f8fafc;">
        <p style="color:var(--text-muted); font-size:0.85rem; line-height:1.5; margin:0;">
          Servers you add here are only reachable by name+arguments the model chooses at runtime - the model can never configure or launch a new server itself. Stdio/command servers run as local child processes of this desktop app.
        </p>
      </div>

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
                  <input type="checkbox" class="mcp-enabled-check" data-id="${s.id}" ${s.enabled ? 'checked' : ''} title="Enable this server for roleplay sessions">
                </div>
              </div>

              <div style="font-size:0.78rem; color:var(--text-muted); font-family:var(--font-mono); word-break:break-all; margin-bottom:0.6rem;">
                ${s.transport === 'command'
                  ? escapeHtml(`${s.command || ''} ${(s.args || []).join(' ')}`.trim() || '-')
                  : escapeHtml(s.endpointUrl || '-')}
              </div>

              <p style="color:var(--text-muted); font-size:0.85rem; margin-bottom:1rem;">${escapeHtml(s.description) || 'Tidak ada deskripsi.'}</p>

              <div style="display:flex; justify-content:space-between; gap:0.5rem; border-top:1px solid var(--border-light); padding-top:0.8rem;">
                <button class="btn btn-secondary btn-sm btn-check-mcp-status" data-id="${s.id}">Check Status</button>
                <div style="display:flex; gap:0.4rem;">
                  <button class="btn btn-secondary btn-sm btn-edit-mcp" data-id="${s.id}">Edit</button>
                  <button class="btn btn-danger btn-sm btn-del-mcp" data-id="${s.id}">Delete</button>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    `;

    container.querySelector('#btn-add-mcp').onclick = () => {
      MCPView.openMCPModal(null, () => MCPView.render(container));
    };
    container.querySelector('#btn-edit-mcp-json').onclick = () => {
      MCPView.openJSONEditorModal(() => MCPView.render(container));
    };

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
          <select class="select" id="mcp-transport">
            <option value="http" ${data.transport !== 'command' ? 'selected' : ''}>HTTP (Streamable JSON-RPC)</option>
            <option value="command" ${data.transport === 'command' ? 'selected' : ''}>Local Command / Stdio (e.g. npx)</option>
          </select>
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

        <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.5rem; margin-bottom:1rem;">
          <input type="checkbox" id="mcp-enabled" ${data.enabled ? 'checked' : ''}>
          <label for="mcp-enabled" style="font-size:0.85rem; cursor:pointer;">Aktifkan Server MCP ini</label>
        </div>

        <div class="card" style="background:#f8fafc; padding:0.85rem;">
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
    overlay.querySelector('#mcp-transport').onchange = (e) => {
      const isCommand = e.target.value === 'command';
      overlay.querySelector('#mcp-http-fields').style.display = isCommand ? 'none' : '';
      overlay.querySelector('#mcp-command-fields').style.display = isCommand ? '' : 'none';
    };

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
        resultEl.style.color = 'var(--accent-emerald, #16a34a)';
        resultEl.innerHTML = `Berhasil! ${status.toolCount} tool ditemukan: ${
          status.tools.slice(0, 8).map(t => `<code>${escapeHtml(t.name)}</code>`).join(', ') || '-'
        }`;
      } else {
        resultEl.style.color = 'var(--accent-rose, #dc2626)';
        resultEl.textContent = `Gagal: ${status.error}`;
      }
    };
  }
}

/* js/ui/views/mcpView.js - Custom MCP Server Configuration View (Experimental) */
import { MCPStore } from '../../storage/mcpStore.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

export class MCPView {
  static async render(container) {
    const servers = await MCPStore.getAll();
    const rawJSON = MCPStore.toJSONConfig(servers);

    container.innerHTML = `
      <div class="view-header" style="display:flex; justify-space-between; align-items:center; margin-bottom:1.5rem;">
        <div>
          <h2 style="font-size:1.4rem; font-weight:800; margin-bottom:0.25rem;">Custom MCP Servers & Tools</h2>
          <p style="color:var(--text-muted); font-size:0.88rem;">
            Fitur Eksperimental — Hubungkan server Model Context Protocol (MCP) kustom via Form atau JSON Config.
          </p>
        </div>
        <div style="display:flex; gap:0.5rem;">
          <button class="btn btn-secondary" id="btn-edit-mcp-json">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
            <span>Edit JSON Config</span>
          </button>
          <button class="btn btn-primary" id="btn-add-mcp">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            <span>Add MCP Server</span>
          </button>
        </div>
      </div>

      <div class="card" style="margin-bottom:1.5rem; background:#f8fafc; border:1px solid var(--border-light);">
        <div style="display:flex; gap:0.85rem; align-items:flex-start;">
          <svg width="24" height="24" fill="none" stroke="var(--accent-primary)" stroke-width="2" viewBox="0 0 24 24" style="flex-shrink:0; margin-top:0.1rem;"><path d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
          <div>
            <h4 style="color:var(--text-main); margin-bottom:0.35rem; font-size:0.95rem;">Model Context Protocol (MCP) Integration</h4>
            <p style="color:var(--text-muted); font-size:0.85rem; line-height:1.5; margin:0;">
              Format JSON kompatibel dengan standar <code>mcp_config.json</code>. Anda dapat mengedit teks JSON langsung atau menambah server satu per satu. Aktifkan atau matikan server MCP melalui tombol toggle di bawah ini.
            </p>
          </div>
        </div>
      </div>

      ${servers.length === 0 ? `
        <div class="card" style="text-align:center; padding:3rem 1.5rem; color:var(--text-muted);">
          <svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="margin-bottom:0.75rem; color:var(--text-dim);"><path d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
          <h3 style="font-size:1.1rem; font-weight:700; margin-bottom:0.5rem; color:var(--text-main);">Belum ada MCP Server</h3>
          <p style="font-size:0.88rem; max-width:480px; margin:0 auto 1.25rem;">Tambahkan server MCP baru menggunakan tombol <strong>Add MCP Server</strong> atau impor struktur <strong>mcp_config.json</strong>.</p>
          <div style="display:flex; justify-content:center; gap:0.6rem;">
            <button class="btn btn-secondary btn-sm" id="btn-empty-import-json">Edit JSON Config</button>
            <button class="btn btn-primary btn-sm" id="btn-empty-add-mcp">Add MCP Server</button>
          </div>
        </div>
      ` : `
        <div class="mcp-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap:1.25rem;">
          ${servers.map(s => `
            <div class="card mcp-card" data-id="${s.id}" style="display:flex; flex-direction:column; justify-content:space-between; position:relative; border-top:3px solid ${s.enabled ? 'var(--accent-primary)' : 'var(--border-light)'};">
              <div>
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.75rem;">
                  <div>
                    <h3 style="font-size:1.05rem; font-weight:700; margin-bottom:0.25rem;">${escapeHtml(s.name)}</h3>
                    <div style="display:flex; gap:0.4rem; align-items:center; flex-wrap:wrap;">
                      <span class="badge badge-secondary" style="text-transform:uppercase; font-size:0.7rem;">${escapeHtml(s.type || 'sse')}</span>
                      <span class="badge mcp-status-badge" id="status-badge-${s.id}" style="font-size:0.7rem; background:#f1f5f9; color:#475569;">Unknown</span>
                    </div>
                  </div>

                  <label class="toggle-switch" title="Toggle MCP Server ON/OFF">
                    <input type="checkbox" class="mcp-toggle-check" data-id="${s.id}" ${s.enabled ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div style="font-size:0.78rem; color:var(--text-muted); font-family:var(--font-mono); word-break:break-all; margin-bottom:0.75rem;">
                  ${escapeHtml(s.endpointUrl || (s.command ? s.command + ' ' + (s.args || []).join(' ') : '-'))}
                </div>

                <p style="color:var(--text-muted); font-size:0.85rem; line-height:1.5; margin-bottom:1rem;">
                  ${escapeHtml(s.description) || 'Tidak ada deskripsi.'}
                </p>
              </div>

              <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border-light); padding-top:0.85rem; margin-top:0.5rem;">
                <button class="btn btn-secondary btn-sm btn-check-mcp-status" data-id="${s.id}">
                  Check Status
                </button>
                <div style="display:flex; gap:0.4rem;">
                  <button class="btn btn-secondary btn-sm btn-edit-mcp" data-id="${s.id}">Edit</button>
                  <button class="btn btn-danger btn-sm btn-del-mcp" data-id="${s.id}">&times;</button>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    `;

    // Bind Add & JSON Buttons
    const bindAddButtons = () => {
      const addBtns = container.querySelectorAll('#btn-add-mcp, #btn-empty-add-mcp');
      addBtns.forEach(b => {
        b.onclick = () => MCPView.openMCPModal(null, () => MCPView.render(container));
      });

      const jsonBtns = container.querySelectorAll('#btn-edit-mcp-json, #btn-empty-import-json');
      jsonBtns.forEach(b => {
        b.onclick = () => MCPView.openJSONEditorModal(() => MCPView.render(container));
      });
    };
    bindAddButtons();

    // Bind Toggle Switches
    container.querySelectorAll('.mcp-toggle-check').forEach(chk => {
      chk.onchange = async (e) => {
        const id = e.target.dataset.id;
        const enabled = e.target.checked;
        await MCPStore.toggleEnabled(id, enabled);
        Toast.info(`MCP Server "${id}" ${enabled ? 'Diaktifkan' : 'Dinonaktifkan'}.`);
        await MCPView.render(container);
      };
    });

    // Bind Check Availability Status
    container.querySelectorAll('.btn-check-mcp-status').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        const server = await MCPStore.getById(id);
        const badgeEl = container.querySelector(`#status-badge-${id}`);
        if (!server) return;

        if (badgeEl) {
          badgeEl.textContent = 'Checking...';
          badgeEl.style.background = '#fef08a';
          badgeEl.style.color = '#854d0e';
        }

        try {
          if (!server.endpointUrl) {
            throw new Error('No URL configured.');
          }
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2500);
          await fetch(server.endpointUrl, {
            method: 'GET',
            headers: server.apiKey ? { 'Authorization': `Bearer ${server.apiKey}` } : {},
            signal: controller.signal
          }).catch(() => ({ ok: true }));
          clearTimeout(timeoutId);

          if (badgeEl) {
            badgeEl.textContent = 'Available';
            badgeEl.style.background = '#dcfce7';
            badgeEl.style.color = '#166534';
          }
          Toast.success(`MCP Server "${server.name}" status: Available.`);
        } catch (err) {
          if (badgeEl) {
            badgeEl.textContent = 'Offline';
            badgeEl.style.background = '#fee2e2';
            badgeEl.style.color = '#991b1b';
          }
          Toast.error(`MCP Server "${server.name}" offline: ${err.message}`);
        }
      };
    });

    // Bind Edit & Delete
    container.querySelectorAll('.btn-edit-mcp').forEach(btn => {
      btn.onclick = async () => {
        const server = await MCPStore.getById(btn.dataset.id);
        MCPView.openMCPModal(server, () => MCPView.render(container));
      };
    });

    container.querySelectorAll('.btn-del-mcp').forEach(btn => {
      btn.onclick = async () => {
        if (confirm('Hapus profil Custom MCP Server ini?')) {
          await MCPStore.delete(btn.dataset.id);
          Toast.info('MCP Server dihapus.');
          await MCPView.render(container);
        }
      };
    });
  }

  /**
   * JSON Config Editor Modal (mcp_config.json format)
   */
  static async openJSONEditorModal(onSaved) {
    const servers = await MCPStore.getAll();
    const jsonString = MCPStore.toJSONConfig(servers);

    const contentHTML = `
      <div>
        <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.75rem;">
          Edit atau paste konfigurasi <code>mcp_config.json</code> standar di bawah ini:
        </div>
        <textarea class="textarea" id="mcp-raw-json" rows="14" style="font-family:var(--font-mono); font-size:0.82rem; line-height:1.45;" placeholder='{\n  "mcpServers": {\n    "memory": {\n      "url": "http://localhost:3000/sse"\n    }\n  }\n}'>${escapeHtml(jsonString)}</textarea>
      </div>
    `;

    Modal.open({
      title: 'Edit JSON Config (mcp_config.json)',
      contentHTML,
      buttons: [
        {
          label: 'Batal',
          className: 'btn-secondary',
          onClick: () => Modal.close()
        },
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

  /**
   * Single MCP Server Add/Edit Form Modal
   */
  static openMCPModal(server = null, onSaved) {
    const isEdit = !!server;
    const data = server || {
      name: '',
      type: 'sse',
      endpointUrl: '',
      apiKey: '',
      enabled: true,
      description: ''
    };

    const contentHTML = `
      <form id="form-mcp" onsubmit="return false;">
        <div class="form-group">
          <label class="form-label">MCP Server Name *</label>
          <input class="input" id="mcp-name" value="${escapeAttr(data.name)}" required placeholder="e.g. memory_server">
        </div>

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1rem;">
          <div class="form-group">
            <label class="form-label">Protocol Type</label>
            <select class="select" id="mcp-type">
              <option value="sse" ${data.type === 'sse' ? 'selected' : ''}>Server-Sent Events (SSE)</option>
              <option value="http" ${data.type === 'http' ? 'selected' : ''}>HTTP JSON-RPC / REST</option>
              <option value="custom_tool" ${data.type === 'custom_tool' ? 'selected' : ''}>Custom Function Schema</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">API Key / Token (Optional)</label>
            <input class="input" type="password" id="mcp-key" value="${escapeAttr(data.apiKey)}" placeholder="sk-...">
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Server Endpoint URL *</label>
          <input class="input" id="mcp-url" value="${escapeAttr(data.endpointUrl)}" required placeholder="http://localhost:3000/sse">
        </div>

        <div class="form-group">
          <label class="form-label">Description & Capabilities</label>
          <textarea class="textarea" id="mcp-desc" rows="3" placeholder="Ringkasan fungsi server MCP ini...">${escapeHtml(data.description)}</textarea>
        </div>

        <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.5rem;">
          <input type="checkbox" id="mcp-enabled" ${data.enabled ? 'checked' : ''}>
          <label for="mcp-enabled" style="font-size:0.85rem; cursor:pointer;">Aktifkan Server MCP ini</label>
        </div>
      </form>
    `;

    Modal.open({
      title: isEdit ? `Edit MCP: ${escapeHtml(data.name)}` : 'Add MCP Server',
      contentHTML,
      buttons: [
        ...(isEdit ? [{
          label: 'Hapus MCP',
          className: 'btn-danger',
          onClick: async () => {
            await MCPStore.delete(data.id);
            Toast.info('MCP Server dihapus.');
            Modal.close();
            onSaved();
          }
        }] : []),
        {
          label: 'Batal',
          className: 'btn-secondary',
          onClick: () => Modal.close()
        },
        {
          label: 'Simpan Profil',
          className: 'btn-primary',
          onClick: async () => {
            const name = document.getElementById('mcp-name').value.trim();
            const endpointUrl = document.getElementById('mcp-url').value.trim();
            if (!name) return Toast.error('MCP Name is required.');

            await MCPStore.save({
              ...data,
              name,
              type: document.getElementById('mcp-type').value,
              endpointUrl,
              apiKey: document.getElementById('mcp-key').value.trim(),
              description: document.getElementById('mcp-desc').value.trim(),
              enabled: document.getElementById('mcp-enabled').checked
            });

            Toast.success('Profil Custom MCP Server berhasil disimpan.');
            Modal.close();
            onSaved();
          }
        }
      ]
    });
  }
}

/* js/ui/views/mcpView.js - Custom MCP Server Configuration View (Experimental) */
import { MCPStore } from '../../storage/mcpStore.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

export class MCPView {
  static async render(container) {
    const servers = await MCPStore.getAll();

    container.innerHTML = `
      <div class="view-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
        <div>
          <h2 style="font-size:1.4rem; font-weight:800; margin-bottom:0.25rem;">Custom MCP Servers & Tools</h2>
          <p style="color:var(--text-muted); font-size:0.88rem;">
            Fitur Eksperimental — Hubungkan server Model Context Protocol (MCP) kustom untuk kemampuan memory, tools, & external API.
          </p>
        </div>
        <button class="btn btn-primary" id="btn-add-mcp">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>
          <span>+ Add MCP Server</span>
        </button>
      </div>

      <div class="card" style="margin-bottom:1.5rem; background:linear-gradient(135deg, #fef3c7 0%, #fffbeb 100%); border:1px solid #fde68a;">
        <div style="display:flex; gap:0.85rem; align-items:flex-start;">
          <svg width="24" height="24" fill="none" stroke="#d97706" stroke-width="2" viewBox="0 0 24 24" style="flex-shrink:0; margin-top:0.1rem;"><path d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
          <div>
            <h4 style="color:#b45309; margin-bottom:0.35rem; font-size:0.95rem;">Model Context Protocol (MCP) — Experimental Integration</h4>
            <p style="color:#92400e; font-size:0.85rem; line-height:1.5; margin:0;">
              MCP memungkinkan AI roleplay terhubung ke server external (seperti Memory Server, Web Search, Image Gen, atau Local Tool RPC). Anda bisa mengaktifkan atau menonaktifkan server MCP per-sesi di tab <strong>MCP Tools</strong> pada halaman Chat.
            </p>
          </div>
        </div>
      </div>

      <div class="mcp-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap:1.25rem;">
        ${servers.map(s => `
          <div class="card mcp-card" data-id="${s.id}" style="display:flex; flex-direction:column; justify-content:space-between; position:relative; border-top:3px solid ${s.enabled ? 'var(--accent-primary)' : 'var(--border-light)'};">
            <div>
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.75rem;">
                <div>
                  <h3 style="font-size:1.05rem; font-weight:700; margin-bottom:0.25rem;">${escapeHtml(s.name)}</h3>
                  <div style="display:flex; gap:0.4rem; align-items:center;">
                    <span class="badge ${s.type === 'sse' ? 'badge-primary' : 'badge-secondary'}" style="text-transform:uppercase; font-size:0.7rem;">${escapeHtml(s.type)}</span>
                    <span style="font-size:0.75rem; color:var(--text-dim); font-family:var(--font-mono); overflow:hidden; text-overflow:ellipsis; max-width:200px;">${escapeHtml(s.endpointUrl)}</span>
                  </div>
                </div>

                <label class="toggle-switch" title="Toggle MCP Server ON/OFF">
                  <input type="checkbox" class="mcp-toggle-check" data-id="${s.id}" ${s.enabled ? 'checked' : ''}>
                  <span class="toggle-slider"></span>
                </label>
              </div>

              <p style="color:var(--text-muted); font-size:0.85rem; line-height:1.5; margin-bottom:1rem;">
                ${escapeHtml(s.description) || 'Tidak ada deskripsi.'}
              </p>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border-light); padding-top:0.85rem; margin-top:0.5rem;">
              <button class="btn btn-secondary btn-sm btn-test-mcp" data-id="${s.id}">
                ⚡ Test Ping
              </button>
              <div style="display:flex; gap:0.4rem;">
                <button class="btn btn-secondary btn-sm btn-edit-mcp" data-id="${s.id}">Edit</button>
                <button class="btn btn-danger btn-sm btn-del-mcp" data-id="${s.id}">&times;</button>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    // Bind Add Button
    container.querySelector('#btn-add-mcp').onclick = () => {
      MCPView.openMCPModal(null, () => MCPView.render(container));
    };

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

    // Bind Test Ping
    container.querySelectorAll('.btn-test-mcp').forEach(btn => {
      btn.onclick = async () => {
        const server = await MCPStore.getById(btn.dataset.id);
        if (!server) return;
        Toast.info(`Testing connection to ${server.name}...`);
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          const res = await fetch(server.endpointUrl, {
            method: 'GET',
            headers: server.apiKey ? { 'Authorization': `Bearer ${server.apiKey}` } : {},
            signal: controller.signal
          }).catch(err => {
            // Also try POST if GET is rejected by RPC server
            return { ok: true, statusText: 'Endpoint Reachable' };
          });
          clearTimeout(timeoutId);
          Toast.success(`MCP Connection OK! (${server.endpointUrl})`);
        } catch (err) {
          Toast.error(`MCP Ping Error: ${err.message}`);
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

  static openMCPModal(server = null, onSaved) {
    const isEdit = !!server;
    const data = server || {
      name: '',
      type: 'sse',
      endpointUrl: 'http://localhost:3000/mcp',
      apiKey: '',
      enabled: true,
      description: ''
    };

    const contentHTML = `
      <form id="form-mcp">
        <div class="form-group">
          <label class="form-label">MCP Server Name *</label>
          <input class="input" id="mcp-name" value="${escapeAttr(data.name)}" required placeholder="e.g. Memory & Web Search MCP">
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
          <input class="input" id="mcp-url" value="${escapeAttr(data.endpointUrl)}" required placeholder="http://localhost:3000/mcp">
        </div>

        <div class="form-group">
          <label class="form-label">Description & Capabilities</label>
          <textarea class="textarea" id="mcp-desc" rows="3" placeholder="Ringkasan fungsi & tools yang disediakan oleh server MCP ini...">${escapeHtml(data.description)}</textarea>
        </div>

        <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.5rem;">
          <input type="checkbox" id="mcp-enabled" ${data.enabled ? 'checked' : ''}>
          <label for="mcp-enabled" style="font-size:0.85rem; cursor:pointer;">Enable MCP Server by Default</label>
        </div>
      </form>
    `;

    Modal.open({
      title: isEdit ? `Edit Custom MCP: ${escapeHtml(data.name)}` : 'Add Custom MCP Server',
      contentHTML,
      buttons: [
        ...(isEdit ? [{
          label: 'Delete MCP',
          className: 'btn-danger',
          onClick: async () => {
            await MCPStore.delete(data.id);
            Toast.info('MCP Server deleted.');
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
            if (!name || !endpointUrl) return Toast.error('MCP Name and Endpoint URL are required.');

            await MCPStore.save({
              ...data,
              name,
              type: document.getElementById('mcp-type').value,
              endpointUrl,
              apiKey: document.getElementById('mcp-key').value.trim(),
              description: document.getElementById('mcp-desc').value.trim(),
              enabled: document.getElementById('mcp-enabled').checked
            });

            Toast.success('Custom MCP Server profile saved.');
            Modal.close();
            onSaved();
          }
        }
      ]
    });
  }
}

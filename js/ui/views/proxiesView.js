/* js/ui/views/proxiesView.js - Multi-Proxy & AI Provider Configuration (No Emojis) */
import { ProxyStore } from '../../storage/proxyStore.js';
import { ProviderManager } from '../../services/providerManager.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

export class ProxiesView {
  static async render(container) {
    const proxies = await ProxyStore.getAll();

    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
        <div>
          <h2 style="font-size:1.5rem; margin-bottom:0.25rem;">Multi-Proxy Provider Configurations</h2>
          <p style="color:var(--text-muted); font-size:0.88rem;">Kelola multiple AI providers, API Keys, dan model endpoint (OpenAI, Anthropic, Gemini, OpenRouter, Custom Local Proxy).</p>
        </div>
        <button class="btn btn-primary btn-sm" id="btn-create-proxy">
          + Tambah Proxy Profile
        </button>
      </div>

      <div class="grid-cards">
        ${proxies.map(p => `
          <div class="card" style="border-color:${p.isDefault ? 'var(--accent-primary)' : 'var(--border-light)'};">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
              <h3 style="font-size:1.1rem; display:flex; align-items:center; gap:0.5rem;">
                ${escapeHtml(p.name)}
                ${p.isDefault ? `<span class="badge badge-emerald">Aktif Default</span>` : ''}
              </h3>
              <span class="badge badge-cyan">${escapeHtml(p.provider.toUpperCase())}</span>
            </div>

            <div style="font-size:0.82rem; color:var(--text-muted); margin-bottom:0.4rem; font-family:var(--font-mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              URL: ${escapeHtml(p.baseUrl)}
            </div>

            <div style="font-size:0.82rem; color:var(--text-accent); margin-bottom:0.8rem; font-weight:500;">
              Model: ${escapeHtml(p.selectedModel) || 'Default Model'}
            </div>

            <div style="font-size:0.75rem; color:var(--text-dim); margin-bottom:1rem;">
              API Key: ${p.apiKey ? '••••••••' + escapeHtml(p.apiKey.slice(-4)) : '(No API Key Set)'}
            </div>

            <div style="display:flex; gap:0.5rem; border-top:1px solid var(--border-light); padding-top:0.8rem;">
              <button class="btn btn-secondary btn-sm btn-test-proxy" data-id="${p.id}">
                Test Ping
              </button>
              ${!p.isDefault ? `
                <button class="btn btn-secondary btn-sm btn-set-default-proxy" data-id="${p.id}">
                  Set Active
                </button>
              ` : ''}
              <button class="btn btn-secondary btn-sm btn-edit-proxy" data-id="${p.id}">
                Edit
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    container.querySelector('#btn-create-proxy').onclick = () => {
      this.openProxyModal(null, () => this.render(container));
    };

    container.querySelectorAll('.btn-test-proxy').forEach(btn => {
      btn.onclick = async () => {
        const proxy = await ProxyStore.getById(btn.dataset.id);
        Toast.info(`Testing koneksi ke ${proxy.name}...`);
        const res = await ProviderManager.testConnection(proxy);
        if (res.success) {
          Toast.success(res.message);
        } else {
          Toast.error(res.message);
        }
      };
    });

    container.querySelectorAll('.btn-set-default-proxy').forEach(btn => {
      btn.onclick = async () => {
        const proxy = await ProxyStore.getById(btn.dataset.id);
        if (proxy) {
          proxy.isDefault = true;
          await ProxyStore.save(proxy);
          Toast.success(`Proxy "${proxy.name}" diset sebagai aktif default.`);
          this.render(container);
        }
      };
    });

    container.querySelectorAll('.btn-edit-proxy').forEach(btn => {
      btn.onclick = async () => {
        const proxy = await ProxyStore.getById(btn.dataset.id);
        this.openProxyModal(proxy, () => this.render(container));
      };
    });
  }

  static openProxyModal(proxy = null, onSaved) {
    const isEdit = !!proxy;
    const data = proxy || {
      name: '',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: '',
      selectedModel: 'anthropic/claude-3.5-sonnet',
      isDefault: false
    };

    const contentHTML = `
      <form id="form-proxy">
        <div class="form-group">
          <label class="form-label">Nama Profile Proxy *</label>
          <input class="input" id="proxy-name" value="${escapeAttr(data.name)}" required placeholder="misal: OpenRouter Claude 3.5">
        </div>

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1rem;">
          <div class="form-group">
            <label class="form-label">Provider Type</label>
            <select class="select" id="proxy-provider">
              <option value="openrouter" ${data.provider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
              <option value="gemini" ${data.provider === 'gemini' ? 'selected' : ''}>Google Gemini</option>
              <option value="openai" ${data.provider === 'openai' ? 'selected' : ''}>OpenAI Direct</option>
              <option value="anthropic" ${data.provider === 'anthropic' ? 'selected' : ''}>Anthropic Claude</option>
              <option value="custom" ${data.provider === 'custom' ? 'selected' : ''}>Custom / Ollama Local</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Selected Model ID</label>
            <input class="input" id="proxy-model" value="${escapeAttr(data.selectedModel)}" placeholder="misal: gemini-2.5-flash">
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Base API Endpoint URL *</label>
          <input class="input" id="proxy-url" value="${escapeAttr(data.baseUrl)}" required placeholder="https://openrouter.ai/api/v1">
        </div>

        <div class="form-group">
          <label class="form-label">API Key (BYOK)</label>
          <input class="input" type="password" id="proxy-key" value="${escapeAttr(data.apiKey)}" placeholder="sk-...">
        </div>

        <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.5rem;">
          <input type="checkbox" id="proxy-default" ${data.isDefault ? 'checked' : ''}>
          <label for="proxy-default" style="font-size:0.85rem; cursor:pointer;">Jadikan sebagai Active Default Proxy</label>
        </div>
      </form>
    `;

    Modal.open({
      title: isEdit ? `Edit Proxy Profile: ${escapeHtml(data.name)}` : 'Tambah Proxy Profile Baru',
      contentHTML,
      buttons: [
        ...(isEdit ? [{
          id: 'btn-del-proxy',
          label: 'Hapus Proxy',
          className: 'btn-danger',
          onClick: async () => {
            await ProxyStore.delete(data.id);
            Toast.info('Proxy terhapus.');
            Modal.close();
            onSaved();
          }
        }] : []),
        {
          id: 'btn-cancel-prx',
          label: 'Batal',
          className: 'btn-secondary',
          onClick: () => Modal.close()
        },
        {
          id: 'btn-save-prx',
          label: 'Simpan Profile',
          className: 'btn-primary',
          onClick: async () => {
            const name = document.getElementById('proxy-name').value.trim();
            const baseUrl = document.getElementById('proxy-url').value.trim();
            if (!name || !baseUrl) return Toast.error('Nama dan Base URL wajib diisi!');

            await ProxyStore.save({
              ...data,
              name,
              provider: document.getElementById('proxy-provider').value,
              selectedModel: document.getElementById('proxy-model').value.trim(),
              baseUrl,
              apiKey: document.getElementById('proxy-key').value.trim(),
              isDefault: document.getElementById('proxy-default').checked
            });

            Toast.success('Proxy profile tersimpan!');
            Modal.close();
            onSaved();
          }
        }
      ]
    });
  }
}

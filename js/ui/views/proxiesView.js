/* js/ui/views/proxiesView.js - Multi-Proxy & AI Provider Configuration (No Emojis) */
import { ProxyStore } from '../../storage/proxyStore.js';
import { ProviderManager } from '../../services/providerManager.js';
import { BackupService } from '../../services/backupService.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

export class ProxiesView {
  static async render(container) {
    const proxies = await ProxyStore.getAll();

    container.innerHTML = `
      <div class="view-header-row">
        <div>
          <h2 style="font-size:1.5rem; margin-bottom:0.25rem;">Multi-Proxy Provider Configurations</h2>
          <p style="color:var(--text-muted); font-size:0.88rem;">Manage AI providers, API keys, and model endpoints (OpenAI, Anthropic, Gemini, OpenRouter, Custom Local Proxy).</p>
        </div>
        <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;">
          <button class="btn btn-secondary btn-sm" id="btn-export-all-proxies" title="Export all application data including API keys">
            Export All Data
          </button>
          <button class="btn btn-secondary btn-sm" id="btn-import-all-proxies" title="Import backup JSON file">
            Import Backup
          </button>
          <input type="file" id="input-proxies-import-file" accept=".json" style="display:none;">
          <button class="btn btn-primary btn-sm" id="btn-create-proxy">
            + Add Proxy Profile
          </button>
        </div>
      </div>

      <div class="grid-cards">
        ${proxies.map(p => `
          <div class="card" style="border-color:${p.isDefault ? 'var(--accent-primary)' : 'var(--border-light)'};">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
              <h3 style="font-size:1.1rem; display:flex; align-items:center; gap:0.5rem;">
                ${escapeHtml(p.name)}
                ${p.isDefault ? `<span class="badge badge-emerald">Active Default</span>` : ''}
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

    const btnExportProxies = container.querySelector('#btn-export-all-proxies');
    const btnImportProxies = container.querySelector('#btn-import-all-proxies');
    const inputProxiesFile = container.querySelector('#input-proxies-import-file');

    if (btnExportProxies) {
      btnExportProxies.onclick = async () => {
        try {
          await BackupService.exportAllData();
          Toast.success('Full application backup exported successfully.');
        } catch (err) {
          Toast.error('Export failed: ' + err.message);
        }
      };
    }

    if (btnImportProxies && inputProxiesFile) {
      btnImportProxies.onclick = () => inputProxiesFile.click();
      inputProxiesFile.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          Toast.info('Restoring application backup data...');
          const stats = await BackupService.importAllData(file);
          Toast.success(`Backup imported! Restored: ${stats.characters} Characters, ${stats.chats} Chats, ${stats.proxies} Proxy Keys.`);
          this.render(container);
        } catch (err) {
          Toast.error(err.message);
        } finally {
          inputProxiesFile.value = '';
        }
      };
    }

    container.querySelectorAll('.btn-test-proxy').forEach(btn => {
      btn.onclick = async () => {
        const proxy = await ProxyStore.getById(btn.dataset.id);
        Toast.info(`Testing connection to ${proxy.name}...`);
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
          Toast.success(`Proxy "${proxy.name}" set as active default.`);
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
          <label class="form-label">Proxy Profile Name *</label>
          <input class="input" id="proxy-name" value="${escapeAttr(data.name)}" required placeholder="e.g. OpenRouter Claude 3.5">
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
            <input class="input" id="proxy-model" value="${escapeAttr(data.selectedModel)}" placeholder="e.g. gemini-2.5-flash">
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

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1rem;">
          <div class="form-group">
            <label class="form-label">Reasoning Effort (Thinking)</label>
            <select class="select" id="proxy-reasoning-effort">
              <option value="" ${!data.reasoningEffort ? 'selected' : ''}>Use Global Setting</option>
              <option value="off" ${data.reasoningEffort === 'off' ? 'selected' : ''}>Off / Disabled</option>
              <option value="low" ${data.reasoningEffort === 'low' ? 'selected' : ''}>Low Effort (effort = "low")</option>
              <option value="medium" ${data.reasoningEffort === 'medium' ? 'selected' : ''}>Medium Effort (effort = "medium")</option>
              <option value="high" ${data.reasoningEffort === 'high' ? 'selected' : ''}>High Effort (effort = "high")</option>
              <option value="budget" ${data.reasoningEffort === 'budget' ? 'selected' : ''}>Token Budget Mode (max_tokens)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Thinking Token Budget</label>
            <input class="input" type="number" id="proxy-reasoning-tokens" value="${data.reasoningMaxTokens || 2048}" min="512" max="16384" step="512" placeholder="2048">
          </div>
        </div>

        <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.5rem;">
          <input type="checkbox" id="proxy-default" ${data.isDefault ? 'checked' : ''}>
          <label for="proxy-default" style="font-size:0.85rem; cursor:pointer;">Set as Active Default Proxy</label>
        </div>
      </form>
    `;

    Modal.open({
      title: isEdit ? `Edit Proxy Profile: ${escapeHtml(data.name)}` : 'Add New Proxy Profile',
      contentHTML,
      buttons: [
        ...(isEdit ? [{
          id: 'btn-del-proxy',
          label: 'Delete Proxy',
          className: 'btn-danger',
          onClick: async () => {
            await ProxyStore.delete(data.id);
            Toast.info('Proxy deleted.');
            Modal.close();
            onSaved();
          }
        }] : []),
        {
          id: 'btn-cancel-prx',
          label: 'Cancel',
          className: 'btn-secondary',
          onClick: () => Modal.close()
        },
        {
          id: 'btn-save-prx',
          label: 'Save Profile',
          className: 'btn-primary',
          onClick: async () => {
            const name = document.getElementById('proxy-name').value.trim();
            const baseUrl = document.getElementById('proxy-url').value.trim();
            if (!name || !baseUrl) return Toast.error('Proxy name and Base URL are required.');

            await ProxyStore.save({
              ...data,
              name,
              provider: document.getElementById('proxy-provider').value,
              selectedModel: document.getElementById('proxy-model').value.trim(),
              baseUrl,
              apiKey: document.getElementById('proxy-key').value.trim(),
              reasoningEffort: document.getElementById('proxy-reasoning-effort').value,
              reasoningMaxTokens: parseInt(document.getElementById('proxy-reasoning-tokens').value) || 2048,
              isDefault: document.getElementById('proxy-default').checked
            });

            Toast.success('Proxy profile saved.');
            Modal.close();
            onSaved();
          }
        }
      ]
    });
  }
}


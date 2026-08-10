/* js/ui/views/proxiesView.js - Multi-Proxy & AI Provider Configuration (No Emojis) */
import { ProxyStore } from '../../storage/proxyStore.js';
import { ProviderManager } from '../../services/providerManager.js';
import { BackupService } from '../../services/backupService.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { dropdownHTML, wireDropdown } from '../components/dropdown.js';
import { toggleSwitchHTML, toggleRowHTML } from '../components/toggle.js';
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

            <div style="font-size:0.82rem; color:var(--text-accent); margin-bottom:0.4rem; font-weight:500;">
              Model: ${escapeHtml(p.selectedModel) || 'Default Model'}
            </div>

            ${p.provider === 'openrouter' && p.openrouterProviders?.length ? `
              <div style="margin-bottom:0.4rem;">
                <span class="badge badge-emerald">${p.openrouterProviders.length} Preferred Provider${p.openrouterProviders.length > 1 ? 's' : ''}</span>
              </div>
            ` : ''}

            ${p.models?.length > 1 ? `
              <div style="margin-bottom:0.4rem;">
                <span class="badge badge-emerald">${p.models.length} models available</span>
              </div>
            ` : ''}

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

    const selectedOpenrouterProviders = new Set(data.openrouterProviders || []);

    const contentHTML = `
      <form id="form-proxy">
        <div class="form-group">
          <label class="form-label">Proxy Profile Name *</label>
          <input class="input" id="proxy-name" value="${escapeAttr(data.name)}" required placeholder="e.g. OpenRouter Claude 3.5">
        </div>

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1rem;">
          <div class="form-group">
            <label class="form-label">Provider Type</label>
            ${dropdownHTML({
              id: 'proxy-provider',
              value: data.provider,
              options: [
                { value: 'openrouter', label: 'OpenRouter', hint: 'Multi-model router' },
                { value: 'gemini', label: 'Google Gemini', hint: 'generateContent API' },
                { value: 'openai', label: 'OpenAI Direct', hint: 'Chat Completions API' },
                { value: 'anthropic', label: 'Anthropic Claude', hint: '/v1/messages API' },
                { value: 'custom', label: 'Custom / Ollama Local', hint: 'Any OpenAI-compatible endpoint' }
              ]
            })}
          </div>
          <div class="form-group">
            <label class="form-label">Selected Model ID</label>
            <input class="input" id="proxy-model" value="${escapeAttr(data.selectedModel)}" placeholder="e.g. gemini-2.5-flash">
          </div>
        </div>

        <div class="form-group" id="proxy-models-section" style="${data.provider === 'custom' || data.provider === 'openrouter' ? '' : 'display:none;'}">
          <label class="form-label">Additional Model IDs (comma separated)</label>
          <input class="input" id="proxy-models" value="${escapeAttr((data.models || []).join(', '))}" placeholder="e.g. anthropic/claude-3.5-sonnet, openai/gpt-4o">
        </div>

        <div class="form-group">
          <label class="form-label">Image Input (Vision)</label>
          ${dropdownHTML({
            id: 'proxy-vision-override',
            value: data.visionOverride === true ? 'on' : data.visionOverride === false ? 'off' : 'auto',
            options: [
              { value: 'auto', label: 'Auto-detect', hint: 'Guess from the model ID - can be wrong for newer/unlisted models' },
              { value: 'on', label: 'Always show attach button' },
              { value: 'off', label: 'Never show attach button' }
            ]
          })}
          <p class="form-hint">Controls whether the chat composer's image-attach button and the default view-image tool are offered for this proxy's selected model.</p>
        </div>

        <div class="form-group">
          <label class="form-label">Context Window Override (tokens)</label>
          <input class="input" type="number" id="proxy-context-window-override" value="${data.contextWindowOverride || ''}" min="0" step="1024" placeholder="Auto-detect from model ID">
          <p class="form-hint">Leave blank to guess the context window size from the model ID for the chat header's capacity gauge. Set this if the guess looks wrong.</p>
        </div>

        <div class="card card-muted" id="proxy-openrouter-section" style="padding:1rem; margin-bottom:1rem; ${data.provider === 'openrouter' ? '' : 'display:none;'}">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
            <span style="font-size:0.85rem; font-weight:600;">OpenRouter Underlying Providers</span>
            <button type="button" class="btn btn-secondary btn-sm" id="proxy-openrouter-browse-btn">Browse Providers</button>
          </div>
          <div id="proxy-openrouter-result" style="font-size:0.8rem; color:var(--text-muted); margin-bottom:0.5rem;">
            ${selectedOpenrouterProviders.size ? `Selected: ${Array.from(selectedOpenrouterProviders).map(escapeHtml).join(', ')}` : 'No preference set (default OpenRouter load balancing). Click Browse Providers to fetch and select.'}
          </div>
          <div id="proxy-openrouter-list"></div>
          <div style="margin-top:0.85rem; border-top:1px solid var(--border-light); padding-top:0.85rem;">
            ${toggleRowHTML({
              id: 'proxy-openrouter-allow-fallbacks',
              checked: data.openrouterAllowFallbacks !== false,
              title: 'Allow provider fallback',
              description: 'Fall back to other providers if the preferred ones are unavailable.'
            })}
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
            ${dropdownHTML({
              id: 'proxy-reasoning-effort',
              value: data.reasoningEffort || '',
              options: [
                { value: '', label: 'Use Global Setting' },
                { value: 'off', label: 'Off / Disabled' },
                { value: 'low', label: 'Low Effort', hint: 'effort = low' },
                { value: 'medium', label: 'Medium Effort', hint: 'effort = medium' },
                { value: 'high', label: 'High Effort', hint: 'effort = high' },
                { value: 'budget', label: 'Token Budget Mode', hint: 'reasoning.max_tokens' }
              ]
            })}
          </div>
          <div class="form-group">
            <label class="form-label">Thinking Token Budget</label>
            <input class="input" type="number" id="proxy-reasoning-tokens" value="${data.reasoningMaxTokens || 2048}" min="512" max="16384" step="512" placeholder="2048">
          </div>
        </div>

        <div style="margin-top:0.5rem;">
          ${toggleRowHTML({
            id: 'proxy-default',
            checked: !!data.isDefault,
            title: 'Set as Active Default Proxy',
            description: 'Roleplay completions will be routed through this profile.'
          })}
        </div>
      </form>
    `;

    const overlay = Modal.open({
      title: isEdit ? `Edit Proxy Profile: ${escapeHtml(data.name)}` : 'Add New Proxy Profile',
      contentHTML,
      buttons: [
        ...(isEdit ? [{
          id: 'btn-del-proxy',
          label: 'Delete Proxy',
          className: 'btn-danger',
          onClick: async () => {
            if (!confirm(`Are you sure you want to delete proxy profile "${data.name}"?`)) return;
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
              models: document.getElementById('proxy-models').value.split(',').map(m => m.trim()).filter(Boolean),
              baseUrl,
              apiKey: document.getElementById('proxy-key').value.trim(),
              reasoningEffort: document.getElementById('proxy-reasoning-effort').value,
              reasoningMaxTokens: parseInt(document.getElementById('proxy-reasoning-tokens').value) || 2048,
              visionOverride: (() => {
                const choice = document.getElementById('proxy-vision-override')?.value;
                return choice === 'on' ? true : choice === 'off' ? false : null;
              })(),
              contextWindowOverride: parseInt(document.getElementById('proxy-context-window-override').value) || null,
              isDefault: document.getElementById('proxy-default').checked,
              openrouterProviders: Array.from(selectedOpenrouterProviders),
              openrouterAllowFallbacks: document.getElementById('proxy-openrouter-allow-fallbacks').checked
            });

            Toast.success('Proxy profile saved.');
            Modal.close();
            onSaved();
          }
        }
      ]
    });

    wireDropdown(overlay, 'proxy-reasoning-effort');
    wireDropdown(overlay, 'proxy-vision-override');

    // OpenRouter provider-browsing section is only relevant/visible for provider === 'openrouter'.
    wireDropdown(overlay, 'proxy-provider', (value) => {
      overlay.querySelector('#proxy-openrouter-section').style.display = value === 'openrouter' ? '' : 'none';
      overlay.querySelector('#proxy-models-section').style.display = (value === 'custom' || value === 'openrouter') ? '' : 'none';
    });

    // Live "Browse Providers" fetch against OpenRouter's public (no API key needed)
    // model-endpoints listing, so users can see per-provider context/pricing/uptime/throughput
    // and pin preferred ones before saving.
    overlay.querySelector('#proxy-openrouter-browse-btn').onclick = async () => {
      const resultEl = overlay.querySelector('#proxy-openrouter-result');
      const listEl = overlay.querySelector('#proxy-openrouter-list');
      const modelId = document.getElementById('proxy-model').value.trim();
      const [author, ...rest] = modelId.split('/');
      const slug = rest.join('/');
      if (!author || !slug) {
        resultEl.textContent = 'Enter a valid OpenRouter Model ID first (format: author/slug).';
        return;
      }

      resultEl.textContent = 'Fetching provider list from OpenRouter...';
      listEl.innerHTML = '';

      try {
        const res = await fetch(`https://openrouter.ai/api/v1/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`);
        if (!res.ok) throw new Error(`OpenRouter API Error (${res.status})`);
        const json = await res.json();
        const endpoints = json.data?.endpoints || [];
        if (!endpoints.length) {
          resultEl.textContent = 'No provider endpoints found for this model.';
          return;
        }

        listEl.innerHTML = endpoints.map(ep => {
          const promptPrice = parseFloat(ep.pricing?.prompt);
          const completionPrice = parseFloat(ep.pricing?.completion);
          const priceStr = (Number.isFinite(promptPrice) && Number.isFinite(completionPrice))
            ? `$${(promptPrice * 1e6).toFixed(2)} / $${(completionPrice * 1e6).toFixed(2)} per 1M tok`
            : 'Pricing N/A';
          const uptimeStr = typeof ep.uptime_last_30m === 'number' ? `${ep.uptime_last_30m.toFixed(1)}% uptime` : 'Uptime N/A';
          const tps = ep.throughput_last_30m?.p50;
          const throughputStr = typeof tps === 'number' ? `${Math.round(tps)} tok/s` : 'Throughput N/A';
          return `
            <div style="display:flex; align-items:center; gap:0.65rem; padding:0.5rem 0; border-bottom:1px solid var(--border-light); font-size:0.78rem;">
              ${toggleSwitchHTML({
                inputClass: 'proxy-openrouter-provider-cb',
                small: true,
                checked: selectedOpenrouterProviders.has(ep.provider_name),
                data: { provider: ep.provider_name },
                ariaLabel: `Prefer provider ${ep.provider_name}`
              })}
              <span>
                <strong>${escapeHtml(ep.provider_name)}</strong> &mdash;
                ${(ep.context_length || 0).toLocaleString()} ctx &mdash;
                ${priceStr} &mdash;
                ${uptimeStr} &mdash;
                ${throughputStr}
              </span>
            </div>
          `;
        }).join('');

        const updateResultText = () => {
          resultEl.textContent = selectedOpenrouterProviders.size
            ? `Selected: ${Array.from(selectedOpenrouterProviders).join(', ')}`
            : `Found ${endpoints.length} provider(s) - select preferred ones below.`;
        };

        listEl.querySelectorAll('.proxy-openrouter-provider-cb').forEach(cb => {
          cb.onchange = () => {
            // The provider name rides on data-provider now (toggleSwitchHTML
            // renders the checkbox itself, and `value` is not part of its API).
            const providerName = cb.dataset.provider;
            if (cb.checked) selectedOpenrouterProviders.add(providerName);
            else selectedOpenrouterProviders.delete(providerName);
            updateResultText();
          };
        });

        updateResultText();
      } catch (err) {
        resultEl.textContent = `Failed: ${err.message}`;
      }
    };
  }
}


/* js/ui/views/settingsView.js - Global Instructions & Generation Settings */
import { ProxyStore } from '../../storage/proxyStore.js';
import { Toast } from '../components/toast.js';
import { escapeHtml } from '../../utils/sanitize.js';

export class SettingsView {
  static async render(container) {
    const settings = await ProxyStore.getGenerationSettings();
    const globalPrompt = await ProxyStore.getGlobalSystemPrompt();
    const proxies = await ProxyStore.getAll();
    const defaultProxy = await ProxyStore.getDefault();
    const presets = await ProxyStore.getSystemPromptPresets();
    const currentFontSize = settings.fontSize || 'medium';

    container.innerHTML = `
      <div style="max-width:800px; margin:0 auto;">
        <h2 style="font-size:1.5rem; margin-bottom:0.25rem;">Global Settings & Instruct Parameters</h2>
        <p style="color:var(--text-muted); font-size:0.88rem; margin-bottom:1.5rem;">Configure global roleplay system prompts, presets, and AI sampling parameters.</p>

        <div class="card" style="margin-bottom:1.5rem;">
          <h3 style="font-size:1.1rem; margin-bottom:1rem;">Active AI Proxy Engine</h3>
          <div class="form-group">
            <label class="form-label">Select Active Proxy Profile</label>
            <select class="select" id="setting-active-proxy">
              ${proxies.map(p => `
                <option value="${p.id}" ${defaultProxy && defaultProxy.id === p.id ? 'selected' : ''}>
                  ${escapeHtml(p.name)} — (${escapeHtml(p.selectedModel || p.provider)})
                </option>
              `).join('')}
            </select>
            <span class="form-hint">The selected proxy engine will be used for AI roleplay completions.</span>
          </div>
        </div>

        <div class="card" style="margin-bottom:1.5rem;">
          <h3 style="font-size:1.1rem; margin-bottom:1rem;">Global System Instruction & Preset Manager</h3>

          <div class="form-group" style="margin-bottom:1.25rem;">
            <label class="form-label">Select System Instruction Preset</label>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;">
              <select class="select" id="select-preset-dropdown" style="flex:1; min-width:220px;">
                ${presets.map(p => `
                  <option value="${p.id}">
                    ${escapeHtml(p.name)} ${p.isBuiltIn || p.id === 'preset-default' ? '(System Default)' : ''}
                  </option>
                `).join('')}
              </select>
              <button class="btn btn-secondary btn-icon" id="btn-save-current-preset" title="Save changes to selected preset" aria-label="Save changes to selected preset">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
              </button>
              <button class="btn btn-secondary btn-icon" id="btn-save-as-new-preset" title="Save as new custom preset" aria-label="Save as new custom preset">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              </button>
              <button class="btn btn-danger btn-icon" id="btn-delete-current-preset" title="Delete selected custom preset" aria-label="Delete selected custom preset">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
              </button>
            </div>
            <span class="form-hint">Selecting a preset loads its system instructions into the editor below.</span>
          </div>

          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label">Active Global System Prompt (Extended Editor)</label>
            <textarea class="textarea" id="global-system-prompt" style="min-height:520px; font-family:monospace; font-size:0.86rem; line-height:1.55; padding:1rem;">${escapeHtml(globalPrompt)}</textarea>
            <span class="form-hint">This prompt is prepended at the top of every completion payload before character definitions.</span>
          </div>
        </div>

        <div class="card" style="margin-bottom:1.5rem;">
          <h3 style="font-size:1.1rem; margin-bottom:1rem;">Chat Font Size</h3>
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label">Chat Message Text Size</label>
            <div style="display:flex; gap:0.75rem; margin-top:0.35rem;">
              <label class="btn btn-secondary" style="flex:1; justify-content:center; cursor:pointer;">
                <input type="radio" name="font-size-opt" value="small" ${currentFontSize === 'small' ? 'checked' : ''}> Small (14px)
              </label>
              <label class="btn btn-secondary" style="flex:1; justify-content:center; cursor:pointer;">
                <input type="radio" name="font-size-opt" value="medium" ${currentFontSize === 'medium' ? 'checked' : ''}> Medium (15.5px)
              </label>
              <label class="btn btn-secondary" style="flex:1; justify-content:center; cursor:pointer;">
                <input type="radio" name="font-size-opt" value="big" ${currentFontSize === 'big' ? 'checked' : ''}> Big (18px)
              </label>
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom:1.5rem;">
          <h3 style="font-size:1.1rem; margin-bottom:1rem;">Response Mode</h3>
          <div style="display:flex; align-items:center; gap:0.5rem;">
            <input type="checkbox" id="setting-streaming-enabled" ${settings.streamingEnabled ? 'checked' : ''}>
            <label for="setting-streaming-enabled" style="font-size:0.85rem; cursor:pointer;">Enable Live Streaming Responses (tokens stream live in real-time)</label>
          </div>
        </div>

        <div class="card" style="margin-bottom:1.5rem;">
          <h3 style="font-size:1.1rem; margin-bottom:1rem;">AI Response Prefill</h3>
          <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.75rem;">
            <input type="checkbox" id="setting-prefill-enabled" ${settings.prefillEnabled ? 'checked' : ''}>
            <label for="setting-prefill-enabled" style="font-size:0.85rem; cursor:pointer;">Enable Response Prefill (disabled by default)</label>
          </div>
          <div class="form-group">
            <label class="form-label">Prefill Text</label>
            <textarea class="textarea" id="setting-prefill-text" style="min-height:80px;" placeholder="e.g. &lt;think&gt;\nRemember: describe physical actions and expressions in italics.\n">${escapeHtml(settings.prefillText)}</textarea>
            <span class="form-hint">Prepends initial assistant response text before completion continues.</span>
          </div>
        </div>

        <div class="card" style="margin-bottom:1.5rem;">
          <h3 style="font-size:1.1rem; margin-bottom:1rem;">Sampling & Generation Parameters</h3>

          <div class="form-group">
            <label class="form-label">
              <span>Temperature</span>
              <span class="slider-value" id="val-temp">${settings.temperature ?? 0.85}</span>
            </label>
            <div class="slider-container">
              <input type="range" class="range-slider" id="slider-temp" min="0.1" max="2.0" step="0.05" value="${settings.temperature ?? 0.85}">
            </div>
            <span class="form-hint">Higher values increase creativity, lower values increase determinism.</span>
          </div>

          <div class="form-group">
            <label class="form-label">
              <span>Top-P Sampling</span>
              <span class="slider-value" id="val-topp">${settings.topP ?? 0.95}</span>
            </label>
            <div class="slider-container">
              <input type="range" class="range-slider" id="slider-topp" min="0.1" max="1.0" step="0.05" value="${settings.topP ?? 0.95}">
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">
              <span>Max Tokens</span>
              <span class="slider-value" id="val-tokens">${settings.maxTokens ?? 1024}</span>
            </label>
            <div class="slider-container">
              <input type="range" class="range-slider" id="slider-tokens" min="100" max="4096" step="64" value="${settings.maxTokens ?? 1024}">
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">
              <span>Repetition Penalty</span>
              <span class="slider-value" id="val-penalty">${settings.repetitionPenalty ?? 1.15}</span>
            </label>
            <div class="slider-container">
              <input type="range" class="range-slider" id="slider-penalty" min="1.0" max="2.0" step="0.05" value="${settings.repetitionPenalty ?? 1.15}">
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">
              <span>Context Message Limit</span>
              <span class="slider-value" id="val-context">${settings.contextLimit ?? 20}</span>
            </label>
            <div class="slider-container">
              <input type="range" class="range-slider" id="slider-context" min="5" max="50" step="1" value="${settings.contextLimit ?? 20}">
            </div>
            <span class="form-hint">Number of recent chat history turns sent to the API per completion.</span>
          </div>
        </div>

        <div style="display:flex; justify-content:flex-end;">
          <button class="btn btn-primary" id="btn-save-settings">
            Save Settings
          </button>
        </div>
      </div>
    `;

    // Bind slider value updates
    const bindSlider = (sliderId, valId) => {
      const slider = container.querySelector(sliderId);
      const val = container.querySelector(valId);
      slider.oninput = () => { val.textContent = slider.value; };
    };

    bindSlider('#slider-temp', '#val-temp');
    bindSlider('#slider-topp', '#val-topp');
    bindSlider('#slider-tokens', '#val-tokens');
    bindSlider('#slider-penalty', '#val-penalty');
    bindSlider('#slider-context', '#val-context');

    // Bind Preset Dropdown & Action Controls
    const presetDropdown = container.querySelector('#select-preset-dropdown');
    const promptTextarea = container.querySelector('#global-system-prompt');
    const btnSaveCurrentPreset = container.querySelector('#btn-save-current-preset');
    const btnSaveAsNewPreset = container.querySelector('#btn-save-as-new-preset');
    const btnDeleteCurrentPreset = container.querySelector('#btn-delete-current-preset');

    presetDropdown.onchange = async () => {
      const selectedId = presetDropdown.value;
      const targetPreset = presets.find(p => p.id === selectedId);
      if (targetPreset) {
        promptTextarea.value = targetPreset.content;
        await ProxyStore.saveGlobalSystemPrompt(targetPreset.content);
        Toast.success(`Preset "${targetPreset.name}" loaded & activated.`);
      }
    };

    btnSaveCurrentPreset.onclick = async () => {
      const selectedId = presetDropdown.value;
      const textVal = promptTextarea.value.trim();
      if (!textVal) {
        Toast.error('System prompt textarea cannot be empty.');
        return;
      }
      const targetPreset = presets.find(p => p.id === selectedId);
      if (!targetPreset) return;

      if (targetPreset.isBuiltIn || targetPreset.id === 'preset-default') {
        Toast.info('Default preset is protected. Saving as new custom preset...');
        const newName = window.prompt('Enter name for new custom preset:');
        if (!newName) return;

        const newPreset = { id: `preset-${Date.now()}`, name: newName, content: textVal };
        presets.push(newPreset);
        await ProxyStore.saveSystemPromptPresets(presets);
        await ProxyStore.saveGlobalSystemPrompt(textVal);
        Toast.success(`New preset "${newName}" saved.`);
        this.render(container);
      } else {
        targetPreset.content = textVal;
        await ProxyStore.saveSystemPromptPresets(presets);
        await ProxyStore.saveGlobalSystemPrompt(textVal);
        Toast.success(`Changes saved to preset "${targetPreset.name}".`);
      }
    };

    btnSaveAsNewPreset.onclick = async () => {
      const textVal = promptTextarea.value.trim();
      if (!textVal) {
        Toast.error('System prompt textarea cannot be empty.');
        return;
      }
      const presetName = window.prompt('Enter name for new custom preset:');
      if (!presetName) return;

      const newPreset = { id: `preset-${Date.now()}`, name: presetName, content: textVal };
      const allPresets = await ProxyStore.getSystemPromptPresets();
      allPresets.push(newPreset);
      await ProxyStore.saveSystemPromptPresets(allPresets);
      await ProxyStore.saveGlobalSystemPrompt(textVal);
      Toast.success(`Preset "${presetName}" created.`);
      this.render(container);
    };

    btnDeleteCurrentPreset.onclick = async () => {
      const selectedId = presetDropdown.value;
      const targetPreset = presets.find(p => p.id === selectedId);
      if (!targetPreset) return;

      if (targetPreset.isBuiltIn || targetPreset.id === 'preset-default') {
        Toast.error('System Default preset cannot be deleted.');
        return;
      }

      if (!confirm(`Delete custom preset "${targetPreset.name}"?`)) return;

      const allPresets = await ProxyStore.getSystemPromptPresets();
      const filtered = allPresets.filter(p => p.id !== selectedId);
      await ProxyStore.saveSystemPromptPresets(filtered);

      const defaultP = filtered.find(p => p.id === 'preset-default') || filtered[0];
      if (defaultP) {
        await ProxyStore.saveGlobalSystemPrompt(defaultP.content);
      }

      Toast.success(`Preset "${targetPreset.name}" deleted.`);
      this.render(container);
    };

    container.querySelector('#btn-save-settings').onclick = async () => {
      const globalPromptVal = container.querySelector('#global-system-prompt').value.trim();
      const selectedFontSize = container.querySelector('input[name="font-size-opt"]:checked')?.value || 'medium';

      const updatedSettings = {
        temperature: parseFloat(container.querySelector('#slider-temp').value),
        topP: parseFloat(container.querySelector('#slider-topp').value),
        maxTokens: parseInt(container.querySelector('#slider-tokens').value),
        repetitionPenalty: parseFloat(container.querySelector('#slider-penalty').value),
        contextLimit: parseInt(container.querySelector('#slider-context').value),
        streamingEnabled: container.querySelector('#setting-streaming-enabled').checked,
        prefillEnabled: container.querySelector('#setting-prefill-enabled').checked,
        prefillText: container.querySelector('#setting-prefill-text').value,
        fontSize: selectedFontSize
      };

      const selectedProxyId = container.querySelector('#setting-active-proxy').value;
      const proxyObj = await ProxyStore.getById(selectedProxyId);
      if (proxyObj) {
        proxyObj.isDefault = true;
        await ProxyStore.save(proxyObj);
      }

      await ProxyStore.saveGlobalSystemPrompt(globalPromptVal);
      await ProxyStore.saveGenerationSettings(updatedSettings);

      Toast.success('Global settings saved successfully.');
    };
  }
}

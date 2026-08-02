/* js/ui/views/settingsView.js - Global Instructions & Generation Settings */
import { ProxyStore } from '../../storage/proxyStore.js';
import { Toast } from '../components/toast.js';
import { escapeHtml } from '../../utils/sanitize.js';

export class SettingsView {
  static async render(container) {
    const settings = await ProxyStore.getGenerationSettings();
    const globalPrompt = await ProxyStore.getGlobalSystemPrompt();

    container.innerHTML = `
      <div style="max-width:800px; margin:0 auto;">
        <h2 style="font-size:1.5rem; margin-bottom:0.25rem;">Global Settings & Instruct Parameters</h2>
        <p style="color:var(--text-muted); font-size:0.88rem; margin-bottom:1.5rem;">Atur instruksi global roleplay dan parameter sampel generasi AI.</p>

        <div class="card" style="margin-bottom:1.5rem;">
          <h3 style="font-size:1.1rem; margin-bottom:1rem;">Global System Instruction & Formatting Preset</h3>
          <div class="form-group">
            <label class="form-label">System Prompt Global</label>
            <textarea class="textarea" id="global-system-prompt" style="min-height:120px;">${escapeHtml(globalPrompt)}</textarea>
            <span class="form-hint">Instruksi ini dimasukkan di bagian paling atas konteks prompt sebelum definisi Karakter.</span>
          </div>
        </div>

        <div class="card" style="margin-bottom:1.5rem;">
          <h3 style="font-size:1.1rem; margin-bottom:1rem;">Response Mode</h3>
          <div style="display:flex; align-items:center; gap:0.5rem;">
            <input type="checkbox" id="setting-streaming-enabled" ${settings.streamingEnabled ? 'checked' : ''}>
            <label for="setting-streaming-enabled" style="font-size:0.85rem; cursor:pointer;">Aktifkan Streaming Response (respon AI muncul token demi token secara live)</label>
          </div>
        </div>

        <div class="card" style="margin-bottom:1.5rem;">
          <h3 style="font-size:1.1rem; margin-bottom:1rem;">Prefill Respon AI</h3>
          <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.75rem;">
            <input type="checkbox" id="setting-prefill-enabled" ${settings.prefillEnabled ? 'checked' : ''}>
            <label for="setting-prefill-enabled" style="font-size:0.85rem; cursor:pointer;">Aktifkan Prefill (default nonaktif)</label>
          </div>
          <div class="form-group">
            <label class="form-label">Teks Prefill</label>
            <textarea class="textarea" id="setting-prefill-text" style="min-height:80px;" placeholder="misal: &lt;think&gt;\nIngat: deskripsikan aksi dan ekspresi secara detail, jangan tulis dialog milik user.\n">${escapeHtml(settings.prefillText)}</textarea>
            <span class="form-hint">Teks ini disisipkan sebagai awal balasan AI sebelum AI melanjutkan menulis - berguna untuk reminder gaya penulisan, menuntun format thinking, dsb. AI akan meneruskan dari titik ini.</span>
          </div>
        </div>

        <div class="card" style="margin-bottom:1.5rem;">
          <h3 style="font-size:1.1rem; margin-bottom:1rem;">Sampling & Generation Parameters</h3>

          <div class="form-group">
            <label class="form-label">
              <span>Temperature (Kreativitas)</span>
              <span class="slider-value" id="val-temp">${settings.temperature ?? 0.85}</span>
            </label>
            <div class="slider-container">
              <input type="range" class="range-slider" id="slider-temp" min="0.1" max="2.0" step="0.05" value="${settings.temperature ?? 0.85}">
            </div>
            <span class="form-hint">Makin tinggi makin kreatif dan bervariasi, makin rendah makin deterministik.</span>
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
              <span>Max Tokens (Respon Maksimal)</span>
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
              <span>Context Message Limit (Riwayat Pesan)</span>
              <span class="slider-value" id="val-context">${settings.contextLimit ?? 20}</span>
            </label>
            <div class="slider-container">
              <input type="range" class="range-slider" id="slider-context" min="5" max="50" step="1" value="${settings.contextLimit ?? 20}">
            </div>
            <span class="form-hint">Jumlah riwayat pesan terakhir yang dikirimkan ke API per pergantian turn.</span>
          </div>
        </div>

        <div style="display:flex; justify-content:flex-end;">
          <button class="btn btn-primary" id="btn-save-settings">
            Simpan Pengaturan
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

    container.querySelector('#btn-save-settings').onclick = async () => {
      const globalPromptVal = container.querySelector('#global-system-prompt').value.trim();
      const updatedSettings = {
        temperature: parseFloat(container.querySelector('#slider-temp').value),
        topP: parseFloat(container.querySelector('#slider-topp').value),
        maxTokens: parseInt(container.querySelector('#slider-tokens').value),
        repetitionPenalty: parseFloat(container.querySelector('#slider-penalty').value),
        contextLimit: parseInt(container.querySelector('#slider-context').value),
        streamingEnabled: container.querySelector('#setting-streaming-enabled').checked,
        prefillEnabled: container.querySelector('#setting-prefill-enabled').checked,
        prefillText: container.querySelector('#setting-prefill-text').value
      };

      await ProxyStore.saveGlobalSystemPrompt(globalPromptVal);
      await ProxyStore.saveGenerationSettings(updatedSettings);

      Toast.success('Pengaturan global berhasil disimpan!');
    };
  }
}

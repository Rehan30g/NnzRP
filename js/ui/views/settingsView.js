/* js/ui/views/settingsView.js - Unified tabbed Settings page
   ==========================================================
   Everything configurable in the app now lives here behind five tabs. The
   former standalone "Multi-Proxy Config" page is embedded as the Proxies tab
   (ProxiesView is mounted into a container rather than duplicated - the same
   reuse trick chatView.js already uses to show it inside a modal).

   IMPORTANT - all five panels stay in the DOM at once (hidden via `.hidden`,
   never removed). The single "Save Settings" handler resolves every field with
   `container.querySelector('#...')`, so tearing inactive panels out would make
   saving from one tab silently drop the others' values.

   Appearance settings (theme mode, accent colours) are the exception: they
   apply and persist the instant they're clicked, because a theme you have to
   press Save to preview is useless. Everything else still batches behind Save.
   ========================================================== */
import { ProxyStore } from '../../storage/proxyStore.js';
import { ThemeStore } from '../../storage/themeStore.js';
import { BackupService } from '../../services/backupService.js';
import { ProxiesView } from './proxiesView.js';
import { Toast } from '../components/toast.js';
import { dropdownHTML, wireDropdown } from '../components/dropdown.js';
import { toggleRowHTML } from '../components/toggle.js';
import { ACCENT_PRESETS, setThemeMode, setAccent, applyAccent } from '../theme.js';
import { showOnboardingWizard } from '../components/onboardingWizard.js';
import { checkForUpdate, downloadAndInstall, isAndroidNative } from '../../services/androidUpdateService.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';

const TAB_ICONS = {
  appearance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5"></circle><circle cx="17.5" cy="10.5" r=".5"></circle><circle cx="8.5" cy="7.5" r=".5"></circle><circle cx="6.5" cy="12.5" r=".5"></circle><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"></path></svg>',
  generation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
  model: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>',
  proxies: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>',
  data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>'
};

const TABS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'generation', label: 'Generation' },
  { id: 'model', label: 'Model' },
  { id: 'proxies', label: 'Proxies' },
  { id: 'data', label: 'Data' }
];

/* Mobile-only "Settings home": the grouped rounded-card list of categories a
   phone user drills into (see .settings-menu / .settings-panel-head in
   css/components.css). Desktop keeps the horizontal tab bar and never renders
   any of this (both blocks are display:none outside the <=768px media query),
   so this is purely an alternate way of REACHING a panel - the panels
   themselves, their fields and the single save handler are untouched.

   Ids reference TABS/TAB_ICONS rather than restating labels/icons, so the
   category list can never drift from the tab bar's. */
const MOBILE_MENU_GROUPS = [
  ['appearance', 'generation', 'model'],
  ['proxies', 'data']
];

const CHEVRON_SVG = '<svg class="settings-menu-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>';
const BACK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>';

/* Short, glanceable state labels for the menu rows' subtitle line. Deliberately
   shorter than the full control labels inside the panels (e.g. "Off / Disabled"
   -> "Reasoning off") - the subtitle has one line on a phone. */
const THEME_MODE_SHORT = { auto: 'Auto (System)', light: 'Light', dark: 'Dark' };
const REASONING_SHORT = {
  off: 'Reasoning off',
  low: 'Reasoning low',
  medium: 'Reasoning medium',
  high: 'Reasoning high',
  budget: 'Reasoning token budget'
};

const modelMenuSummary = (s) =>
  `Temp ${s.temperature ?? 0.85} · ${REASONING_SHORT[s.reasoningEffort] || REASONING_SHORT.off}`;

const FONT_SIZES = [
  { value: 'small', label: 'Small', note: '14px' },
  { value: 'medium', label: 'Medium', note: '15.5px' },
  { value: 'big', label: 'Big', note: '18px' }
];

const THEME_MODES_UI = [
  { value: 'auto', label: 'Auto (System)' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
];

export class SettingsView {
  /**
   * @param {Element} container
   * @param {{tab?: string}} [options] - initial tab (the #proxies route redirects
   *        here with tab:'proxies'; see App.parseHash).
   */
  static async render(container, options = {}) {
    const settings = await ProxyStore.getGenerationSettings();
    const globalPrompt = await ProxyStore.getGlobalSystemPrompt();
    const proxies = await ProxyStore.getAll();
    const defaultProxy = await ProxyStore.getDefault();
    const presets = await ProxyStore.getSystemPromptPresets();
    const currentFontSize = settings.fontSize || 'medium';

    const themeMode = await ThemeStore.getMode();
    const accent = await ThemeStore.getAccent();

    /* Android-only "App Updates" card in the Data panel. Gated here rather
       than hidden with CSS so it is entirely ABSENT from the DOM on Electron /
       a browser tab / the PWA, none of which have an APK to replace (the web
       content there is always current by construction - see
       js/services/androidUpdateService.js's header). */
    const isAndroidApp = isAndroidNative();
    let installedAppVersion = '';
    if (isAndroidApp) {
      try {
        installedAppVersion = (await window.Capacitor?.Plugins?.App?.getInfo())?.version || '';
      } catch { /* non-fatal - the card just omits the version line */ }
    }

    /* Plugin settings no longer live here at all - both the management UI and
       every per-plugin settings panel are in the top-level Plugins view
       (#plugins, pluginsView.js). This page is the 5 fixed tabs, full stop. */
    const allTabs = TABS;

    // Tabs whose controls persist themselves - the shared Save button is a
    // no-op there and is hidden (same treatment as Proxies/Data).
    const selfSavingTabs = ['proxies', 'data'];

    const initialTab = allTabs.some(t => t.id === options.tab) ? options.tab : 'appearance';
    // Embedded mode (opened from the chat drawer's "Settings" shortcut, inside
    // a Modal) drops the page title/section descriptions and hides the
    // internal floating save bar via CSS (.settings-shell-embedded, see
    // components.css) - a `position: fixed` bar escapes the Modal entirely
    // (fixed positioning is relative to the viewport, not any ancestor,
    // Modal included), and the descriptions just ate space in an already
    // cramped popup. `#btn-save-settings` itself still exists (just hidden)
    // and still holds the real save logic - chatView.js's
    // `btn-open-global-settings` adds its own "Save Settings" Modal footer
    // button that clicks this hidden one, rather than duplicating the logic.
    const embedded = !!options.embedded;

    const proxyOptions = proxies.map(p => ({
      value: p.id,
      label: p.name,
      hint: p.selectedModel || p.provider
    }));

    const presetOptions = presets.map(p => ({
      value: p.id,
      label: p.name,
      hint: (p.isBuiltIn || p.id === 'preset-default') ? 'System Default' : 'Custom preset'
    }));

    const reasoningOptions = [
      { value: 'off', label: 'Off / Disabled', hint: 'Standard non-reasoning models' },
      { value: 'low', label: 'Low Effort', hint: 'reasoning.effort = "low"' },
      { value: 'medium', label: 'Medium Effort', hint: 'reasoning.effort = "medium"' },
      { value: 'high', label: 'High Effort', hint: 'reasoning.effort = "high"' },
      { value: 'budget', label: 'Token Budget Mode', hint: 'reasoning.max_tokens' }
    ];

    const segmentedHTML = (groupClass, items, current) => `
      <div class="segmented ${groupClass}" role="group">
        ${items.map(item => `
          <button type="button" class="segmented-option${item.value === current ? ' active' : ''}" data-value="${escapeAttr(item.value)}">
            ${escapeHtml(item.label)}${item.note ? ` <span style="font-weight:400; opacity:0.7;">(${escapeHtml(item.note)})</span>` : ''}
          </button>
        `).join('')}
      </div>
    `;

    /* Live one-line summaries for the mobile grouped-list rows, computed from
       the same data this render already fetched (no extra IndexedDB reads). */
    const menuSubtitles = {
      appearance: THEME_MODE_SHORT[themeMode] || THEME_MODE_SHORT.auto,
      generation: defaultProxy ? defaultProxy.name : 'No proxy configured',
      model: modelMenuSummary(settings),
      proxies: proxies.length
        ? `${proxies.length} profile${proxies.length === 1 ? '' : 's'} configured`
        : 'No profiles yet',
      data: isAndroidApp ? 'App updates, backup & restore' : 'Backup, restore & setup wizard'
    };

    const menuRowHTML = (id) => {
      const tab = allTabs.find(t => t.id === id);
      if (!tab) return '';
      const sub = menuSubtitles[id];
      const icon = TAB_ICONS[id] || '';
      return `
        <button type="button" class="settings-menu-row" data-goto="${escapeAttr(id)}">
          <span class="settings-menu-icon">${icon}</span>
          <span class="settings-menu-text">
            <span class="settings-menu-label">${escapeHtml(tab.label)}</span>
            ${sub ? `<span class="settings-menu-sub" data-menu-sub="${escapeAttr(id)}">${escapeHtml(sub)}</span>` : ''}
          </span>
          ${CHEVRON_SVG}
        </button>
      `;
    };

    const initialTabLabel = (allTabs.find(t => t.id === initialTab) || allTabs[0]).label;

    // Mobile grouped-list layout: the 5 built-ins in their two groups.
    const menuGroups = MOBILE_MENU_GROUPS;

    container.innerHTML = `
      <div class="settings-shell${embedded ? ' settings-shell-embedded' : ''}">
        ${embedded ? '' : `
        <div style="margin-bottom:1.25rem;">
          <h2 class="view-header-title" style="font-size:1.6rem; margin-bottom:0.3rem;">Settings</h2>
          <p class="view-header-desc" style="color:var(--text-muted); font-size:0.9rem;">Appearance, generation behaviour, model parameters, API proxies and backups - all in one place.</p>
        </div>
        `}

        <!-- Mobile-only grouped category list (the "Settings home" screen) and
             the in-panel back header that replaces it once a row is tapped.
             Both are display:none above 768px - see components.css. -->
        <div class="settings-menu" id="settings-menu">
          ${menuGroups.map(group => `
            <div class="settings-menu-group">${group.map(menuRowHTML).join('')}</div>
          `).join('')}
        </div>

        <!-- The whole bar is the back button (not just a small icon inside it) -
             a 36px icon on its own is a cramped tap target on a sticky header
             that spans the full screen width; the icon is now purely decorative
             (a <span>, not a nested <button>, to avoid a button-inside-a-button). -->
        <button type="button" class="settings-panel-head" id="btn-settings-back" aria-label="Back to settings list">
          <span class="settings-back-icon" aria-hidden="true">${BACK_SVG}</span>
          <span class="settings-panel-head-title" id="settings-panel-head-title">${escapeHtml(initialTabLabel)}</span>
        </button>

        <div class="settings-tabbar" role="tablist">
          ${allTabs.map(t => `
            <button type="button" class="settings-tab${t.id === initialTab ? ' active' : ''}" data-tab="${escapeAttr(t.id)}" role="tab" aria-selected="${t.id === initialTab}">
              ${TAB_ICONS[t.id] || ''}<span>${escapeHtml(t.label)}</span>
            </button>
          `).join('')}
        </div>

        <!-- ============ APPEARANCE ============ -->
        <div class="settings-panel${initialTab === 'appearance' ? '' : ' hidden'}" data-panel="appearance">
          <div class="card">
            <h3 class="settings-section-title">Theme</h3>
            <p class="settings-section-desc">Auto follows your operating system's light/dark setting and switches live when it changes. Applied and saved immediately - no need to press Save.</p>
            ${segmentedHTML('theme-mode-group', THEME_MODES_UI, themeMode)}
          </div>

          <div class="card">
            <h3 class="settings-section-title">Accent Colour</h3>
            <p class="settings-section-desc">Recolours buttons, links, active navigation and highlights across both light and dark themes. Applied and saved immediately.</p>

            <div class="form-group">
              <label class="form-label">Presets</label>
              <div class="swatch-row" id="accent-preset-row">
                ${ACCENT_PRESETS.map(p => `
                  <button type="button" class="swatch${p.primary === accent.primary && p.secondary === accent.secondary ? ' active' : ''}"
                          data-primary="${escapeAttr(p.primary)}" data-secondary="${escapeAttr(p.secondary)}"
                          title="${escapeAttr(p.name)}" aria-label="${escapeAttr(p.name)} accent"
                          style="background: linear-gradient(135deg, ${escapeAttr(p.primary)} 0%, ${escapeAttr(p.secondary)} 100%);"></button>
                `).join('')}
              </div>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem;">
              <div class="form-group" style="margin-bottom:0;">
                <label class="form-label" for="accent-primary-input">Primary</label>
                <div class="color-field">
                  <input type="color" id="accent-primary-input" value="${escapeAttr(accent.primary)}">
                  <div>
                    <div class="color-field-name">Buttons &amp; links</div>
                    <div class="color-field-value" id="accent-primary-value">${escapeHtml(accent.primary)}</div>
                  </div>
                </div>
              </div>
              <div class="form-group" style="margin-bottom:0;">
                <label class="form-label" for="accent-secondary-input">Secondary</label>
                <div class="color-field">
                  <input type="color" id="accent-secondary-input" value="${escapeAttr(accent.secondary)}">
                  <div>
                    <div class="color-field-name">Character names &amp; tools</div>
                    <div class="color-field-value" id="accent-secondary-value">${escapeHtml(accent.secondary)}</div>
                  </div>
                </div>
              </div>
            </div>

            <div style="margin-top:1rem;">
              <button class="btn btn-secondary btn-sm" id="btn-reset-accent">Reset to default indigo</button>
            </div>
          </div>

          <div class="card">
            <h3 class="settings-section-title">Chat Font Size</h3>
            <p class="settings-section-desc">Text size of roleplay messages in the chat stream. Saved with the Save Settings button.</p>
            ${segmentedHTML('font-size-group', FONT_SIZES, currentFontSize)}
            <input type="hidden" id="setting-font-size" value="${escapeAttr(currentFontSize)}">
          </div>
        </div>

        <!-- ============ GENERATION ============ -->
        <div class="settings-panel${initialTab === 'generation' ? '' : ' hidden'}" data-panel="generation">
          <div class="card">
            <h3 class="settings-section-title">Active AI Proxy Engine</h3>
            <div class="form-group" style="margin-bottom:0;">
              <label class="form-label">Select Active Proxy Profile</label>
              ${dropdownHTML({
                id: 'setting-active-proxy',
                options: proxyOptions,
                value: defaultProxy ? defaultProxy.id : '',
                placeholder: 'No proxy configured'
              })}
              <span class="form-hint">The selected proxy engine will be used for AI roleplay completions. Manage profiles under the Proxies tab.</span>
            </div>
          </div>

          <div class="card">
            <h3 class="settings-section-title">Response Behaviour</h3>
            <div style="display:flex; flex-direction:column; gap:1.1rem;">
              ${toggleRowHTML({
                id: 'setting-streaming-enabled',
                checked: !!settings.streamingEnabled,
                title: 'Live Streaming Responses',
                description: 'Tokens appear in real time as the model generates them.'
              })}
              <div style="border-top:1px solid var(--border-light); padding-top:1.1rem;">
                ${toggleRowHTML({
                  id: 'setting-prefill-enabled',
                  checked: !!settings.prefillEnabled,
                  title: 'AI Response Prefill',
                  description: 'Prepends fixed assistant text before the model continues. Disabled by default.'
                })}
                <div class="form-group" style="margin-top:1rem; margin-bottom:0;">
                  <label class="form-label">Prefill Text</label>
                  <textarea class="textarea" id="setting-prefill-text" style="min-height:90px;" placeholder="e.g. &lt;think&gt;">${escapeHtml(settings.prefillText)}</textarea>
                  <span class="form-hint">Prepends initial assistant response text before completion continues.</span>
                </div>
              </div>
              <div style="border-top:1px solid var(--border-light); padding-top:1.1rem;">
                ${toggleRowHTML({
                  id: 'setting-autocompact-enabled',
                  checked: settings.autoCompactEnabled !== false,
                  title: 'Auto Context Compaction',
                  description: 'Automatically summarizes older turns into a short continuity summary before generating once the context window is nearly full. Stored chat history is never modified.'
                })}
              </div>
            </div>
          </div>

          <div class="card">
            <h3 class="settings-section-title">Global System Instruction &amp; Preset Manager</h3>

            <div class="form-group" style="margin-bottom:1.35rem;">
              <label class="form-label">Select System Instruction Preset</label>
              <div style="display:flex; gap:0.6rem; flex-wrap:wrap; align-items:center;">
                <div style="flex:1; min-width:240px;">
                  ${dropdownHTML({
                    id: 'select-preset-dropdown',
                    options: presetOptions,
                    value: (presets.find(p => p.content === settings.globalPrompt) || presets[0] || { id: '' }).id,
                    placeholder: 'No presets'
                  })}
                </div>
                <button class="btn btn-secondary btn-sm btn-icon" id="btn-save-current-preset" title="Save changes to selected preset" aria-label="Save changes to selected preset">
                  <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
                </button>
                <button class="btn btn-secondary btn-sm btn-icon" id="btn-save-as-new-preset" title="Save as new custom preset" aria-label="Save as new custom preset">
                  <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                </button>
                <button class="btn btn-danger btn-sm btn-icon" id="btn-delete-current-preset" title="Delete selected custom preset" aria-label="Delete selected custom preset">
                  <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
                </button>
              </div>
              <span class="form-hint">Selecting a preset loads its system instructions into the editor below.</span>
            </div>

            <div class="form-group" style="margin-bottom:0;">
              <label class="form-label">Active Global System Prompt (Extended Editor)</label>
              <textarea class="textarea" id="global-system-prompt" style="min-height:460px; font-family:var(--font-mono); font-size:0.86rem; line-height:1.55; padding:1rem;">${escapeHtml(globalPrompt)}</textarea>
              <span class="form-hint">This prompt is prepended at the top of every completion payload before character definitions.</span>
            </div>
          </div>
        </div>

        <!-- ============ MODEL CONFIGURATIONS ============ -->
        <div class="settings-panel${initialTab === 'model' ? '' : ' hidden'}" data-panel="model">
          <div class="card">
            <h3 class="settings-section-title">Sampling &amp; Generation Parameters</h3>
            <p class="settings-section-desc">Applied to every completion request sent through the active proxy.</p>

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
                <span class="slider-value" id="val-tokens">${settings.maxTokens ?? 2048}</span>
              </label>
              <div class="slider-container">
                <input type="range" class="range-slider" id="slider-tokens" min="100" max="32768" step="64" value="${settings.maxTokens ?? 2048}" ${settings.unlimitedTokens ? 'disabled' : ''}>
              </div>
              <div style="margin-top:0.6rem;">
                ${toggleRowHTML({
                  id: 'setting-unlimited-tokens',
                  checked: !!settings.unlimitedTokens,
                  title: 'Unlimited',
                  description: 'Use the highest output length each provider allows instead of the slider above - prevents long thinking/replies from being cut off mid-way.'
                })}
              </div>
            </div>

            <div class="form-group" style="margin-bottom:0;">
              <label class="form-label">
                <span>Repetition Penalty</span>
                <span class="slider-value" id="val-penalty">${settings.repetitionPenalty ?? 1.15}</span>
              </label>
              <div class="slider-container">
                <input type="range" class="range-slider" id="slider-penalty" min="1.0" max="2.0" step="0.05" value="${settings.repetitionPenalty ?? 1.15}">
              </div>
            </div>
          </div>

          <div class="card">
            <h3 class="settings-section-title">Model Reasoning &amp; Extended Thinking</h3>
            <p class="settings-section-desc">
              Thinking effort &amp; token budget for reasoning models (Claude 3.7 Sonnet, DeepSeek R1, OpenAI o1/o3, Gemini Flash Thinking, OpenRouter).
            </p>

            <div class="form-group" style="margin-bottom:1.35rem;">
              <label class="form-label">Reasoning Effort</label>
              ${dropdownHTML({
                id: 'setting-reasoning-effort',
                options: reasoningOptions,
                value: settings.reasoningEffort || 'off'
              })}
              <span class="form-hint">Controls reasoning intensity sent to OpenRouter &amp; Provider APIs.</span>
            </div>

            <div class="form-group" style="margin-bottom:0;">
              <label class="form-label">
                <span>Thinking Token Budget</span>
                <span class="slider-value" id="val-reasoning-tokens">${settings.reasoningMaxTokens ?? 2048}</span>
              </label>
              <div class="slider-container">
                <input type="range" class="range-slider" id="slider-reasoning-tokens" min="512" max="16384" step="512" value="${settings.reasoningMaxTokens ?? 2048}">
              </div>
              <span class="form-hint">Maximum token budget allocated for internal reasoning thoughts before generating text.</span>
            </div>
          </div>
        </div>

        <!-- ============ PROXIES (embeds ProxiesView) ============ -->
        <div class="settings-panel${initialTab === 'proxies' ? '' : ' hidden'}" data-panel="proxies">
          <div id="settings-proxies-mount"></div>
        </div>

        <!-- ============ DATA ============ -->
        <div class="settings-panel${initialTab === 'data' ? '' : ' hidden'}" data-panel="data">
          ${isAndroidApp ? `
          <div class="card">
            <h3 class="settings-section-title">App Updates</h3>
            <p class="settings-section-desc">
              The app's content updates itself on every launch. This checks whether the <em>installed Android app</em> itself${installedAppVersion ? ` (currently version ${escapeHtml(installedAppVersion)})` : ''}
              has a newer released build, downloads it, and opens Android's installer.
              Android always asks you to confirm the install - that single tap can't be skipped by any app outside the Play Store.
            </p>
            <div style="display:flex; gap:0.75rem; flex-wrap:wrap; align-items:center;">
              <button class="btn btn-secondary" id="btn-check-app-update">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21.5 2v6h-6"></path><path d="M2.5 22v-6h6"></path><path d="M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"></path></svg>
                Check Updates
              </button>
            </div>
            <!-- Inline status, NOT a toast: Toast.info/.success are display:none
                 on mobile (components.css) and this card only ever renders on a
                 phone, so a toast-driven flow would be completely invisible
                 exactly where it matters. Only Toast.error survives there. -->
            <p id="app-update-status" class="hidden" style="margin:0.85rem 0 0; font-size:0.85rem; color:var(--text-dim);"></p>
          </div>
          ` : ''}

          <div class="card">
            <h3 class="settings-section-title">Data Backup &amp; Migration</h3>
            <p class="settings-section-desc">
              Export or import all application data (Characters, Chat History, Personas, System Prompts, and Proxy API Keys) as a single JSON backup file.
              The export contains your API keys in plain text - store it somewhere safe.
            </p>
            <div style="display:flex; gap:0.75rem; flex-wrap:wrap; align-items:center;">
              <button class="btn btn-secondary" id="btn-export-all-data">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                Export
              </button>
              <button class="btn btn-secondary" id="btn-trigger-import-data">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                Import
              </button>
              <input type="file" id="input-import-data-file" accept=".json" style="display:none;">
            </div>
          </div>

          <div class="card">
            <h3 class="settings-section-title">Setup Wizard</h3>
            <p class="settings-section-desc">
              Re-run the first-run walkthrough (provider, model, persona, and the recommended optional settings) - useful for revisiting it after skipping, or for setting up a second provider from scratch.
            </p>
            <button class="btn btn-secondary" id="btn-rerun-onboarding">
              <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21.5 2v6h-6"></path><path d="M2.5 22v-6h6"></path><path d="M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"></path></svg>
              Run Wizard Again
            </button>
          </div>
        </div>

        <div class="settings-savebar${selfSavingTabs.includes(initialTab) ? ' hidden' : ''}" id="settings-savebar">
          <div class="settings-savebar-inner">
            <!-- .settings-savebar-hint is display:none on mobile (components.css)
                 - the sentence ate most of the bar's width next to the button on
                 a phone, and the bar switches to right-aligning the button alone
                 there. A class, not a bare "span" selector, so a future second
                 element in this bar isn't hidden by accident. -->
            <span class="settings-savebar-hint" style="font-size:0.8rem; color:var(--text-dim);">Theme &amp; accent save instantly; everything else needs Save.</span>
            <button class="btn btn-primary" id="btn-save-settings">Save</button>
          </div>
        </div>
      </div>
    `;

    /* ---------------- Tab switching ---------------- */
    const tabButtons = container.querySelectorAll('.settings-tab');
    const panels = container.querySelectorAll('.settings-panel');
    const savebarEl = container.querySelector('#settings-savebar');
    // Tabs whose controls persist themselves (see `selfSavingTabs` above -
    // proxies and data) - the shared Save button would be a no-op there, so
    // it's hidden rather than left looking inert.
    let proxiesMounted = false;

    /* Mobile grouped-list state. `.settings-mobile-home` on the shell means
       "show the category list, hide every panel + the save bar" - and it is
       ONLY interpreted inside components.css's <=768px media query, so a
       desktop viewport is completely unaffected by the class being present.
       That also keeps the JS `.hidden` panel state (which the desktop tab bar
       drives) authoritative and untouched, so resizing a phone-width window up
       to desktop lands on a normally-rendered tab + panel. */
    const shellEl = container.querySelector('.settings-shell');
    const headTitleEl = container.querySelector('#settings-panel-head-title');
    const setMenuSub = (id, text) => {
      const el = container.querySelector(`[data-menu-sub="${id}"]`);
      if (el) el.textContent = text;
    };

    const mountProxiesIfNeeded = async () => {
      if (proxiesMounted) return;
      const mount = container.querySelector('#settings-proxies-mount');
      if (!mount) return;
      proxiesMounted = true;
      await ProxiesView.render(mount);
    };

    const switchTab = async (tabId) => {
      // Leaving the mobile category list is implicit in picking a category -
      // desktop tab clicks run this too, harmlessly (the class does nothing
      // above 768px).
      if (shellEl) shellEl.classList.remove('settings-mobile-home');
      const tabMeta = allTabs.find(t => t.id === tabId);
      if (headTitleEl && tabMeta) headTitleEl.textContent = tabMeta.label;
      tabButtons.forEach(btn => {
        const active = btn.dataset.tab === tabId;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', String(active));
      });
      panels.forEach(panel => panel.classList.toggle('hidden', panel.dataset.panel !== tabId));
      if (savebarEl) savebarEl.classList.toggle('hidden', selfSavingTabs.includes(tabId));
      if (tabId === 'proxies') await mountProxiesIfNeeded();
    };

    tabButtons.forEach(btn => {
      btn.onclick = () => switchTab(btn.dataset.tab);
    });

    container.querySelectorAll('.settings-menu-row').forEach(row => {
      row.onclick = () => switchTab(row.dataset.goto);
    });

    const btnSettingsBack = container.querySelector('#btn-settings-back');
    if (btnSettingsBack) {
      btnSettingsBack.onclick = () => shellEl.classList.add('settings-mobile-home');
    }

    /* Land on the category list, EXCEPT when a tab was named explicitly - the
       #proxies -> #settings redirect (App.parseHash) and this view's own
       re-renders after preset/backup actions both pass one, and bouncing those
       back out to the list would lose the user's place. */
    if (shellEl && !allTabs.some(t => t.id === options.tab)) {
      shellEl.classList.add('settings-mobile-home');
    }

    // Mounting ProxiesView is deferred until its tab is first opened (it does its
    // own IndexedDB read + render), except when we land directly on that tab.
    if (initialTab === 'proxies') await mountProxiesIfNeeded();

    /* ---------------- Appearance: theme mode ---------------- */
    const themeGroup = container.querySelector('.theme-mode-group');
    themeGroup.querySelectorAll('.segmented-option').forEach(btn => {
      btn.onclick = async () => {
        const mode = btn.dataset.value;
        themeGroup.querySelectorAll('.segmented-option').forEach(b => b.classList.toggle('active', b === btn));
        await setThemeMode(mode);
        setMenuSub('appearance', THEME_MODE_SHORT[mode] || THEME_MODE_SHORT.auto);
        Toast.success(`Theme set to ${mode === 'auto' ? 'Auto (follows system)' : mode}.`);
      };
    });

    /* ---------------- Appearance: accent colours ---------------- */
    const primaryInput = container.querySelector('#accent-primary-input');
    const secondaryInput = container.querySelector('#accent-secondary-input');
    const primaryValueEl = container.querySelector('#accent-primary-value');
    const secondaryValueEl = container.querySelector('#accent-secondary-value');
    const swatchButtons = container.querySelectorAll('#accent-preset-row .swatch');

    const syncSwatchActive = () => {
      swatchButtons.forEach(sw => {
        sw.classList.toggle(
          'active',
          sw.dataset.primary === primaryInput.value.toLowerCase() &&
          sw.dataset.secondary === secondaryInput.value.toLowerCase()
        );
      });
      primaryValueEl.textContent = primaryInput.value.toLowerCase();
      secondaryValueEl.textContent = secondaryInput.value.toLowerCase();
    };

    // `input` = live preview while dragging the OS colour picker (apply only,
    // no IndexedDB write per pixel); `change` = the committed pick, persisted.
    const previewAccent = () => {
      applyAccent({ primary: primaryInput.value, secondary: secondaryInput.value });
      syncSwatchActive();
    };
    const commitAccent = async () => {
      await setAccent({ primary: primaryInput.value, secondary: secondaryInput.value });
      syncSwatchActive();
    };

    primaryInput.oninput = previewAccent;
    secondaryInput.oninput = previewAccent;
    primaryInput.onchange = commitAccent;
    secondaryInput.onchange = commitAccent;

    swatchButtons.forEach(sw => {
      sw.onclick = async () => {
        primaryInput.value = sw.dataset.primary;
        secondaryInput.value = sw.dataset.secondary;
        await commitAccent();
        Toast.success(`Accent colour set to ${sw.title}.`);
      };
    });

    container.querySelector('#btn-reset-accent').onclick = async () => {
      primaryInput.value = ACCENT_PRESETS[0].primary;
      secondaryInput.value = ACCENT_PRESETS[0].secondary;
      await commitAccent();
      Toast.info('Accent colour reset to default.');
    };

    /* ---------------- Appearance: chat font size ---------------- */
    const fontGroup = container.querySelector('.font-size-group');
    const fontHidden = container.querySelector('#setting-font-size');
    fontGroup.querySelectorAll('.segmented-option').forEach(btn => {
      btn.onclick = () => {
        fontGroup.querySelectorAll('.segmented-option').forEach(b => b.classList.toggle('active', b === btn));
        fontHidden.value = btn.dataset.value;
      };
    });

    /* ---------------- Sliders ---------------- */
    const bindSlider = (sliderId, valId) => {
      const slider = container.querySelector(sliderId);
      const val = container.querySelector(valId);
      slider.oninput = () => { val.textContent = slider.value; };
    };

    bindSlider('#slider-temp', '#val-temp');
    bindSlider('#slider-topp', '#val-topp');
    bindSlider('#slider-tokens', '#val-tokens');
    bindSlider('#slider-penalty', '#val-penalty');
    bindSlider('#slider-reasoning-tokens', '#val-reasoning-tokens');

    const unlimitedTokensToggle = container.querySelector('#setting-unlimited-tokens');
    const tokensSlider = container.querySelector('#slider-tokens');
    if (unlimitedTokensToggle && tokensSlider) {
      unlimitedTokensToggle.onchange = () => {
        tokensSlider.disabled = unlimitedTokensToggle.checked;
      };
    }

    /* ---------------- Dropdowns ---------------- */
    wireDropdown(container, 'setting-active-proxy');
    wireDropdown(container, 'setting-reasoning-effort');

    const promptTextarea = container.querySelector('#global-system-prompt');

    wireDropdown(container, 'select-preset-dropdown', async (selectedId) => {
      const targetPreset = presets.find(p => p.id === selectedId);
      if (targetPreset) {
        promptTextarea.value = targetPreset.content;
        await ProxyStore.saveGlobalSystemPrompt(targetPreset.content);
        Toast.success(`Preset "${targetPreset.name}" loaded & activated.`);
      }
    });

    /* ---------------- Preset management ---------------- */
    const presetValueEl = container.querySelector('#select-preset-dropdown');
    const btnSaveCurrentPreset = container.querySelector('#btn-save-current-preset');
    const btnSaveAsNewPreset = container.querySelector('#btn-save-as-new-preset');
    const btnDeleteCurrentPreset = container.querySelector('#btn-delete-current-preset');

    btnSaveCurrentPreset.onclick = async () => {
      const selectedId = presetValueEl.value;
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
        this.render(container, { tab: 'generation' });
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
      this.render(container, { tab: 'generation' });
    };

    btnDeleteCurrentPreset.onclick = async () => {
      const selectedId = presetValueEl.value;
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
      this.render(container, { tab: 'generation' });
    };

    /* ---------------- Save (everything except appearance) ----------------
     *
     * Feedback is IN the button ("Saved", checkmark, ~1.6s) rather than a
     * toast: on mobile a toast is a separate banner at the top of the screen,
     * far away from the button the thumb just pressed, and info/success toasts
     * are display:none on mobile anyway (components.css) - so the old
     * Toast.success meant pressing Save on a phone produced no feedback at
     * all. Same shape as chatView.js's code-copy button ("Copied", 1500ms,
     * original label restored): stash the label, swap, disable so a
     * double-tap can't re-enter mid-feedback, restore on a timer.
     *
     * The Modal-embedded copy (chat drawer -> Settings) hides this bar
     * entirely and drives it via its own footer "Save Settings" button, which
     * `.click()`s this one - so the flash is mirrored onto that button too,
     * otherwise the feedback would land on an invisible element. */
    const SAVED_FLASH_MS = 1600;
    const CHECK_SVG =
      '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">' +
      '<polyline points="20 6 9 17 4 12"></polyline></svg>';

    const flashSaved = (btn) => {
      if (!btn || btn.dataset.flashing === '1') return;
      const originalHTML = btn.innerHTML;
      const wasDisabled = btn.disabled;
      btn.dataset.flashing = '1';
      btn.disabled = true;
      btn.classList.add('btn-saved-flash');
      btn.innerHTML = `${CHECK_SVG}<span>Saved</span>`;
      setTimeout(() => {
        btn.innerHTML = originalHTML;
        btn.classList.remove('btn-saved-flash');
        btn.disabled = wasDisabled;
        delete btn.dataset.flashing;
      }, SAVED_FLASH_MS);
    };

    container.querySelector('#btn-save-settings').onclick = async () => {
      const globalPromptVal = container.querySelector('#global-system-prompt').value.trim();
      const selectedFontSize = container.querySelector('#setting-font-size').value || 'medium';

      const updatedSettings = {
        ...settings,
        temperature: parseFloat(container.querySelector('#slider-temp').value),
        topP: parseFloat(container.querySelector('#slider-topp').value),
        maxTokens: parseInt(container.querySelector('#slider-tokens').value),
        unlimitedTokens: container.querySelector('#setting-unlimited-tokens').checked,
        repetitionPenalty: parseFloat(container.querySelector('#slider-penalty').value),
        reasoningEffort: container.querySelector('#setting-reasoning-effort').value,
        reasoningMaxTokens: parseInt(container.querySelector('#slider-reasoning-tokens').value),
        streamingEnabled: container.querySelector('#setting-streaming-enabled').checked,
        prefillEnabled: container.querySelector('#setting-prefill-enabled').checked,
        prefillText: container.querySelector('#setting-prefill-text').value,
        autoCompactEnabled: container.querySelector('#setting-autocompact-enabled').checked,
        fontSize: selectedFontSize
      };

      const selectedProxyId = container.querySelector('#setting-active-proxy').value;
      const proxyObj = selectedProxyId ? await ProxyStore.getById(selectedProxyId) : null;
      if (proxyObj) {
        proxyObj.isDefault = true;
        await ProxyStore.save(proxyObj);
      }

      await ProxyStore.saveGlobalSystemPrompt(globalPromptVal);
      await ProxyStore.saveGenerationSettings(updatedSettings);

      // Keep the mobile category list's summary lines truthful without a
      // re-render (going Back re-shows the same DOM).
      setMenuSub('model', modelMenuSummary(updatedSettings));
      setMenuSub('generation', proxyObj ? proxyObj.name : 'No proxy configured');

      // "bukan notif" - the confirmation lives on the button, not in a toast.
      flashSaved(container.querySelector('#btn-save-settings'));
      if (embedded) flashSaved(document.getElementById('btn-save-settings-modal'));
    };

    /* ---------------- Backup & restore ---------------- */
    const btnExportAll = container.querySelector('#btn-export-all-data');
    const btnImportTrigger = container.querySelector('#btn-trigger-import-data');
    const inputImportFile = container.querySelector('#input-import-data-file');

    if (btnExportAll) {
      btnExportAll.onclick = async () => {
        try {
          await BackupService.exportAllData();
          Toast.success('Full application backup exported successfully.');
        } catch (err) {
          Toast.error('Export failed: ' + err.message);
        }
      };
    }

    if (btnImportTrigger && inputImportFile) {
      btnImportTrigger.onclick = () => inputImportFile.click();

      inputImportFile.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
          Toast.info('Restoring application backup data...');
          const stats = await BackupService.importAllData(file);
          Toast.success(`Backup imported! Restored: ${stats.characters} Characters, ${stats.chats} Chats, ${stats.proxies} Proxy Keys, ${stats.personas} Personas.`);
          this.render(container, { tab: 'data' });
        } catch (err) {
          Toast.error(err.message);
        } finally {
          inputImportFile.value = '';
        }
      };
    }

    const btnRerunOnboarding = container.querySelector('#btn-rerun-onboarding');
    if (btnRerunOnboarding) {
      btnRerunOnboarding.onclick = () => showOnboardingWizard();
    }

    /* ---------------- Android app updates ----------------
       Only wired when the card was actually rendered (Android APK only).

       Every state lands INLINE - the button label plus the #app-update-status
       line - rather than in a toast, because Toast.info/.success are
       display:none on mobile (see components.css) and this card is
       mobile-only; a toast-driven flow here would be invisible on the exact
       device it exists for. Toast.error still shows on mobile, so real
       failures get one on top of the inline message.

       The flow ends at Android's own install dialog: downloadAndInstall()
       resolves once the installer intent has been fired, and the OS owns the
       screen from there - so the final state is just "confirm the install in
       the dialog", never a spinner waiting on something this page can see. */
    const btnCheckUpdate = container.querySelector('#btn-check-app-update');
    const updateStatusEl = container.querySelector('#app-update-status');
    if (btnCheckUpdate && updateStatusEl) {
      let statusClearTimer = null;
      // tone -> token. No raw hex anywhere (CLAUDE.md rule 2).
      const STATUS_TONES = {
        neutral: 'var(--text-dim)',
        good: 'var(--accent-emerald)',
        bad: 'var(--accent-rose)'
      };
      const setStatus = (text, tone = 'neutral', autoClearMs = 0) => {
        clearTimeout(statusClearTimer);
        updateStatusEl.textContent = text;
        updateStatusEl.style.color = STATUS_TONES[tone] || STATUS_TONES.neutral;
        updateStatusEl.classList.toggle('hidden', !text);
        if (autoClearMs) {
          statusClearTimer = setTimeout(() => {
            updateStatusEl.textContent = '';
            updateStatusEl.classList.add('hidden');
          }, autoClearMs);
        }
      };

      const originalUpdateBtnHTML = btnCheckUpdate.innerHTML;
      const setBusy = (label) => {
        btnCheckUpdate.disabled = !!label;
        btnCheckUpdate.innerHTML = label ? `<span>${escapeHtml(label)}</span>` : originalUpdateBtnHTML;
      };

      btnCheckUpdate.onclick = async () => {
        setBusy('Checking');
        setStatus('Checking for a newer app version...');
        let info;
        try {
          info = await checkForUpdate();
        } catch (err) {
          setBusy(null);
          setStatus(`Update check failed: ${err.message}`, 'bad');
          Toast.error('Update check failed: ' + err.message);
          return;
        }

        if (!info.available) {
          setBusy(null);
          setStatus(`You're on the latest version (${info.currentVersion || 'unknown'}).`, 'good', 5000);
          return;
        }

        setBusy('Downloading');
        setStatus(`Update available (v${info.latestVersion}) - downloading...`);
        try {
          await downloadAndInstall(info.downloadUrl, ({ percent }) => {
            setStatus(
              percent === null
                ? `Update available (v${info.latestVersion}) - downloading...`
                : `Update available (v${info.latestVersion}) - downloading ${percent}%...`
            );
          });
          // Android's package installer is now on screen (or about to be).
          // Nothing further for this page to do or wait on.
          setBusy(null);
          setStatus(`Downloaded v${info.latestVersion}. Confirm the install in the Android dialog.`, 'good');
        } catch (err) {
          setBusy(null);
          setStatus(`Download failed: ${err.message}. You can still install it manually from the release page.`, 'bad');
          Toast.error('Update download failed: ' + err.message);
        }
      };
    }
  }
}

/* js/ui/components/onboardingWizard.js - First-run setup wizard
   ============================================================================
   Shown once (js/app.js's init(), gated by js/storage/onboardingStore.js)
   after the app's normal shell has rendered - it's an overlay on top of the
   already-mounted characters view, not a separate route. Re-openable anytime
   from Settings -> Data ("Run Setup Wizard Again").

   Three required steps (Proxy -> Model -> Persona) walk the user through the
   exact same data the app already seeds empty defaults for on first boot
   (see js/storage/db.js's initDatabase()) - this wizard EDITS those seeded
   records in place (same ids) rather than creating new ones, so finishing it
   twice, or skipping straight to Settings instead, never produces duplicates.
   A 4th optional/recommended step exposes three settings that live elsewhere
   in the app (MCPStore's Immersive Roleplay + intensity + Embed HTML,
   ProxyStore's generationSettings.unlimitedTokens) - each toggle writes
   immediately on change, same as their "real" home views, so this step has
   nothing to commit on Next/Back.

   Desktop: a large centered floating card over a dimmed backdrop.
   Mobile: a fullscreen slide-by-slide takeover (see the mobile block in
   css/components.css) - one step fully occupies the screen at a time, with a
   directional slide/fade transition between them, closer to a slideshow than
   a form.
   ============================================================================ */
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';
import { dropdownHTML, wireDropdown } from './dropdown.js';
import { toggleRowHTML } from './toggle.js';
import { renderAvatarPickerHTML, wireAvatarPicker } from './avatarPicker.js';
import { Toast } from './toast.js';
import { ProxyStore } from '../../storage/proxyStore.js';
import { PersonaStore } from '../../storage/personaStore.js';
import { MCPStore } from '../../storage/mcpStore.js';
import { OnboardingStore } from '../../storage/onboardingStore.js';
import { ProviderManager } from '../../services/providerManager.js';
import { APP_CONFIG } from '../../config.js';

// `seedId` matches the id of one of js/config.js's APP_CONFIG.DEFAULT_PROXIES
// entries (so committing this step edits that seeded, empty-key placeholder
// in place) - `null` for providers with no seeded default (Anthropic isn't
// one of the four DEFAULT_PROXIES entries), which just creates a fresh one.
const PROVIDER_META = {
  openrouter: { seedId: 'openrouter-default', label: 'OpenRouter', hint: 'Multi-model router' },
  gemini: { seedId: 'gemini-default', label: 'Google Gemini', hint: 'generateContent API' },
  openai: { seedId: 'openai-default', label: 'OpenAI Direct', hint: 'Chat Completions API' },
  anthropic: { seedId: null, label: 'Anthropic Claude', hint: '/v1/messages API', baseUrl: 'https://api.anthropic.com', exampleModel: 'claude-3-5-sonnet-20241022' },
  custom: { seedId: 'ollama-local', label: 'Custom / Ollama Local', hint: 'Any OpenAI-compatible endpoint' }
};

const STEP_IDS = ['welcome', 'proxy', 'model', 'persona', 'optional', 'done'];

// Welcome/Done are the only two steps with no form of their own to anchor
// on, so they get a badge instead - the app's OWN icon (src/icon.png)
// shown plain, no frame/gradient/background wrapper (tried a boot-splash-
// style gradient square first; the clash with the icon's own pixel-art
// palette was the whole complaint).
const STEP_BADGE_HTML =
  '<div class="onboarding-step-icon"><img src="src/icon.png" alt="NnzRP Icon"></div>';

let activeOverlay = null;
let state = null;

function presetFor(providerKey) {
  const meta = PROVIDER_META[providerKey] || PROVIDER_META.openrouter;
  const seed = meta.seedId ? APP_CONFIG.DEFAULT_PROXIES.find(p => p.id === meta.seedId) : null;
  return {
    ...meta,
    baseUrl: meta.baseUrl || seed?.baseUrl || '',
    exampleModel: meta.exampleModel || seed?.selectedModel || '',
    seedApiKey: seed?.apiKey || ''
  };
}

/** Called once at boot (js/app.js) - shows the wizard only if never completed. */
export async function maybeShowOnboardingWizard() {
  const done = await OnboardingStore.getCompleted().catch(() => true);
  if (!done) await showOnboardingWizard();
}

/** Also exported directly for settingsView.js's "Run Setup Wizard Again". */
export async function showOnboardingWizard() {
  closeWizard();

  state = { stepIndex: 0, provider: 'openrouter', proxyId: null };

  const overlay = document.createElement('div');
  overlay.className = 'onboarding-overlay';
  overlay.innerHTML = `
    <div class="onboarding-window">
      <div class="onboarding-progress" id="onboarding-progress"></div>
      <div class="onboarding-slide" id="onboarding-slide"></div>
      <div class="onboarding-footer">
        <button type="button" class="btn btn-secondary btn-sm" id="onboarding-skip">Skip Setup</button>
        <div class="onboarding-footer-nav">
          <button type="button" class="btn btn-secondary" id="onboarding-back">Back</button>
          <button type="button" class="btn btn-primary" id="onboarding-next">Next</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activeOverlay = overlay;

  overlay.querySelector('#onboarding-skip').onclick = async () => {
    await OnboardingStore.setCompleted(true);
    Toast.info('You can finish setup anytime from Settings > Data.');
    closeWizard();
  };
  overlay.querySelector('#onboarding-back').onclick = () => go(-1);

  await renderStep(0, 'none');
}

function closeWizard() {
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
  state = null;
}

async function go(direction) {
  const nextIndex = state.stepIndex + direction;
  if (nextIndex < 0 || nextIndex >= STEP_IDS.length) return;

  if (direction > 0) {
    const ok = await commitStep(STEP_IDS[state.stepIndex]);
    if (!ok) return;
  }

  state.stepIndex = nextIndex;
  await renderStep(state.stepIndex, direction > 0 ? 'forward' : 'back');
}

async function finish() {
  await OnboardingStore.setCompleted(true);
  Toast.success('Setup complete - have fun!');
  closeWizard();
}

async function renderStep(index, direction) {
  const stepId = STEP_IDS[index];
  const slideEl = activeOverlay.querySelector('#onboarding-slide');

  switch (stepId) {
    case 'welcome': await renderWelcomeStep(slideEl); break;
    case 'proxy': await renderProxyStep(slideEl); break;
    case 'model': await renderModelStep(slideEl); break;
    case 'persona': await renderPersonaStep(slideEl); break;
    case 'optional': await renderOptionalStep(slideEl); break;
    case 'done': await renderDoneStep(slideEl); break;
  }

  updateChrome(index);

  // Directional enter animation - removed/re-added (with a reflow between)
  // so replaying the SAME class on consecutive same-direction steps still
  // restarts the animation instead of a no-op class toggle.
  slideEl.classList.remove('onboarding-slide-enter-fwd', 'onboarding-slide-enter-back');
  void slideEl.offsetWidth;
  if (direction === 'forward') slideEl.classList.add('onboarding-slide-enter-fwd');
  else if (direction === 'back') slideEl.classList.add('onboarding-slide-enter-back');
}

function updateChrome(index) {
  const backBtn = activeOverlay.querySelector('#onboarding-back');
  const nextBtn = activeOverlay.querySelector('#onboarding-next');
  const skipBtn = activeOverlay.querySelector('#onboarding-skip');
  const progressEl = activeOverlay.querySelector('#onboarding-progress');
  const isLast = index === STEP_IDS.length - 1;

  // A class, not an inline style - visibility:hidden still reserves its
  // layout box, which is exactly right for the desktop footer (Back/Skip
  // sit in a fixed side-by-side arrangement, so their absence shouldn't
  // reflow Next) but wrong for the mobile footer (a hidden-but-space-
  // reserving Back button left Next looking shoved off-centre instead of
  // truly full-width). css/components.css's mobile block overrides this
  // same class to display:none instead, so each layout gets the behavior
  // that's actually correct for it.
  backBtn.classList.toggle('onboarding-btn-hidden', index === 0);
  skipBtn.classList.toggle('onboarding-btn-hidden', isLast);
  // Mobile-only (see css/components.css's mobile block): Skip only shows on
  // the very first slide, styled as small plain text rather than a button -
  // once you've committed to "Get Started" it's no longer offered on every
  // subsequent slide. Desktop is untouched by this class (still shows Skip
  // as a real button through every step except the last, via the toggle
  // above).
  skipBtn.classList.toggle('onboarding-skip-not-first', index !== 0);
  nextBtn.textContent = isLast ? 'Start Roleplaying' : index === 0 ? 'Get Started' : 'Next';
  nextBtn.onclick = isLast ? finish : () => go(1);

  progressEl.innerHTML = STEP_IDS.map((_, i) => `
    <span class="onboarding-dot${i === index ? ' active' : ''}${i < index ? ' done' : ''}"></span>
  `).join('');
}

async function commitStep(stepId) {
  const slideEl = activeOverlay.querySelector('#onboarding-slide');
  switch (stepId) {
    case 'proxy': return commitProxyStep(slideEl);
    case 'model': return commitModelStep(slideEl);
    case 'persona': return commitPersonaStep(slideEl);
    default: return true;
  }
}

/* ============================ Welcome / Done ============================ */

async function renderWelcomeStep(slideEl) {
  slideEl.innerHTML = `
    <div class="onboarding-step onboarding-step-center">
      ${STEP_BADGE_HTML}
      <h2>Welcome to NnzRP</h2>
      <p class="onboarding-step-desc">Let's get you set up - an AI provider, a model, and who you'll be in the story. About a minute, and every bit of it stays changeable later.</p>
    </div>
  `;
}

async function renderDoneStep(slideEl) {
  slideEl.innerHTML = `
    <div class="onboarding-step onboarding-step-center">
      ${STEP_BADGE_HTML}
      <h2>All set</h2>
      <p class="onboarding-step-desc">Pick a character from the library and start the scene. Revisit any of this later from Settings, Personas, or the Custom MCP page.</p>
    </div>
  `;
}

/* ================================ Proxy ================================= */

async function renderProxyStep(slideEl) {
  const meta = PROVIDER_META[state.provider];
  const seed = meta.seedId ? await ProxyStore.getById(meta.seedId) : (state.proxyId ? await ProxyStore.getById(state.proxyId) : null);
  const preset = presetFor(state.provider);
  const currentApiKey = seed?.apiKey || '';
  const currentBaseUrl = seed?.baseUrl || preset.baseUrl;

  slideEl.innerHTML = `
    <div class="onboarding-step">
      <div class="onboarding-step-eyebrow">Step 1 of 3 &middot; Required</div>
      <h2>Connect an AI provider</h2>
      <p class="onboarding-step-desc">Bring your own API key - NnzRP talks to the provider directly, nothing passes through a middleman.</p>

      <div class="form-group">
        <label class="form-label">Provider</label>
        ${dropdownHTML({
          id: 'onboarding-provider',
          value: state.provider,
          options: Object.entries(PROVIDER_META).map(([value, m]) => ({ value, label: m.label, hint: m.hint }))
        })}
      </div>
      <div class="form-group">
        <label class="form-label">API Key (BYOK)</label>
        <input class="input" type="password" id="onboarding-apikey" value="${escapeAttr(currentApiKey)}" placeholder="sk-...">
        <span class="form-hint">Leave blank for now if you're just exploring - a local Ollama server doesn't need one.</span>
      </div>
      <div class="form-group">
        <label class="form-label">Base API Endpoint URL</label>
        <input class="input" id="onboarding-baseurl" value="${escapeAttr(currentBaseUrl)}">
      </div>
      <div style="display:flex; align-items:center; gap:0.75rem;">
        <button type="button" class="btn btn-secondary btn-sm" id="onboarding-test-connection">Test Connection</button>
        <span id="onboarding-test-result" class="form-hint" style="margin:0;"></span>
      </div>
    </div>
  `;

  wireDropdown(slideEl, 'onboarding-provider', (value) => {
    state.provider = value;
    const nextPreset = presetFor(value);
    slideEl.querySelector('#onboarding-baseurl').value = nextPreset.baseUrl;
    slideEl.querySelector('#onboarding-apikey').value = nextPreset.seedApiKey;
    slideEl.querySelector('#onboarding-test-result').textContent = '';
  });

  slideEl.querySelector('#onboarding-test-connection').onclick = async () => {
    const resultEl = slideEl.querySelector('#onboarding-test-result');
    resultEl.textContent = 'Testing...';
    resultEl.style.color = 'var(--text-muted)';
    const providerVal = document.getElementById('onboarding-provider').value;
    const res = await ProviderManager.testConnection({
      name: PROVIDER_META[providerVal]?.label || providerVal,
      provider: providerVal,
      baseUrl: slideEl.querySelector('#onboarding-baseurl').value.trim(),
      apiKey: slideEl.querySelector('#onboarding-apikey').value.trim(),
      selectedModel: presetFor(providerVal).exampleModel
    });
    resultEl.textContent = res.message;
    resultEl.style.color = res.success ? 'var(--accent-emerald)' : 'var(--accent-rose)';
  };
}

async function commitProxyStep(slideEl) {
  const provider = document.getElementById('onboarding-provider').value || 'openrouter';
  const apiKey = slideEl.querySelector('#onboarding-apikey').value.trim();
  const baseUrl = slideEl.querySelector('#onboarding-baseurl').value.trim();
  const meta = PROVIDER_META[provider];
  const preset = presetFor(provider);

  const existing = meta.seedId
    ? await ProxyStore.getById(meta.seedId)
    : (state.proxyId ? await ProxyStore.getById(state.proxyId) : null);

  const saved = await ProxyStore.save({
    ...(existing || {}),
    id: existing?.id,
    name: existing?.name || meta.label,
    provider,
    baseUrl: baseUrl || preset.baseUrl,
    apiKey,
    selectedModel: existing?.selectedModel || preset.exampleModel,
    isDefault: true
  });

  state.proxyId = saved.id;
  state.provider = provider;
  return true;
}

/* ================================ Model ================================= */

async function renderModelStep(slideEl) {
  const proxy = state.proxyId ? await ProxyStore.getById(state.proxyId) : null;
  const preset = presetFor(state.provider);
  const currentModel = proxy?.selectedModel || preset.exampleModel;

  slideEl.innerHTML = `
    <div class="onboarding-step">
      <div class="onboarding-step-eyebrow">Step 2 of 3 &middot; Required</div>
      <h2>Pick a model</h2>
      <p class="onboarding-step-desc">Which model on ${escapeHtml(PROVIDER_META[state.provider].label)} should your characters use? You can add more and switch anytime from the chat composer.</p>
      <div class="form-group">
        <label class="form-label">Model ID</label>
        <input class="input" id="onboarding-model" value="${escapeAttr(currentModel)}" placeholder="${escapeAttr(preset.exampleModel)}">
        <span class="form-hint">Example: <code>${escapeHtml(preset.exampleModel)}</code></span>
      </div>
    </div>
  `;
}

async function commitModelStep(slideEl) {
  if (!state.proxyId) return true;
  const preset = presetFor(state.provider);
  const modelId = slideEl.querySelector('#onboarding-model').value.trim() || preset.exampleModel;
  const existing = await ProxyStore.getById(state.proxyId);
  if (existing) await ProxyStore.save({ ...existing, selectedModel: modelId });
  return true;
}

/* =============================== Persona ================================ */

async function renderPersonaStep(slideEl) {
  const persona = await PersonaStore.getDefault() || { name: '', avatar: '', description: '' };

  slideEl.innerHTML = `
    <div class="onboarding-step">
      <div class="onboarding-step-eyebrow">Step 3 of 3 &middot; Required</div>
      <h2>Who are you in the story?</h2>
      <p class="onboarding-step-desc">Your persona - how characters see and address you.</p>
      <div class="form-group">
        <label class="form-label">Name *</label>
        <input class="input" id="onboarding-persona-name" value="${escapeAttr(persona.name)}" required>
      </div>
      ${renderAvatarPickerHTML('onboarding-persona-avatar', persona.avatar)}
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label">Short Description</label>
        <textarea class="textarea" id="onboarding-persona-desc" style="min-height:80px;">${escapeHtml(persona.description || '')}</textarea>
      </div>
    </div>
  `;

  wireAvatarPicker(slideEl, 'onboarding-persona-avatar');
}

async function commitPersonaStep(slideEl) {
  const name = slideEl.querySelector('#onboarding-persona-name').value.trim();
  if (!name) {
    Toast.error('Give your persona a name first.');
    return false;
  }
  const avatar = slideEl.querySelector('#onboarding-persona-avatar').value.trim();
  const description = slideEl.querySelector('#onboarding-persona-desc').value.trim();
  const existing = await PersonaStore.getDefault();

  await PersonaStore.save({
    ...(existing || {}),
    id: existing?.id,
    name,
    avatar,
    description,
    isDefault: true
  });
  return true;
}

/* =============================== Optional ================================ */

async function renderOptionalStep(slideEl) {
  const [immersive, intensity, embedHtml, genSettings] = await Promise.all([
    MCPStore.getImmersiveRoleplay(),
    MCPStore.getImmersiveIntensity(),
    MCPStore.getEmbedHtmlEnabled(),
    ProxyStore.getGenerationSettings()
  ]);

  slideEl.innerHTML = `
    <div class="onboarding-step">
      <div class="onboarding-step-eyebrow">Optional &middot; Recommended</div>
      <h2>Fine-tune the experience</h2>
      <p class="onboarding-step-desc">Nothing here is required - the defaults are safe. All of it stays changeable later from Settings and the Custom MCP page.</p>

      ${toggleRowHTML({
        id: 'onboarding-immersive',
        checked: !!immersive,
        title: 'Immersive Roleplay',
        description: 'Characters reach for connected tools proactively and in-character instead of waiting to be asked. Only matters once you connect an MCP tool server.'
      })}
      <div id="onboarding-intensity-row" style="margin:0.85rem 0 0; padding-top:0.85rem; border-top:1px solid var(--border-light); opacity:${immersive ? '1' : '0.5'}; pointer-events:${immersive ? '' : 'none'};">
        <div class="form-label" style="margin-bottom:0.5rem;">Tool Use Frequency</div>
        <div class="segmented" role="group" id="onboarding-intensity-group">
          <button type="button" class="segmented-option${intensity === 'medium' ? ' active' : ''}" data-value="medium">Medium</button>
          <button type="button" class="segmented-option${intensity === 'high' ? ' active' : ''}" data-value="high">High</button>
          <button type="button" class="segmented-option${intensity === 'max' ? ' active' : ''}" data-value="max">MAX</button>
        </div>
      </div>

      <div style="border-top:1px solid var(--border-light); padding-top:1rem; margin-top:1rem;">
        ${toggleRowHTML({
          id: 'onboarding-embed-html',
          checked: !!embedHtml,
          title: 'Embed HTML (Experimental)',
          description: 'Lets characters render small HTML/JS/CSS snippets inline in chat - sandboxed, but it means AI-authored script actually runs. Off by default for a reason.'
        })}
      </div>

      <div style="border-top:1px solid var(--border-light); padding-top:1rem; margin-top:1rem;">
        ${toggleRowHTML({
          id: 'onboarding-unlimited-tokens',
          checked: !!genSettings.unlimitedTokens,
          title: 'Unlimited Response Length',
          description: "Use the highest output length each provider allows instead of a fixed cap - prevents long replies or thinking from being cut off mid-way."
        })}
      </div>
    </div>
  `;

  const intensityRow = slideEl.querySelector('#onboarding-intensity-row');
  const immersiveToggle = slideEl.querySelector('#onboarding-immersive');
  immersiveToggle.onchange = async (e) => {
    await MCPStore.setImmersiveRoleplay(e.target.checked);
    intensityRow.style.opacity = e.target.checked ? '1' : '0.5';
    intensityRow.style.pointerEvents = e.target.checked ? '' : 'none';
  };

  slideEl.querySelectorAll('#onboarding-intensity-group .segmented-option').forEach(btn => {
    btn.onclick = async () => {
      await MCPStore.setImmersiveIntensity(btn.dataset.value);
      slideEl.querySelectorAll('#onboarding-intensity-group .segmented-option').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
    };
  });

  slideEl.querySelector('#onboarding-embed-html').onchange = (e) => {
    MCPStore.setEmbedHtmlEnabled(e.target.checked);
  };

  slideEl.querySelector('#onboarding-unlimited-tokens').onchange = async (e) => {
    const current = await ProxyStore.getGenerationSettings();
    await ProxyStore.saveGenerationSettings({ ...current, unlimitedTokens: e.target.checked });
  };
}

/* js/ui/views/chatView.js - Dedicated Chat Page (Response Swiping on Last Message) */
import { CharacterStore } from '../../storage/characterStore.js';
import { ChatStore } from '../../storage/chatStore.js';
import { PersonaStore } from '../../storage/personaStore.js';
import { ProxyStore } from '../../storage/proxyStore.js';
import { MCPStore } from '../../storage/mcpStore.js';
import { PromptBuilder } from '../../services/promptBuilder.js';
import { ProviderManager } from '../../services/providerManager.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { ProxiesView } from './proxiesView.js';
import { SettingsView } from './settingsView.js';
import { MCPView } from './mcpView.js';
import { escapeHtml, escapeAttr } from '../../utils/sanitize.js';
import { extractThinking } from '../../utils/thinkingParser.js';
import { replaceMacros } from '../../utils/macroReplacer.js';

// Module-level generation state - only one ChatView is ever mounted at a time
// in this SPA, so a shared abort/generating flag is simpler than threading it
// through every closure and the static swipe handlers.
let activeAbortController = null;
let isGenerating = false;

/**
 * Toggles the send button between "send" (arrow-up) and "stop" (square) look,
 * disables the composer while a generation is in flight, and locks down
 * per-message actions (edit/fork/swipe) so they can't race the request.
 */
function setGeneratingState(generating) {
  isGenerating = generating;
  const sendBtn = document.getElementById('btn-send-message');
  const sendInput = document.getElementById('chat-input');
  const messagesEl = document.getElementById('messages-container');
  if (!sendBtn) return;

  if (generating) {
    sendBtn.classList.add('generating');
    sendBtn.title = 'Stop Generation';
    sendBtn.setAttribute('aria-label', 'Stop Generation');
    sendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>';
    if (sendInput) sendInput.disabled = true;
    if (messagesEl) messagesEl.classList.add('generating-lock');
  } else {
    sendBtn.classList.remove('generating');
    sendBtn.title = 'Send Message';
    sendBtn.setAttribute('aria-label', 'Send Message');
    sendBtn.innerHTML = '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>';
    if (sendInput) sendInput.disabled = false;
    if (messagesEl) messagesEl.classList.remove('generating-lock');
  }
}

// Remembers user preference for collapsing thinking blocks.
// If the user collapses any thinking block, subsequent thinking blocks start collapsed.
let isThinkingCollapsedDefault = localStorage.getItem('aetheria_thinking_collapsed') === '1';

/**
 * Estimates token count for thinking text (~3.8 chars per token).
 */
function estimateThinkingTokens(thinkingText = '') {
  if (!thinkingText || !thinkingText.trim()) return 0;
  return Math.max(1, Math.ceil(thinkingText.trim().length / 3.8));
}

/**
 * Robust helper to scroll the chat container to bottom.
 */
function scrollToBottom(containerEl) {
  const el = containerEl || document.getElementById('messages-container');
  if (!el) return;
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
  });
}

/**
 * Creates/updates/removes a message's collapsible thinking block to match
 * `thinkingText`, live during streaming or as a final sync after generation.
 * Includes real-time thinking token counter.
 */
function syncThinkingBlock(containerEl, thinkingText, { streaming = false } = {}) {
  if (!containerEl) return;
  const contentEl = containerEl.querySelector('.message-content');
  let block = containerEl.querySelector('.thinking-block');

  if (!thinkingText || !thinkingText.trim()) {
    if (block) block.remove();
    return;
  }

  const tokenCount = estimateThinkingTokens(thinkingText);

  if (!block) {
    block = document.createElement('div');
    block.className = `thinking-block ${isThinkingCollapsedDefault ? '' : 'expanded'}`.trim();
    block.innerHTML = `
      <button class="thinking-toggle" type="button">
        <svg class="thinking-chevron" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>
        <span>Thinking</span>
        <span class="thinking-token-badge">${tokenCount.toLocaleString()} tokens</span>
      </button>
      <div class="thinking-content"></div>
    `;
    block.querySelector('.thinking-toggle').onclick = () => {
      const isExpanded = block.classList.toggle('expanded');
      isThinkingCollapsedDefault = !isExpanded;
      localStorage.setItem('aetheria_thinking_collapsed', isThinkingCollapsedDefault ? '1' : '0');
    };
    if (contentEl) containerEl.insertBefore(block, contentEl);
    else containerEl.appendChild(block);
  }

  const textEl = block.querySelector('.thinking-content');
  textEl.textContent = thinkingText;

  const tokenBadgeEl = block.querySelector('.thinking-token-badge');
  if (tokenBadgeEl) {
    tokenBadgeEl.textContent = `${tokenCount.toLocaleString()} tokens`;
  }

  if (block.classList.contains('expanded')) {
    textEl.scrollTop = textEl.scrollHeight;
  }
}

/**
 * When prefill is enabled, appends a trailing assistant-role message to the
 * prompt payload so the model continues writing from that seed text instead
 * of starting fresh - useful for style reminders or nudging the model into
 * an opening <think> block.
 */
function applyPrefill(genSettings, promptPayload) {
  if (genSettings.prefillEnabled && genSettings.prefillText) {
    return [...promptPayload, { role: 'assistant', content: genSettings.prefillText }];
  }
  return promptPayload;
}

/**
 * Merges the prefill seed text back onto the model's continuation and
 * re-splits thinking/content, so a prefill like "<think>\n" that the model
 * later closes with "</think>" is recognized as a complete thinking block
 * once combined - not two disconnected loose fragments.
 */
function mergePrefillResult(genSettings, result) {
  if (!genSettings.prefillEnabled || !genSettings.prefillText) return result;
  const combined = genSettings.prefillText + result.content;
  const { thinking: extraThinking, content } = extractThinking(combined);
  const thinking = [result.thinking, extraThinking].filter(Boolean).join('\n\n');
  return { content, thinking };
}

export class ChatView {
  static async render(container, activeCharacterId = null, callbacks = {}) {
    const { onBack, onProxyChanged } = callbacks;
    const characters = await CharacterStore.getAll();
    if (characters.length === 0) {
      container.innerHTML = `
        <div style="padding:4rem 2rem; text-align:center; max-width:500px; margin:0 auto;">
          <h3 style="margin-bottom:0.5rem;">Belum ada Karakter AI</h3>
          <p style="color:var(--text-muted); margin-bottom:1.5rem;">Silakan buat karakter baru terlebih dahulu di menu <strong>AI Characters</strong>.</p>
        </div>
      `;
      return;
    }

    // activeCharacterId can come from a restored URL hash and point at a
    // character that no longer exists - fall back to the first character.
    let selectedCharId = activeCharacterId && characters.some(c => c.id === activeCharacterId)
      ? activeCharacterId
      : characters[0].id;
    const activeChar = await CharacterStore.getById(selectedCharId);
    let sessions = await ChatStore.getChatsByCharacter(selectedCharId);

    // Creates a chat AND immediately persists the character's greeting as the
    // first assistant message, instead of only rendering it virtually when
    // there are zero stored messages - that virtual-only greeting used to
    // vanish from the message list the moment the first real message got sent.
    const createChatWithGreeting = async (personaId, title) => {
      const chat = await ChatStore.createChat(selectedCharId, personaId, title);
      if (activeChar.first_mes) {
        const personaObj = personaId ? await PersonaStore.getById(personaId) : await PersonaStore.getDefault();
        const userName = personaObj?.name || 'User';
        const charName = activeChar.name || 'Character';
        const startMsg = replaceMacros(activeChar.first_mes, userName, charName);
        await ChatStore.addMessage(chat.id, 'assistant', startMsg, '', [startMsg]);
      }
      return chat;
    };

    // Auto-create initial session if none exists
    if (sessions.length === 0) {
      const defaultPersona = await PersonaStore.getDefault();
      const newSession = await createChatWithGreeting(defaultPersona?.id, `Session 1 - ${activeChar.name}`);
      sessions = [newSession];
    }

    let currentChatId = sessions[0].id;

    container.innerHTML = `
      <div class="chat-layout">
        <!-- Dedicated Chat Workspace -->
        <div class="chat-workspace">
          <!-- Top Header Bar (Centered 880px Reading Column) -->
          <div class="chat-header">
            <div class="chat-header-inner">
              <div style="display:flex; align-items:center; gap:0.5rem;">
                <button class="btn-chat-back-icon" id="btn-chat-back" title="Back to Main Dashboard" aria-label="Back to Main Dashboard">
                  <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
                </button>

                <div class="character-header-info" id="btn-char-info-header" title="Click for Character Details">
                  <img src="${escapeAttr(activeChar.avatar)}" class="avatar-img" onerror="this.src='https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(activeChar.name)}'">
                  <div>
                    <div class="character-header-name">${escapeHtml(activeChar.name)}</div>
                    <div class="character-header-tagline">${escapeHtml(activeChar.tagline) || 'AI Roleplay Partner'}</div>
                  </div>
                </div>
              </div>

              <!-- Right Button Aligned with Central Chat Column -->
              <button class="btn btn-secondary btn-sm" id="btn-open-right-drawer" title="Config & Chat Sessions (Keybind: Ctrl+.)">
                <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path></svg>
                <span>Config</span>
              </button>
            </div>
          </div>

          <!-- Messages Stream Container (Per-Block Story Layout) -->
          <div class="messages-container" id="messages-container"></div>

          <!-- Chat Input Container (Clean Floating Box) -->
          <div class="chat-input-container">
            <div class="chat-input-wrapper">
              <textarea class="chat-textarea" id="chat-input" rows="2" placeholder="Type action (*looks around*) or dialogue (&quot;Hello...&quot;)... (Shift+Enter for new line)"></textarea>
              <div class="chat-input-toolbar" style="justify-content:flex-end;">
                <button class="btn-send-icon" id="btn-send-message" title="Send Message" aria-label="Send Message">
                  <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Slide-over Right Drawer with Separate Tabs for Chat Sessions & Options -->
        <div class="chat-right-drawer-overlay hidden" id="right-drawer-overlay">
          <div class="chat-right-drawer-content">
            <div class="drawer-tab-header">
              <div class="drawer-tab active" id="tab-btn-sessions">Sessions</div>
              <div class="drawer-tab" id="tab-btn-options">Options</div>
              <div class="drawer-tab" id="tab-btn-mcp">MCP (Exp)</div>
              <button class="btn-icon" id="btn-close-right-drawer" style="margin-right:0.5rem;" title="Close (Esc)">&times;</button>
            </div>

            <!-- Tab 1 Content: Chat Sessions -->
            <div class="drawer-body" id="tab-content-sessions">
              <button class="btn btn-primary btn-sm" id="btn-new-session" style="width:100%;">
                + New Chat Session
              </button>
              <div id="right-drawer-session-list" style="display:flex; flex-direction:column; gap:0.6rem;"></div>
            </div>

            <!-- Tab 2 Content: Chat Options -->
            <div class="drawer-body hidden" id="tab-content-options">
              <!-- Player Persona Switcher -->
              <div class="form-group">
                <label class="form-label">Player Persona</label>
                <select class="select" id="drawer-persona-select"></select>
              </div>

              <!-- AI Proxy Switcher -->
              <div class="form-group">
                <label class="form-label">Active AI Proxy</label>
                <select class="select" id="drawer-proxy-select"></select>
              </div>

              <!-- System Prompt Preset Switcher -->
              <div class="form-group">
                <label class="form-label">System Prompt Preset</label>
                <select class="select" id="drawer-preset-select"></select>
              </div>

              <!-- Chat Font Size Selector -->
              <div class="form-group">
                <label class="form-label">Chat Text Size</label>
                <div style="display:flex; gap:0.4rem;" id="drawer-font-size-group">
                  <button class="btn btn-secondary btn-sm btn-font-opt" data-size="small" style="flex:1;">Small</button>
                  <button class="btn btn-secondary btn-sm btn-font-opt" data-size="medium" style="flex:1;">Medium</button>
                  <button class="btn btn-secondary btn-sm btn-font-opt" data-size="big" style="flex:1;">Big</button>
                </div>
              </div>

              <!-- Quick Config Shortcuts -->
              <div style="display:flex; flex-direction:column; gap:0.5rem; margin-top:0.25rem;">
                <button class="btn btn-secondary btn-sm" id="btn-open-proxies-config" style="width:100%;">Multi-Proxy Config</button>
                <button class="btn btn-secondary btn-sm" id="btn-open-global-settings" style="width:100%;">Global Settings</button>
              </div>

              <!-- Character Summary Card -->
              <div class="card" style="padding:1rem; font-size:0.85rem;">
                <div style="font-weight:700; font-size:0.95rem; margin-bottom:0.2rem;">${escapeHtml(activeChar.name)}</div>
                <div style="color:var(--text-accent); font-size:0.78rem; margin-bottom:0.5rem;">${escapeHtml(activeChar.tagline) || ''}</div>
                <p style="color:var(--text-muted); font-size:0.82rem; margin-bottom:0.75rem;">${escapeHtml(activeChar.description) || 'No description provided.'}</p>
                <button class="btn btn-secondary btn-sm" id="btn-view-char-details" style="width:100%;">View Full Details</button>
              </div>

              <div style="border-top:1px solid var(--border-light); padding-top:1rem; margin-top:auto;">
                <button class="btn btn-danger btn-sm" id="btn-delete-current-session" style="width:100%;">
                  Delete Current Session
                </button>
              </div>
            </div>

            <!-- Tab 3 Content: Custom MCP Tools (Experimental) -->
            <div class="drawer-body hidden" id="tab-content-mcp">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                <div style="font-weight:700; font-size:0.9rem;">Active MCP Servers</div>
                <button class="btn btn-secondary btn-sm" id="btn-drawer-manage-mcp">Manage All MCP</button>
              </div>
              <p style="color:var(--text-muted); font-size:0.78rem; margin-bottom:1rem;">
                Toggle custom MCP tools ON/OFF for this roleplay session.
              </p>
              <div id="drawer-mcp-list" style="display:flex; flex-direction:column; gap:0.6rem;"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Drawer Overlay & Tab Logic
    const drawerOverlay = container.querySelector('#right-drawer-overlay');
    const openDrawerBtn = container.querySelector('#btn-open-right-drawer');
    const closeDrawerBtn = container.querySelector('#btn-close-right-drawer');

    const tabSessionsBtn = container.querySelector('#tab-btn-sessions');
    const tabOptionsBtn = container.querySelector('#tab-btn-options');
    const tabMcpBtn = container.querySelector('#tab-btn-mcp');
    const tabSessionsContent = container.querySelector('#tab-content-sessions');
    const tabOptionsContent = container.querySelector('#tab-content-options');
    const tabMcpContent = container.querySelector('#tab-content-mcp');

    const switchTab = (targetTab) => {
      tabSessionsBtn.classList.toggle('active', targetTab === 'sessions');
      tabOptionsBtn.classList.toggle('active', targetTab === 'options');
      tabMcpBtn.classList.toggle('active', targetTab === 'mcp');

      tabSessionsContent.classList.toggle('hidden', targetTab !== 'sessions');
      tabOptionsContent.classList.toggle('hidden', targetTab !== 'options');
      tabMcpContent.classList.toggle('hidden', targetTab !== 'mcp');
    };

    tabSessionsBtn.onclick = () => switchTab('sessions');
    tabOptionsBtn.onclick = () => switchTab('options');
    tabMcpBtn.onclick = () => switchTab('mcp');

    openDrawerBtn.onclick = () => {
      drawerOverlay.classList.remove('hidden');
    };

    closeDrawerBtn.onclick = () => {
      drawerOverlay.classList.add('hidden');
    };

    drawerOverlay.onclick = (e) => {
      if (e.target === drawerOverlay) {
        drawerOverlay.classList.add('hidden');
      }
    };

    // Toggle keybind: Ctrl+. or Cmd+. or Alt+C or Esc
    const handleKeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '.') {
        e.preventDefault();
        drawerOverlay.classList.toggle('hidden');
      } else if (e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        drawerOverlay.classList.toggle('hidden');
      } else if (e.key === 'Escape' && !drawerOverlay.classList.contains('hidden')) {
        drawerOverlay.classList.add('hidden');
      }
    };
    window.addEventListener('keydown', handleKeydown);

    // Back Button Handler
    const backBtn = container.querySelector('#btn-chat-back');
    if (backBtn && onBack) {
      backBtn.onclick = () => {
        window.removeEventListener('keydown', handleKeydown);
        onBack();
      };
    }

    // Populate Select Options in Opsi Tab
    const populateDrawerSelects = async () => {
      const personas = await PersonaStore.getAll();
      const currentPersona = await PersonaStore.getDefault();
      const personaSelect = container.querySelector('#drawer-persona-select');
      personaSelect.innerHTML = personas.map(p => `<option value="${p.id}" ${currentPersona && currentPersona.id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');

      personaSelect.onchange = async (e) => {
        const persona = await PersonaStore.getById(e.target.value);
        if (persona) {
          persona.isDefault = true;
          await PersonaStore.save(persona);
          Toast.success(`Persona diset ke: ${persona.name}`);
          await renderMessages();
        }
      };

      const proxies = await ProxyStore.getAll();
      const currentProxy = await ProxyStore.getDefault();
      const proxySelect = container.querySelector('#drawer-proxy-select');
      proxySelect.innerHTML = proxies.map(p => `<option value="${p.id}" ${currentProxy && currentProxy.id === p.id ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.selectedModel || p.provider)})</option>`).join('');

      proxySelect.onchange = async (e) => {
        const proxy = await ProxyStore.getById(e.target.value);
        if (proxy) {
          proxy.isDefault = true;
          await ProxyStore.save(proxy);
          Toast.success(`Active Proxy: ${proxy.name}`);
          if (onProxyChanged) onProxyChanged();
        }
      };

      // System Prompt Presets
      const presets = await ProxyStore.getSystemPromptPresets();
      const presetSelect = container.querySelector('#drawer-preset-select');
      if (presetSelect) {
        presetSelect.innerHTML = `<option value="">-- Select System Prompt Preset --</option>` +
          presets.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

        presetSelect.onchange = async (e) => {
          const selectedId = e.target.value;
          const targetPreset = presets.find(p => p.id === selectedId);
          if (targetPreset) {
            await ProxyStore.saveGlobalSystemPrompt(targetPreset.content);
            Toast.success(`Preset System Prompt diset: ${targetPreset.name}`);
          }
        };
      }

      // Font Size Buttons
      const genSettings = await ProxyStore.getGenerationSettings();
      const currentFontSize = genSettings.fontSize || 'medium';
      const messagesEl = container.querySelector('#messages-container');
      if (messagesEl) {
        messagesEl.className = 'messages-container font-' + currentFontSize;
      }

      const fontBtns = container.querySelectorAll('.btn-font-opt');
      fontBtns.forEach(btn => {
        if (btn.dataset.size === currentFontSize) {
          btn.classList.add('btn-primary');
          btn.classList.remove('btn-secondary');
        } else {
          btn.classList.remove('btn-primary');
          btn.classList.add('btn-secondary');
        }

        btn.onclick = async () => {
          const newSize = btn.dataset.size;
          genSettings.fontSize = newSize;
          await ProxyStore.saveGenerationSettings(genSettings);

          fontBtns.forEach(b => {
            b.classList.remove('btn-primary');
            b.classList.add('btn-secondary');
          });
          btn.classList.add('btn-primary');
          btn.classList.remove('btn-secondary');

          if (messagesEl) {
            messagesEl.className = 'messages-container font-' + newSize;
          }
          Toast.success(`Ukuran teks diset: ${newSize.toUpperCase()}`);
        };
      });
    };

    const renderDrawerMCPList = async () => {
      const mcpListEl = container.querySelector('#drawer-mcp-list');
      if (!mcpListEl) return;
      const servers = await MCPStore.getAll();

      if (servers.length === 0) {
        mcpListEl.innerHTML = `
          <div style="padding:1rem; text-align:center; background:#ffffff; border-radius:var(--radius-md); border:1px dashed var(--border-light); font-size:0.82rem; color:var(--text-muted);">
            <div>Belum ada Custom MCP Server.</div>
            <div style="display:flex; justify-content:center; gap:0.4rem; margin-top:0.6rem;">
              <button class="btn btn-secondary btn-sm" id="btn-drawer-json-edit">Edit JSON Config</button>
            </div>
          </div>
        `;
        const jsonBtn = mcpListEl.querySelector('#btn-drawer-json-edit');
        if (jsonBtn) {
          jsonBtn.onclick = () => {
            MCPView.openJSONEditorModal(async () => {
              await renderDrawerMCPList();
            });
          };
        }
        return;
      }

      mcpListEl.innerHTML = servers.map(s => `
        <div style="padding:0.75rem; background:#ffffff; border-radius:var(--radius-md); border:1px solid var(--border-light); font-size:0.82rem; display:flex; flex-direction:column; gap:0.4rem; box-shadow:var(--shadow-sm);">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-weight:600; color:var(--text-main);">${escapeHtml(s.name)}</div>
              <div style="font-size:0.72rem; color:var(--text-muted); font-family:var(--font-mono);">${escapeHtml(s.type.toUpperCase())}</div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" class="drawer-mcp-toggle" data-id="${s.id}" ${s.enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border-light); padding-top:0.4rem; margin-top:0.2rem;">
            <span class="badge" id="drawer-mcp-status-${s.id}" style="font-size:0.68rem; background:#f1f5f9; color:#475569;">Unknown</span>
            <button class="btn btn-secondary btn-sm drawer-check-mcp" data-id="${s.id}" style="padding:0.15rem 0.45rem; font-size:0.72rem;">Check Status</button>
          </div>
        </div>
      `).join('');

      mcpListEl.querySelectorAll('.drawer-mcp-toggle').forEach(chk => {
        chk.onchange = async (e) => {
          await MCPStore.toggleEnabled(e.target.dataset.id, e.target.checked);
          Toast.info(`MCP Tool ${e.target.checked ? 'Diaktifkan' : 'Dinonaktifkan'}.`);
        };
      });

      mcpListEl.querySelectorAll('.drawer-check-mcp').forEach(btn => {
        btn.onclick = async () => {
          const id = btn.dataset.id;
          const server = await MCPStore.getById(id);
          const badgeEl = mcpListEl.querySelector(`#drawer-mcp-status-${id}`);
          if (!server || !badgeEl) return;

          badgeEl.textContent = 'Checking...';
          badgeEl.style.background = '#fef08a';
          badgeEl.style.color = '#854d0e';

          try {
            if (!server.endpointUrl) throw new Error('No URL');
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2500);
            await fetch(server.endpointUrl, { signal: controller.signal }).catch(() => ({ ok: true }));
            clearTimeout(timeoutId);
            badgeEl.textContent = 'Available';
            badgeEl.style.background = '#dcfce7';
            badgeEl.style.color = '#166534';
          } catch (err) {
            badgeEl.textContent = 'Offline';
            badgeEl.style.background = '#fee2e2';
            badgeEl.style.color = '#991b1b';
          }
        };
      });
    };

    await populateDrawerSelects();
    await renderDrawerMCPList();

    const manageMcpBtn = container.querySelector('#btn-drawer-manage-mcp');
    if (manageMcpBtn) {
      manageMcpBtn.onclick = () => {
        const overlay = Modal.open({
          title: 'Custom MCP Servers & Tools',
          contentHTML: '<div id="embedded-mcp-view"></div>',
          buttons: [{ id: 'btn-close-mcp-modal', label: 'Tutup', className: 'btn-secondary', onClick: async () => {
            Modal.close();
            await renderDrawerMCPList();
          } }]
        });
        MCPView.render(overlay.querySelector('#embedded-mcp-view'));
      };
    }

    const showCharInfoModal = () => {
      Modal.open({
        title: `Karakter Info: ${escapeHtml(activeChar.name)}`,
        contentHTML: `
          <div style="display:flex; gap:1rem; align-items:center; margin-bottom:1rem;">
            <img src="${escapeAttr(activeChar.avatar)}" style="width:64px; height:64px; border-radius:50%; object-fit:cover;">
            <div>
              <h3>${escapeHtml(activeChar.name)}</h3>
              <div style="color:var(--text-accent); font-size:0.85rem;">${escapeHtml(activeChar.tagline) || ''}</div>
            </div>
          </div>
          <p style="margin-bottom:1rem; font-size:0.9rem; color:var(--text-muted);">${escapeHtml(activeChar.description) || 'Tidak ada deskripsi.'}</p>
          <div style="margin-bottom:0.75rem;"><strong>Personality:</strong> <span style="color:var(--text-muted);">${escapeHtml(activeChar.personality) || '-'}</span></div>
          <div style="margin-bottom:0.75rem;"><strong>Scenario:</strong> <span style="color:var(--text-muted);">${escapeHtml(activeChar.scenario) || '-'}</span></div>
        `,
        buttons: [{ label: 'Tutup', className: 'btn-secondary', onClick: () => Modal.close() }]
      });
    };

    container.querySelector('#btn-char-info-header').onclick = showCharInfoModal;
    container.querySelector('#btn-view-char-details').onclick = showCharInfoModal;

    // Multi-Proxy Config / Global Settings quick-access shortcuts (Opsi Chat tab)
    container.querySelector('#btn-open-proxies-config').onclick = () => {
      const overlay = Modal.open({
        title: 'Multi-Proxy Config',
        contentHTML: '<div id="embedded-proxies-view"></div>',
        buttons: [{ id: 'btn-close-proxies-modal', label: 'Tutup', className: 'btn-secondary', onClick: async () => {
          Modal.close();
          await populateDrawerSelects();
          if (onProxyChanged) onProxyChanged();
        } }]
      });
      ProxiesView.render(overlay.querySelector('#embedded-proxies-view'));
    };

    container.querySelector('#btn-open-global-settings').onclick = () => {
      const overlay = Modal.open({
        title: 'Global Settings',
        contentHTML: '<div id="embedded-settings-view"></div>',
        buttons: [{ id: 'btn-close-settings-modal', label: 'Tutup', className: 'btn-secondary', onClick: () => Modal.close() }]
      });
      SettingsView.render(overlay.querySelector('#embedded-settings-view'));
    };

    container.querySelector('#btn-delete-current-session').onclick = async () => {
      if (confirm('Delete current chat session?')) {
        await ChatStore.deleteChat(currentChatId);
        const remaining = await ChatStore.getChatsByCharacter(selectedCharId);
        if (remaining.length > 0) {
          currentChatId = remaining[0].id;
        } else {
          const defaultPersona = await PersonaStore.getDefault();
          const newSession = await createChatWithGreeting(defaultPersona?.id, `Session 1 - ${activeChar.name}`);
          currentChatId = newSession.id;
        }
        await updateSessionList();
        await renderMessages();
        drawerOverlay.classList.add('hidden');
        Toast.info('Chat session deleted.');
      }
    };

    // Internal State Render Methods
    const updateSessionList = async () => {
      const chatSessions = await ChatStore.getChatsByCharacter(selectedCharId);
      const listEl = container.querySelector('#right-drawer-session-list');

      listEl.innerHTML = chatSessions.map(s => `
        <div class="session-item ${s.id === currentChatId ? 'active' : ''}" data-id="${s.id}" style="padding:0.65rem 0.85rem; background:#ffffff; border-radius:var(--radius-md); border:1px solid ${s.id === currentChatId ? 'var(--accent-primary)' : 'var(--border-light)'}; cursor:pointer; font-size:0.85rem; display:flex; justify-content:space-between; align-items:center; box-shadow:var(--shadow-sm);">
          <div class="session-title-row">
            <div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1;">${escapeHtml(s.title)}</div>
          </div>
          <div style="display:flex; align-items:center; gap:0.15rem; flex-shrink:0;">
            <button class="btn-rename-session" data-id="${s.id}" title="Rename Session">
              <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            ${chatSessions.length > 1 ? `<button class="btn-icon btn-del-session" data-id="${s.id}" style="padding:0.1rem 0.3rem;" title="Delete Session">&times;</button>` : ''}
          </div>
        </div>
      `).join('');

      listEl.querySelectorAll('.session-item').forEach(item => {
        item.onclick = async (e) => {
          if (e.target.closest('.btn-del-session') || e.target.closest('.btn-rename-session')) return;
          currentChatId = item.dataset.id;
          drawerOverlay.classList.add('hidden');
          await updateSessionList();
          await renderMessages();
        };
      });

      listEl.querySelectorAll('.btn-rename-session').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const targetId = btn.dataset.id;
          const targetChat = chatSessions.find(s => s.id === targetId);
          const newTitle = prompt('Rename session:', targetChat?.title || '');
          if (newTitle && newTitle.trim()) {
            await ChatStore.updateChatTitle(targetId, newTitle.trim(), { manual: true });
            await updateSessionList();
          }
        };
      });

      listEl.querySelectorAll('.btn-del-session').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const targetId = btn.dataset.id;
          if (confirm('Delete this chat session?')) {
            await ChatStore.deleteChat(targetId);
            const remaining = await ChatStore.getChatsByCharacter(selectedCharId);
            if (remaining.length > 0) currentChatId = remaining[0].id;
            await updateSessionList();
            await renderMessages();
          }
        };
      });
    };

    const renderMessages = async () => {
      const messagesEl = container.querySelector('#messages-container');
      const msgs = await ChatStore.getMessages(currentChatId);
      const activePersonaObj = await PersonaStore.getDefault();
      const userName = activePersonaObj?.name || 'User';
      const charName = activeChar?.name || 'Character';

      if (msgs.length === 0) {
        // First message greeting block from character
        const startMsg = replaceMacros(activeChar.first_mes, userName, charName);
        messagesEl.innerHTML = `
          <div class="message-block assistant">
            <div class="message-block-inner">
              <div class="message-header">
                <img src="${escapeAttr(activeChar.avatar)}" class="message-avatar" onerror="this.src='https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(activeChar.name)}'">
                <div class="message-sender-name">${escapeHtml(activeChar.name)}</div>
              </div>
              <div class="message-content">
                ${this.formatRoleplayMarkdown(startMsg)}
              </div>
            </div>
          </div>
        `;
        return;
      }

      const assistantIndexes = msgs.map((m, i) => (m.role === 'assistant' ? i : -1)).filter(i => i >= 0);
      const lastAssistantIndex = assistantIndexes.length ? assistantIndexes[assistantIndexes.length - 1] : -1;
      const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
      const isLastMsgUser = lastMsg && lastMsg.role === 'user';

      messagesEl.innerHTML = msgs.map((m, idx) => {
        const isUser = m.role === 'user';
        const isLastItem = idx === msgs.length - 1;
        const isLastUserMsg = isUser && isLastItem;
        const senderName = isUser ? userName : charName;
        const avatar = isUser ? (activePersonaObj?.avatar || 'https://api.dicebear.com/7.x/bottts/svg?seed=User') : activeChar.avatar;
        const swipeCount = m.swipes ? m.swipes.length : 1;
        const swipeIdx = m.swipeIndex || 0;
        const isLastAssistant = !isUser && idx === lastAssistantIndex;
        const thoughtsText = (m.thoughts || '').trim();

        return `
          <div class="message-block ${isUser ? 'user' : 'assistant'}" data-id="${m.id}">
            <div class="message-block-inner">
              <div class="message-header">
                <img src="${escapeAttr(avatar)}" class="message-avatar" onerror="this.src='https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(senderName)}'">
                <div class="message-sender-name">${escapeHtml(senderName)}</div>
              </div>

              ${!isUser && thoughtsText ? `
                <div class="thinking-block ${isThinkingCollapsedDefault ? '' : 'expanded'}" data-msgid="${m.id}">
                  <button class="thinking-toggle" type="button">
                    <svg class="thinking-chevron" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>
                    <span>Thinking</span>
                    <span class="thinking-token-badge">${estimateThinkingTokens(thoughtsText).toLocaleString()} tokens</span>
                  </button>
                  <div class="thinking-content">${escapeHtml(thoughtsText)}</div>
                </div>
              ` : ''}

              <div class="message-content" data-msgid="${m.id}">
                ${this.formatRoleplayMarkdown(m.content, userName, charName)}
              </div>

              <div class="message-footer">
                <div class="message-footer-actions">
                  <button class="btn-msg-action btn-edit-message" data-id="${m.id}" title="Edit pesan">
                    <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                  </button>
                  ${!isUser && !isLastAssistant ? `
                    <button class="btn-msg-action btn-fork-message" data-id="${m.id}" title="Fork sesi dari pesan ini">
                      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><circle cx="18" cy="6" r="3"></circle><path d="M18 9v2a2 2 0 01-2 2H8a2 2 0 01-2-2V9"></path><path d="M12 12v3"></path></svg>
                    </button>
                  ` : ''}
                  <button class="btn-msg-action btn-delete-message" data-id="${m.id}" title="Hapus pesan ini">
                    <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
                  </button>
                  ${isLastUserMsg ? `
                    <button class="btn-msg-action btn-generate-ai-response" data-id="${m.id}" title="Generate respon AI dari pesan ini">
                      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                    </button>
                  ` : ''}
                </div>

                ${!isUser ? `
                  <div class="swipe-controls" title="Swipe Variasi Respon AI">
                    <button class="swipe-btn swipe-prev" data-id="${m.id}" ${swipeCount <= 1 ? 'disabled' : ''} title="Variasi Sebelumnya">&lt;</button>
                    <span class="swipe-counter">${swipeIdx + 1} / ${swipeCount}</span>
                    <button class="swipe-btn swipe-next" data-id="${m.id}" title="${isLastAssistant ? 'Variasi Selanjutnya / Buat Baru' : 'Variasi Selanjutnya'}">&gt;</button>
                  </div>
                ` : ''}
              </div>
            </div>
          </div>
        `;
      }).join('');

      scrollToBottom(messagesEl);

      // Direction-aware slide animation helper for swipe transitions
      const refreshMessageBlock = async (messageId, direction = 'next') => {
        const blockEl = messagesEl.querySelector(`.message-block[data-id="${messageId}"]`);
        if (!blockEl) return;
        const innerEl = blockEl.querySelector('.message-block-inner');
        const contentEl = blockEl.querySelector('.message-content');
        const counterEl = blockEl.querySelector('.swipe-counter');
        const freshMsg = await ChatStore.getMessageById(messageId);
        if (!contentEl || !freshMsg) return;

        const outClass = direction === 'next' ? 'msg-swipe-out-left' : 'msg-swipe-out-right';
        const inClass = direction === 'next' ? 'msg-swipe-out-right' : 'msg-swipe-out-left';

        contentEl.classList.add('msg-swipe-anim', outClass);
        await new Promise(r => setTimeout(r, 180));

        contentEl.innerHTML = this.formatRoleplayMarkdown(freshMsg.content);
        if (counterEl) {
          const count = freshMsg.swipes ? freshMsg.swipes.length : 1;
          counterEl.textContent = `${(freshMsg.swipeIndex || 0) + 1} / ${count}`;
        }
        // Creates/updates/removes the thinking block based on the fresh
        // variation's actual thoughts, instead of leaving a stale one behind.
        syncThinkingBlock(innerEl, (freshMsg.thoughts || '').trim(), { streaming: false });

        contentEl.classList.remove(outClass);
        contentEl.classList.add(inClass);
        void contentEl.offsetWidth; // force reflow so the browser registers the jump before transitioning back
        requestAnimationFrame(() => contentEl.classList.remove(inClass));
        setTimeout(() => contentEl.classList.remove('msg-swipe-anim'), 220);
      };

      // Swipe event listeners directly on AI message controls
      messagesEl.querySelectorAll('.swipe-prev').forEach(btn => {
        btn.onclick = async () => this.handleSwipePrev(btn.dataset.id, () => refreshMessageBlock(btn.dataset.id, 'prev'));
      });
      messagesEl.querySelectorAll('.swipe-next').forEach(btn => {
        btn.onclick = async () => this.handleSwipeNext(btn.dataset.id, currentChatId, activeChar, () => refreshMessageBlock(btn.dataset.id, 'next'));
      });

      // Thinking block collapse/expand toggle
      messagesEl.querySelectorAll('.thinking-toggle').forEach(btn => {
        btn.onclick = () => {
          const block = btn.closest('.thinking-block');
          if (block) {
            const isExpanded = block.classList.toggle('expanded');
            isThinkingCollapsedDefault = !isExpanded;
            localStorage.setItem('aetheria_thinking_collapsed', isThinkingCollapsedDefault ? '1' : '0');
          }
        };
      });

      // Delete message handler
      messagesEl.querySelectorAll('.btn-delete-message').forEach(btn => {
        btn.onclick = async () => {
          const msgId = btn.dataset.id;
          if (confirm('Hapus pesan ini?')) {
            await ChatStore.deleteMessage(msgId);
            Toast.info('Pesan dihapus.');
            await renderMessages();
          }
        };
      });

      // Generate AI response on last user message
      messagesEl.querySelectorAll('.btn-generate-ai-response').forEach(btn => {
        btn.onclick = () => triggerAIGeneration();
      });

      // Inline message editing (both user and assistant messages)
      messagesEl.querySelectorAll('.btn-edit-message').forEach(btn => {
        btn.onclick = () => {
          const msgId = btn.dataset.id;
          const msgObj = msgs.find(m => m.id === msgId);
          const blockEl = messagesEl.querySelector(`.message-block[data-id="${msgId}"]`);
          const contentEl = blockEl?.querySelector('.message-content');
          if (!msgObj || !contentEl) return;
          const originalHTML = contentEl.innerHTML;

          contentEl.innerHTML = `
            <textarea class="textarea message-edit-textarea">${escapeHtml(msgObj.content)}</textarea>
            <div class="message-edit-actions">
              <button class="btn btn-primary btn-sm btn-save-edit">Simpan</button>
              <button class="btn btn-secondary btn-sm btn-cancel-edit">Batal</button>
            </div>
          `;
          const textarea = contentEl.querySelector('textarea');
          textarea.focus();

          contentEl.querySelector('.btn-cancel-edit').onclick = () => {
            contentEl.innerHTML = originalHTML;
          };
          contentEl.querySelector('.btn-save-edit').onclick = async () => {
            const newText = textarea.value.trim();
            if (!newText) {
              Toast.error('Pesan tidak boleh kosong.');
              return;
            }
            await ChatStore.updateMessageContent(msgId, newText);
            Toast.success('Message edited successfully.');
            await renderMessages();
          };
        };
      });

      // Fork-to-regenerate: old (non-last) assistant messages can only be regenerated
      // after branching a new session from that point.
      messagesEl.querySelectorAll('.btn-fork-message').forEach(btn => {
        btn.onclick = async () => {
          const msgId = btn.dataset.id;
          if (!confirm('Fork chat session from this message point? A new session branch will be created.')) return;
          try {
            const newChat = await ChatStore.forkChat(currentChatId, msgId);
            currentChatId = newChat.id;
            await updateSessionList();
            await renderMessages();
            drawerOverlay.classList.add('hidden');
            Toast.success(`New session "${newChat.title}" created from fork.`);
          } catch (err) {
            Toast.error(err.message);
          }
        };
      });
    };

    // Auto-generate a short session title every 10 messages, unless the user
    // has manually renamed the session (chat.titleEdited).
    const generateAutoTitle = async (chatObj, messagesForTitle) => {
      try {
        const proxyObj = await ProxyStore.getDefault();
        if (!proxyObj) return;

        const excerpt = messagesForTitle
          .slice(-10)
          .map(m => `${m.role === 'user' ? 'User' : activeChar.name}: ${m.content}`)
          .join('\n')
          .slice(0, 3000);

        const titlePrompt = [
          { role: 'system', content: 'Buat judul sesi roleplay yang sangat singkat (maksimal 6 kata), tanpa tanda kutip, tanpa titik di akhir, merangkum percakapan berikut. Balas HANYA dengan judulnya saja.' },
          { role: 'user', content: excerpt }
        ];

        const result = await ProviderManager.sendChatCompletion(proxyObj, titlePrompt, { maxTokens: 20, temperature: 0.4 });
        const titleText = (result.content || '').trim().replace(/^["']+|["']+$/g, '').slice(0, 60);
        if (titleText) {
          await ChatStore.updateChatTitle(chatObj.id, titleText);
          await updateSessionList();
        }
      } catch (err) {
        console.warn('Auto title generation failed:', err);
      }
    };

    // Attach Action Handlers
    const sendInput = container.querySelector('#chat-input');
    const sendBtn = container.querySelector('#btn-send-message');
    const newSessionBtn = container.querySelector('#btn-new-session');

    const triggerAIGeneration = async () => {
      if (isGenerating) return;

      const currentMessages = await ChatStore.getMessages(currentChatId);
      if (!currentMessages.length) return;

      const lastMsg = currentMessages[currentMessages.length - 1];
      if (lastMsg.role !== 'user') return; // AI only responds if last message is from user

      const proxyObj = await ProxyStore.getDefault();
      if (!proxyObj) {
        Toast.error('Silakan konfigurasi Multi-Proxy API terlebih dahulu di menu Multi-Proxy Config!');
        return;
      }

      const activePersonaObj = await PersonaStore.getDefault();
      const genSettings = await ProxyStore.getGenerationSettings();
      const globalPrompt = await ProxyStore.getGlobalSystemPrompt();
      const enabledMcpServers = await MCPStore.getEnabledServers();

      const promptPayload = applyPrefill(genSettings, PromptBuilder.buildPromptPayload({
        character: activeChar,
        persona: activePersonaObj,
        globalSystemPrompt: globalPrompt,
        messages: currentMessages,
        contextLimit: genSettings.contextLimit || 20,
        mcpServers: enabledMcpServers
      }));

      const messagesEl = container.querySelector('#messages-container');
      const typingIndicator = document.createElement('div');
      typingIndicator.className = 'message-block assistant';
      typingIndicator.id = 'typing-indicator';
      typingIndicator.innerHTML = `
        <div class="message-block-inner">
          <div class="message-header">
            <img src="${escapeAttr(activeChar.avatar)}" class="message-avatar">
            <div class="message-sender-name">${escapeHtml(activeChar.name)}</div>
          </div>
          <div class="message-content" id="typing-indicator-content" style="color:var(--text-dim);">
            <em>${escapeHtml(activeChar.name)} sedang mengetik...</em>
          </div>
        </div>
      `;
      messagesEl.appendChild(typingIndicator);
      scrollToBottom(messagesEl);

      activeAbortController = new AbortController();
      setGeneratingState(true);
      let liveContent = genSettings.prefillEnabled && genSettings.prefillText ? genSettings.prefillText : '';
      let liveThinking = '';

      try {
        let finalContent, finalThinking;

        if (genSettings.streamingEnabled) {
          const typingInnerEl = typingIndicator.querySelector('.message-block-inner');
          const typingContentEl = typingIndicator.querySelector('#typing-indicator-content');
          typingContentEl.removeAttribute('style');
          typingContentEl.innerHTML = liveContent ? this.formatRoleplayMarkdown(liveContent) : '';
          const result = await ProviderManager.streamChatCompletion(proxyObj, promptPayload, genSettings, {
            signal: activeAbortController.signal,
            onContentChunk: (delta) => {
              liveContent += delta;
              typingContentEl.innerHTML = this.formatRoleplayMarkdown(liveContent);
              scrollToBottom(messagesEl);
            },
            onThinkingChunk: (delta) => {
              liveThinking += delta;
              syncThinkingBlock(typingInnerEl, liveThinking, { streaming: true });
              scrollToBottom(messagesEl);
            }
          });
          ({ content: finalContent, thinking: finalThinking } = mergePrefillResult(genSettings, result));
        } else {
          const result = await ProviderManager.sendChatCompletion(proxyObj, promptPayload, genSettings, { signal: activeAbortController.signal });
          ({ content: finalContent, thinking: finalThinking } = mergePrefillResult(genSettings, result));
        }

        typingIndicator.remove();

        await ChatStore.addMessage(currentChatId, 'assistant', finalContent, finalThinking, [finalContent]);
        await renderMessages();

        const updatedMessages = await ChatStore.getMessages(currentChatId);
        const chatObj = await ChatStore.getChatById(currentChatId);
        if (chatObj && !chatObj.titleEdited && updatedMessages.length % 10 === 0) {
          generateAutoTitle(chatObj, updatedMessages);
        }
      } catch (err) {
        typingIndicator.remove();
        if (err.name === 'AbortError') {
          if (liveContent.trim()) {
            await ChatStore.addMessage(currentChatId, 'assistant', liveContent, liveThinking, [liveContent]);
            await renderMessages();
            Toast.info('Generasi dihentikan - jawaban sebagian tersimpan.');
          } else {
            Toast.info('Generasi dibatalkan.');
          }
        } else {
          Toast.error(`Gagal mendapatkan respon AI: ${err.message}`);
          await renderMessages();
        }
      } finally {
        activeAbortController = null;
        setGeneratingState(false);
        sendInput.focus();
      }
    };

    const handleSendMessage = async () => {
      const text = sendInput.value.trim();
      if (!text || isGenerating) return;

      sendInput.value = '';

      // 1. Add User Message to ChatStore
      await ChatStore.addMessage(currentChatId, 'user', text);
      await renderMessages();

      // 2. Trigger AI Generation
      await triggerAIGeneration();
    };

    sendBtn.onclick = () => {
      if (isGenerating) {
        if (activeAbortController) activeAbortController.abort();
      } else {
        handleSendMessage();
      }
    };
    sendInput.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    };

    newSessionBtn.onclick = async () => {
      const activePersonaObj = await PersonaStore.getDefault();
      const chatSessions = await ChatStore.getChatsByCharacter(selectedCharId);
      const newSession = await createChatWithGreeting(activePersonaObj?.id, `Session ${chatSessions.length + 1} - ${activeChar.name}`);
      currentChatId = newSession.id;
      await updateSessionList();
      await renderMessages();
      Toast.success('New roleplay session created!');
    };

    // Initial render
    await updateSessionList();
    await renderMessages();
  }

  /* Direct Message Swipe Handlers */
  static async handleSwipePrev(messageId, onDone) {
    const msg = await ChatStore.getMessageById(messageId);
    if (!msg || !msg.swipes || msg.swipes.length <= 1) return;

    let nextIdx = (msg.swipeIndex || 0) - 1;
    if (nextIdx < 0) nextIdx = msg.swipes.length - 1;

    await ChatStore.updateMessageSwipes(messageId, msg.swipes, nextIdx);
    onDone();
  }

  static async handleSwipeNext(messageId, chatId, activeChar, onDone) {
    if (isGenerating) {
      Toast.error('Masih ada proses generate yang berjalan.');
      return;
    }
    const msg = await ChatStore.getMessageById(messageId);
    if (!msg) return;
    const msgs = await ChatStore.getMessages(chatId);
    const msgIndex = msgs.findIndex(m => m.id === messageId);
    if (msgIndex === -1) return;

    const swipeCount = msg.swipes ? msg.swipes.length : 1;
    const currentIdx = msg.swipeIndex || 0;

    // If there is a next existing swipe variation, just switch to it - always allowed.
    if (currentIdx + 1 < swipeCount) {
      await ChatStore.updateMessageSwipes(messageId, msg.swipes, currentIdx + 1);
      onDone();
      return;
    }

    // Regenerating a brand NEW variation is only allowed on the LAST assistant
    // message in the chat. Older messages must be forked first.
    const assistantIndexes = msgs.map((m, i) => (m.role === 'assistant' ? i : -1)).filter(i => i >= 0);
    const lastAssistantIndex = assistantIndexes.length ? assistantIndexes[assistantIndexes.length - 1] : -1;
    if (msgIndex !== lastAssistantIndex) {
      Toast.error('Pesan lama tidak bisa di-regenerate. Fork sesi ini dulu untuk melanjutkan dari pesan ini.');
      return;
    }

    // Generate a brand NEW swipe response!
    const activeProxy = await ProxyStore.getDefault();
    if (!activeProxy) return Toast.error('Belum ada Proxy aktif.');

    const activePersonaObj = await PersonaStore.getDefault();
    const genSettings = await ProxyStore.getGenerationSettings();
    const globalPrompt = await ProxyStore.getGlobalSystemPrompt();
    const enabledMcpServers = await MCPStore.getEnabledServers();

    // History up to the message before this assistant message
    const historyBefore = msgs.slice(0, msgIndex);
    const promptPayload = applyPrefill(genSettings, PromptBuilder.buildPromptPayload({
      character: activeChar,
      persona: activePersonaObj,
      globalSystemPrompt: globalPrompt,
      messages: historyBefore,
      contextLimit: genSettings.contextLimit || 20,
      mcpServers: enabledMcpServers
    }));

    activeAbortController = new AbortController();
    setGeneratingState(true);

    const messagesEl = document.getElementById('messages-container');
    const contentEl = document.querySelector(`.message-content[data-msgid="${messageId}"]`);
    const blockInnerEl = document.querySelector(`.message-block[data-id="${messageId}"] .message-block-inner`);

    // Remove any stale thinking block from previous variation before starting generation
    if (blockInnerEl) {
      const staleThinking = blockInnerEl.querySelector('.thinking-block');
      if (staleThinking) staleThinking.remove();
    }

    const restoreOriginal = () => {
      if (contentEl) contentEl.innerHTML = ChatView.formatRoleplayMarkdown(msg.content);
      if (blockInnerEl) syncThinkingBlock(blockInnerEl, (msg.thoughts || '').trim(), { streaming: false });
    };
    let liveContent = genSettings.prefillEnabled && genSettings.prefillText ? genSettings.prefillText : '';
    let liveThinking = '';

    try {
      let newContent, newThinking;

      if (genSettings.streamingEnabled) {
        if (contentEl) contentEl.innerHTML = liveContent ? ChatView.formatRoleplayMarkdown(liveContent) : '';
        const result = await ProviderManager.streamChatCompletion(activeProxy, promptPayload, genSettings, {
          signal: activeAbortController.signal,
          onContentChunk: (delta) => {
            liveContent += delta;
            if (contentEl) contentEl.innerHTML = ChatView.formatRoleplayMarkdown(liveContent);
            scrollToBottom(messagesEl);
          },
          onThinkingChunk: (delta) => {
            liveThinking += delta;
            if (blockInnerEl) syncThinkingBlock(blockInnerEl, liveThinking, { streaming: true });
            scrollToBottom(messagesEl);
          }
        });
        ({ content: newContent, thinking: newThinking } = mergePrefillResult(genSettings, result));
      } else {
        if (contentEl) contentEl.innerHTML = '<em style="color:var(--text-dim);">Menggenerasi variasi baru...</em>';
        const result = await ProviderManager.sendChatCompletion(activeProxy, promptPayload, genSettings, { signal: activeAbortController.signal });
        ({ content: newContent, thinking: newThinking } = mergePrefillResult(genSettings, result));
      }

      const updatedSwipes = [...(msg.swipes || [msg.content]), newContent];
      const newIndex = updatedSwipes.length - 1;
      await ChatStore.updateMessageSwipes(messageId, updatedSwipes, newIndex, newThinking);
      onDone();
    } catch (err) {
      if (err.name === 'AbortError') {
        if (liveContent.trim()) {
          const updatedSwipes = [...(msg.swipes || [msg.content]), liveContent];
          const newIndex = updatedSwipes.length - 1;
          await ChatStore.updateMessageSwipes(messageId, updatedSwipes, newIndex, liveThinking);
          onDone();
          Toast.info('Generasi dihentikan - jawaban sebagian tersimpan.');
        } else {
          Toast.info('Generasi dibatalkan.');
          restoreOriginal();
        }
      } else {
        Toast.error(`Gagal swipe: ${err.message}`);
        restoreOriginal();
      }
    } finally {
      activeAbortController = null;
      setGeneratingState(false);
    }
  }

  static formatRoleplayMarkdown(text = '', userName = '', charName = '') {
    if (!text) return '';
    let textToFormat = text;
    if (userName || charName) {
      textToFormat = replaceMacros(text, userName, charName);
    }
    // Escape raw HTML first so chat content (user-typed or AI-generated) can
    // never inject tags/scripts through here - only markdown syntax survives.
    let formatted = escapeHtml(textToFormat);
    // Format actions in italics (*action* -> <em>action</em>)
    formatted = formatted.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Format quotes ("speech" -> <strong>"speech"</strong>)
    formatted = formatted.replace(/"([^"]+)"/g, '<span style="color:#0f172a; font-weight:500;">"$1"</span>');
    // Use marked parser if available. `breaks: true` makes single newlines
    // render as <br> instead of being collapsed away - AI/roleplay replies
    // are usually formatted with single line breaks, not blank-line paragraphs.
    if (window.marked) {
      return window.marked.parse(formatted, { breaks: true });
    }
    return formatted.replace(/\n/g, '<br>');
  }
}

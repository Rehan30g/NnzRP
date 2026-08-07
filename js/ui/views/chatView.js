/* js/ui/views/chatView.js - Dedicated Chat Page (Response Swiping on Last Message) */
import { CharacterStore } from '../../storage/characterStore.js';
import { ChatStore } from '../../storage/chatStore.js';
import { PersonaStore } from '../../storage/personaStore.js';
import { ProxyStore } from '../../storage/proxyStore.js';
import { PromptBuilder } from '../../services/promptBuilder.js';
import { ProviderManager } from '../../services/providerManager.js';
import { MCPToolRegistry } from '../../services/mcpToolRegistry.js';
import { AgentRunner } from '../../services/agentRunner.js';
import { MCPStore } from '../../storage/mcpStore.js';
import { MCPClient } from '../../services/mcpClient.js';
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

// A message typed/submitted while a generation is already in flight - kept
// here (not disabling the composer) so the user can keep drafting instead of
// waiting; auto-sent once the in-flight generation ends (success or abort).
// `queuedMessageHandlers` is (re)bound by ChatView.render() to the currently
// mounted chat's own send/refresh closures.
let queuedMessage = null;
let queuedMessageHandlers = null; // { flush(text): Promise<void>, refreshIndicator(): void }

async function flushQueuedMessageIfAny() {
  if (!queuedMessage || !queuedMessageHandlers) return;
  const next = queuedMessage;
  queuedMessage = null;
  queuedMessageHandlers.refreshIndicator();
  await queuedMessageHandlers.flush(next);
}

// Wrench icon used on the "Tools Used" chip so an MCP-tool-triggering message
// is visually distinguishable from a plain thinking block at a glance.
const WRENCH_ICON_SVG = '<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"></path></svg>';

/**
 * Toggles the send button between "send" (arrow-up) and "stop" (square) look
 * and locks down per-message actions (edit/fork/swipe) while a generation is
 * in flight. The composer itself is intentionally left enabled throughout -
 * see `queuedMessage` above - so the user can keep typing instead of waiting.
 */
function setGeneratingState(generating) {
  isGenerating = generating;
  const sendBtn = document.getElementById('btn-send-message');
  const messagesEl = document.getElementById('messages-container');
  if (!sendBtn) return;

  if (generating) {
    sendBtn.classList.add('generating');
    sendBtn.title = 'Stop Generation';
    sendBtn.setAttribute('aria-label', 'Stop Generation');
    sendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>';
    if (messagesEl) messagesEl.classList.add('generating-lock');
  } else {
    sendBtn.classList.remove('generating');
    sendBtn.title = 'Send Message';
    sendBtn.setAttribute('aria-label', 'Send Message');
    sendBtn.innerHTML = '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>';
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
 * `containerEl.insertBefore(x, y)` requires `y` to be a DIRECT child of
 * `containerEl` - true for a persisted message's `.message-content` (always a
 * direct child of `.message-block-inner`), but NOT during live generation,
 * where the typing indicator / swipe host wraps one-or-more `.message-content`
 * blocks inside an intermediate `#typing-indicator-content`/host div (see
 * `renderLiveBodyHTML`) so inline tool markers can sit between them. Returns
 * whichever DIRECT child of `containerEl` should be inserted-before to land
 * right above the content area, in either case.
 */
function findContentAnchor(containerEl) {
  for (const child of containerEl.children) {
    if (child.classList.contains('message-content') || child.querySelector('.message-content')) {
      return child;
    }
  }
  return null;
}

/**
 * Creates/updates/removes a message's collapsible thinking block to match
 * `thinkingText`, live during streaming or as a final sync after generation.
 * Includes real-time thinking token counter.
 */
function syncThinkingBlock(containerEl, thinkingText, { streaming = false } = {}) {
  if (!containerEl) return;
  const contentEl = findContentAnchor(containerEl);
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
 * Creates/updates/removes a message's collapsible "Tools Used" block to match
 * `toolTrace` (an array of {name,args,result}) - used when a swipe variation
 * is switched to, so a stale tool-trace from a different variation isn't left
 * displayed alongside the newly-shown content.
 */
function syncToolTraceBlock(containerEl, toolTrace = []) {
  if (!containerEl) return;
  const contentEl = findContentAnchor(containerEl);
  let block = containerEl.querySelector('.tool-trace-block');

  if (!toolTrace || toolTrace.length === 0) {
    if (block) block.remove();
    return;
  }

  if (!block) {
    block = document.createElement('div');
    block.className = 'tool-trace-block';
    block.innerHTML = `
      <button class="thinking-toggle" type="button">
        ${WRENCH_ICON_SVG}
        <svg class="thinking-chevron" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>
        <span>Tools Used</span>
        <span class="thinking-token-badge"></span>
      </button>
      <div class="thinking-content"></div>
    `;
    block.querySelector('.thinking-toggle').onclick = () => block.classList.toggle('expanded');
    if (contentEl) containerEl.insertBefore(block, contentEl);
    else containerEl.appendChild(block);
  }

  block.querySelector('.thinking-token-badge').textContent = `${toolTrace.length} call${toolTrace.length > 1 ? 's' : ''}`;
  block.querySelector('.thinking-content').textContent = toolTrace.map(t => `${t.name}(${JSON.stringify(t.args)})\n→ ${t.result}`).join('\n\n');
}

/**
 * De-duplicated, comma-joined list of the tool names in a `toolTrace` (or a
 * single round's slice of one), for the small always-visible inline marker
 * placed at the point a tool was called. Returns '' for no tools.
 */
function toolTraceNames(toolTrace = []) {
  const names = [];
  for (const t of toolTrace) {
    const name = (t && t.name) || '';
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join(', ');
}

/**
 * HTML for one `.tool-inline-note` marker covering a group of tool call(s)
 * (comma-joined + de-duplicated names, same as the old whole-message note),
 * or '' if that group called no tools. When the group represents more than
 * one individual call - several rounds merged together with no narration
 * text between them (see `renderMessageBodyHTML`), or just several tools
 * called in one round - a "(Nx)" count is appended so calling the same tool
 * repeatedly doesn't silently collapse into a single name with no indication
 * it happened more than once. Applies the same way whether the merged calls
 * are the same tool repeated or different tools, per the user's request.
 * Tool names come from user-configured MCP servers, so they're escaped.
 */
function toolInlineNoteHTML(toolTrace = []) {
  const names = toolTraceNames(toolTrace);
  if (!names) return '';
  const suffix = toolTrace.length > 1 ? ` (${toolTrace.length}x)` : '';
  return `<div class="tool-inline-note">${WRENCH_ICON_SVG}<span>${escapeHtml(names + suffix)}</span></div>`;
}

/**
 * Whether `msg.toolSegments` (see `ChatStore.addMessage`'s JSDoc) carries real
 * per-round tool-call boundary data worth rendering as inline markers between
 * text blocks - as opposed to a message with no tool use at all, or one
 * persisted before this field existed (which only has the old flat `toolTrace`).
 */
function hasToolSegments(msg) {
  return Array.isArray(msg.toolSegments) && msg.toolSegments.length > 0 &&
    msg.toolSegments.some(seg => Array.isArray(seg.tools) && seg.tools.length > 0);
}

/**
 * Flattens a `toolSegments`-shaped array (`[{text, tools}, ...]`) into a
 * text/tools event stream, merging any consecutive tool-call groups that end
 * up with no non-empty text between them into ONE group (concatenating their
 * `tools`) instead of leaving them as separate groups sandwiching invisible
 * empty text - a model very often calls a tool with no lead-in text, and can
 * do that across several consecutive rounds (call tool A, get the result,
 * immediately call tool B still with no narration). Shared by
 * `renderMessageBodyHTML` (persisted messages) and `renderLiveBodyHTML`
 * (mid-generation) so both apply the exact same grouping.
 */
function groupToolSegments(segments) {
  const groups = [];
  for (const seg of segments) {
    if (seg.text && seg.text.trim()) {
      groups.push({ type: 'text', text: seg.text });
    }
    if (Array.isArray(seg.tools) && seg.tools.length) {
      const last = groups[groups.length - 1];
      if (last && last.type === 'tools') {
        last.tools.push(...seg.tools);
      } else {
        groups.push({ type: 'tools', tools: [...seg.tools] });
      }
    }
  }
  return groups;
}

/**
 * Builds the HTML for a message's whole content area. When `msg.toolSegments`
 * has real per-round boundaries, renders one `.message-content` block per
 * round's own text with a `.tool-inline-note` marker sandwiched exactly where
 * that round called its tool(s) - e.g. "fine ill search that" / [websearch
 * marker] / "here's what i found...", confirmed with the user over the old
 * "one note glued below the whole message" placement. `toolInlineNoteHTML`
 * shows a "(Nx)" count on a merged group (see `groupToolSegments`), same as
 * it would for several tools called in a single round.
 *
 * Falls back to the pre-existing single-blob + trailing-note rendering
 * (driven by the flat `toolTrace`) for messages persisted before
 * `toolSegments` existed, or for any message with no tool use at all - old
 * data must never crash or render blank. `formatFn` is
 * `ChatView.formatRoleplayMarkdown` (passed in rather than referenced
 * directly since this is a module-level helper, not a class method) - every
 * segment's text still goes through it, same as `m.content` always has, so
 * macros/escaping/markdown are never skipped.
 */
function renderMessageBodyHTML(msg, formatFn, userName, charName) {
  if (hasToolSegments(msg)) {
    const groups = groupToolSegments(msg.toolSegments);
    return groups.map(g => g.type === 'text'
      ? `<div class="message-content" data-msgid="${msg.id}">${formatFn(g.text, userName, charName)}</div>`
      : toolInlineNoteHTML(g.tools)
    ).join('');
  }
  const toolTrace = Array.isArray(msg.toolTrace) ? msg.toolTrace : [];
  const text = formatFn(msg.content, userName, charName);
  return `<div class="message-content" data-msgid="${msg.id}">${text}</div>${toolInlineNoteHTML(toolTrace)}`;
}

/**
 * Live counterpart to `renderMessageBodyHTML`, used while a turn is still
 * streaming so tool markers appear AS SOON AS a round's tool call resolves
 * instead of only once the whole turn is persisted (previously the live
 * typing indicator only ever showed plain joined text - no inline note until
 * `renderMessages()` re-rendered from the committed message). `committedSegments`
 * is the `segments` array `AgentRunner`'s `onRoundComplete` hands back each
 * round boundary (every round that's fully finished, tool call included);
 * `currentText` is the round currently streaming in (no `tools` yet, still in
 * progress) and always gets its own trailing block, falling back to
 * `placeholderHTML` ("...sedang mengetik...") while it's still empty - e.g.
 * right after a tool resolves and the next round hasn't produced any text yet.
 */
function renderLiveBodyHTML(committedSegments, currentText, placeholderHTML, formatFn) {
  const groups = groupToolSegments(committedSegments);
  let html = groups.map(g => g.type === 'text'
    ? `<div class="message-content">${formatFn(g.text)}</div>`
    : toolInlineNoteHTML(g.tools)
  ).join('');
  html += currentText.trim()
    ? `<div class="message-content">${formatFn(currentText)}</div>`
    : `<div class="message-content">${placeholderHTML}</div>`;
  return html;
}

/**
 * DOM-surgery counterpart to `renderMessageBodyHTML`, for the swipe
 * refresh/restore paths where the message block is already mounted (rebuilding
 * the whole `.message-block` string via `renderMessages()` would lose scroll
 * position/in-flight animation state). Removes whatever content/marker
 * elements are currently there - a stale variation may have had a different
 * number of segments than the fresh one - and re-inserts fresh ones anchored
 * right before `.message-footer` (so they land in the same slot the old single
 * `.message-content` used to occupy, ahead of the thinking/tool-trace blocks'
 * own insertion point which is unaffected by this).
 */
function syncMessageBody(containerEl, msg, formatFn, userName, charName) {
  if (!containerEl) return;
  containerEl.querySelectorAll('.message-content, .tool-inline-note').forEach(el => el.remove());
  const footerEl = containerEl.querySelector('.message-footer');
  const wrap = document.createElement('div');
  wrap.innerHTML = renderMessageBodyHTML(msg, formatFn, userName, charName);
  Array.from(wrap.childNodes).forEach(node => {
    if (footerEl) containerEl.insertBefore(node, footerEl);
    else containerEl.appendChild(node);
  });
}

/**
 * Creates/updates/removes a LIVE "Tools Used" box shown mid-generation while
 * tool call(s) are executing - deliberately its own element (not merged into
 * the thinking block, and not the persisted `.tool-trace-block`) with a
 * spinner per in-flight call so tool use is visible in real time instead of
 * silently happening behind the typing indicator. Purely transient: it's torn
 * down with the rest of the typing indicator once the round commits, at which
 * point `syncToolTraceBlock` renders the permanent record on the saved message.
 */
function syncLiveToolBox(containerEl, calls = []) {
  if (!containerEl) return;
  const contentEl = findContentAnchor(containerEl);
  let block = containerEl.querySelector('.tool-live-block');

  if (!calls.length) {
    if (block) block.remove();
    return;
  }

  if (!block) {
    block = document.createElement('div');
    block.className = 'tool-live-block';
    if (contentEl) containerEl.insertBefore(block, contentEl);
    else containerEl.appendChild(block);
  }

  block.innerHTML = `
    <div class="tool-live-header">${WRENCH_ICON_SVG}<span>Tools Used</span></div>
    ${calls.map(c => `
      <div class="tool-live-item">
        ${c.done ? '<span class="tool-live-check">&#10003;</span>' : '<span class="tool-live-spinner"></span>'}
        <span>${c.done ? 'Used' : 'Using'} tool: ${escapeHtml(c.name)}...</span>
      </div>
    `).join('')}
  `;
}

/**
 * Wraps a render function so it runs at most once per `minIntervalMs`, no
 * matter how many times `schedule()` is called in between. Streaming re-runs
 * `formatRoleplayMarkdown()` (markdown re-parse of the WHOLE accumulated
 * reply so far, not incremental) on every call - cheap for a short reply, but
 * its cost grows with reply length, and bursty chunk delivery (a client
 * recovering from a network stall delivers many buffered chunks back to
 * back) can fire it dozens of times in a tight loop with no gap to paint.
 *
 * This deliberately does NOT use `requestAnimationFrame`: rAF (and timers)
 * get heavily throttled by Chromium once a window loses focus/visibility,
 * which made an earlier rAF-based version of this helper *worse* - text
 * would stall for seconds while the window was unfocused, then dump in a
 * burst on refocus, which is a bigger regression than the bursty-chunks
 * problem it was meant to fix. A plain wall-clock gate checked synchronously
 * inside the normal chunk-arrival flow has no such dependency on the
 * renderer being foregrounded (`main.js` also sets `backgroundThrottling:
 * false` on the window, but this helper does not rely on that either).
 *
 * A skipped render is harmless ONLY as long as something later forces a final
 * render: `liveContent`/`liveThinking` are always kept current (cheap string
 * concat happens before `schedule()` is even called), but the gate silently
 * drops whatever arrived inside the last `minIntervalMs` window. That trailing
 * drop is exactly why a reply visibly lost its last character(s) ("fine ill
 * search that" showing as "fine ill search tha") while an MCP tool ran: the
 * final token before the model stopped to call a tool landed inside the gate
 * window, was never painted, and nothing corrected the display until the WHOLE
 * generation finished several seconds later. Hence `schedule.flush()` - call it
 * at every point where streaming pauses (tool starting, round boundary, end).
 */
function createThrottledRenderer(renderFn, minIntervalMs = 50) {
  let lastRun = 0;
  const schedule = function () {
    const now = Date.now();
    if (now - lastRun < minIntervalMs) return;
    lastRun = now;
    renderFn();
  };
  /** Renders immediately, ignoring the interval gate. */
  schedule.flush = () => {
    lastRun = Date.now();
    renderFn();
  };
  return schedule;
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
              <div class="queued-message-indicator hidden" id="queued-message-indicator" style="display:flex; align-items:center; gap:0.5rem; padding:0.4rem 0.75rem; margin-bottom:0.4rem; background:#eef2ff; border:1px solid var(--border-light); border-radius:var(--radius-md); font-size:0.78rem; color:var(--text-accent);">
                <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                <span id="queued-message-text" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>
                <button type="button" id="btn-cancel-queued" title="Batalkan" aria-label="Batalkan pesan yang diantrikan" style="background:none; border:none; cursor:pointer; color:var(--text-accent); font-size:1rem; line-height:1; padding:0 0.2rem;">&times;</button>
              </div>
              <textarea class="chat-textarea" id="chat-input" rows="2" placeholder="Type action (*looks around*) or dialogue (&quot;Hello...&quot;)... (Shift+Enter for new line)"></textarea>
              <div class="chat-input-toolbar" style="justify-content:space-between;">
                <select class="select" id="chat-model-select" title="Active Model" aria-label="Active Model" style="max-width:220px; font-size:0.78rem; padding:0.3rem 0.6rem; height:auto;"></select>
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
              <div class="card" style="padding:0.85rem; margin-bottom:1rem; display:flex; flex-direction:column; gap:0.75rem;">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:0.75rem;">
                  <div>
                    <div style="font-weight:700; font-size:0.85rem;">MCP Tools</div>
                    <div style="font-size:0.72rem; color:var(--text-muted); margin-top:0.15rem;">Master switch - turns all MCP tool-calling on/off across the whole app.</div>
                  </div>
                  <input type="checkbox" id="drawer-mcp-global-toggle" title="Enable MCP tools globally">
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; gap:0.75rem; border-top:1px solid var(--border-light); padding-top:0.65rem;">
                  <div>
                    <div style="font-weight:700; font-size:0.85rem;">Immersive Roleplay</div>
                    <div style="font-size:0.72rem; color:var(--text-muted); margin-top:0.15rem;">${escapeHtml(activeChar.name)} proactively uses tools in-character (e.g. websearch while browsing) without being explicitly asked.</div>
                  </div>
                  <input type="checkbox" id="drawer-mcp-immersive-toggle" title="Enable immersive proactive tool use">
                </div>
              </div>

              <div id="drawer-mcp-servers-section">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                  <div style="font-weight:700; font-size:0.9rem;">Active MCP Servers</div>
                  <button class="btn btn-secondary btn-sm" id="btn-drawer-manage-mcp">Manage All MCP</button>
                </div>
                <p style="color:var(--text-muted); font-size:0.78rem; margin-bottom:1rem;">
                  Toggle custom MCP tools ON/OFF for this roleplay session. Enabled + reachable servers let ${escapeHtml(activeChar.name)} call real tools mid-reply.
                </p>
                <div id="drawer-mcp-list" style="display:flex; flex-direction:column; gap:0.6rem;"></div>
              </div>
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
          await populateModelSelect();
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

    // Compact model switcher next to the send button (Claude-style) - reads
    // the active proxy's `models` list (js/ui/views/proxiesView.js lets you
    // configure more than one for custom/openrouter proxies) and falls back
    // to just showing the single `selectedModel` when no list is configured.
    const populateModelSelect = async () => {
      const modelSelect = container.querySelector('#chat-model-select');
      if (!modelSelect) return;
      const proxy = await ProxyStore.getDefault();
      if (!proxy) {
        modelSelect.innerHTML = '<option>No Proxy</option>';
        modelSelect.disabled = true;
        modelSelect.onchange = null;
        return;
      }

      const candidates = Array.isArray(proxy.models) ? [...proxy.models] : [];
      if (proxy.selectedModel && !candidates.includes(proxy.selectedModel)) candidates.unshift(proxy.selectedModel);
      if (candidates.length === 0) candidates.push(proxy.selectedModel || proxy.provider);

      modelSelect.innerHTML = candidates.map(m => `<option value="${escapeAttr(m)}" ${m === proxy.selectedModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
      modelSelect.disabled = candidates.length <= 1;

      modelSelect.onchange = async (e) => {
        const updatedProxy = await ProxyStore.getById(proxy.id);
        if (!updatedProxy) return;
        updatedProxy.selectedModel = e.target.value;
        await ProxyStore.save(updatedProxy);
        Toast.info(`Model diset ke: ${e.target.value}`);
        if (onProxyChanged) onProxyChanged();
      };
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
              <div style="font-size:0.72rem; color:var(--text-muted); font-family:var(--font-mono);">${s.transport === 'command' ? 'STDIO' : 'HTTP'}</div>
            </div>
            <input type="checkbox" class="drawer-mcp-toggle" data-id="${s.id}" ${s.enabled ? 'checked' : ''} title="Enable this server for roleplay sessions">
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border-light); padding-top:0.4rem; margin-top:0.2rem;">
            <span class="badge" id="drawer-mcp-status-${s.id}">Unknown</span>
            <button class="btn btn-secondary btn-sm drawer-check-mcp" data-id="${s.id}" style="padding:0.15rem 0.45rem; font-size:0.72rem;">Check Status</button>
          </div>
        </div>
      `).join('');

      mcpListEl.querySelectorAll('.drawer-mcp-toggle').forEach(chk => {
        chk.onchange = async (e) => {
          await MCPStore.toggleEnabled(e.target.dataset.id, e.target.checked);
          MCPToolRegistry.invalidate(e.target.dataset.id);
          Toast.info(`MCP Tool ${e.target.checked ? 'Diaktifkan' : 'Dinonaktifkan'}.`);
        };
      });

      const checkDrawerServerStatus = async (server, { silent = false } = {}) => {
        const badgeEl = mcpListEl.querySelector(`#drawer-mcp-status-${server.id}`);
        if (!badgeEl) return;
        badgeEl.textContent = 'Checking...';
        badgeEl.className = 'badge';

        const status = await MCPClient.checkStatus(server);
        if (status.online) {
          badgeEl.textContent = `Online (${status.toolCount})`;
          badgeEl.className = 'badge badge-emerald';
        } else {
          badgeEl.textContent = 'Offline';
          badgeEl.className = 'badge badge-rose';
          if (!silent) Toast.error(`"${server.name}" unreachable: ${status.error}`);
        }
      };

      mcpListEl.querySelectorAll('.drawer-check-mcp').forEach(btn => {
        btn.onclick = async () => {
          const server = await MCPStore.getById(btn.dataset.id);
          if (server) await checkDrawerServerStatus(server);
        };
      });

      // Check status as soon as the drawer's MCP tab is populated, so it's
      // ready without a manual click.
      servers.forEach(s => { checkDrawerServerStatus(s, { silent: true }); });
    };

    await populateDrawerSelects();
    await populateModelSelect();
    await renderDrawerMCPList();

    // MCP master switch + Immersive Roleplay toggle (drawer copy - mirrors the
    // same global settings surfaced on the home "MCP (Exp)" tab in mcpView.js).
    const mcpGlobalToggle = container.querySelector('#drawer-mcp-global-toggle');
    const mcpImmersiveToggle = container.querySelector('#drawer-mcp-immersive-toggle');
    const mcpServersSection = container.querySelector('#drawer-mcp-servers-section');

    const applyMcpMasterVisualState = (enabled) => {
      if (mcpServersSection) {
        mcpServersSection.style.opacity = enabled ? '1' : '0.5';
        mcpServersSection.style.pointerEvents = enabled ? '' : 'none';
      }
      if (mcpImmersiveToggle) mcpImmersiveToggle.disabled = !enabled;
    };

    if (mcpGlobalToggle) {
      mcpGlobalToggle.checked = await MCPStore.getGlobalEnabled();
      applyMcpMasterVisualState(mcpGlobalToggle.checked);
      mcpGlobalToggle.onchange = async (e) => {
        await MCPStore.setGlobalEnabled(e.target.checked);
        applyMcpMasterVisualState(e.target.checked);
        Toast.info(`MCP Tools ${e.target.checked ? 'diaktifkan' : 'dinonaktifkan'} secara global.`);
      };
    }

    if (mcpImmersiveToggle) {
      mcpImmersiveToggle.checked = await MCPStore.getImmersiveRoleplay();
      mcpImmersiveToggle.disabled = !mcpGlobalToggle?.checked;
      mcpImmersiveToggle.onchange = async (e) => {
        await MCPStore.setImmersiveRoleplay(e.target.checked);
        Toast.info(`Immersive Roleplay ${e.target.checked ? 'diaktifkan' : 'dinonaktifkan'}.`);
      };
    }

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
          await populateModelSelect();
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
        clearQueuedMessage();
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
          clearQueuedMessage();
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
            clearQueuedMessage();
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
        const toolTrace = Array.isArray(m.toolTrace) ? m.toolTrace : [];

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

              ${!isUser && toolTrace.length > 0 ? `
                <div class="tool-trace-block" data-msgid="${m.id}">
                  <button class="thinking-toggle" type="button">
                    ${WRENCH_ICON_SVG}
                    <svg class="thinking-chevron" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>
                    <span>Tools Used</span>
                    <span class="thinking-token-badge">${toolTrace.length} call${toolTrace.length > 1 ? 's' : ''}</span>
                  </button>
                  <div class="thinking-content">${escapeHtml(toolTrace.map(t => `${t.name}(${JSON.stringify(t.args)})\n→ ${t.result}`).join('\n\n'))}</div>
                </div>
              ` : ''}

              ${renderMessageBodyHTML(m, (t, u, c) => this.formatRoleplayMarkdown(t, u, c), userName, charName)}

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
        // The FIRST `.message-content` (there may be several if the fresh
        // variation is segmented) - used only as the slide-animation anchor.
        const anchorEl = blockEl.querySelector('.message-content');
        const counterEl = blockEl.querySelector('.swipe-counter');
        const freshMsg = await ChatStore.getMessageById(messageId);
        if (!anchorEl || !freshMsg) return;

        const outClass = direction === 'next' ? 'msg-swipe-out-left' : 'msg-swipe-out-right';
        const inClass = direction === 'next' ? 'msg-swipe-out-right' : 'msg-swipe-out-left';

        anchorEl.classList.add('msg-swipe-anim', outClass);
        await new Promise(r => setTimeout(r, 180));

        if (counterEl) {
          const count = freshMsg.swipes ? freshMsg.swipes.length : 1;
          counterEl.textContent = `${(freshMsg.swipeIndex || 0) + 1} / ${count}`;
        }
        // Rebuilds the whole content area (may now have a different number of
        // segments than the previous variation had) instead of just this one
        // element's text - the old single-element innerHTML swap can't express
        // "insert an inline marker between two text blocks".
        syncMessageBody(innerEl, freshMsg, (t, u, c) => this.formatRoleplayMarkdown(t, u, c), userName, charName);
        // Creates/updates/removes the thinking/tool-trace blocks based on the
        // fresh variation's actual data, instead of leaving stale ones behind.
        syncThinkingBlock(innerEl, (freshMsg.thoughts || '').trim(), { streaming: false });
        syncToolTraceBlock(innerEl, Array.isArray(freshMsg.toolTrace) ? freshMsg.toolTrace : []);
        syncLiveToolBox(innerEl, []); // clear the transient live box now that the real trace is shown

        // `syncMessageBody` replaced `anchorEl` with fresh node(s) - re-find the
        // (new) first one to finish the slide-in half of the animation on it.
        const newAnchorEl = blockEl.querySelector('.message-content');
        if (newAnchorEl) {
          newAnchorEl.classList.add('msg-swipe-anim', inClass);
          void newAnchorEl.offsetWidth; // force reflow so the browser registers the start position before transitioning
          requestAnimationFrame(() => newAnchorEl.classList.remove(inClass));
          setTimeout(() => newAnchorEl.classList.remove('msg-swipe-anim'), 220);
        }
      };

      // Swipe event listeners directly on AI message controls
      messagesEl.querySelectorAll('.swipe-prev').forEach(btn => {
        btn.onclick = async () => this.handleSwipePrev(btn.dataset.id, () => refreshMessageBlock(btn.dataset.id, 'prev'));
      });
      messagesEl.querySelectorAll('.swipe-next').forEach(btn => {
        btn.onclick = async () => this.handleSwipeNext(btn.dataset.id, currentChatId, activeChar, () => refreshMessageBlock(btn.dataset.id, 'next'));
      });

      // Thinking / tool-trace block collapse/expand toggle
      messagesEl.querySelectorAll('.thinking-toggle').forEach(btn => {
        btn.onclick = () => {
          const block = btn.closest('.thinking-block, .tool-trace-block');
          if (!block) return;
          const isExpanded = block.classList.toggle('expanded');
          // Only a THINKING block drives the remembered collapse preference -
          // opening a "Tools Used" block used to also flip it, so peeking at a
          // tool result silently changed how every future thinking block opened.
          if (block.classList.contains('thinking-block')) {
            isThinkingCollapsedDefault = !isExpanded;
            localStorage.setItem('aetheria_thinking_collapsed', isThinkingCollapsedDefault ? '1' : '0');
          }
        };
      });

      // Delete message handler
      messagesEl.querySelectorAll('.btn-delete-message').forEach(btn => {
        btn.onclick = async () => {
          const msgId = btn.dataset.id;
          // Deleting a user message cascades to the reply it generated, so say
          // so up front instead of silently removing more than was clicked.
          const msgIndex = msgs.findIndex(m => m.id === msgId);
          const cascades = msgIndex !== -1
            && msgs[msgIndex].role === 'user'
            && msgs[msgIndex + 1]?.role === 'assistant';
          const prompt = cascades
            ? 'Hapus pesan ini beserta balasan AI yang dihasilkan darinya?'
            : 'Hapus pesan ini?';
          if (confirm(prompt)) {
            const removed = await ChatStore.deleteMessage(msgId);
            Toast.info(removed > 1 ? `${removed} pesan dihapus.` : 'Pesan dihapus.');
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
          const innerEl = blockEl?.querySelector('.message-block-inner');
          if (!msgObj || !innerEl) return;

          // A tool-using message can render as several `.message-content`/
          // `.tool-inline-note` pairs (one per round, see renderMessageBodyHTML) -
          // editing swaps ALL of them for one textarea over the full `content`,
          // not just whichever segment happened to be the first DOM match.
          const footerEl = innerEl.querySelector('.message-footer');
          innerEl.querySelectorAll('.message-content, .tool-inline-note').forEach(el => el.remove());

          const editorHost = document.createElement('div');
          editorHost.className = 'message-content message-edit-host';
          editorHost.innerHTML = `
            <textarea class="textarea message-edit-textarea">${escapeHtml(msgObj.content)}</textarea>
            <div class="message-edit-actions">
              <button class="btn btn-primary btn-sm btn-save-edit">Simpan</button>
              <button class="btn btn-secondary btn-sm btn-cancel-edit">Batal</button>
            </div>
          `;
          if (footerEl) innerEl.insertBefore(editorHost, footerEl);
          else innerEl.appendChild(editorHost);

          const textarea = editorHost.querySelector('textarea');
          textarea.focus();

          // Cancel re-renders the message body from its still-unmodified store
          // data (rather than restoring stashed HTML) so it's correct whether
          // the message had one segment or several.
          const restoreBody = () => {
            editorHost.remove();
            syncMessageBody(innerEl, msgObj, (t, u, c) => this.formatRoleplayMarkdown(t, u, c), userName, charName);
          };

          editorHost.querySelector('.btn-cancel-edit').onclick = restoreBody;
          editorHost.querySelector('.btn-save-edit').onclick = async () => {
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
      const activeTools = await MCPToolRegistry.getActiveTools();
      const immersiveRoleplay = await MCPStore.getImmersiveRoleplay();

      const promptPayload = applyPrefill(genSettings, PromptBuilder.buildPromptPayload({
        character: activeChar,
        persona: activePersonaObj,
        globalSystemPrompt: globalPrompt,
        messages: currentMessages,
        contextLimit: genSettings.contextLimit || 20,
        tools: activeTools,
        immersiveRoleplay
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
          <div id="typing-indicator-content"></div>
        </div>
      `;
      messagesEl.appendChild(typingIndicator);
      scrollToBottom(messagesEl);

      activeAbortController = new AbortController();
      setGeneratingState(true);
      let liveContent = genSettings.prefillEnabled && genSettings.prefillText ? genSettings.prefillText : '';
      let liveThinking = '';
      let liveToolTrace = [];
      let liveToolCalls = []; // [{id, name, done}] - drives the live "Tools Used" box
      // Live-render-only state, separate from `liveContent` (which stays the
      // full joined-so-far text, still needed for the final/abort-partial
      // save): `liveSegments` is every round that's fully finished (tool call
      // included, straight from AgentRunner's `onRoundComplete` payload),
      // `currentRoundText` is just the round CURRENTLY streaming in, with no
      // `tools` yet. Rendering these separately (via `renderLiveBodyHTML`) is
      // what lets a tool marker appear the moment its round resolves, instead
      // of only once the whole turn commits and `renderMessages()` re-renders
      // from the persisted `toolSegments`.
      let liveSegments = [];
      let currentRoundText = liveContent;
      const typingPlaceholderHTML = `<em style="color:var(--text-dim);">${escapeHtml(activeChar.name)} sedang mengetik...</em>`;

      const typingInnerEl = typingIndicator.querySelector('.message-block-inner');
      const typingContentEl = typingIndicator.querySelector('#typing-indicator-content');
      typingContentEl.innerHTML = renderLiveBodyHTML(liveSegments, currentRoundText, typingPlaceholderHTML, (t) => this.formatRoleplayMarkdown(t));

      // Coalesce rapid/bursty chunk delivery into at most one DOM update per
      // ~50ms - see createThrottledRenderer's comment.
      const scheduleContentRender = createThrottledRenderer(() => {
        typingContentEl.innerHTML = renderLiveBodyHTML(liveSegments, currentRoundText, typingPlaceholderHTML, (t) => this.formatRoleplayMarkdown(t));
        scrollToBottom(messagesEl);
      });
      const scheduleThinkingRender = createThrottledRenderer(() => {
        syncThinkingBlock(typingInnerEl, liveThinking, { streaming: true });
        scrollToBottom(messagesEl);
      });

      try {
        const { content: finalContent, thinking: finalThinking, toolTrace: finalToolTrace, segments: finalSegments } = await AgentRunner.run({
          proxy: proxyObj,
          initialPayload: promptPayload,
          settings: genSettings,
          tools: activeTools,
          streaming: genSettings.streamingEnabled,
          signal: activeAbortController.signal,
          transformFirstResult: (result) => mergePrefillResult(genSettings, result),
          callbacks: {
            onContentChunk: (delta) => {
              liveContent += delta;
              currentRoundText += delta;
              scheduleContentRender();
            },
            onThinkingChunk: (delta) => {
              liveThinking += delta;
              scheduleThinkingRender();
            },
            onToolExecuting: (call) => {
              // Own live box, outside the thinking block, so it's never
              // confused with the model's actual reasoning - and never
              // overwrites the streamed reply text like it briefly did.
              // Flush first: streaming has just paused for the tool call, so
              // without this the lead-in text sits on screen missing whatever
              // arrived in the last throttle window for the tool's whole runtime.
              scheduleContentRender.flush();
              scheduleThinkingRender.flush();
              liveToolCalls.push({ id: call.id, name: call.name, done: false });
              syncLiveToolBox(typingInnerEl, liveToolCalls);
              scrollToBottom(messagesEl);
            },
            onToolResult: (call, result) => {
              liveToolTrace.push({ name: call.name, args: call.args, result });
              const entry = liveToolCalls.find(c => c.id === call.id);
              if (entry) entry.done = true;
              syncLiveToolBox(typingInnerEl, liveToolCalls);
              scrollToBottom(messagesEl);
            },
            onRoundComplete: ({ content, thinking, segments }) => {
              // ONE message per user turn, however many tool rounds it takes.
              // Re-seed the live buffers with everything accumulated so far
              // (AgentRunner already joined the rounds with a blank line) and
              // add the separator the next round's chunks will be appended
              // after - so the pre-tool narration stays on screen and the
              // post-tool text continues it, instead of the narration being
              // replaced (it "disappeared") or the next round being glued onto
              // a stale buffer with no separator (it read as duplicated text).
              liveContent = content ? `${content}\n\n` : '';
              liveThinking = thinking ? `${thinking}\n\n` : '';
              // `segments` already has this round's own tool call(s) attached
              // (AgentRunner built it before firing this callback) - adopt it
              // wholesale as the new "committed" set and start the next
              // round's text fresh, so the marker for the tool that JUST
              // finished shows up right now instead of waiting for the turn
              // to fully end.
              liveSegments = segments || [];
              currentRoundText = '';
              scheduleContentRender.flush();
              scheduleThinkingRender.flush();
              scrollToBottom(messagesEl);
            }
          }
        });

        typingIndicator.remove();

        // The single message for this whole turn: every round's narration
        // (joined by AgentRunner) plus every tool call it made along the way,
        // plus the per-round breakdown so the UI can place an inline marker at
        // each round's actual tool-call boundary instead of one note at the end.
        await ChatStore.addMessage(currentChatId, 'assistant', finalContent, finalThinking, [finalContent], finalToolTrace, finalSegments);
        await renderMessages();

        const updatedMessages = await ChatStore.getMessages(currentChatId);
        const chatObj = await ChatStore.getChatById(currentChatId);
        if (chatObj && !chatObj.titleEdited && updatedMessages.length % 10 === 0) {
          generateAutoTitle(chatObj, updatedMessages);
        }
      } catch (err) {
        typingIndicator.remove();
        if (err.name === 'AbortError') {
          // `liveContent`/`liveToolTrace` already span every round of this turn
          // (re-seeded at each round boundary), so an abort mid-tool-loop still
          // saves the earlier rounds' narration and tool calls, not just the last.
          // No `toolSegments` passed here deliberately: `liveContent` may include
          // a partial round's text beyond what the last `onRoundComplete` saw, so
          // there's no authoritative segment breakdown for it - this partial save
          // falls back to the old single-blob + trailing-note rendering, which is
          // exactly what that fallback path exists for.
          if (liveContent.trim() || liveToolTrace.length) {
            await ChatStore.addMessage(currentChatId, 'assistant', liveContent, liveThinking, [liveContent], liveToolTrace);
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
        await flushQueuedMessageIfAny();
      }
    };

    const sendMessageText = async (text) => {
      await ChatStore.addMessage(currentChatId, 'user', text);
      await renderMessages();
      await triggerAIGeneration();
    };

    const refreshQueuedIndicator = () => {
      const indicatorEl = container.querySelector('#queued-message-indicator');
      const textEl = container.querySelector('#queued-message-text');
      if (!indicatorEl || !textEl) return;
      indicatorEl.classList.toggle('hidden', !queuedMessage);
      if (queuedMessage) textEl.textContent = queuedMessage;
    };

    // A queued draft belongs to the session it was typed in - drop it
    // whenever `currentChatId` changes so it can never fire into a
    // different session than the one the user was looking at.
    const clearQueuedMessage = () => {
      queuedMessage = null;
      refreshQueuedIndicator();
    };

    // Bind this chat's own send/refresh closures as the target for the
    // module-level queue - a message queued while generating is in flight
    // gets flushed through here once the response finishes (see
    // flushQueuedMessageIfAny above).
    queuedMessageHandlers = { flush: sendMessageText, refreshIndicator: refreshQueuedIndicator };
    queuedMessage = null; // discard any leftover queue from a previous render/session
    refreshQueuedIndicator();

    const handleSendMessage = async () => {
      const text = sendInput.value.trim();
      if (!text) return;
      sendInput.value = '';

      if (isGenerating) {
        // Don't block drafting while the AI is responding - queue it and
        // send automatically once the in-flight generation ends.
        queuedMessage = text;
        refreshQueuedIndicator();
        Toast.info('Pesan diantrikan, akan dikirim setelah respons ini selesai.');
        return;
      }

      await sendMessageText(text);
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

    container.querySelector('#btn-cancel-queued').onclick = () => {
      if (!queuedMessage) return;
      sendInput.value = queuedMessage;
      queuedMessage = null;
      refreshQueuedIndicator();
      sendInput.focus();
    };

    newSessionBtn.onclick = async () => {
      const activePersonaObj = await PersonaStore.getDefault();
      const chatSessions = await ChatStore.getChatsByCharacter(selectedCharId);
      const newSession = await createChatWithGreeting(activePersonaObj?.id, `Session ${chatSessions.length + 1} - ${activeChar.name}`);
      currentChatId = newSession.id;
      clearQueuedMessage();
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
    const activeTools = await MCPToolRegistry.getActiveTools();
    const immersiveRoleplay = await MCPStore.getImmersiveRoleplay();

    // History up to the message before this assistant message
    const historyBefore = msgs.slice(0, msgIndex);
    const promptPayload = applyPrefill(genSettings, PromptBuilder.buildPromptPayload({
      character: activeChar,
      persona: activePersonaObj,
      globalSystemPrompt: globalPrompt,
      messages: historyBefore,
      contextLimit: genSettings.contextLimit || 20,
      tools: activeTools,
      immersiveRoleplay
    }));

    activeAbortController = new AbortController();
    setGeneratingState(true);

    const messagesEl = document.getElementById('messages-container');
    const blockInnerEl = document.querySelector(`.message-block[data-id="${messageId}"] .message-block-inner`);
    const userName = activePersonaObj?.name || 'User';
    const charName = activeChar?.name || 'Character';

    // Remove any stale thinking/tool blocks AND the previous variation's whole
    // content area before starting generation - a variation that involved tool
    // calls may have left behind several `.message-content` segments + inline
    // markers, not just one. A single fresh `.message-content` is (re)built
    // below to hold the live streaming text; once the new variation is actually
    // persisted, `onDone` -> `refreshMessageBlock` rebuilds the final (possibly
    // re-segmented) DOM from the stored message.
    if (blockInnerEl) {
      const staleThinking = blockInnerEl.querySelector('.thinking-block');
      if (staleThinking) staleThinking.remove();
      const staleTrace = blockInnerEl.querySelector('.tool-trace-block');
      if (staleTrace) staleTrace.remove();
      const staleLive = blockInnerEl.querySelector('.tool-live-block');
      if (staleLive) staleLive.remove();
      blockInnerEl.querySelectorAll('.message-content, .tool-inline-note').forEach(el => el.remove());
    }

    // Wrapper host, not itself `.message-content` - a live variation can
    // involve several `.message-content`/`.tool-inline-note` pairs once tool
    // calls are involved (see `renderLiveBodyHTML`), same as a persisted
    // multi-segment message does.
    const contentHostEl = document.createElement('div');
    if (blockInnerEl) {
      const footerEl = blockInnerEl.querySelector('.message-footer');
      if (footerEl) blockInnerEl.insertBefore(contentHostEl, footerEl);
      else blockInnerEl.appendChild(contentHostEl);
    }

    const restoreOriginal = () => {
      if (blockInnerEl) {
        // Rebuilds from the pre-swipe `msg` as-is (segmented if it already had
        // `toolSegments`, same fallback rendering otherwise) - restoring the
        // exact state the block was in before this swipe attempt started.
        syncMessageBody(blockInnerEl, msg, (t, u, c) => ChatView.formatRoleplayMarkdown(t, u, c), userName, charName);
        syncThinkingBlock(blockInnerEl, (msg.thoughts || '').trim(), { streaming: false });
        syncToolTraceBlock(blockInnerEl, Array.isArray(msg.toolTrace) ? msg.toolTrace : []);
        syncLiveToolBox(blockInnerEl, []);
      }
    };
    let liveContent = genSettings.prefillEnabled && genSettings.prefillText ? genSettings.prefillText : '';
    let liveThinking = '';
    let liveToolTrace = [];
    let liveToolCalls = []; // [{id, name, done}] - drives the live "Tools Used" box
    // See the matching declarations in `triggerAIGeneration` - `liveSegments`/
    // `currentRoundText` drive the live inline-marker rendering, kept separate
    // from `liveContent` (which stays the full joined-so-far text needed for
    // the final/abort-partial swipe save).
    let liveSegments = [];
    let currentRoundText = liveContent;
    const swipePlaceholderHTML = '<em style="color:var(--text-dim);">Menggenerasi variasi baru...</em>';

    // Coalesce rapid/bursty chunk delivery into at most one DOM update per
    // ~50ms - see createThrottledRenderer's comment.
    const scheduleContentRender = createThrottledRenderer(() => {
      if (contentHostEl) contentHostEl.innerHTML = renderLiveBodyHTML(liveSegments, currentRoundText, swipePlaceholderHTML, (t) => ChatView.formatRoleplayMarkdown(t));
      scrollToBottom(messagesEl);
    });
    const scheduleThinkingRender = createThrottledRenderer(() => {
      if (blockInnerEl) syncThinkingBlock(blockInnerEl, liveThinking, { streaming: true });
      scrollToBottom(messagesEl);
    });

    try {
      // Non-streaming mode has nothing to progressively render (the whole
      // reply arrives at once at the end), so this always just shows the
      // placeholder wrapped the same way `renderLiveBodyHTML` would wrap real
      // content - keeping `.message-content`'s own styling (font-size,
      // line-height) rather than leaving the `<em>` as a bare, unstyled child
      // of `contentHostEl`.
      if (contentHostEl) {
        contentHostEl.innerHTML = genSettings.streamingEnabled
          ? renderLiveBodyHTML(liveSegments, currentRoundText, swipePlaceholderHTML, (t) => ChatView.formatRoleplayMarkdown(t))
          : `<div class="message-content">${swipePlaceholderHTML}</div>`;
      }

      const { content: newContent, thinking: newThinking, toolTrace, segments: newSegments } = await AgentRunner.run({
        proxy: activeProxy,
        initialPayload: promptPayload,
        settings: genSettings,
        tools: activeTools,
        streaming: genSettings.streamingEnabled,
        signal: activeAbortController.signal,
        transformFirstResult: (result) => mergePrefillResult(genSettings, result),
        callbacks: {
          onContentChunk: (delta) => {
            liveContent += delta;
            currentRoundText += delta;
            scheduleContentRender();
          },
          onThinkingChunk: (delta) => {
            liveThinking += delta;
            scheduleThinkingRender();
          },
          onToolExecuting: (call) => {
            // Own live box, outside the thinking block - never overwrites
            // the streamed reply text in `contentHostEl`. Flush first so the
            // lead-in text isn't left missing its last throttle window's
            // characters for the whole time the tool runs.
            scheduleContentRender.flush();
            scheduleThinkingRender.flush();
            liveToolCalls.push({ id: call.id, name: call.name, done: false });
            if (blockInnerEl) syncLiveToolBox(blockInnerEl, liveToolCalls);
            scrollToBottom(messagesEl);
          },
          onToolResult: (call, result) => {
            liveToolTrace.push({ name: call.name, args: call.args, result });
            const entry = liveToolCalls.find(c => c.id === call.id);
            if (entry) entry.done = true;
            if (blockInnerEl) syncLiveToolBox(blockInnerEl, liveToolCalls);
            scrollToBottom(messagesEl);
          },
          onRoundComplete: ({ content, thinking, segments }) => {
            // Same single-message rule as triggerAIGeneration. Previously the
            // swipe path wired NO round-boundary callback at all, so round 2's
            // chunks were concatenated straight onto round 1's still-displayed
            // text with no separator (the "double chat" garbling) and the
            // persisted variation then kept only the final round's text.
            liveContent = content ? `${content}\n\n` : '';
            liveThinking = thinking ? `${thinking}\n\n` : '';
            liveSegments = segments || [];
            currentRoundText = '';
            scheduleContentRender.flush();
            scheduleThinkingRender.flush();
            scrollToBottom(messagesEl);
          }
        }
      });

      const updatedSwipes = [...(msg.swipes || [msg.content]), newContent];
      const newIndex = updatedSwipes.length - 1;
      await ChatStore.updateMessageSwipes(messageId, updatedSwipes, newIndex, newThinking, toolTrace, newSegments);
      onDone();
    } catch (err) {
      if (err.name === 'AbortError') {
        if (liveContent.trim()) {
          // No `toolSegments` passed here, same reasoning as the abort-partial
          // path in `triggerAIGeneration`: `liveContent` may include a partial
          // round's text beyond what the last `onRoundComplete` saw, so there's
          // no authoritative segment breakdown - falls back to the old
          // single-blob + trailing-note rendering.
          const updatedSwipes = [...(msg.swipes || [msg.content]), liveContent];
          const newIndex = updatedSwipes.length - 1;
          await ChatStore.updateMessageSwipes(messageId, updatedSwipes, newIndex, liveThinking, liveToolTrace);
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
      await flushQueuedMessageIfAny();
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

/* js/ui/views/chatView.js - Dedicated Chat Page (Response Swiping on Last Message) */
import { CharacterStore } from '../../storage/characterStore.js';
import { ChatStore } from '../../storage/chatStore.js';
import { PersonaStore } from '../../storage/personaStore.js';
import { ProxyStore } from '../../storage/proxyStore.js';
import { PromptBuilder } from '../../services/promptBuilder.js';
import { ProviderManager } from '../../services/providerManager.js';
import { MCPToolRegistry } from '../../services/mcpToolRegistry.js';
import { AgentRunner } from '../../services/agentRunner.js';
import { getBuiltinTools, BUILTIN_EMBED_HTML_TOOL } from '../../services/builtinTools.js';
import { supportsVision } from '../../utils/modelVision.js';
import { readFileAsDataURL, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE } from '../../utils/imageUtils.js';
import { estimateTokens } from '../../utils/tokenEstimate.js';
import { getContextWindowSize } from '../../utils/contextWindowSize.js';
import { GreetingWizardService, GREETING_WIZARD_TOTAL_QUESTIONS } from '../../services/greetingWizardService.js';
import { MCPStore } from '../../storage/mcpStore.js';
import { MCPClient, isTransportUnsupportedHere, UNSUPPORTED_TRANSPORT_REASON } from '../../services/mcpClient.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { ProxiesView } from './proxiesView.js';
import { SettingsView } from './settingsView.js';
import { MCPView, INTENSITY_LABELS, MCP_INTENSITY_HINTS } from './mcpView.js';
import { dropdownHTML, wireDropdown, setDropdownOptions, setDropdownDisabled, setDropdownValue } from '../components/dropdown.js';
import { toggleSwitchHTML, toggleRowHTML } from '../components/toggle.js';
import { openModelPickerSheet } from '../components/modelPickerSheet.js';
import { attachSheetDragToClose, dismissSheet } from '../components/sheetGesture.js';
import { escapeHtml, escapeAttr, unescapeHtml } from '../../utils/sanitize.js';
import { extractThinking } from '../../utils/thinkingParser.js';
import { replaceMacros } from '../../utils/macroReplacer.js';
import { highlightCode } from '../../utils/syntaxHighlight.js';

/**
 * Custom fenced-code-block/inline-code renderers, registered once at module
 * load (js/vendor/marked.min.js is loaded as a plain <script> before this
 * module, so `window.marked` already exists here).
 *
 * WHY this is needed at all: formatRoleplayMarkdown() below escapeHtml()'s
 * the WHOLE message before handing it to marked.parse() - the load-bearing
 * XSS guard for chat content. marked's OWN default code/codespan renderers
 * then escape the text again when building their output, since they assume
 * they're receiving raw unescaped markdown source. The result was visible
 * double-escaping - a literal "<!DOCTYPE html>" in a code block rendered as
 * the LITERAL TEXT "&lt;!DOCTYPE html&gt;" instead of the angle brackets.
 * These renderers unescapeHtml() the token's text back to the original
 * characters first, then build the output HTML themselves (via
 * highlightCode(), which re-escapes exactly once as it emits highlight
 * spans) - so escaping happens exactly once, end to end.
 */
if (window.marked) {
  window.marked.use({
    renderer: {
      code({ text, lang }) {
        const rawCode = unescapeHtml(text);
        const langLabel = (lang || '').trim().split(/\s+/)[0] || '';
        const highlighted = highlightCode(rawCode, langLabel);
        return `
          <div class="code-block-wrap">
            <div class="code-block-header">
              <span class="code-block-lang">${escapeHtml(langLabel || 'text')}</span>
              <button type="button" class="code-copy-btn" data-code="${escapeAttr(rawCode)}">Copy</button>
            </div>
            <pre><code class="language-${escapeAttr(langLabel)}">${highlighted}</code></pre>
          </div>
        `;
      },
      codespan({ text }) {
        return `<code>${escapeHtml(unescapeHtml(text))}</code>`;
      }
    }
  });
}

// Module-level generation state - only one ChatView is ever mounted at a time
// in this SPA, so a shared abort/generating flag is simpler than threading it
// through every closure and the static swipe handlers.
let activeAbortController = null;
let isGenerating = false;

// Set by render(), invoked by the static teardown() below (called from
// App.navigate() right before it wipes #view-container's innerHTML - see
// CLAUDE.md's chatView-internals notes) and re-checked at the start of the
// next render() as a belt-and-braces cleanup of a stale previous mount.
// Covers every way the chat view can go away mid-generation, not just the
// dedicated Back button: sidebar nav, a hashchange from a link inside a chat
// message (`[x](#settings)` renders as a real link), Ctrl+./Alt+C leading
// elsewhere, etc. Without this, an open MCP tool-permission prompt's promise
// never settles (nothing left to click, and no abort was ever issued), which
// hangs AgentRunner's tool loop forever and leaves `isGenerating` - a
// module-level singleton shared by the whole app - stuck true, silently
// blocking every future generation in every chat until app restart.
let activeChatTeardown = null;

// A message typed/submitted while a generation is already in flight - kept
// here (not disabling the composer) so the user can keep drafting instead of
// waiting; auto-sent once the in-flight generation ends (success or abort).
// `queuedMessageHandlers` is (re)bound by ChatView.render() to the currently
// mounted chat's own send/refresh closures.
let queuedMessage = null;
let queuedImages = []; // images attached to the queued message, if any - see pendingAttachedImages below
let queuedMessageHandlers = null; // { flush(text, images): Promise<void>, refreshIndicator(): void }

// Images attached via the composer's "+" button but not sent yet - same
// module-level/singleton reasoning as `queuedMessage` above, and cleared
// alongside it in `clearQueuedMessage()` so a draft attachment can never leak
// into a different session than the one it was picked in.
let pendingAttachedImages = [];

// Compact Chat recommendation - in-memory-only "already dismissed/offered"
// tracking, keyed by chatId. Deliberately NOT persisted to IndexedDB: this is
// a light nudge, not a setting, so it resets on app restart rather than
// permanently silencing the recommendation for a chat the user is still
// actively growing.
const compactDismissedChats = new Set();
const COMPACT_RECOMMEND_THRESHOLD = 40;
// The character's opening + earliest scene-setting turns - never folded into
// the AI summary, so the new chat still opens the same way the original did.
const COMPACT_KEEP_FIRST = 4;
// The most recent turns - also never folded into the summary, so the new
// chat can pick the scene back up immediately instead of the newest message
// only surviving however well the AI's prose recap happened to capture it.
const COMPACT_KEEP_LAST = 4;

// Auto session-title generation cadence: a fresh session's default title is
// generic ("Session 1 - <char>"), so the first real title comes early (as
// soon as there's enough conversation to summarize) and then gets refreshed
// periodically as the scene moves on - but not on every single message,
// which would burn a title-generation call per turn for no real benefit.
const AUTO_TITLE_FIRST_AT = 3;
const AUTO_TITLE_INTERVAL = 15;

/** Whether `messageCount` lands on an auto-title generation point - the
 * first-ever title at AUTO_TITLE_FIRST_AT messages, then every
 * AUTO_TITLE_INTERVAL messages on a fixed grid after that (not counted
 * onward from the first trigger - simpler to reason about, and the two
 * numbers are close enough that the difference is immaterial in practice). */
function isAutoTitlePoint(messageCount) {
  return messageCount === AUTO_TITLE_FIRST_AT || messageCount % AUTO_TITLE_INTERVAL === 0;
}

async function flushQueuedMessageIfAny() {
  if ((!queuedMessage && !queuedImages.length) || !queuedMessageHandlers) return;
  const next = queuedMessage;
  const nextImages = queuedImages;
  queuedMessage = null;
  queuedImages = [];
  queuedMessageHandlers.refreshIndicator();
  await queuedMessageHandlers.flush(next || '', nextImages);
}

// Wrench icon used on the "Tools Used" chip so an MCP-tool-triggering message
// is visually distinguishable from a plain thinking block at a glance.
const WRENCH_ICON_SVG = '<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"></path></svg>';

/**
 * Seed for the dicebear avatar fallback used in the inline onerror handlers.
 * encodeURIComponent deliberately does NOT escape `'`, which would otherwise
 * terminate the single-quoted JS string literal inside onerror="..." and let
 * an imported character/persona name execute arbitrary script.
 */
function avatarSeed(name) {
  return encodeURIComponent(name || '').replace(/'/g, '%27');
}

/**
 * OpenRouter/custom model ids look like "deepseek/deepseek-v4-flash-0731" or
 * "z-ai/glm-5.2" - drops the "owner/" segment before the last "/", turns "-"
 * into spaces, and capitalizes each word's first letter, so the chat
 * composer's model picker (populateModelSelect below) shows "Deepseek V4
 * Flash 0731" / "Glm 5.2" instead of the raw slug. Only the display label
 * changes - selection/config still uses the untouched raw id as `value`.
 */
function formatModelLabel(modelId) {
  const name = modelId.includes('/') ? modelId.slice(modelId.lastIndexOf('/') + 1) : modelId;
  return name
    .replace(/-/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

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
 * Estimates token count for thinking text - thin wrapper over the shared
 * estimator (js/utils/tokenEstimate.js), kept as its own named function since
 * every call site here reads as "thinking tokens" specifically.
 */
function estimateThinkingTokens(thinkingText = '') {
  return estimateTokens(thinkingText);
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
 * `createLiveBodyHost`) so inline tool markers can sit between them. Returns
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
 * Structured "Tools Used" content - one card per call (name, pretty-printed
 * + syntax-highlighted JSON args, result text) instead of the old single
 * wall of escaped plain text (`name(args)\n→ result` for every call joined
 * by blank lines), which read as an undifferentiated dump once there was
 * more than one call or the args/result were non-trivial. Declined calls get
 * a visible badge instead of just reading TOOL_DECLINED_NOTICE as if it were
 * a normal result. Excludes the builtin Embed HTML tool entirely (see
 * `visibleToolTrace`) - `toolTrace` passed in here should already be
 * pre-filtered by the caller, this only re-filters defensively.
 */
function toolTraceDetailHTML(toolTrace = []) {
  const visible = visibleToolTrace(toolTrace);
  if (!visible.length) return '';
  return visible.map(t => {
    let argsJson;
    try {
      argsJson = JSON.stringify(t.args ?? {}, null, 2);
    } catch {
      argsJson = String(t.args);
    }
    return `
      <div class="tool-trace-entry">
        <div class="tool-trace-entry-head">
          <span class="tool-trace-entry-name">${escapeHtml(t.name)}</span>
          ${t.declined ? '<span class="tool-trace-entry-declined">Declined</span>' : ''}
        </div>
        <pre class="tool-trace-entry-args"><code>${highlightCode(argsJson, 'json')}</code></pre>
        ${!t.declined ? `<div class="tool-trace-entry-result">${escapeHtml(t.result || '')}</div>` : ''}
      </div>
    `;
  }).join('');
}

/**
 * Creates/updates/removes a message's collapsible "Tools Used" block to match
 * `toolTrace` (an array of {name,args,result}) - used when a swipe variation
 * is switched to, so a stale tool-trace from a different variation isn't left
 * displayed alongside the newly-shown content. Visibility/the call-count
 * badge are both driven by `visibleToolTrace(toolTrace)` (excludes the
 * builtin Embed HTML tool - see that function) rather than the raw array, so
 * a round that ONLY called the embed tool doesn't leave behind an oddly
 * empty "Tools Used (1 call)" box.
 *
 * Inserted BEFORE the thinking-block if one exists (falling back to right
 * before the content area otherwise) so "Tools Used" always sits above
 * "Thinking" regardless of which of the two syncs runs first - the model
 * decided to use tools, then reasoned/replied using what came back, so the
 * tool activity reads as the earlier step.
 */
function syncToolTraceBlock(containerEl, toolTrace = []) {
  if (!containerEl) return;
  const contentEl = findContentAnchor(containerEl);
  const thinkingEl = containerEl.querySelector('.thinking-block');
  let block = containerEl.querySelector('.tool-trace-block');

  const visible = visibleToolTrace(toolTrace);
  if (!visible.length) {
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
    const anchor = thinkingEl || contentEl;
    if (anchor) containerEl.insertBefore(block, anchor);
    else containerEl.appendChild(block);
  }

  block.querySelector('.thinking-token-badge').textContent = `${visible.length} call${visible.length > 1 ? 's' : ''}`;
  block.querySelector('.thinking-content').innerHTML = toolTraceDetailHTML(toolTrace);
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
 * Flattens every `images` array a `toolTrace` entry carries (currently only
 * the builtin view-image tool ever sets one, see agentRunner.js) into a
 * single list - what actually gets persisted as the message's own `images`
 * field, so a fetched image renders in chat via the exact same
 * messageImagesHTML() thumbnail path a user-uploaded image uses.
 */
function collectToolImages(toolTrace = []) {
  return toolTrace.flatMap(t => (t && Array.isArray(t.images)) ? t.images : []);
}

/**
 * Same pattern as `collectToolImages` above, for the builtin "Embed HTML"
 * tool (js/services/builtinTools.js): flattens every `{html, htmlTitle}` a
 * `toolTrace` entry carries (see agentRunner.js's dispatch of
 * BUILTIN_EMBED_HTML_TOOL) into the `{html, title}` array shape persisted as
 * the message's own `embeds` field, rendered by `messageEmbedsHTML()` below.
 * A declined call never has `.html` set (agentRunner.js only attaches it on
 * a successful, allowed execution), so this naturally excludes those too.
 */
function collectToolEmbeds(toolTrace = []) {
  return toolTrace
    .filter(t => t && typeof t.html === 'string' && t.html)
    .map(t => ({ html: t.html, title: t.htmlTitle || '' }));
}

/**
 * Drops builtin Embed HTML calls from anything that displays a raw tool
 * NAME/count (the inline marker, the live "Tools Used" spinner box, the
 * collapsible trace listing) - the embed card itself (messageEmbedsHTML(),
 * rendered separately and unaffected by this filter) is already visible
 * proof it ran, so a redundant "builtin__embed_html" label next to it is
 * just technical noise. A round that called ONLY the embed tool ends up with
 * no note/badge at all, which is the intended outcome, not a bug.
 */
function visibleToolTrace(toolTrace = []) {
  return (toolTrace || []).filter(t => t && t.name !== BUILTIN_EMBED_HTML_TOOL);
}

/**
 * HTML for one `.tool-inline-note` marker covering a group of tool call(s)
 * (comma-joined + de-duplicated names, same as the old whole-message note),
 * or '' if that group called no (visible - see `visibleToolTrace`) tools.
 * When the group represents more than one individual call - several rounds
 * merged together with no narration text between them (see
 * `renderMessageBodyHTML`), or just several tools called in one round - a
 * "(Nx)" count is appended so calling the same tool repeatedly doesn't
 * silently collapse into a single name with no indication it happened more
 * than once. Applies the same way whether the merged calls are the same tool
 * repeated or different tools, per the user's request. Tool names come from
 * user-configured MCP servers, so they're escaped.
 */
function toolInlineNoteHTML(toolTrace = []) {
  const visible = visibleToolTrace(toolTrace);
  const names = toolTraceNames(visible);
  if (!names) return '';
  const suffix = visible.length > 1 ? ` (${visible.length}x)` : '';
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
 * `renderMessageBodyHTML` (persisted messages) and `liveCommittedGroupsHTML`
 * (mid-generation, via `createLiveBodyHost`) so both apply the exact same grouping.
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
/**
 * Thumbnail strip for a message's attached images - a user's composer upload
 * on a 'user' message, or something the builtin view-image tool fetched
 * mid-reply on an 'assistant' message (see ChatStore.addMessage's JSDoc).
 * Data URLs are app-generated (FileReader output / fetched image bytes), not
 * model/character text, but still run through `escapeAttr` for consistency
 * with every other `src=` in this file.
 */
function messageImagesHTML(msg) {
  if (!Array.isArray(msg.images) || !msg.images.length) return '';
  return `<div class="message-image-row">${msg.images.map(src =>
    `<img class="message-image-thumb" src="${escapeAttr(src)}" alt="">`
  ).join('')}</div>`;
}

/**
 * Whether the app is CURRENTLY showing the dark palette - mirrors the same
 * resolution js/ui/theme.js's applyThemeMode() uses: an explicit
 * `data-theme` attribute wins, 'auto' (the attribute is absent) falls back
 * to the OS media query. Needed because a sandboxed iframe is a fully
 * separate document - it does NOT inherit the parent page's CSS custom
 * properties, so an embed rendered with no explicit styling of its own used
 * to default to the BROWSER's baseline white-background/black-text look
 * regardless of the app's theme. See buildEmbedDocument() below.
 */
function isDarkThemeActive() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/**
 * Resolves the handful of CSS custom properties an embedded document needs
 * to LOOK like part of the current chat theme, as literal computed values
 * (a var(--x) reference is meaningless inside the iframe's own separate
 * document - it has no access to this page's :root).
 */
function getEmbedThemeVars() {
  const cs = getComputedStyle(document.documentElement);
  const dark = isDarkThemeActive();
  const read = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  return {
    scheme: dark ? 'dark' : 'light',
    text: read('--text-main', dark ? '#e2e8f0' : '#1e293b'),
    accent: read('--accent-primary', '#4f46e5'),
    font: read('--font-family', 'system-ui, sans-serif')
  };
}

// Injected into every embed document, providing capabilities a sandboxed
// (deliberately no allow-same-origin - see messageEmbedsHTML's security
// note) iframe has no other way to reach the parent page for:
//   - auto-reporting its real content height back (the 'message' listener
//     wired in render() below) - the parent can't just read
//     contentDocument.body.scrollHeight directly across the sandbox boundary.
//   - `fillChatInput(text)`, a global function the model's own embed HTML can
//     call (e.g. from a <button onclick>) to put text into the chat composer
//     - lets an embed offer clickable options/choices the user can send or
//     edit, instead of only ever being a passive visual.
//   - auto-wiring any element carrying a `data-fill-text="..."` attribute to
//     call fillChatInput() with that exact attribute value on click, with NO
//     onclick/JS needed from the model at all. This is the RECOMMENDED way
//     (see EMBED_HTML_DESCRIPTOR in builtinTools.js) specifically because a
//     model writing `onclick="fillChatInput('...')"` by hand has to
//     correctly escape any single-quote inside the text - and natural
//     dialogue is full of contractions ("don't", "I'll", "you're") that
//     silently truncate/break the whole handler the moment one goes
//     unescaped (confirmed live: a real generated embed had exactly this
//     bug on every option containing a contraction). Reading a plain HTML
//     attribute via getAttribute() instead sidesteps JS-string-literal
//     escaping entirely - HTML attribute parsing only breaks on the
//     attribute's own OWN quote character, and this tool always writes
//     double-quoted attributes, which plain English dialogue essentially
//     never contains.
const EMBED_RUNTIME_SCRIPT = `<script>(function(){
function reportHeight(){
  try {
    var h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    parent.postMessage({ type: 'nnzrp-embed-resize', height: h }, '*');
  } catch (e) {}
}
window.fillChatInput = function(text){
  try {
    parent.postMessage({ type: 'nnzrp-embed-fill-input', text: String(text == null ? '' : text) }, '*');
  } catch (e) {}
};
document.addEventListener('click', function(ev){
  var el = ev.target && ev.target.closest ? ev.target.closest('[data-fill-text]') : null;
  if (el) fillChatInput(el.getAttribute('data-fill-text'));
});
window.addEventListener('load', reportHeight);
if (window.ResizeObserver && document.body) new ResizeObserver(reportHeight).observe(document.body);
setTimeout(reportHeight, 60);
setTimeout(reportHeight, 300);
})();</script>`;

/**
 * Wraps the model's raw HTML with a small reset stylesheet (transparent
 * background + theme-matched text/link/selection colors, so unstyled
 * elements blend into the current chat theme instead of defaulting to a
 * plain white box) and the runtime script above (resize handshake +
 * `fillChatInput`).
 *
 * An earlier version tried to splice the style/script into wherever the
 * model's own `<head>`/`</body>` happened to be, found via regex - which
 * broke silently and unpredictably depending on exactly how the model
 * formatted its HTML (a `<head>` with unusual attributes, a missing
 * `</body>`, a full document that omitted `<html>`, etc.), and even when it
 * DID match, the script landed at the very END of the document - so if the
 * model's OWN script tried to call `fillChatInput` synchronously (not from a
 * later click handler) it could run before the runtime script defining it
 * had executed yet. Reported as "the button sometimes just doesn't work,
 * weirdly" - exactly the kind of intermittent failure that formatting-
 * dependent regex splicing produces.
 *
 * Now: the style+script are always inserted as close to the very START of
 * the document as possible, unconditionally, no head/body detection at all -
 * `<style>`/`<script>` tags are valid ANYWHERE in an HTML document per the
 * HTML5 parsing algorithm (a browser hoists them into an implied `<head>`
 * even with no explicit `<head>`/`<html>` wrapper), and script execution
 * order is what actually matters for `fillChatInput` to be defined before
 * anything can call it - putting it first guarantees that regardless of how
 * the rest of the model's document is shaped. The one exception: if the
 * model's HTML starts with `<!DOCTYPE html>`, that has to stay the LITERAL
 * first thing in the document or the browser drops into quirks mode (a real
 * rendering behavior change, not just a technicality) - so in that case the
 * insertion point is right after the doctype instead of before it.
 */
function buildEmbedDocument(rawHtml) {
  const theme = getEmbedThemeVars();
  const style = `<style>
    :root { color-scheme: ${theme.scheme}; }
    html, body { margin:0; padding:0.65rem; background:transparent; color:${theme.text}; font-family:${theme.font}; font-size:14px; }
    a { color:${theme.accent}; }
    ::selection { background:${theme.accent}; color:#fff; }
  </style>`;
  const prefix = style + EMBED_RUNTIME_SCRIPT;

  const doctypeMatch = /^\s*<!doctype html[^>]*>/i.exec(rawHtml);
  if (doctypeMatch) {
    const end = doctypeMatch[0].length;
    return rawHtml.slice(0, end) + prefix + rawHtml.slice(end);
  }
  return prefix + rawHtml;
}

/**
 * Renders a `[{html, title}]` list (see `collectToolEmbeds` above - either
 * one round's own slice of a live/persisted toolTrace, or the whole
 * message's flat `msg.embeds` fallback, see the two call sites below) as one
 * SANDBOXED iframe per entry, sitting directly in the message flow with NO
 * visible chrome at all (no card border/background, no "AI-generated embed"
 * label) - any visible technical label read as breaking immersion/feeling
 * bolted onto the chat instead of part of it. `e.title` (model-generated) is
 * only used as the iframe's `title` ATTRIBUTE now (screen-reader-only, never
 * painted on screen), not a visible caption. Called from BOTH
 * `renderMessageBodyHTML` (per round, right where that round's tool marker
 * sits - not appended once at the bottom regardless of which round produced
 * it) and `liveCommittedGroupsHTML` (same per-round placement, live, the
 * moment a streaming round's tool call resolves rather than waiting for the
 * whole turn to finish).
 * This is the security-critical render path for that tool:
 *   - `sandbox="allow-scripts"` and NOTHING else. Deliberately no
 *     `allow-same-origin` - omitting it is what gives the iframe a unique,
 *     opaque origin even though scripts run inside it, so an embedded script
 *     can't reach this window, can't read/write the app's DOM, can't touch
 *     IndexedDB/localStorage, and has no path to Node/Electron internals
 *     (this renderer already runs with `nodeIntegration:false`). No
 *     `allow-forms`/`allow-popups`/`allow-modals`/`allow-top-navigation`
 *     either - no form posts, no popup spam, no alert()/confirm()/prompt()
 *     floods, no navigating the app away.
 *   - Content is set via the `srcdoc` ATTRIBUTE (not `src="data:..."`), the
 *     standard way to hand an iframe inline sandboxed markup. The document
 *     text (see buildEmbedDocument()) is model-generated untrusted content,
 *     so it goes through `escapeAttr()` same as every other attribute value
 *     in this file - the browser HTML-decodes the attribute value back into
 *     the iframe's srcdoc document, so entity-escaping here is exactly the
 *     correct (and only) encoding step, not a double-escape.
 *   - Starts at a small placeholder height and grows to fit its own content
 *     via the postMessage height report (see the 'message' listener in
 *     render()) instead of a fixed box that's mostly empty for small embeds
 *     - clamped both directions there so one runaway/huge embed still can't
 *     blow out the chat layout.
 */
function embedCardsHTML(embeds = []) {
  const list = (embeds || []).filter(e => e && e.html);
  if (!list.length) return '';
  // `data-raw-html` carries the RAW, un-processed model-authored HTML (not
  // the wrapped buildEmbedDocument() output actually running in the iframe) -
  // purely for the hidden Ctrl+Alt+D debug shortcut (see handleKeydown below)
  // to read back out. escapeAttr()'d same as every other attribute value in
  // this file; the browser HTML-decodes it back to the exact original string
  // when read via `.dataset.rawHtml`.
  return list.map(e => `
    <div class="message-embed-card" data-raw-html="${escapeAttr(e.html)}">
      <iframe class="message-embed-frame" sandbox="allow-scripts" title="${escapeAttr(e.title || 'Embedded content')}" srcdoc="${escapeAttr(buildEmbedDocument(e.html))}"></iframe>
    </div>
  `).join('');
}

// Whole-message fallback (see renderMessageBodyHTML's non-segmented branch
// below) - only used when there's no per-round toolSegments data to place an
// embed at its actual call site, e.g. messages persisted before toolSegments
// existed. `msg.embeds` (ChatStore.addMessage's field) is the same
// {html,title} shape embedCardsHTML expects.
function messageEmbedsHTML(msg) {
  return embedCardsHTML(msg.embeds);
}

function renderMessageBodyHTML(msg, formatFn, userName, charName) {
  if (hasToolSegments(msg)) {
    const groups = groupToolSegments(msg.toolSegments);
    // Embeds render at the exact point the round that produced them sits in
    // the message - immediately after that round's inline tool marker -
    // instead of every embed in the whole message being appended once at
    // the very bottom regardless of which round actually called the tool.
    return messageImagesHTML(msg) + groups.map(g => g.type === 'text'
      ? `<div class="message-content" data-msgid="${msg.id}">${formatFn(g.text, userName, charName)}</div>`
      : toolInlineNoteHTML(g.tools) + embedCardsHTML(collectToolEmbeds(g.tools))
    ).join('');
  }
  // No toolSegments (old data, or a tool-less message) - no per-round
  // boundary to place an embed at, so it falls back to the old
  // whole-message-appended-at-the-end placement via messageEmbedsHTML(msg).
  const toolTrace = Array.isArray(msg.toolTrace) ? msg.toolTrace : [];
  const text = formatFn(msg.content, userName, charName);
  return `${messageImagesHTML(msg)}<div class="message-content" data-msgid="${msg.id}">${text}</div>${toolInlineNoteHTML(toolTrace)}${messageEmbedsHTML(msg)}`;
}

function liveCommittedGroupsHTML(committedSegments, formatFn) {
  const groups = groupToolSegments(committedSegments);
  return groups.map(g => g.type === 'text'
    ? `<div class="message-content">${formatFn(g.text)}</div>`
    : toolInlineNoteHTML(g.tools) + embedCardsHTML(collectToolEmbeds(g.tools))
  ).join('');
}

function liveCurrentTextHTML(currentText, placeholderHTML, formatFn) {
  return currentText.trim()
    ? `<div class="message-content">${formatFn(currentText)}</div>`
    : `<div class="message-content">${placeholderHTML}</div>`;
}

/**
 * Live counterpart to `renderMessageBodyHTML`, used while a turn is still
 * streaming so tool markers (and, same as the persisted path above, any
 * embed a round's tool call produced) appear AS SOON AS that round resolves
 * instead of only once the whole turn is persisted. Returns an incremental
 * updater rather than an HTML string, driving the host element
 * (`triggerAIGeneration`'s typing indicator, `handleSwipeNext`'s swipe
 * preview) across every throttled content chunk while generating:
 *
 * An earlier version just built one HTML string (committed segments +
 * current streaming text) and assigned it wholesale to the host's
 * `innerHTML` on EVERY chunk - harmless for plain text, but it also
 * destroyed and recreated any already-finished round's embed iframe
 * (`embedCardsHTML`/`.message-embed-frame`) each time, which re-fired that
 * iframe's `load` event, re-ran its resize handshake, and re-played its
 * grow-in height transition on every single streamed chunk for the rest of
 * the turn - a distracting flash/repeat instead of the one-time entrance it
 * was meant to be.
 *
 * This splits the host into two sub-divs instead: `committedHost` (finished
 * rounds - text, tool markers, embeds; `committedSegments` is the `segments`
 * array `AgentRunner`'s `onRoundComplete` hands back each round boundary,
 * every round's toolTrace entries and any `.html`/`.htmlTitle` they carry
 * already attached) only gets rebuilt when `liveSegments` itself changes (a
 * new round just completed - `onRoundComplete` always REASSIGNS
 * `liveSegments` to a new array rather than mutating one in place, so a
 * plain `!==` reference check in `.update()` is a correct and cheap "did
 * anything actually change" test) - not on every text chunk. `currentHost`
 * (the round currently streaming in, no `tools` yet, plain text only, no
 * iframes - falls back to `placeholderHTML` e.g. "...sedang mengetik..."
 * while still empty) still updates on every chunk same as before - there's
 * nothing there to lose animation state.
 */
function createLiveBodyHost(hostEl, formatFn, placeholderHTML) {
  const committedHost = document.createElement('div');
  const currentHost = document.createElement('div');
  hostEl.innerHTML = '';
  hostEl.appendChild(committedHost);
  hostEl.appendChild(currentHost);

  let lastSegments = null;
  return {
    update(liveSegments, currentText) {
      if (liveSegments !== lastSegments) {
        committedHost.innerHTML = liveCommittedGroupsHTML(liveSegments, formatFn);
        lastSegments = liveSegments;
      }
      currentHost.innerHTML = liveCurrentTextHTML(currentText, placeholderHTML, formatFn);
    }
  };
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
  // .message-image-row/.message-embed-card were missing from this cleanup -
  // renderMessageBodyHTML() always emits fresh copies of both (from the
  // NEW msg.images/msg.embeds) alongside the fresh .message-content below,
  // so leaving the OLD variation's copies in place doubled them up instead
  // of replacing them on every edit/swipe.
  containerEl.querySelectorAll('.message-content, .tool-inline-note, .message-image-row, .message-embed-card, .live-body-host').forEach(el => el.remove());
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
  // Same "don't show the builtin Embed HTML tool's raw name" rule as
  // visibleToolTrace() - here too the embed card itself (once it lands) is
  // the visible proof, not a spinner line reading "Using tool:
  // builtin__embed_html...".
  const visibleCalls = calls.filter(c => c && c.name !== BUILTIN_EMBED_HTML_TOOL);

  if (!visibleCalls.length) {
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
    ${visibleCalls.map(c => {
      // A call the user refused never ran at all - shown here as a distinct
      // third state (not a spinner, not a success check) so "I said no" is
      // immediately legible in the same place the running calls appear.
      if (c.declined) {
        return `
          <div class="tool-live-item tool-live-item-declined">
            <span class="tool-live-cross">&times;</span>
            <span>Declined tool: ${escapeHtml(c.name)}</span>
          </div>
        `;
      }
      return `
        <div class="tool-live-item">
          ${c.done ? '<span class="tool-live-check">&#10003;</span>' : '<span class="tool-live-spinner"></span>'}
          <span>${c.done ? 'Used' : 'Using'} tool: ${escapeHtml(c.name)}...</span>
        </div>
      `;
    }).join('')}
  `;
}

/* ---------------------------------------------------------------------------
 * MCP tool permission prompt (rendered directly ABOVE the composer)
 *
 * Every MCP tool call the model makes passes through `requestToolPermission()`
 * before it is allowed to run (wired into AgentRunner as `onPermissionRequest`
 * by BOTH generation call sites). The stored per-tool setting decides whether
 * the user is asked at all:
 *   'allow'   -> runs silently
 *   'decline' -> skipped silently (model is told it was refused)
 *   'ask'     -> the DEFAULT for any tool with no explicit setting, and the
 *                only outcome that surfaces this prompt.
 * Deliberately NOT a `Modal` - a full-screen blocking overlay is the wrong
 * shape for "a question about the reply currently streaming in"; this is a
 * small card inserted as the first child of `.chat-input-container`, which is
 * bottom-anchored (`bottom: 24px`) so an added child grows the box UPWARD,
 * landing the prompt directly on top of the input box.
 * ------------------------------------------------------------------------- */

const PERMISSION_PROMPT_ID = 'tool-permission-prompt';
// Set while a prompt is on screen; calling it resolves that prompt as a
// refusal and tears down its DOM. Module-level for the same reason the other
// generation state is (only one ChatView is ever mounted).
let activePermissionCleanup = null;

/** Pretty-prints model-supplied tool arguments for display (still escaped at the call site). */
function formatToolArgsPreview(args) {
  if (args === undefined || args === null) return '{}';
  let text;
  if (typeof args === 'string') {
    text = args;
  } else {
    try {
      text = JSON.stringify(args, null, 2);
    } catch {
      text = String(args);
    }
  }
  if (typeof text !== 'string') text = String(text);
  return text.length > 4000 ? `${text.slice(0, 4000)}\n... (dipotong)` : text;
}

/** Force-closes any open permission prompt, resolving it as a refusal (fail closed). */
function removeToolPermissionPrompt() {
  const cleanup = activePermissionCleanup;
  activePermissionCleanup = null;
  if (cleanup) cleanup();
  const stray = document.getElementById(PERMISSION_PROMPT_ID);
  if (stray) stray.remove();
}

/**
 * Renders the Yes / No / Always Allow card above the composer and resolves
 * once the user picks one. Resolves 'decline' if the generation is aborted
 * while the prompt is open, so a pending call can never hang the tool loop.
 */
function showToolPermissionPrompt(call, signal) {
  return new Promise((resolve) => {
    // AgentRunner awaits each call sequentially so two prompts can't legitimately
    // overlap - but tear down any stray one first so a prompt leaked by an
    // earlier aborted turn can never stack up or answer on this one's behalf.
    removeToolPermissionPrompt();

    if (signal?.aborted) { resolve('decline'); return; }

    const host = document.querySelector('.chat-input-container');
    // No composer on screen = no way to ask the user = refuse. Failing closed
    // is the only safe direction for this whole feature.
    if (!host) { resolve('decline'); return; }

    const promptEl = document.createElement('div');
    promptEl.className = 'tool-permission-prompt';
    promptEl.id = PERMISSION_PROMPT_ID;
    // `call.name`/`call.args` are model-generated untrusted text - escaped
    // before going anywhere near innerHTML, same as all chat content.
    promptEl.innerHTML = `
      <div class="tool-permission-head">
        ${WRENCH_ICON_SVG}
        <span>MCP Tool Permission</span>
      </div>
      <div class="tool-permission-question">AI ingin memanggil tool berikut. Izinkan?</div>
      <div class="tool-permission-name">${escapeHtml(call.name)}</div>
      <pre class="tool-permission-args">${escapeHtml(formatToolArgsPreview(call.args))}</pre>
      <div class="tool-permission-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-decision="decline">No</button>
        <button type="button" class="btn btn-secondary btn-sm" data-decision="always">Always Allow</button>
        <button type="button" class="btn btn-primary btn-sm" data-decision="allow">Yes</button>
      </div>
    `;
    host.insertBefore(promptEl, host.firstChild);

    let settled = false;
    const finish = (decision) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (activePermissionCleanup === cleanup) activePermissionCleanup = null;
      promptEl.remove();
      resolve(decision);
    };
    const onAbort = () => finish('decline');
    const cleanup = () => finish('decline');

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    activePermissionCleanup = cleanup;

    promptEl.querySelectorAll('[data-decision]').forEach(btn => {
      btn.onclick = async () => {
        const choice = btn.dataset.decision;
        if (choice !== 'always') {
          // 'allow' here is a ONE-TIME allow - nothing is persisted, so the
          // same tool asks again on its next call.
          finish(choice === 'allow' ? 'allow' : 'decline');
          return;
        }
        try {
          await MCPToolRegistry.setToolPermission(call.name, 'allow');
          Toast.info(`Tool "${call.name}" sekarang selalu diizinkan.`);
        } catch (err) {
          // Persisting failed - still honor the click for THIS call, but the
          // tool will ask again next time rather than silently going quiet.
          Toast.error(`Gagal menyimpan izin tool: ${err.message}`);
        }
        finish('allow');
      };
    });
  });
}

/**
 * The single permission decision point for chat-driven MCP tool calls, shared
 * by `triggerAIGeneration` and `handleSwipeNext`. Resolves 'allow'/'decline'.
 *
 * SAFETY: every failure mode here resolves to asking or refusing, never to a
 * silent allow - an unknown tool, an unreadable permission store, an aborted
 * generation and a missing composer all end at 'ask' or 'decline'.
 */
async function requestToolPermission(call, signal) {
  if (signal?.aborted) return 'decline';

  let stored = 'ask';
  try {
    stored = await MCPToolRegistry.getToolPermission(call.name);
  } catch (err) {
    console.warn('[ChatView] Could not read MCP tool permission, asking the user instead:', err);
    stored = 'ask';
  }

  if (stored === 'allow') return 'allow';
  if (stored === 'decline') return 'decline';
  return showToolPermissionPrompt(call, signal);
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

    // Matches the CSS mobile breakpoint (css/chat.css) and the same
    // window.innerWidth<=768 check populateModelSelect() uses below - only
    // used here to word the composer placeholder correctly, since mobile
    // soft keyboards use Enter for a newline (send stays button-only) while
    // desktop uses Enter to send and Shift+Enter for a newline.
    const composerPlaceholder = window.innerWidth <= 768
      ? 'Type action (*looks around*) or dialogue (&quot;Hello...&quot;)...'
      : 'Type action (*looks around*) or dialogue (&quot;Hello...&quot;)... (Shift+Enter for new line)';

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
                  <img src="${escapeAttr(activeChar.avatar)}" class="avatar-img" onerror="this.src='https://api.dicebear.com/7.x/bottts/svg?seed=${avatarSeed(activeChar.name)}'">
                  <div>
                    <div class="character-header-name">${escapeHtml(activeChar.name)}</div>
                    <div class="character-header-tagline">${escapeHtml(activeChar.tagline) || 'AI Roleplay Partner'}</div>
                  </div>
                </div>
              </div>

              <!-- Right Button Aligned with Central Chat Column -->
              <div style="display:flex; align-items:center; gap:0.6rem;">
                <!-- Context-capacity gauge (js/utils/contextWindowSize.js) - a
                     CSS conic-gradient donut ring, refreshed by refreshContextGauge()
                     whenever the message list or active proxy changes. -->
                <div class="context-gauge hidden" id="context-gauge" title="">
                  <div class="context-gauge-inner" id="context-gauge-label">0%</div>
                </div>
                <button class="btn btn-secondary btn-sm" id="btn-open-right-drawer" title="Config & Chat Sessions (Keybind: Ctrl+.)">
                  <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path></svg>
                  <span>Config</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Compact Chat recommendation - shown once a session gets long
               (see refreshCompactBanner() below), dismissible per-session. -->
          <div class="compact-chat-banner hidden" id="compact-chat-banner">
            <div class="compact-chat-banner-text">
              <strong>Percakapan sudah panjang.</strong> Rangkum otomatis ke chat baru agar tetap ringan tanpa kehilangan konteks?
            </div>
            <div class="compact-chat-banner-actions">
              <button type="button" class="btn btn-secondary btn-sm" id="btn-compact-dismiss">Nanti</button>
              <button type="button" class="btn btn-primary btn-sm" id="btn-compact-now">Compact</button>
            </div>
          </div>

          <!-- Messages Stream Container (Per-Block Story Layout) -->
          <div class="messages-container" id="messages-container"></div>

          <!-- Chat Input Container (Clean Floating Box) -->
          <div class="chat-input-container">
            <div class="chat-input-wrapper">
              <div class="queued-message-indicator hidden" id="queued-message-indicator" style="display:flex; align-items:center; gap:0.5rem; padding:0.4rem 0.75rem; margin-bottom:0.4rem; background:var(--accent-primary-softer); border:1px solid var(--border-light); border-radius:var(--radius-md); font-size:0.78rem; color:var(--text-accent);">
                <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                <span id="queued-message-text" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>
                <button type="button" id="btn-cancel-queued" title="Batalkan" aria-label="Batalkan pesan yang diantrikan" style="background:none; border:none; cursor:pointer; color:var(--text-accent); font-size:1rem; line-height:1; padding:0 0.2rem;">&times;</button>
              </div>
              <div class="chat-attach-preview hidden" id="chat-attach-preview"></div>
              <textarea class="chat-textarea" id="chat-input" rows="2" placeholder="${composerPlaceholder}"></textarea>
              <div class="chat-input-toolbar" style="justify-content:space-between;">
                <div class="chat-toolbar-left-group">
                  <!-- Only shown when the active model looks vision-capable (js/utils/modelVision.js) -->
                  <div class="chat-attach-wrap hidden" id="chat-attach-wrap">
                    <button type="button" class="btn-icon chat-attach-btn" id="btn-chat-attach" title="Attach" aria-label="Attach image">
                      <svg width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.3" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>
                    </button>
                    <div class="chat-attach-menu hidden" id="chat-attach-menu">
                      <button type="button" class="chat-attach-menu-item" id="btn-chat-attach-upload">Upload Image</button>
                    </div>
                    <input type="file" id="chat-image-file" accept="image/*" multiple style="display:none;">
                  </div>
                  ${dropdownHTML({
                    id: 'chat-model-select',
                    options: [],
                    title: 'Active Model',
                    ariaLabel: 'Active Model',
                    small: true,
                    placeholder: 'No Proxy',
                    wrapperStyle: 'max-width:260px; width:auto; min-width:150px;'
                  })}
                </div>
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
            <!-- Mobile-only grab strip (display:none on desktop, where this
                 drawer is a side panel rather than a bottom sheet). Powers
                 swipe-down-to-dismiss via js/ui/components/sheetGesture.js -
                 deliberately its own inert element rather than the tab header,
                 which is full of tappable tabs a drag would fight. -->
            <div class="sheet-drag-handle" id="drawer-drag-handle" aria-hidden="true"></div>
            <div class="drawer-tab-header">
              <div class="drawer-tab active" id="tab-btn-sessions">Sessions</div>
              <div class="drawer-tab" id="tab-btn-options">Options</div>
              <div class="drawer-tab" id="tab-btn-mcp">MCP (Exp)</div>
              <button class="btn-icon" id="btn-close-right-drawer" style="margin-right:0.5rem;" title="Close (Esc)">&times;</button>
            </div>

            <!-- Tab 1 Content: Chat Sessions -->
            <div class="drawer-body" id="tab-content-sessions">
              <button class="btn btn-primary btn-sm" id="btn-new-session" style="width:100%;">
                + New Session
              </button>
              <div id="right-drawer-session-list" style="display:flex; flex-direction:column; gap:0.6rem;"></div>
            </div>

            <!-- Tab 2 Content: Chat Options -->
            <div class="drawer-body hidden" id="tab-content-options">
              <!-- Player Persona Switcher -->
              <div class="form-group">
                <label class="form-label">Player Persona</label>
                ${dropdownHTML({ id: 'drawer-persona-select', options: [], placeholder: 'No personas' })}
              </div>

              <!-- AI Proxy Switcher -->
              <div class="form-group">
                <label class="form-label">Active AI Proxy</label>
                ${dropdownHTML({ id: 'drawer-proxy-select', options: [], placeholder: 'No proxies' })}
              </div>

              <!-- System Prompt Preset Switcher -->
              <div class="form-group">
                <label class="form-label">System Prompt Preset</label>
                ${dropdownHTML({ id: 'drawer-preset-select', options: [], placeholder: '-- Select System Prompt Preset --' })}
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

              <!-- Context Capacity (js/utils/contextWindowSize.js) - moved here from the
                   chat header; the header copy is opt-in via the toggle below, off by default. -->
              <div class="card" style="padding:1rem; display:flex; align-items:center; gap:0.85rem;">
                <div class="context-gauge hidden" id="drawer-context-gauge" title="">
                  <div class="context-gauge-inner" id="drawer-context-gauge-label">0%</div>
                </div>
                <div style="flex:1; min-width:0;">
                  <div style="font-weight:700; font-size:0.88rem;">Context Capacity</div>
                  <div style="font-size:0.78rem; color:var(--text-muted);" id="drawer-context-gauge-detail">Menghitung...</div>
                </div>
              </div>
              <div class="form-group">
                ${toggleRowHTML({
                  id: 'drawer-show-context-gauge',
                  title: 'Tampilkan di Header Chat',
                  description: 'Tampilkan indikator kapasitas konteks ini juga di header chat, di samping tombol Config.',
                  ariaLabel: 'Show context gauge in chat header'
                })}
              </div>

              <!-- Compact Chat - manual trigger, independent of the >=40-message
                   recommendation banner (chatView.js's refreshCompactBanner()). -->
              <div class="card" style="padding:1rem;">
                <div style="font-weight:700; font-size:0.88rem; margin-bottom:0.3rem;">Compact Chat</div>
                <p style="font-size:0.78rem; color:var(--text-muted); margin-bottom:0.75rem;">
                  Rangkum percakapan ini dengan AI ke sesi chat baru agar tetap ringan tanpa kehilangan konteks. 4 pesan pertama dan 4 pesan terakhir tidak akan dirangkum.
                </p>
                <button class="btn btn-secondary btn-sm" id="btn-drawer-compact-chat" style="width:100%;">Compact Sekarang</button>
              </div>

              <!-- Quick Config Shortcuts -->
              <div style="display:flex; flex-direction:column; gap:0.5rem; margin-top:0.25rem;">
                <button class="btn btn-secondary btn-sm" id="btn-open-proxies-config" style="width:100%;">Proxies</button>
                <button class="btn btn-secondary btn-sm" id="btn-open-global-settings" style="width:100%;">Settings</button>
              </div>

              <!-- Character Summary Card -->
              <div class="card" style="padding:1rem; font-size:0.85rem;">
                <div style="font-weight:700; font-size:0.95rem; margin-bottom:0.2rem;">${escapeHtml(activeChar.name)}</div>
                <div style="color:var(--text-accent); font-size:0.78rem; margin-bottom:0.5rem;">${escapeHtml(activeChar.tagline) || ''}</div>
                <p style="color:var(--text-muted); font-size:0.82rem; margin-bottom:0.75rem;">${escapeHtml(activeChar.description) || 'No description provided.'}</p>
                <button class="btn btn-secondary btn-sm" id="btn-view-char-details" style="width:100%;">Details</button>
              </div>

              <div style="border-top:1px solid var(--border-light); padding-top:1rem; margin-top:auto;">
                <button class="btn btn-danger btn-sm" id="btn-delete-current-session" style="width:100%;">
                  Delete Current Session
                </button>
              </div>
            </div>

            <!-- Tab 3 Content: Custom MCP Tools (Experimental) -->
            <div class="drawer-body hidden" id="tab-content-mcp">
              <div class="card" style="padding:1rem; margin-bottom:1rem; display:flex; flex-direction:column; gap:0.9rem;">
                ${toggleRowHTML({
                  id: 'drawer-mcp-global-toggle',
                  title: 'MCP Tools',
                  description: 'Master switch - turns all MCP tool-calling on/off across the whole app.',
                  ariaLabel: 'Enable MCP tools globally'
                })}
                <div style="border-top:1px solid var(--border-light); padding-top:0.9rem;">
                  ${toggleRowHTML({
                    id: 'drawer-mcp-immersive-toggle',
                    title: 'Immersive Roleplay',
                    description: `${escapeHtml(activeChar.name)} proactively uses tools in-character (e.g. websearch while browsing) without being explicitly asked.`,
                    ariaLabel: 'Enable immersive proactive tool use'
                  })}
                  <div id="drawer-mcp-intensity-row" style="margin-top:0.8rem; padding-top:0.8rem; border-top:1px solid var(--border-light);">
                    <div class="form-label" style="margin-bottom:0.5rem;">Tool Use Frequency</div>
                    <div class="segmented" role="group" id="drawer-mcp-intensity-group">
                      <button type="button" class="segmented-option" data-value="medium">Medium</button>
                      <button type="button" class="segmented-option" data-value="high">High</button>
                      <button type="button" class="segmented-option" data-value="max">MAX</button>
                    </div>
                    <p id="drawer-mcp-intensity-hint" style="font-size:0.76rem; color:var(--text-muted); margin:0.5rem 0 0;"></p>
                  </div>
                </div>
                <div style="border-top:1px solid var(--border-light); padding-top:0.9rem;">
                  ${toggleRowHTML({
                    id: 'drawer-mcp-iteration-limit-toggle',
                    title: 'Custom Tool Call Limit',
                    description: "Caps how many tool-call rounds the model may chain in a single reply. Off by default (built-in cap of 6 rounds).",
                    ariaLabel: 'Enable a custom tool call round limit'
                  })}
                  <div id="drawer-mcp-iteration-limit-row" style="margin-top:0.7rem; display:flex; align-items:center; gap:0.6rem;">
                    <label class="form-label" for="drawer-mcp-iteration-limit-value" style="margin:0;">Max rounds per reply:</label>
                    <input class="input" type="number" id="drawer-mcp-iteration-limit-value" min="1" max="500" step="1" style="width:90px;">
                  </div>
                </div>
                <div style="border-top:1px solid var(--border-light); padding-top:0.9rem;">
                  ${toggleRowHTML({
                    id: 'drawer-mcp-embed-html-toggle',
                    title: 'Embed HTML (Eksperimental)',
                    description: 'Lets the AI render HTML/JS/CSS directly in chat (charts, small animations, interactive diagrams) inside a sandboxed frame. This means AI-generated script content actually executes in the app - OFF by default for safety. Same Ask/Allow/Decline permission gate as every other tool.',
                    ariaLabel: 'Enable the builtin embed HTML tool'
                  })}
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

    const drawerSheetEl = container.querySelector('.chat-right-drawer-content');
    // Mobile (bottom sheet): slide down + fade the backdrop before actually
    // hiding it, matching the model-picker sheet's exit. Desktop (side panel)
    // is unchanged - it never had a slide-in animation to begin with, so an
    // added slide-out would be a new, unrequested motion rather than a fix.
    const closeDrawer = () => {
      if (window.innerWidth <= 768 && drawerSheetEl) {
        dismissSheet({ sheetEl: drawerSheetEl, overlayEl: drawerOverlay, onDismiss: () => drawerOverlay.classList.add('hidden') });
      } else {
        drawerOverlay.classList.add('hidden');
      }
    };

    openDrawerBtn.onclick = () => {
      // Defensive: a drag that ended in a dismissal clears its own inline
      // transform, but if anything ever left one behind it would survive the
      // `slideUpMobile` open animation and drop the sheet off-screen the
      // instant that animation finished. Cheap insurance, no downside.
      if (drawerSheetEl) {
        drawerSheetEl.style.transform = '';
        drawerSheetEl.style.transition = '';
      }
      drawerOverlay.classList.remove('hidden');
    };

    closeDrawerBtn.onclick = closeDrawer;

    drawerOverlay.onclick = (e) => {
      if (e.target === drawerOverlay) closeDrawer();
    };

    // Mobile swipe-down-to-dismiss. Additive only - the close button and the
    // backdrop tap above are untouched, and the handle is display:none on
    // desktop so the gesture simply never engages there. onDismiss is wired
    // straight to the raw hide (not closeDrawer()) because the drag gesture
    // already played its own slide-down/fade-out via overlayEl before calling
    // this - going through closeDrawer() here would animate a second time.
    attachSheetDragToClose({
      sheetEl: drawerSheetEl,
      handleEl: container.querySelector('#drawer-drag-handle'),
      overlayEl: drawerOverlay,
      onDismiss: () => drawerOverlay.classList.add('hidden')
    });

    // Toggle keybind: Ctrl+. or Cmd+. or Alt+C or Esc
    // Undocumented debug shortcut (Ctrl+Alt+D, see handleKeydown below) - not
    // discoverable in any UI, purely for tracking down a specific embed's
    // fillChatInput/other button not working: shows the RAW model-authored
    // HTML (data-raw-html, set in embedCardsHTML() - the un-processed source,
    // not the buildEmbedDocument()-wrapped document actually running in the
    // iframe) in a copyable, syntax-highlighted modal. Targets whichever
    // `.message-embed-card` the mouse is currently over (`:hover` can be
    // queried live via .matches() at any time, not just during a mouse
    // event, so no separate hover-tracking listeners are needed), falling
    // back to the LAST (most recent) embed in the chat if the mouse isn't
    // over one - still useful since that's usually the one just generated.
    const openEmbedDebugModal = () => {
      const cards = Array.from(container.querySelectorAll('.message-embed-card'));
      if (!cards.length) {
        Toast.info('Tidak ada embed HTML di chat ini.');
        return;
      }
      const target = cards.find(c => c.matches(':hover')) || cards[cards.length - 1];
      const rawHtml = target.dataset.rawHtml || '';

      Modal.open({
        title: 'Embed HTML - Raw Source (Debug)',
        contentHTML: `
          <div class="code-block-wrap" style="margin:0;">
            <pre style="margin:0; padding:1rem; max-height:60vh; overflow:auto;"><code>${highlightCode(rawHtml, 'html')}</code></pre>
          </div>
        `,
        buttons: [
          {
            label: 'Copy Raw HTML',
            className: 'btn-primary',
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(rawHtml);
                Toast.success('Raw HTML disalin ke clipboard.');
              } catch {
                Toast.error('Gagal menyalin ke clipboard.');
              }
            }
          }
        ]
      });
    };

    // Opening never animates via JS (the CSS slideUpMobile keyframe replays on
    // its own the instant `.hidden` is removed) - only closing needs to route
    // through closeDrawer() for the animated exit.
    const toggleDrawer = () => {
      if (drawerOverlay.classList.contains('hidden')) drawerOverlay.classList.remove('hidden');
      else closeDrawer();
    };

    const handleKeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '.') {
        e.preventDefault();
        toggleDrawer();
      } else if (e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        toggleDrawer();
      } else if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        openEmbedDebugModal();
      } else if (e.key === 'Escape' && !drawerOverlay.classList.contains('hidden')) {
        closeDrawer();
      }
    };
    if (activeChatTeardown) activeChatTeardown();
    window.addEventListener('keydown', handleKeydown);

    // Message-based bridge for embed-HTML iframes (js/ui/views/chatView.js's
    // messageEmbedsHTML/buildEmbedDocument/EMBED_RUNTIME_SCRIPT) - sandboxed
    // WITHOUT allow-same-origin on purpose (see the security note on
    // messageEmbedsHTML), so postMessage is the ONLY channel an embed has
    // back to the app at all. Both message types below are matched against
    // every currently-mounted `.message-embed-frame` by `event.source` (the
    // iframe's own window) first, so a stray/unrelated postMessage sender
    // can't spoof either one:
    //   - 'nnzrp-embed-resize': the embed reporting its real content height,
    //     so the iframe can grow to fit instead of sitting in a fixed empty
    //     box - clamped both directions so one tiny or one huge/runaway
    //     embed can't collapse to nothing or blow out the chat layout.
    //   - 'nnzrp-embed-fill-input': the model's embed HTML calling the
    //     injected `fillChatInput(text)` helper (e.g. from a <button
    //     onclick>) - lets an embed offer clickable options/choices that put
    //     text straight into the composer, ready to send or edit, instead of
    //     only ever being a passive visual. Replaces whatever draft text was
    //     there (an "option" click is a deliberate choice, not something a
    //     user expects appended to unrelated text they were mid-typing) and
    //     focuses the composer so it's obvious something happened. Just a
    //     plain textarea `.value` assignment - never parsed as HTML/executed,
    //     so no XSS surface regardless of what the embed sends.
    const handleEmbedMessage = (e) => {
      if (!e.data || !e.data.type) return;
      const frames = container.querySelectorAll('.message-embed-frame');
      const sourceFrame = Array.from(frames).find(f => f.contentWindow === e.source);
      if (!sourceFrame) return;

      if (e.data.type === 'nnzrp-embed-resize') {
        const h = Math.min(Math.max(Number(e.data.height) || 0, 40), 800);
        sourceFrame.style.height = `${h}px`;
        // Only while a generation is actively streaming - an embed resizing
        // while the user is just scrolled up reading older history must NOT
        // yank the view back down. During streaming this re-follows the
        // bottom the same way every other streaming update already does
        // (onContentChunk etc. all call scrollToBottom unconditionally too) -
        // without it, the view stayed scrolled to wherever it was BEFORE the
        // embed grew from its placeholder height to its real one, leaving
        // the growth happening below the visible fold.
        if (isGenerating) scrollToBottom(container.querySelector('#messages-container'));
      } else if (e.data.type === 'nnzrp-embed-fill-input') {
        const inputEl = container.querySelector('#chat-input');
        if (!inputEl) return;
        inputEl.value = typeof e.data.text === 'string' ? e.data.text.slice(0, 4000) : '';
        autoResizeComposer();
        inputEl.focus();
      }
    };
    window.addEventListener('message', handleEmbedMessage);
    activeChatTeardown = () => {
      // The permission prompt lives in a DOM the router is about to throw
      // away; without resolving it here (abort first - showToolPermissionPrompt
      // resolves 'decline' on the signal's abort event - then force-close as a
      // second layer) its promise never settles and the tool loop hangs.
      if (activeAbortController) activeAbortController.abort();
      removeToolPermissionPrompt();
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('message', handleEmbedMessage);
    };

    // Copy button for fenced code blocks (marked.use({renderer:{code}}) above)
    // - ONE delegated listener on the container that outlives every
    // renderMessages()/syncMessageBody() innerHTML replacement, instead of
    // rewiring a listener per button on every render. `data-code` is the raw
    // (already HTML-attribute-decoded by the browser) code text.
    // Property assignment, not addEventListener: `container` (#view-container)
    // survives every navigation, so addEventListener stacked one extra handler
    // per chat-view render and made a single Copy click fire N times.
    container.onclick = async (e) => {
      const btn = e.target.closest('.code-copy-btn');
      if (!btn) return;
      try {
        await navigator.clipboard.writeText(btn.dataset.code || '');
        btn.classList.add('copied');
        const originalLabel = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.textContent = originalLabel;
        }, 1500);
      } catch (err) {
        Toast.error('Gagal menyalin kode.');
      }
    };

    // Back Button Handler
    const backBtn = container.querySelector('#btn-chat-back');
    if (backBtn && onBack) {
      backBtn.onclick = () => {
        // App.navigate() (reached via onBack()) calls ChatView.teardown()
        // itself before swapping the view, same as every other navigation
        // path - no need to duplicate the cleanup here.
        onBack();
      };
    }

    // Populate Select Options in Opsi Tab
    const populateDrawerSelects = async () => {
      const personas = await PersonaStore.getAll();
      const currentPersona = await PersonaStore.getDefault();
      setDropdownOptions(
        container,
        'drawer-persona-select',
        personas.map(p => ({ value: p.id, label: p.name })),
        currentPersona ? currentPersona.id : undefined
      );
      wireDropdown(container, 'drawer-persona-select', async (value) => {
        const persona = await PersonaStore.getById(value);
        if (persona) {
          persona.isDefault = true;
          await PersonaStore.save(persona);
          Toast.success(`Persona diset ke: ${persona.name}`);
          await renderMessages();
        }
      });

      const proxies = await ProxyStore.getAll();
      const currentProxy = await ProxyStore.getDefault();
      setDropdownOptions(
        container,
        'drawer-proxy-select',
        proxies.map(p => ({ value: p.id, label: p.name, hint: p.selectedModel || p.provider })),
        currentProxy ? currentProxy.id : undefined
      );
      wireDropdown(container, 'drawer-proxy-select', async (value) => {
        const proxy = await ProxyStore.getById(value);
        if (proxy) {
          proxy.isDefault = true;
          await ProxyStore.save(proxy);
          Toast.success(`Active Proxy: ${proxy.name}`);
          await populateModelSelect();
          if (onProxyChanged) onProxyChanged();
        }
      });

      // System Prompt Presets
      const presets = await ProxyStore.getSystemPromptPresets();
      setDropdownOptions(
        container,
        'drawer-preset-select',
        presets.map(p => ({
          value: p.id,
          label: p.name,
          hint: (p.isBuiltIn || p.id === 'preset-default') ? 'System Default' : 'Custom preset'
        })),
        ''
      );
      wireDropdown(container, 'drawer-preset-select', async (value) => {
        const targetPreset = presets.find(p => p.id === value);
        if (targetPreset) {
          await ProxyStore.saveGlobalSystemPrompt(targetPreset.content);
          Toast.success(`Preset System Prompt diset: ${targetPreset.name}`);
        }
      });

      // Font Size Buttons
      const genSettings = await ProxyStore.getGenerationSettings();
      const currentFontSize = genSettings.fontSize || 'medium';
      const messagesEl = container.querySelector('#messages-container');
      if (messagesEl) {
        // classList, not className: a wholesale assignment wipes the
        // `generating-lock` class setGeneratingState() adds mid-generation.
        messagesEl.classList.remove('font-small', 'font-medium', 'font-big');
        messagesEl.classList.add('font-' + currentFontSize);
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
            messagesEl.classList.remove('font-small', 'font-medium', 'font-big');
            messagesEl.classList.add('font-' + newSize);
          }
          Toast.success(`Ukuran teks diset: ${newSize.toUpperCase()}`);
        };
      });

      // Context gauge header-visibility toggle - default OFF, so the gauge
      // only lives here in the drawer unless the user explicitly opts into
      // also showing it in the chat header.
      const showGaugeToggle = container.querySelector('#drawer-show-context-gauge');
      if (showGaugeToggle) {
        showGaugeToggle.checked = genSettings.showContextGaugeInChat === true;
        showGaugeToggle.onchange = async () => {
          const latestSettings = await ProxyStore.getGenerationSettings();
          latestSettings.showContextGaugeInChat = showGaugeToggle.checked;
          await ProxyStore.saveGenerationSettings(latestSettings);
          await refreshContextGauge();
        };
      }

      const compactBtn = container.querySelector('#btn-drawer-compact-chat');
      if (compactBtn) compactBtn.onclick = handleCompactChat;
    };

    /* -----------------------------------------------------------------
     * Image attach button (composer "+" menu) - multimodal input.
     * Declared here (ahead of its first use inside populateModelSelect
     * below, which is itself called before the sendInput/sendBtn wiring
     * further down the file) so every const it closes over already exists
     * on first call.
     * --------------------------------------------------------------- */
    const attachWrap = container.querySelector('#chat-attach-wrap');
    const attachBtn = container.querySelector('#btn-chat-attach');
    const attachMenu = container.querySelector('#chat-attach-menu');
    const attachUploadItem = container.querySelector('#btn-chat-attach-upload');
    const attachFileInput = container.querySelector('#chat-image-file');
    const attachPreviewEl = container.querySelector('#chat-attach-preview');

    const refreshAttachPreview = () => {
      if (!attachPreviewEl) return;
      if (!pendingAttachedImages.length) {
        attachPreviewEl.classList.add('hidden');
        attachPreviewEl.innerHTML = '';
        return;
      }
      attachPreviewEl.classList.remove('hidden');
      attachPreviewEl.innerHTML = pendingAttachedImages.map((src, i) => `
        <div class="chat-attach-thumb">
          <img src="${escapeAttr(src)}" alt="">
          <button type="button" class="chat-attach-thumb-remove" data-idx="${i}" title="Remove" aria-label="Remove image">&times;</button>
        </div>
      `).join('');
      attachPreviewEl.querySelectorAll('.chat-attach-thumb-remove').forEach(btn => {
        btn.onclick = () => {
          pendingAttachedImages.splice(parseInt(btn.dataset.idx, 10), 1);
          refreshAttachPreview();
        };
      });
    };

    // Menu listeners are added only while open and torn down on close - same
    // idiom as js/ui/components/dropdown.js - so re-opening this chat page
    // repeatedly never piles up stray document-level listeners.
    let closeAttachMenuListeners = null;
    const closeAttachMenu = () => {
      if (!attachMenu) return;
      attachMenu.classList.add('hidden');
      if (closeAttachMenuListeners) { closeAttachMenuListeners(); closeAttachMenuListeners = null; }
    };
    const openAttachMenu = () => {
      if (!attachMenu || !attachWrap) return;
      attachMenu.classList.remove('hidden');
      const onDocMouseDown = (e) => { if (!attachWrap.contains(e.target)) closeAttachMenu(); };
      const onKeyDown = (e) => { if (e.key === 'Escape') closeAttachMenu(); };
      document.addEventListener('mousedown', onDocMouseDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      closeAttachMenuListeners = () => {
        document.removeEventListener('mousedown', onDocMouseDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
      };
    };

    if (attachBtn && attachMenu) {
      attachBtn.onclick = (e) => {
        e.stopPropagation();
        if (attachMenu.classList.contains('hidden')) openAttachMenu();
        else closeAttachMenu();
      };
    }

    if (attachUploadItem && attachFileInput) {
      attachUploadItem.onclick = () => {
        closeAttachMenu();
        attachFileInput.click();
      };
      attachFileInput.onchange = async () => {
        const files = Array.from(attachFileInput.files || []);
        attachFileInput.value = '';
        for (const file of files) {
          if (pendingAttachedImages.length >= MAX_IMAGES_PER_MESSAGE) {
            Toast.error(`Maksimal ${MAX_IMAGES_PER_MESSAGE} gambar per pesan.`);
            break;
          }
          if (!file.type.startsWith('image/')) {
            Toast.error(`"${file.name}" bukan file gambar.`);
            continue;
          }
          if (file.size > MAX_IMAGE_BYTES) {
            Toast.error(`"${file.name}" terlalu besar (maks ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB).`);
            continue;
          }
          try {
            pendingAttachedImages.push(await readFileAsDataURL(file));
          } catch {
            Toast.error(`Gagal membaca file "${file.name}".`);
          }
        }
        refreshAttachPreview();
      };
    }

    // Shows/hides the attach button based on the ACTIVE proxy's currently
    // selected model - re-run whenever the proxy or its selected model
    // changes (populateModelSelect covers both cases below).
    const refreshAttachButtonVisibility = async () => {
      if (!attachWrap) return;
      const proxy = await ProxyStore.getDefault();
      const visionOk = supportsVision(proxy);
      attachWrap.classList.toggle('hidden', !visionOk);
      if (!visionOk) closeAttachMenu();
      if (!visionOk && pendingAttachedImages.length) {
        // Switched to a non-vision model mid-draft - drop the pending
        // attachments rather than silently send images it can't see.
        pendingAttachedImages = [];
        refreshAttachPreview();
      }
    };

    /**
     * Context capacity gauge - replaces the old hard message-count context
     * cap (see promptBuilder.js) with visibility instead of silent
     * truncation: a donut ring showing roughly how full the active model's
     * context window is, so a long-running chat's growing history is
     * something the user can SEE and act on (Compact Chat) rather than
     * something that silently made the character forget old turns.
     *
     * Lives primarily in the drawer's Options tab (#drawer-context-gauge,
     * always shown there when a proxy is active); the chat-header copy
     * (#context-gauge) is opt-in via the "Tampilkan di Header Chat" toggle in
     * that same tab, OFF by default (ProxyStore generation settings key
     * `showContextGaugeInChat`) so the header stays uncluttered unless asked for.
     */
    const refreshContextGauge = async () => {
      const headerGaugeEl = container.querySelector('#context-gauge');
      const headerLabelEl = container.querySelector('#context-gauge-label');
      const drawerGaugeEl = container.querySelector('#drawer-context-gauge');
      const drawerLabelEl = container.querySelector('#drawer-context-gauge-label');
      const drawerDetailEl = container.querySelector('#drawer-context-gauge-detail');
      if (!headerGaugeEl && !drawerGaugeEl) return;

      const proxy = await ProxyStore.getDefault();
      if (!proxy) {
        headerGaugeEl?.classList.add('hidden');
        drawerGaugeEl?.classList.add('hidden');
        if (drawerDetailEl) drawerDetailEl.textContent = 'Belum ada Proxy aktif.';
        return;
      }

      const genSettings = await ProxyStore.getGenerationSettings();
      const msgs = await ChatStore.getMessages(currentChatId);
      const activePersonaObj = await PersonaStore.getDefault();
      const globalPrompt = await ProxyStore.getGlobalSystemPrompt();

      // Reuse the exact same payload assembly generation uses (minus tools,
      // which barely move the needle and would cost an extra MCP round-trip
      // just for this estimate) so the number reflects what's actually sent,
      // not a separately-drifting approximation.
      const payload = PromptBuilder.buildPromptPayload({
        character: activeChar,
        persona: activePersonaObj,
        globalSystemPrompt: globalPrompt,
        messages: msgs
      });

      let tokens = 0;
      for (const m of payload) {
        tokens += estimateTokens(m.content || '');
        // Vision content isn't text but still costs real tokens - a flat
        // per-image estimate keeps the gauge from silently under-reporting a
        // heavily image-attached conversation (~800 tokens/image roughly
        // matches published provider ballparks for a moderate-size upload).
        if (Array.isArray(m.images)) tokens += m.images.length * 800;
      }

      const windowSize = getContextWindowSize(proxy);
      const percent = Math.min(100, Math.round((tokens / windowSize) * 100));
      const color = percent >= 85 ? 'var(--accent-rose)' : percent >= 60 ? 'var(--accent-amber)' : 'var(--accent-emerald)';
      const gaugeBg = `conic-gradient(${color} ${percent}%, var(--bg-tertiary) 0)`;
      const tooltip = `${tokens.toLocaleString()} / ${windowSize.toLocaleString()} token konteks terpakai (~${percent}%)`;

      if (headerGaugeEl) {
        headerGaugeEl.classList.toggle('hidden', genSettings.showContextGaugeInChat !== true);
        headerGaugeEl.style.background = gaugeBg;
        headerGaugeEl.title = tooltip;
      }
      if (headerLabelEl) headerLabelEl.textContent = `${percent}%`;

      if (drawerGaugeEl) {
        drawerGaugeEl.classList.remove('hidden');
        drawerGaugeEl.style.background = gaugeBg;
        drawerGaugeEl.title = tooltip;
      }
      if (drawerLabelEl) drawerLabelEl.textContent = `${percent}%`;
      if (drawerDetailEl) drawerDetailEl.textContent = `${tokens.toLocaleString()} / ${windowSize.toLocaleString()} token (~${percent}%)`;
    };

    /**
     * Shows/hides the Compact Chat recommendation banner based on message
     * count - a light nudge once a session gets long, not a hard gate (the
     * hard context cap this replaces is gone, see promptBuilder.js).
     */
    const refreshCompactBanner = async () => {
      const bannerEl = container.querySelector('#compact-chat-banner');
      if (!bannerEl) return;
      const msgs = await ChatStore.getMessages(currentChatId);
      const shouldShow = msgs.length >= COMPACT_RECOMMEND_THRESHOLD && !compactDismissedChats.has(currentChatId);
      bannerEl.classList.toggle('hidden', !shouldShow);
    };

    /**
     * Compact Chat: summarizes the MIDDLE stretch of the conversation via the
     * active proxy - everything except the first COMPACT_KEEP_FIRST and last
     * COMPACT_KEEP_LAST messages, see ChatStore.getCompactMiddleRange/
     * createCompactedChat's JSDoc for why both ends are kept verbatim now
     * (an earlier version only kept the opening and folded even the newest
     * message into the summary, which read as "my last message got
     * deleted") - then creates a brand-new chat session carrying the kept
     * opening turns, the recap, and the kept recent turns, and switches
     * straight into it. The original chat is left completely untouched -
     * this is additive, not destructive, so a bad summary never costs the
     * user their real history.
     */
    const handleCompactChat = async () => {
      if (isGenerating) {
        Toast.error('Tunggu proses generate selesai dulu sebelum compact chat.');
        return;
      }
      const msgs = await ChatStore.getMessages(currentChatId);
      if (msgs.length <= COMPACT_KEEP_FIRST + COMPACT_KEEP_LAST) {
        Toast.info('Belum cukup pesan untuk di-compact.');
        return;
      }

      const proxyObj = await ProxyStore.getDefault();
      if (!proxyObj) {
        Toast.error('Belum ada Proxy aktif.');
        return;
      }

      const bannerEl = container.querySelector('#compact-chat-banner');
      bannerEl?.classList.add('hidden');
      Toast.info('Merangkum percakapan...');

      try {
        const activePersonaObj = await PersonaStore.getDefault();
        const userName = activePersonaObj?.name || 'User';
        const charName = activeChar?.name || 'Character';

        const toSummarize = ChatStore.getCompactMiddleRange(msgs, COMPACT_KEEP_FIRST, COMPACT_KEEP_LAST);
        const transcript = toSummarize
          .map(m => `${m.role === 'user' ? userName : charName}: ${m.content}`)
          .join('\n\n');

        const summaryPayload = [
          {
            role: 'system',
            content: `You are compressing a roleplay conversation between ${userName} and ${charName} so it can continue in a brand new chat without losing context. Write a thorough but concise "story so far" recap in prose (third person, no markdown headers/lists): established facts, the relationship/emotional state between them, unresolved plot threads, and any concrete details either party would need to remember. This is NOT a message ${charName} would say in character - it is an out-of-character summary the engine will read as background before continuing the scene.`
          },
          { role: 'user', content: transcript }
        ];

        const genSettings = await ProxyStore.getGenerationSettings();
        const { content: summary } = await ProviderManager.sendChatCompletion(proxyObj, summaryPayload, {
          ...genSettings,
          temperature: 0.4,
          maxTokens: genSettings.unlimitedTokens ? genSettings.maxTokens : Math.max(genSettings.maxTokens || 1024, 1536)
        });

        if (!summary || !summary.trim()) throw new Error('Ringkasan kosong dari AI.');

        const newChat = await ChatStore.createCompactedChat(currentChatId, summary.trim(), COMPACT_KEEP_FIRST, COMPACT_KEEP_LAST);
        compactDismissedChats.add(currentChatId);

        currentChatId = newChat.id;
        await updateSessionList();
        await renderMessages();
        Toast.success(`Chat baru "${newChat.title}" berhasil dibuat.`);
      } catch (err) {
        Toast.error(`Gagal compact chat: ${err.message}`);
        await refreshCompactBanner();
      }
    };

    container.querySelector('#btn-compact-dismiss').onclick = () => {
      compactDismissedChats.add(currentChatId);
      container.querySelector('#compact-chat-banner')?.classList.add('hidden');
    };
    container.querySelector('#btn-compact-now').onclick = handleCompactChat;

    // Sentinels for the model-select dropdown's inline "Switch Provider"
    // drill-down (see populateModelSelect below) - never real model/proxy
    // ids, so they can't collide with anything ProxyStore would return.
    const MODEL_SELECT_SWITCH_PROVIDER = '__switch_provider__';
    const MODEL_SELECT_BACK_TO_MODELS = '__back_to_models__';

    // Compact model switcher next to the send button (Claude-style) - reads
    // the active proxy's `models` list (js/ui/views/proxiesView.js lets you
    // configure more than one for custom/openrouter proxies) and falls back
    // to just showing the single `selectedModel` when no list is configured.
    // When more than one proxy is configured, a trailing "Switch Provider"
    // row lets the SAME dropdown drill into the proxy list in place (no
    // modal) - picking one does exactly what the navbar's "Active Proxy"
    // dropdown and the Proxies tab's "Set Active" button already do
    // (proxy.isDefault = true), reusing that mechanism rather than
    // reinventing provider switching. On mobile this same data feeds the
    // bottom-sheet picker (openModelPickerSheet) instead - see the trigger
    // wiring further down.
    const populateModelSelect = async ({ reopen = false } = {}) => {
      if (!container.querySelector('[data-dropdown-for="chat-model-select"]')) return;
      const proxy = await ProxyStore.getDefault();
      if (!proxy) {
        setDropdownOptions(container, 'chat-model-select', [], '');
        setDropdownDisabled(container, 'chat-model-select', true);
        await refreshAttachButtonVisibility();
        await refreshContextGauge();
        return;
      }

      const allProxies = await ProxyStore.getAll();
      const canSwitchProvider = allProxies.length > 1;

      const candidates = Array.isArray(proxy.models) ? [...proxy.models] : [];
      if (proxy.selectedModel && !candidates.includes(proxy.selectedModel)) candidates.unshift(proxy.selectedModel);
      if (candidates.length === 0) candidates.push(proxy.selectedModel || proxy.provider);

      const modelOptions = candidates.map(m => ({ value: m, label: formatModelLabel(m) }));
      if (canSwitchProvider) {
        modelOptions.push({
          value: MODEL_SELECT_SWITCH_PROVIDER,
          label: 'Switch Provider ›',
          hint: `Currently: ${proxy.name}`
        });
      }

      setDropdownOptions(container, 'chat-model-select', modelOptions, proxy.selectedModel || candidates[0], { reopen });
      // Same rule as before the dropdown swap: nothing worth doing in here
      // if there's only one model AND no other provider to switch to.
      setDropdownDisabled(container, 'chat-model-select', candidates.length <= 1 && !canSwitchProvider);
      await refreshAttachButtonVisibility();
      await refreshContextGauge();

      // Shared by both pickers (desktop dropdown drill-down below, and the
      // mobile bottom sheet wired further down) so selecting a model/
      // provider behaves identically regardless of which UI it came from.
      const selectModel = async (value) => {
        const updatedProxy = await ProxyStore.getById(proxy.id);
        if (!updatedProxy) return;
        updatedProxy.selectedModel = value;
        await ProxyStore.save(updatedProxy);
        Toast.info(`Model diset ke: ${value}`);
        // The desktop dropdown syncs its own trigger label as part of its
        // click handling (dropdown.js's commitValue), but the mobile bottom
        // sheet (modelPickerSheet.js) calls this directly and never touches
        // the dropdown component at all - without this, the trigger button
        // keeps showing the old model name after picking a new one there.
        setDropdownValue(container, 'chat-model-select', value);
        await refreshAttachButtonVisibility();
        await refreshContextGauge();
        // Re-run the whole populate pass, exactly like selectProvider() below
        // already does. populateModelSelect() closes over the `proxy` object
        // it fetched at its own top, and the mobile trigger's onclick uses
        // that stale copy to compute `active: m === proxy.selectedModel` -
        // i.e. the bottom sheet's checkmark. Without this re-run the sheet
        // keeps ticking the PREVIOUS model every time it's reopened; the
        // desktop dropdown didn't show it because dropdown.js syncs its own
        // trigger label on click. Cheap and non-recursive: it only redefines
        // these closures, it never calls them.
        await populateModelSelect();
        if (onProxyChanged) onProxyChanged();
      };

      const selectProvider = async (proxyId) => {
        const targetProxy = allProxies.find(p => p.id === proxyId);
        if (!targetProxy) return;
        targetProxy.isDefault = true;
        await ProxyStore.save(targetProxy);
        Toast.success(`Active Proxy: ${targetProxy.name}`);
        await populateModelSelect();
        if (onProxyChanged) onProxyChanged();
      };

      wireDropdown(container, 'chat-model-select', async (value) => {
        if (value === MODEL_SELECT_SWITCH_PROVIDER) {
          const providerOptions = [
            ...allProxies.map(p => ({ value: p.id, label: p.name, hint: p.selectedModel ? formatModelLabel(p.selectedModel) : p.provider })),
            { value: MODEL_SELECT_BACK_TO_MODELS, label: '‹ Back to models' }
          ];
          setDropdownOptions(container, 'chat-model-select', providerOptions, proxy.id, { reopen: true });
          return;
        }

        if (value === MODEL_SELECT_BACK_TO_MODELS) {
          // Deliberately NOT `await populateModelSelect({ reopen: true })` here
          // (that used to be the whole body of this branch) - populateModelSelect
          // starts with several awaited IndexedDB reads before it ever reaches
          // its own setDropdownOptions call, so this async onChange callback
          // yields back to dropdown.js's option click handler at that very first
          // await. That handler unconditionally calls closeDropdown() right after
          // commitValue() returns (see dropdown.js), which ran BEFORE this
          // callback's eventual setDropdownOptions - so by the time it finally
          // ran, `openState` was already null and `{reopen:true}` had nothing to
          // reopen, silently leaving the whole menu closed instead of back on
          // the model list. `modelOptions`/`candidates` were already computed at
          // the top of this populateModelSelect() call and haven't gone stale in
          // the few ms since, so rebuilding via them here - synchronously, same
          // as the SWITCH_PROVIDER branch above - sidesteps the race entirely.
          setDropdownOptions(container, 'chat-model-select', modelOptions, proxy.selectedModel || candidates[0], { reopen: true });
          return;
        }

        if (allProxies.some(p => p.id === value)) {
          await selectProvider(value);
          return;
        }

        await selectModel(value);
      });

      // Mobile: open the bottom sheet instead of the normal dropdown menu.
      // wireDropdown() (above) just set triggerEl.onclick to its own open/
      // close logic - save that reference and wrap it, rather than adding a
      // second listener (a second `addEventListener` on the same element
      // fires in attachment order regardless of capture/bubble, so it
      // can't reliably run BEFORE the onclick property wireDropdown already
      // assigned; overwriting the property is what actually guarantees
      // ordering). Checked at tap time, not just once here, so resizing
      // across the breakpoint doesn't need a re-render to take effect.
      const triggerEl = container.querySelector('[data-dropdown-for="chat-model-select"] .dropdown-trigger');
      if (triggerEl) {
        const desktopOnClick = triggerEl.onclick;
        triggerEl.onclick = (e) => {
          if (window.innerWidth > 768) {
            desktopOnClick(e);
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          openModelPickerSheet({
            models: candidates.map(m => ({ value: m, label: formatModelLabel(m), active: m === (proxy.selectedModel || candidates[0]) })),
            currentProxyName: proxy.name,
            proxies: canSwitchProvider
              ? allProxies.map(p => ({ id: p.id, name: p.name, hint: p.selectedModel ? formatModelLabel(p.selectedModel) : p.provider }))
              : [],
            onSelectModel: selectModel,
            onSelectProvider: selectProvider
          });
        };
      }
    };

    const renderDrawerMCPList = async () => {
      const mcpListEl = container.querySelector('#drawer-mcp-list');
      if (!mcpListEl) return;
      const servers = await MCPStore.getAll();

      if (servers.length === 0) {
        mcpListEl.innerHTML = `
          <div style="padding:1rem; text-align:center; background:var(--bg-surface); border-radius:var(--radius-md); border:1px dashed var(--border-light); font-size:0.82rem; color:var(--text-muted);">
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
        <div style="padding:0.85rem; background:var(--bg-surface); border-radius:var(--radius-md); border:1px solid var(--border-light); font-size:0.82rem; display:flex; flex-direction:column; gap:0.5rem; box-shadow:var(--shadow-sm);">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-weight:600; color:var(--text-main);">${escapeHtml(s.name)}</div>
              <div style="font-size:0.72rem; color:var(--text-muted); font-family:var(--font-mono);">${s.transport === 'command' ? 'STDIO' : 'HTTP'}</div>
            </div>
            ${toggleSwitchHTML({
              inputClass: 'drawer-mcp-toggle',
              data: { id: s.id },
              checked: !!s.enabled,
              small: true,
              title: 'Enable this server for roleplay sessions'
            })}
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; gap:0.4rem; border-top:1px solid var(--border-light); padding-top:0.4rem; margin-top:0.2rem;">
            <span class="badge" id="drawer-mcp-status-${s.id}">Unknown</span>
            <div style="display:flex; gap:0.3rem;">
              <button class="btn btn-secondary btn-sm drawer-check-mcp" data-id="${s.id}" style="padding:0.15rem 0.45rem; font-size:0.72rem;">Status</button>
              <button class="btn btn-secondary btn-sm drawer-mcp-perms" data-id="${s.id}" style="padding:0.15rem 0.45rem; font-size:0.72rem;">Permissions</button>
            </div>
          </div>
          <!-- Same per-tool Ask/Allow/Decline editor as the #mcp settings
               page (one shared implementation in MCPView), mirrored here the
               way the master/immersive toggles already are. -->
          <div class="hidden" id="drawer-mcp-perm-host-${s.id}" style="border-top:1px solid var(--border-light); padding-top:0.5rem;"></div>
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

        // Mirrors mcpView.js's checkServerStatus: a stdio server without the
        // Electron bridge is an unsupported platform, not a broken server, so
        // it gets a neutral "Desktop Only" badge instead of the red "Offline"
        // one - and no round trip, no error toast (nothing to retry).
        if (isTransportUnsupportedHere(server)) {
          badgeEl.textContent = 'Desktop Only';
          badgeEl.className = 'badge';
          badgeEl.title = UNSUPPORTED_TRANSPORT_REASON;
          return;
        }

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
        const owner = servers.find(s => s.id === btn.dataset.id);
        if (owner && isTransportUnsupportedHere(owner)) {
          btn.disabled = true;
          btn.title = UNSUPPORTED_TRANSPORT_REASON;
          return;
        }
        btn.onclick = async () => {
          const server = await MCPStore.getById(btn.dataset.id);
          if (server) await checkDrawerServerStatus(server);
        };
      });

      // Expand-on-demand per-tool permission editor (lazy: needs a live
      // tools/list round trip, so it isn't loaded for every server up front).
      mcpListEl.querySelectorAll('.drawer-mcp-perms').forEach(btn => {
        btn.onclick = async () => {
          const hostEl = mcpListEl.querySelector(`#drawer-mcp-perm-host-${btn.dataset.id}`);
          if (!hostEl) return;
          const nowHidden = hostEl.classList.toggle('hidden');
          if (nowHidden) return;
          if (!hostEl.dataset.loaded) {
            hostEl.dataset.loaded = '1';
            await MCPView.renderToolPermissions(hostEl, btn.dataset.id);
          }
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
    const mcpIntensityRow = container.querySelector('#drawer-mcp-intensity-row');
    const mcpIntensityGroup = container.querySelector('#drawer-mcp-intensity-group');
    const mcpIntensityHint = container.querySelector('#drawer-mcp-intensity-hint');

    const applyMcpMasterVisualState = (enabled) => {
      if (mcpServersSection) {
        mcpServersSection.style.opacity = enabled ? '1' : '0.5';
        mcpServersSection.style.pointerEvents = enabled ? '' : 'none';
      }
      if (mcpImmersiveToggle) mcpImmersiveToggle.disabled = !enabled;
    };

    // Tool Use Frequency only applies while Immersive Roleplay is on - see
    // the matching dimming pattern in mcpView.js (single source of truth for
    // the wording is that file's exported MCP_INTENSITY_HINTS/INTENSITY_LABELS).
    const applyMcpIntensityVisualState = (immersiveOn) => {
      if (mcpIntensityRow) {
        mcpIntensityRow.style.opacity = immersiveOn ? '1' : '0.5';
        mcpIntensityRow.style.pointerEvents = immersiveOn ? '' : 'none';
      }
    };

    const setActiveMcpIntensityButton = (value) => {
      if (!mcpIntensityGroup) return;
      mcpIntensityGroup.querySelectorAll('.segmented-option').forEach(b => {
        b.classList.toggle('active', b.dataset.value === value);
      });
      if (mcpIntensityHint) mcpIntensityHint.textContent = MCP_INTENSITY_HINTS[value] || '';
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
      applyMcpIntensityVisualState(mcpImmersiveToggle.checked);
      mcpImmersiveToggle.onchange = async (e) => {
        await MCPStore.setImmersiveRoleplay(e.target.checked);
        applyMcpIntensityVisualState(e.target.checked);
        Toast.info(`Immersive Roleplay ${e.target.checked ? 'diaktifkan' : 'dinonaktifkan'}.`);
      };
    }

    setActiveMcpIntensityButton(await MCPStore.getImmersiveIntensity());
    if (mcpIntensityGroup) {
      mcpIntensityGroup.querySelectorAll('.segmented-option').forEach(btn => {
        btn.onclick = async () => {
          const value = btn.dataset.value;
          await MCPStore.setImmersiveIntensity(value);
          setActiveMcpIntensityButton(value);
          Toast.info(`Tool Use Frequency diset ke ${INTENSITY_LABELS[value] || value}.`);
        };
      });
    }

    // Custom Tool Call Limit (drawer copy - mirrors mcpView.js). Independent
    // of Immersive Roleplay/intensity, off by default.
    const mcpIterationLimitToggle = container.querySelector('#drawer-mcp-iteration-limit-toggle');
    const mcpIterationLimitRow = container.querySelector('#drawer-mcp-iteration-limit-row');
    const mcpIterationLimitInput = container.querySelector('#drawer-mcp-iteration-limit-value');

    const applyMcpIterationLimitVisualState = (enabled) => {
      if (mcpIterationLimitRow) {
        mcpIterationLimitRow.style.opacity = enabled ? '1' : '0.5';
        mcpIterationLimitRow.style.pointerEvents = enabled ? '' : 'none';
      }
    };

    if (mcpIterationLimitToggle && mcpIterationLimitInput) {
      const storedMcpLimit = await MCPStore.getMaxToolIterations();
      mcpIterationLimitToggle.checked = storedMcpLimit.enabled;
      mcpIterationLimitInput.value = storedMcpLimit.value;
      applyMcpIterationLimitVisualState(storedMcpLimit.enabled);

      mcpIterationLimitToggle.onchange = async (e) => {
        await MCPStore.setMaxToolIterations({ enabled: e.target.checked, value: mcpIterationLimitInput.value });
        applyMcpIterationLimitVisualState(e.target.checked);
        Toast.info(`Custom Tool Call Limit ${e.target.checked ? 'diaktifkan' : 'dinonaktifkan'}.`);
      };
      mcpIterationLimitInput.onchange = async (e) => {
        await MCPStore.setMaxToolIterations({ enabled: mcpIterationLimitToggle.checked, value: e.target.value });
        const savedMcpLimit = await MCPStore.getMaxToolIterations();
        mcpIterationLimitInput.value = savedMcpLimit.value;
      };
    }

    // Embed HTML (Experimental, drawer copy - mirrors mcpView.js). Independent
    // of everything else here except the master MCP switch above. Defaults
    // OFF - see MCPStore.getEmbedHtmlEnabled()'s safe-default comment.
    const mcpEmbedHtmlToggle = container.querySelector('#drawer-mcp-embed-html-toggle');
    if (mcpEmbedHtmlToggle) {
      mcpEmbedHtmlToggle.checked = await MCPStore.getEmbedHtmlEnabled();
      mcpEmbedHtmlToggle.onchange = async (e) => {
        await MCPStore.setEmbedHtmlEnabled(e.target.checked);
        Toast.info(`Embed HTML ${e.target.checked ? 'diaktifkan' : 'dinonaktifkan'}.`);
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
        buttons: [
          { id: 'btn-close-settings-modal', label: 'Tutup', className: 'btn-secondary', onClick: () => Modal.close() },
          {
            id: 'btn-save-settings-modal',
            label: 'Save',
            className: 'btn-primary',
            onClick: () => {
              // settingsView.js's own #btn-save-settings still holds the real
              // save logic - `embedded: true` just hides that button (a fixed
              // savebar has no sane place inside a Modal), this footer button
              // triggers the exact same handler instead of duplicating it.
              overlay.querySelector('#btn-save-settings')?.click();
            }
          }
        ]
      });
      SettingsView.render(overlay.querySelector('#embedded-settings-view'), { embedded: true });
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
        closeDrawer();
        Toast.info('Chat session deleted.');
      }
    };

    // Internal State Render Methods
    const updateSessionList = async () => {
      const chatSessions = await ChatStore.getChatsByCharacter(selectedCharId);
      const listEl = container.querySelector('#right-drawer-session-list');

      listEl.innerHTML = chatSessions.map(s => `
        <div class="session-item ${s.id === currentChatId ? 'active' : ''}" data-id="${s.id}" style="padding:0.75rem 0.9rem; background:var(--bg-surface); border-radius:var(--radius-md); border:1px solid ${s.id === currentChatId ? 'var(--accent-primary)' : 'var(--border-light)'}; cursor:pointer; font-size:0.85rem; display:flex; justify-content:space-between; align-items:center; box-shadow:var(--shadow-sm);">
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
          closeDrawer();
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
      // The user may have navigated away while this call was queued behind an
      // earlier `await` (e.g. a generation's abort/error handler racing
      // App.navigate()'s DOM swap after ChatView.teardown() runs) - the data
      // is already safely persisted via ChatStore by this point, there's just
      // nothing left on screen to render it into.
      if (!messagesEl) return;
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
                <img src="${escapeAttr(activeChar.avatar)}" class="message-avatar" onerror="this.src='https://api.dicebear.com/7.x/bottts/svg?seed=${avatarSeed(activeChar.name)}'">
                <div class="message-sender-name">${escapeHtml(activeChar.name)}</div>
              </div>
              <div class="message-content">
                ${this.formatRoleplayMarkdown(startMsg)}
              </div>
            </div>
          </div>
        `;
        await refreshContextGauge();
        await refreshCompactBanner();
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
        const visibleTrace = visibleToolTrace(toolTrace);

        return `
          <div class="message-block ${isUser ? 'user' : 'assistant'}${m.isSummary ? ' summary-message-block' : ''}" data-id="${m.id}">
            <div class="message-block-inner">
              <div class="message-header">
                <img src="${escapeAttr(avatar)}" class="message-avatar" onerror="this.src='https://api.dicebear.com/7.x/bottts/svg?seed=${avatarSeed(senderName)}'">
                <div class="message-sender-name">${escapeHtml(senderName)}</div>
              </div>

              ${m.isSummary ? `
                <div class="summary-message-badge">
                  <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"></path></svg>
                  <span>Ringkasan Otomatis</span>
                </div>
              ` : ''}

              ${!isUser && visibleTrace.length > 0 ? `
                <div class="tool-trace-block" data-msgid="${m.id}">
                  <button class="thinking-toggle" type="button">
                    ${WRENCH_ICON_SVG}
                    <svg class="thinking-chevron" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg>
                    <span>Tools Used</span>
                    <span class="thinking-token-badge">${visibleTrace.length} call${visibleTrace.length > 1 ? 's' : ''}</span>
                  </button>
                  <div class="thinking-content">${toolTraceDetailHTML(toolTrace)}</div>
                </div>
              ` : ''}

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
                  ${!isUser && idx === 0 && msgs.length === 1 ? `
                    <button class="btn-msg-action btn-personalize-greeting" data-id="${m.id}" title="Personalize opening message with AI">
                      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"></path></svg>
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

      // AI-driven step-by-step greeting personalization wizard - only ever
      // rendered on a fresh chat's sole greeting message (see the button's
      // own idx===0 && msgs.length===1 guard in the template above).
      messagesEl.querySelectorAll('.btn-personalize-greeting').forEach(btn => {
        btn.onclick = () => {
          const msgId = btn.dataset.id;
          ChatView.openGreetingWizard({
            messageId: msgId,
            character: activeChar,
            persona: activePersonaObj,
            onApplied: () => refreshMessageBlock(msgId, 'next')
          });
        };
      });

      // Inline message editing (both user and assistant messages)
      messagesEl.querySelectorAll('.btn-edit-message').forEach(btn => {
        btn.onclick = async () => {
          const msgId = btn.dataset.id;
          // Re-read from the store, not from the render-time `msgs` snapshot:
          // swipes only refresh the DOM, so that snapshot holds the PREVIOUS
          // variation's content and saving it would clobber the active one.
          const msgObj = await ChatStore.getMessageById(msgId);
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
            closeDrawer();
            Toast.success(`New session "${newChat.title}" created from fork.`);
          } catch (err) {
            Toast.error(err.message);
          }
        };
      });

      await refreshContextGauge();
      await refreshCompactBanner();
    };

    // Auto-generates a short session title at the cadence isAutoTitlePoint()
    // defines (first at AUTO_TITLE_FIRST_AT messages, then every
    // AUTO_TITLE_INTERVAL after that), unless the user has manually renamed
    // the session (chat.titleEdited). Only ever reads the last 10
    // messages/3000 chars of the conversation, never the whole (potentially
    // very long) history - a title just needs a recent flavor of the scene,
    // not the full transcript, and re-sending the whole thing on every
    // regeneration would burn tokens for no benefit to the title itself.
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

    // Grows the composer to fit a long draft instead of scrolling inside a
    // fixed 2-row box, stopping at the CSS max-height (180px desktop / 120px
    // mobile, see .chat-textarea in css/chat.css - read via getComputedStyle
    // so this stays in sync with that breakpoint instead of duplicating the
    // numbers here) and scrolling internally past that point. That cap is
    // the "safe point" - it grows the input without ever eating so much of
    // the floating composer's height that it crowds out the message stream
    // or the toolbar/send button below it, on either desktop or mobile.
    // style.height='auto' before measuring is required: scrollHeight only
    // reports content beyond the CURRENT height, so without resetting first
    // the box would never shrink back down after deleting text.
    const autoResizeComposer = () => {
      sendInput.style.height = 'auto';
      const fullHeight = sendInput.scrollHeight;
      const maxHeight = parseFloat(getComputedStyle(sendInput).maxHeight) || 180;
      sendInput.style.height = `${Math.min(fullHeight, maxHeight)}px`;
      sendInput.style.overflowY = fullHeight > maxHeight ? 'auto' : 'hidden';
    };
    sendInput.addEventListener('input', autoResizeComposer);

    const triggerAIGeneration = async () => {
      if (isGenerating) return;
      // Claim the slot synchronously - everything between here and
      // setGeneratingState(true) below is async, so two fast clicks both got
      // past the guard and ran concurrent generations.
      isGenerating = true;

      // Pin the session this turn belongs to: `currentChatId` is mutable and
      // the drawer lets the user switch sessions mid-generation, which would
      // otherwise commit this reply into whatever chat is open when it lands.
      const targetChatId = currentChatId;
      const currentMessages = await ChatStore.getMessages(targetChatId);
      if (!currentMessages.length) { isGenerating = false; return; }

      const lastMsg = currentMessages[currentMessages.length - 1];
      if (lastMsg.role !== 'user') { isGenerating = false; return; } // AI only responds if last message is from user

      const proxyObj = await ProxyStore.getDefault();
      if (!proxyObj) {
        isGenerating = false;
        Toast.error('Please configure a Multi-Proxy API profile first in the Multi-Proxy Config menu!');
        return;
      }

      const activePersonaObj = await PersonaStore.getDefault();
      const genSettings = await ProxyStore.getGenerationSettings();
      const globalPrompt = await ProxyStore.getGlobalSystemPrompt();
      // MCP tools + the default builtin view-image tool (only offered for a
      // vision-capable model, see js/services/builtinTools.js).
      const activeTools = [...(await MCPToolRegistry.getActiveTools()), ...(await getBuiltinTools(proxyObj))];
      const immersiveRoleplay = await MCPStore.getImmersiveRoleplay();
      const immersiveIntensity = await MCPStore.getImmersiveIntensity();
      // Deliberately NOT derived from immersive intensity - an earlier version
      // auto-raised this for High/MAX, but a hard round cap fights against
      // "use tools massively" (AgentRunner throws once it's hit) instead of
      // enabling it. This is purely the user's own opt-in override now.
      const storedMcpLimit = await MCPStore.getMaxToolIterations();
      const mcpMaxIterations = storedMcpLimit.enabled ? storedMcpLimit.value : undefined;

      const promptPayload = applyPrefill(genSettings, PromptBuilder.buildPromptPayload({
        character: activeChar,
        persona: activePersonaObj,
        globalSystemPrompt: globalPrompt,
        messages: currentMessages,
        tools: activeTools,
        immersiveRoleplay,
        immersiveIntensity
      }));

      const messagesEl = container.querySelector('#messages-container');
      // The awaits above (proxy/settings/tool discovery) give a navigation-away
      // a window to tear this view down before generation actually starts -
      // same reasoning as renderMessages()'s guard below, just earlier in the
      // sequence. Nothing to attach a typing indicator to.
      if (!messagesEl) { isGenerating = false; return; }
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
      // Captured once: the module-level controller is nulled in `finally`, but
      // the permission prompt's abort wiring needs this turn's signal for the
      // whole run (including while a prompt is waiting on the user).
      const abortSignal = activeAbortController.signal;
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
      // `tools` yet. Rendering these separately (via `createLiveBodyHost`) is
      // what lets a tool marker appear the moment its round resolves, instead
      // of only once the whole turn commits and `renderMessages()` re-renders
      // from the persisted `toolSegments`.
      let liveSegments = [];
      let currentRoundText = liveContent;
      const typingPlaceholderHTML = `<em style="color:var(--text-dim);">${escapeHtml(activeChar.name)} sedang mengetik...</em>`;

      const typingInnerEl = typingIndicator.querySelector('.message-block-inner');
      const typingContentEl = typingIndicator.querySelector('#typing-indicator-content');
      const typingBodyHost = createLiveBodyHost(typingContentEl, (t) => this.formatRoleplayMarkdown(t, activePersonaObj?.name || 'User', activeChar.name || 'Character'), typingPlaceholderHTML);
      typingBodyHost.update(liveSegments, currentRoundText);

      // Coalesce rapid/bursty chunk delivery into at most one DOM update per
      // ~50ms - see createThrottledRenderer's comment.
      const scheduleContentRender = createThrottledRenderer(() => {
        typingBodyHost.update(liveSegments, currentRoundText);
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
          signal: abortSignal,
          maxIterations: mcpMaxIterations,
          transformFirstResult: (result) => mergePrefillResult(genSettings, result),
          characterAvatar: activeChar.avatar,
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
            // Gate every tool call on the user's stored permission, prompting
            // above the composer for anything not explicitly configured.
            // MUST stay wired - without it AgentRunner falls back to running
            // tools unprompted, which is the exact risk this feature removes.
            onPermissionRequest: (call) => requestToolPermission(call, abortSignal),
            onToolDeclined: (call) => {
              // Show the refusal where the running-tool spinners appear, so a
              // declined call doesn't just silently do nothing on screen.
              liveToolCalls.push({ id: call.id, name: call.name, done: true, declined: true });
              syncLiveToolBox(typingInnerEl, liveToolCalls);
              scrollToBottom(messagesEl);
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
            onToolResult: (call, result, traceEntry) => {
              liveToolTrace.push(traceEntry ? { ...traceEntry } : { name: call.name, args: call.args, result });
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
        await ChatStore.addMessage(targetChatId, 'assistant', finalContent, finalThinking, [finalContent], finalToolTrace, finalSegments, collectToolImages(finalToolTrace), collectToolEmbeds(finalToolTrace));
        await renderMessages();

        const updatedMessages = await ChatStore.getMessages(targetChatId);
        const chatObj = await ChatStore.getChatById(targetChatId);
        if (chatObj && !chatObj.titleEdited && isAutoTitlePoint(updatedMessages.length)) {
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
            await ChatStore.addMessage(targetChatId, 'assistant', liveContent, liveThinking, [liveContent], liveToolTrace, [], collectToolImages(liveToolTrace), collectToolEmbeds(liveToolTrace));
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
        // Belt-and-braces: a prompt still on screen here (error thrown while
        // one was open) would otherwise sit above the composer forever.
        removeToolPermissionPrompt();
        setGeneratingState(false);
        sendInput.focus();
        await flushQueuedMessageIfAny();
      }
    };

    const sendMessageText = async (text, images = []) => {
      await ChatStore.addMessage(currentChatId, 'user', text, '', [], [], [], images);
      await renderMessages();
      await triggerAIGeneration();
    };

    const refreshQueuedIndicator = () => {
      const indicatorEl = container.querySelector('#queued-message-indicator');
      const textEl = container.querySelector('#queued-message-text');
      if (!indicatorEl || !textEl) return;
      const hasQueued = !!queuedMessage || queuedImages.length > 0;
      indicatorEl.classList.toggle('hidden', !hasQueued);
      if (hasQueued) {
        textEl.textContent = queuedMessage || (queuedImages.length ? `[${queuedImages.length} image${queuedImages.length > 1 ? 's' : ''}]` : '');
      }
    };

    // A queued draft belongs to the session it was typed in - drop it
    // whenever `currentChatId` changes so it can never fire into a
    // different session than the one the user was looking at. Also drops any
    // not-yet-sent attached images for the same reason.
    const clearQueuedMessage = () => {
      queuedMessage = null;
      queuedImages = [];
      pendingAttachedImages = [];
      refreshAttachPreview();
      refreshQueuedIndicator();
    };

    // Bind this chat's own send/refresh closures as the target for the
    // module-level queue - a message queued while generating is in flight
    // gets flushed through here once the response finishes (see
    // flushQueuedMessageIfAny above).
    queuedMessageHandlers = { flush: sendMessageText, refreshIndicator: refreshQueuedIndicator };
    queuedMessage = null; // discard any leftover queue from a previous render/session
    queuedImages = [];
    pendingAttachedImages = [];
    refreshQueuedIndicator();

    const handleSendMessage = async () => {
      const text = sendInput.value.trim();
      const images = pendingAttachedImages;
      if (!text && !images.length) return;
      sendInput.value = '';
      autoResizeComposer();
      pendingAttachedImages = [];
      refreshAttachPreview();

      if (isGenerating) {
        // Don't block drafting while the AI is responding - queue it and
        // send automatically once the in-flight generation ends.
        queuedMessage = text;
        queuedImages = images;
        refreshQueuedIndicator();
        Toast.info('Pesan diantrikan, akan dikirim setelah respons ini selesai.');
        return;
      }

      await sendMessageText(text, images);
    };

    sendBtn.onclick = () => {
      if (isGenerating) {
        if (activeAbortController) activeAbortController.abort();
      } else {
        handleSendMessage();
      }
    };
    sendInput.onkeydown = (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      // Mobile: bare Enter just inserts a newline (soft-keyboard behavior),
      // sending stays button-only - checked at keypress time, not just at
      // render time, matching the same window.innerWidth<=768 convention
      // populateModelSelect() uses for its own desktop/mobile branch.
      if (window.innerWidth <= 768) return;
      e.preventDefault();
      handleSendMessage();
    };

    container.querySelector('#btn-cancel-queued').onclick = () => {
      if (!queuedMessage && !queuedImages.length) return;
      sendInput.value = queuedMessage || '';
      autoResizeComposer();
      pendingAttachedImages = queuedImages;
      queuedMessage = null;
      queuedImages = [];
      refreshAttachPreview();
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

  /**
   * Tears down whatever ChatView.render() currently has mounted: aborts an
   * in-flight generation, force-resolves any open MCP tool-permission prompt,
   * and removes the window-level keydown/message listeners. Idempotent (safe
   * to call when nothing is mounted, or more than once) since it clears
   * `activeChatTeardown` after running. Must be called by App.navigate()
   * before it replaces #view-container's innerHTML for ANY route change,
   * not just the dedicated Back button - see the note on `activeChatTeardown`
   * above for why.
   */
  static teardown() {
    if (!activeChatTeardown) return;
    const cleanup = activeChatTeardown;
    activeChatTeardown = null;
    cleanup();
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
    // Claim the slot synchronously - every early return below must release it.
    isGenerating = true;
    const msg = await ChatStore.getMessageById(messageId);
    if (!msg) { isGenerating = false; return; }
    if (msg.isSummary) {
      // An auto-generated recap (ChatStore.createCompactedChat) isn't
      // something the character "said" - regenerating it would ask the model
      // for an in-character reply instead of a summary, which reads as
      // broken. Only ever has one swipe variation by construction anyway.
      isGenerating = false;
      Toast.error('Pesan ringkasan otomatis tidak bisa di-regenerate.');
      return;
    }
    const msgs = await ChatStore.getMessages(chatId);
    const msgIndex = msgs.findIndex(m => m.id === messageId);
    if (msgIndex === -1) { isGenerating = false; return; }

    const swipeCount = msg.swipes ? msg.swipes.length : 1;
    const currentIdx = msg.swipeIndex || 0;

    // If there is a next existing swipe variation, just switch to it - always allowed.
    if (currentIdx + 1 < swipeCount) {
      await ChatStore.updateMessageSwipes(messageId, msg.swipes, currentIdx + 1);
      isGenerating = false;
      onDone();
      return;
    }

    // Regenerating a brand NEW variation is only allowed on the LAST assistant
    // message in the chat. Older messages must be forked first.
    const assistantIndexes = msgs.map((m, i) => (m.role === 'assistant' ? i : -1)).filter(i => i >= 0);
    const lastAssistantIndex = assistantIndexes.length ? assistantIndexes[assistantIndexes.length - 1] : -1;
    if (msgIndex !== lastAssistantIndex) {
      isGenerating = false;
      Toast.error('Pesan lama tidak bisa di-regenerate. Fork sesi ini dulu untuk melanjutkan dari pesan ini.');
      return;
    }

    // Generate a brand NEW swipe response!
    const activeProxy = await ProxyStore.getDefault();
    if (!activeProxy) { isGenerating = false; return Toast.error('Belum ada Proxy aktif.'); }

    const activePersonaObj = await PersonaStore.getDefault();
    const genSettings = await ProxyStore.getGenerationSettings();
    const globalPrompt = await ProxyStore.getGlobalSystemPrompt();
    // See the matching comment in triggerAIGeneration - MCP tools + the
    // default builtin view-image tool (vision-gated).
    const activeTools = [...(await MCPToolRegistry.getActiveTools()), ...(await getBuiltinTools(activeProxy))];
    const immersiveRoleplay = await MCPStore.getImmersiveRoleplay();
    const immersiveIntensity = await MCPStore.getImmersiveIntensity();
    // See the matching comment in triggerAIGeneration - independent of
    // immersive intensity, purely the user's own opt-in override.
    const storedMcpLimit = await MCPStore.getMaxToolIterations();
    const mcpMaxIterations = storedMcpLimit.enabled ? storedMcpLimit.value : undefined;

    // History up to the message before this assistant message
    const historyBefore = msgs.slice(0, msgIndex);
    const promptPayload = applyPrefill(genSettings, PromptBuilder.buildPromptPayload({
      character: activeChar,
      persona: activePersonaObj,
      globalSystemPrompt: globalPrompt,
      messages: historyBefore,
      tools: activeTools,
      immersiveRoleplay,
      immersiveIntensity
    }));

    activeAbortController = new AbortController();
    // See the matching capture in `triggerAIGeneration` - the permission
    // prompt needs this turn's signal even after the module-level controller
    // has been cleared.
    const abortSignal = activeAbortController.signal;
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
    // re-segmented) DOM from the stored message. Also clears any images/embeds
    // the OLD variation attached - left in place, they doubled up alongside
    // whatever the NEW variation attaches instead of being replaced by it.
    if (blockInnerEl) {
      const staleThinking = blockInnerEl.querySelector('.thinking-block');
      if (staleThinking) staleThinking.remove();
      const staleTrace = blockInnerEl.querySelector('.tool-trace-block');
      if (staleTrace) staleTrace.remove();
      const staleLive = blockInnerEl.querySelector('.tool-live-block');
      if (staleLive) staleLive.remove();
      blockInnerEl.querySelectorAll('.message-content, .tool-inline-note, .message-image-row, .message-embed-card').forEach(el => el.remove());
    }

    // Wrapper host, not itself `.message-content` - a live variation can
    // involve several `.message-content`/`.tool-inline-note` pairs once tool
    // calls are involved (see `createLiveBodyHost`), same as a persisted
    // multi-segment message does.
    const contentHostEl = document.createElement('div');
    // Classed so syncMessageBody() can remove this wrapper too - left behind,
    // each swipe adds an empty flex child (and one extra 0.75rem gap).
    contentHostEl.className = 'live-body-host';
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
    // Same "{name} sedang mengetik..." wording as triggerAIGeneration's typing
    // indicator - was "Menggenerasi variasi baru..." before, which read as an
    // inconsistent status between a fresh reply and a swiped one.
    const swipePlaceholderHTML = `<em style="color:var(--text-dim);">${escapeHtml(activeChar.name)} sedang mengetik...</em>`;

    const swipeBodyHost = contentHostEl ? createLiveBodyHost(contentHostEl, (t) => ChatView.formatRoleplayMarkdown(t, userName, charName), swipePlaceholderHTML) : null;

    // Coalesce rapid/bursty chunk delivery into at most one DOM update per
    // ~50ms - see createThrottledRenderer's comment.
    const scheduleContentRender = createThrottledRenderer(() => {
      if (swipeBodyHost) swipeBodyHost.update(liveSegments, currentRoundText);
      scrollToBottom(messagesEl);
    });
    const scheduleThinkingRender = createThrottledRenderer(() => {
      if (blockInnerEl) syncThinkingBlock(blockInnerEl, liveThinking, { streaming: true });
      scrollToBottom(messagesEl);
    });

    try {
      // Non-streaming mode has nothing to progressively render (the whole
      // reply arrives at once at the end), so this always just shows the
      // placeholder wrapped the same way `createLiveBodyHost` would wrap real
      // content - keeping `.message-content`'s own styling (font-size,
      // line-height) rather than leaving the `<em>` as a bare, unstyled child
      // of `contentHostEl`.
      if (contentHostEl && swipeBodyHost) {
        // Always go through the host: assigning contentHostEl.innerHTML here
        // detached the host's own committed/current sub-divs, so every later
        // update() (round boundaries in non-streaming mode) painted nowhere.
        // liveCurrentTextHTML() already falls back to swipePlaceholderHTML
        // while there is no text yet, so this renders identically.
        swipeBodyHost.update(liveSegments, currentRoundText);
      }

      const { content: newContent, thinking: newThinking, toolTrace, segments: newSegments } = await AgentRunner.run({
        proxy: activeProxy,
        initialPayload: promptPayload,
        settings: genSettings,
        tools: activeTools,
        streaming: genSettings.streamingEnabled,
        signal: abortSignal,
        maxIterations: mcpMaxIterations,
        transformFirstResult: (result) => mergePrefillResult(genSettings, result),
        characterAvatar: activeChar.avatar,
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
          // Same permission gate as triggerAIGeneration - a regenerated swipe
          // must not be a way to run tools without being asked.
          onPermissionRequest: (call) => requestToolPermission(call, abortSignal),
          onToolDeclined: (call) => {
            liveToolCalls.push({ id: call.id, name: call.name, done: true, declined: true });
            if (blockInnerEl) syncLiveToolBox(blockInnerEl, liveToolCalls);
            scrollToBottom(messagesEl);
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
          onToolResult: (call, result, traceEntry) => {
            liveToolTrace.push(traceEntry ? { ...traceEntry } : { name: call.name, args: call.args, result });
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
      await ChatStore.updateMessageSwipes(messageId, updatedSwipes, newIndex, newThinking, toolTrace, newSegments, collectToolImages(toolTrace), collectToolEmbeds(toolTrace));
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
          await ChatStore.updateMessageSwipes(messageId, updatedSwipes, newIndex, liveThinking, liveToolTrace, [], collectToolImages(liveToolTrace), collectToolEmbeds(liveToolTrace));
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
      removeToolPermissionPrompt();
      setGeneratingState(false);
      await flushQueuedMessageIfAny();
    }
  }

  /**
   * AI-driven step-by-step wizard for personalizing a fresh chat's opening
   * greeting message. Asks ONE question at a time (3 preset options + a
   * free-text input), each next question built from every answer given so
   * far (`GreetingWizardService.nextQuestion`), then writes a brand new
   * greeting from the full Q&A (`GreetingWizardService.generateGreeting`).
   * The result is applied as a NEW SWIPE VARIATION on the target message
   * (`messageId`, the chat's already-persisted greeting) via
   * `ChatStore.updateMessageSwipes` - the original greeting is never lost,
   * just no longer the active variation, exactly like a normal swipe.
   * `Modal` has no "update body in place" API, so this manipulates the
   * returned `overlay`'s `.modal-body` directly across every step instead of
   * opening/closing a new modal per step (which would read as flicker/lost
   * position) - see the file-level `Modal` class for why that's safe (it
   * just returns the live overlay element, no other file does this yet).
   */
  static async openGreetingWizard({ messageId, character, persona, onApplied }) {
    const proxy = await ProxyStore.getDefault();
    if (!proxy) {
      Toast.error('Please configure a Multi-Proxy API profile first in the Multi-Proxy Config menu!');
      return;
    }
    const genSettings = await ProxyStore.getGenerationSettings();

    const answers = [];
    // questionHistory[step] is the {question, options} shown at that step -
    // cached so "Back" can redisplay a prior question without a new AI call.
    const questionHistory = [];
    let step = 0;
    let generatedText = '';
    // Free-text language for the generated question/greeting text, captured by
    // renderLanguageStep() before the Q&A flow starts. Empty string (never
    // answered) is passed through as-is to GreetingWizardService, which
    // defaults to English on its own - kept as the single source of truth for
    // that default instead of duplicating it here.
    let language = '';

    const overlay = Modal.open({
      title: 'Personalize Opening Message (AI)',
      contentHTML: '<div style="text-align:center; padding:2rem 0; color:var(--text-muted);">Loading...</div>'
    });
    const body = () => overlay.querySelector('.modal-body');

    const renderLoading = (msg) => {
      body().innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; padding:2rem 0; gap:0.75rem;">
          <div class="app-loading-spinner" style="width:28px; height:28px;"></div>
          <p style="color:var(--text-muted); font-size:0.85rem; margin:0;">${escapeHtml(msg)}</p>
        </div>
      `;
    };

    const renderError = (message, { onRetry, onBack }) => {
      body().innerHTML = `
        <div style="text-align:center; padding:1rem 0;">
          <p style="color:var(--accent-rose); font-size:0.88rem; margin-bottom:1rem;">${escapeHtml(message)}</p>
          <div style="display:flex; justify-content:center; gap:0.5rem;">
            ${onBack ? '<button class="btn btn-secondary btn-sm" id="wizard-err-back">Back</button>' : ''}
            <button class="btn btn-primary btn-sm" id="wizard-err-retry">Retry</button>
            <button class="btn btn-secondary btn-sm" id="wizard-err-cancel">Cancel</button>
          </div>
        </div>
      `;
      body().querySelector('#wizard-err-retry').onclick = onRetry;
      if (onBack) body().querySelector('#wizard-err-back').onclick = onBack;
      body().querySelector('#wizard-err-cancel').onclick = () => Modal.closeOverlay(overlay);
    };

    // Free-text language capture, shown once before the Q&A flow starts (not
    // reachable again via "Back" from question 1 - same as the flow never
    // letting question 1 go further back than itself). Left blank = English,
    // handled downstream by GreetingWizardService, not duplicated here.
    const renderLanguageStep = () => {
      body().innerHTML = `
        <p style="font-weight:600; margin-bottom:0.4rem;">What language should the new opening message be written in?</p>
        <p style="color:var(--text-muted); font-size:0.82rem; margin-bottom:0.9rem;">Type any language (e.g. "Indonesian", "Japanese", "Spanish") - leave it blank for English.</p>
        <div style="display:flex; gap:0.5rem;">
          <input class="input" id="wizard-language-input" placeholder="English (default)" style="flex:1;">
          <button class="btn btn-primary" id="wizard-language-continue">Continue</button>
        </div>
        <div style="display:flex; justify-content:flex-end; margin-top:1.1rem;">
          <button class="btn btn-secondary btn-sm" id="wizard-language-cancel">Cancel</button>
        </div>
      `;
      const langInput = body().querySelector('#wizard-language-input');
      langInput.focus();
      const proceed = () => {
        language = langInput.value.trim();
        loadQuestion();
      };
      body().querySelector('#wizard-language-continue').onclick = proceed;
      langInput.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); proceed(); }
      };
      body().querySelector('#wizard-language-cancel').onclick = () => Modal.closeOverlay(overlay);
    };

    const goBackToQuestion = (targetStep) => {
      step = targetStep;
      answers.pop();
      renderQuestion(questionHistory[step]);
    };

    const renderQuestion = (q) => {
      body().innerHTML = `
        <p style="color:var(--text-muted); font-size:0.78rem; margin-bottom:0.6rem;">Question ${step + 1} of ${GREETING_WIZARD_TOTAL_QUESTIONS}</p>
        <p style="font-weight:600; margin-bottom:0.9rem;">${escapeHtml(q.question)}</p>
        <div style="display:flex; flex-direction:column; gap:0.5rem;">
          ${q.options.map(opt => `<button type="button" class="btn btn-secondary wizard-option-btn" data-value="${escapeAttr(opt)}" style="justify-content:flex-start; text-align:left; white-space:normal; width:100%;">${escapeHtml(opt)}</button>`).join('')}
        </div>
        <div style="display:flex; gap:0.5rem; margin-top:0.9rem;">
          <input class="input" id="wizard-custom-input" placeholder="Or type your own answer..." style="flex:1;">
          <button class="btn btn-primary" id="wizard-custom-submit">Send</button>
        </div>
        <div style="display:flex; justify-content:space-between; margin-top:1.1rem;">
          <button class="btn btn-secondary btn-sm" id="wizard-back" ${step === 0 ? 'disabled' : ''}>Back</button>
          <button class="btn btn-secondary btn-sm" id="wizard-cancel">Cancel</button>
        </div>
      `;

      const submitAnswer = (answer) => {
        const trimmed = (answer || '').trim();
        if (!trimmed) return;
        answers.push({ question: q.question, answer: trimmed });
        if (answers.length >= GREETING_WIZARD_TOTAL_QUESTIONS) {
          loadPreview();
        } else {
          step += 1;
          loadQuestion();
        }
      };

      body().querySelectorAll('.wizard-option-btn').forEach(btn => {
        btn.onclick = () => submitAnswer(btn.dataset.value);
      });
      const customInput = body().querySelector('#wizard-custom-input');
      body().querySelector('#wizard-custom-submit').onclick = () => submitAnswer(customInput.value);
      customInput.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitAnswer(customInput.value); }
      };
      body().querySelector('#wizard-back').onclick = () => { if (step > 0) goBackToQuestion(step - 1); };
      body().querySelector('#wizard-cancel').onclick = () => Modal.closeOverlay(overlay);
    };

    const loadQuestion = async () => {
      renderLoading(step === 0 ? 'Generating first question...' : 'Generating next question...');
      try {
        const q = await GreetingWizardService.nextQuestion({ proxy, character, persona, answers, language });
        questionHistory[step] = q;
        renderQuestion(q);
      } catch (err) {
        renderError(err.message || 'Failed to generate question.', {
          onRetry: loadQuestion,
          onBack: step > 0 ? () => goBackToQuestion(step - 1) : null
        });
      }
    };

    const loadPreview = async () => {
      renderLoading('Writing new opening message...');
      try {
        generatedText = await GreetingWizardService.generateGreeting({ proxy, genSettings, character, persona, answers, language });
        renderPreview();
      } catch (err) {
        renderError(err.message || 'Failed to generate opening message.', {
          onRetry: loadPreview,
          onBack: () => goBackToQuestion(GREETING_WIZARD_TOTAL_QUESTIONS - 1)
        });
      }
    };

    const renderPreview = () => {
      body().innerHTML = `
        <p style="font-weight:600; margin-bottom:0.6rem;">New Opening Message Preview</p>
        <textarea class="textarea" id="wizard-preview-text" style="min-height:180px;">${escapeHtml(generatedText)}</textarea>
        <div style="display:flex; flex-wrap:wrap; gap:0.5rem; justify-content:flex-end; margin-top:1rem;">
          <button class="btn btn-secondary btn-sm" id="wizard-preview-back">Edit Answers</button>
          <button class="btn btn-secondary btn-sm" id="wizard-preview-regenerate">Regenerate</button>
          <button class="btn btn-primary btn-sm" id="wizard-preview-apply">Use This Message</button>
        </div>
      `;
      body().querySelector('#wizard-preview-back').onclick = () => goBackToQuestion(GREETING_WIZARD_TOTAL_QUESTIONS - 1);
      body().querySelector('#wizard-preview-regenerate').onclick = () => loadPreview();
      body().querySelector('#wizard-preview-apply').onclick = async () => {
        const finalText = body().querySelector('#wizard-preview-text').value.trim();
        if (!finalText) {
          Toast.error('Opening message text cannot be empty.');
          return;
        }
        const msg = await ChatStore.getMessageById(messageId);
        if (!msg) {
          Modal.closeOverlay(overlay);
          return;
        }
        const updatedSwipes = [...(msg.swipes && msg.swipes.length ? msg.swipes : [msg.content]), finalText];
        await ChatStore.updateMessageSwipes(messageId, updatedSwipes, updatedSwipes.length - 1);
        Modal.closeOverlay(overlay);
        Toast.success('Opening message personalized successfully!');
        if (onApplied) await onApplied();
      };
    };

    renderLanguageStep();
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
    // The *action*/"quote" regex styling below must never touch the inside
    // of a fenced code block (```...```) - it used to run over the WHOLE
    // escaped message unconditionally, which mangled any code sample
    // containing a quoted string (e.g. class="box", extremely common in
    // HTML/JS/JSON/CSS) by injecting a raw <span style="..."> BEFORE
    // marked.parse() ever saw the fence, corrupting the code block's actual
    // content. Backticks survive escapeHtml() untouched, so splitting on
    // fence boundaries here and only formatting the non-code segments keeps
    // code blocks byte-for-byte as escaped source until marked + the custom
    // code renderer (registered at module load, above) handle them.
    const segments = formatted.split(/(```[\s\S]*?```)/g);
    formatted = segments.map((seg, i) => {
      if (i % 2 === 1) return seg; // odd indices are fenced code blocks
      // Format actions in italics (*action* -> <em>action</em>)
      let s = seg.replace(/\*(.*?)\*/g, '<em>$1</em>');
      // Format quotes ("speech" -> <span>"speech"</span>)
      s = s.replace(/"([^"]+)"/g, '<span style="color:var(--text-main); font-weight:500;">"$1"</span>');
      return s;
    }).join('');
    // Use marked parser if available. `breaks: true` makes single newlines
    // render as <br> instead of being collapsed away - AI/roleplay replies
    // are usually formatted with single line breaks, not blank-line paragraphs.
    if (window.marked) {
      return window.marked.parse(formatted, { breaks: true });
    }
    return formatted.replace(/\n/g, '<br>');
  }
}

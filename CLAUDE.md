# CLAUDE.md — Agent System Guide & Code Function Index

This document provides a concise architectural sitemap and function lookup table for **NnzRP**. AI agents reading this file can instantly understand the codebase structure without reading every file individually.

**Total app code is small (~5,700 lines across `js/`, excluding the vendored `marked.min.js`)** — `js/ui/views/chatView.js` is by far the largest file (~1,300+ lines) and holds most of the chat runtime logic.

---

## 🏛️ System Overview & Core Stack

- **App Name**: NnzRP (Client-Side BYOK AI Roleplay Studio)
- **Backend**: None (100% Client-Side, Browser BYOK) — all AI provider calls are direct `fetch()` from the renderer.
- **Shell**: **Electron desktop app** (`main.js` + `preload.js`, launched via `npm start` / `run.bat` → `run_electron.bat`). There is **no Python server anymore** — `server.py` was removed; older docs (README.md, AGENTS.md) still describe it and are stale.
- **Database**: Native IndexedDB (`AetheriaRoleplayDB_v2`), stores: `characters`, `chats`, `messages`, `personas`, `proxies`, `settings`.
- **Routing**: ES6 Module Router in `js/app.js`, hash-based (`#characters`, `#chat/<charId>`, `#personas`, `#proxies`, `#settings`).
- **UI Style**: Flat Grayish Slate Light Theme, No Emojis, Dedicated Fullscreen Chat Page, Storybook Per-Block Layout, Floating Input Box.
- **Packaging**: `electron-builder` (see `package.json` `build` block) → `dist/` (win-unpacked, nsis/zip/portable). `dist/` and `venv/` are build/py-tooling artifacts, not app source — ignore when searching code.

---

## 📂 Directory Sitemap & Module Map

| File Path | Component / Layer | Primary Purpose & Key Functions |
|---|---|---|
| `index.html` | Entry Point | Mounts `#app` shell + custom frameless titlebar, imports fonts, marked.js, CSS stylesheets with `?v=X` cache-busting parameters. |
| `main.js` | Electron Main Process | Creates splash + main `BrowserWindow` (frameless, `contextIsolation: true`, `nodeIntegration: false`). IPC handlers for custom titlebar (`window-minimize/maximize/close`, `window-is-maximized`) plus a stdio MCP child-process manager (`mcp:start/stop/request` — see **MCP tool-calling** below). |
| `preload.js` | Electron Preload | `contextBridge.exposeInMainWorld('electronAPI', ...)` — exposes `minimizeWindow/maximizeWindow/closeWindow/isMaximized` plus `mcp.start/stop/request` (stdio MCP bridge). Minimal surface, no filesystem/node access leaked to renderer beyond that. |
| `run.bat` / `start.bat` / `run_electron.bat` | Launcher | Windows scripts that just run `npm start` (Electron). |
| `css/variables.css` | Design Tokens | Colors (`--bg-primary: #f1f5f9`, `--accent-primary: #4f46e5`), typography, spacing, shadows. |
| `css/base.css` | Global CSS | Typography, resets, light custom scrollbars, flat text badges (`.badge-emerald`, `.badge-rose`, `.badge-cyan`). |
| `css/components.css` | UI Elements | Flat buttons (`.btn-primary`, `.btn-secondary`), inputs (`.input`, `.textarea`, `.select`), cards (`.card`), modals, toasts. |
| `css/layout.css` | Shell Layout | Main dashboard container, navigation sidebar (`.app-sidebar.collapsed`), header navbar, responsive grid. |
| `css/chat.css` | Chat Layout | Storybook per-block rows (`.message-block`), centered 880px header column, floating overlay input (`.chat-input-container`), right drawer tabs. |
| `js/app.js` | App Core / Router | Class `App`: `init()`, `renderShell()`, `navigate(view, params)`, `parseHash()`/`updateHash()`. Manages dedicated fullscreen chat view vs main dashboard views; wires titlebar buttons to `window.electronAPI`. |
| `js/config.js` | App Config | `APP_CONFIG`: sample characters (*Vespera Zenith*, *Archmage Aurelia*), default persona, default proxy presets (OpenRouter/Gemini/OpenAI/Ollama), `DEFAULT_GENERATION_SETTINGS`, the big default roleplay system prompt, and `DEFAULT_SYSTEM_PROMPT_PRESETS`. |
| `js/storage/db.js` | Database | Class `NativeDB`: `open()`, `getAll()`, `get()`, `put()`, `delete()`, `count()`, `getByIndex()`. `initDatabase()` seeds sample data on first run. `syncToDisk()` — see **Dead code** below. |
| `js/storage/characterStore.js` | Storage CRUD | Class `CharacterStore`: `getAll()`, `getById(id)`, `save(data)`, `delete(id)` (cascades to that character's chats+messages). |
| `js/storage/chatStore.js` | Storage CRUD | Class `ChatStore`: `getChatsByCharacter()`, `createChat()`, `updateChatTitle()`, `forkChat(chatId, uptoMessageId)`, `deleteChat()`, `getMessages()`, `getMessageById()`, `addMessage(chatId, role, content, thoughts, swipes, toolTrace)`, `updateMessageSwipes(id, swipes, activeIndex, thoughts, toolTrace)`, `updateMessageContent()`, `deleteMessage()`. `toolTrace` (optional, `[{name,args,result}]`) is a single current-variation field, same non-per-swipe-history limitation as `thoughts` — see **chatView internals**. |
| `js/storage/personaStore.js` | Storage CRUD | Class `PersonaStore`: `getAll()`, `getById()`, `getDefault()`, `save()` (unsets other `isDefault` flags), `delete()`. |
| `js/storage/proxyStore.js` | Storage CRUD | Class `ProxyStore`: `getAll()`, `getDefault()`, `save()`, `delete()`, `getGenerationSettings()`, `getGlobalSystemPrompt()`, `getSystemPromptPresets()`/`saveSystemPromptPresets()`. |
| `js/storage/mcpStore.js` | Storage CRUD | Class `MCPStore`: `getAll/getById/saveAll/save/delete/toggleEnabled/getEnabledServers()` for Custom MCP Server configs (`settings` key `customMcpServers`). `transport: 'http'\|'command'` picks which fields matter (`endpointUrl`/`apiKey` vs `command`/`args`/`env`). `toJSONConfig`/`parseJSONConfig` round-trip the standard `mcp_config.json` shape. See **MCP tool-calling** below. |
| `js/services/providerManager.js` | Service Layer | Class `ProviderManager`: `testConnection(proxy)`, `sendChatCompletion(...)`, `streamChatCompletion(...)` + shared `_consumeSSE()` helper. Handles OpenAI/OpenRouter/Custom, Anthropic (`/v1/messages`, `dangerously-allow-browser: true`), Gemini (`generateContent`/`streamGenerateContent`) — including each provider's distinct "native thinking" field shape. Both methods take an optional `tools` array and return `{content, thinking, toolCalls}` — see **MCP tool-calling** below. |
| `js/services/promptBuilder.js` | Service Layer | Class `PromptBuilder`: `buildPromptPayload({ character, persona, globalSystemPrompt, messages, contextLimit, tools })` — assembles system block (profile + persona + lorebook + example dialogue + short tool-availability note when `tools.length>0`), injects `first_mes` on empty history, slices recent history. |
| `js/services/lorebookEngine.js` | Service Layer | Class `LorebookEngine`: `getMatchingLore(lorebooks, messages, scanCount=10)` keyword trigger scanner over recent message text. |
| `js/services/cardImporter.js` | Service Layer | Class `CardImporter`: `parseJSONFile(file)` (also detects+delegates full NnzRP backup files to `BackupService`), `normalizeCharacterCard()`, `extractLorebooks()`, `exportToJSON(character)` for Tavern/SillyTavern/Janitor AI Card V2 JSON. |
| `js/services/backupService.js` | Service Layer | Class `BackupService`: `exportAllData()` (dumps all IndexedDB stores incl. plaintext API keys to a downloaded JSON) / `importAllData(file)` (restores all stores, calls `syncToDisk()` after). |
| `js/services/mcpClient.js` | Service Layer | Class `MCPClient`: `listTools/callTool/checkStatus(server)` — dispatches to HTTP `fetch()` JSON-RPC or (for `transport:'command'`) `window.electronAPI.mcp.*`. Does the MCP `initialize` handshake once per server per app session (tolerates servers that don't implement it). |
| `js/services/mcpToolRegistry.js` | Service Layer | Class `MCPToolRegistry`: `getActiveTools()` aggregates all enabled MCP servers into one flat, namespaced (`server__tool`) list with 60s-TTL caching; `executeTool(qualifiedName, args)` dispatches back to the right server and flattens the result to text. |
| `js/services/agentRunner.js` | Service Layer | Class `AgentRunner`: `run({proxy, initialPayload, settings, tools, streaming, callbacks, maxIterations})` — the bounded tool-use loop (default `settings.mcpMaxToolIterations`, 6) that calls `ProviderManager`, executes any returned tool calls via `MCPToolRegistry`, feeds results back, and loops until a tool-call-free response. See **MCP tool-calling** below. |
| `js/utils/sanitize.js` | Utility | `escapeHtml(str)`, `escapeAttr(str)` — used pervasively before any user/character/import-supplied string goes into `innerHTML`. See **XSS approach** below. |
| `js/utils/macroReplacer.js` | Utility | `replaceMacros(text, userName, charName)` — case-insensitive `{{user}}`/`{{char}}` substitution. |
| `js/utils/thinkingParser.js` | Utility | `extractThinking(rawText)` (non-streaming `<think>`/`<thinking>` splitter) and `ThinkingStreamParser` class (stateful incremental splitter for streaming deltas, handles tags split across chunks). |
| `js/utils/toolCallAccumulator.js` | Utility | `ToolCallAccumulator` class — assembles streamed tool-call deltas (OpenAI `tool_calls[i]` fragments, Anthropic `input_json_delta`, Gemini's already-complete `functionCall` parts) into finished `{id,name,args}` calls. |
| `js/ui/components/toast.js` | UI Component | Class `Toast`: `success(msg)`, `error(msg)`, `info(msg)` notifications without emojis. |
| `js/ui/components/modal.js` | UI Component | Class `Modal`: `open({ title, contentHTML, buttons, onClose, closeOnBackdropClick })`, `close()`, `closeOverlay()`, `closeAll()`. Supports a **stack** of nested modals. `title`/`contentHTML` are injected raw — see **XSS approach** below. |
| `js/ui/components/navbar.js` | UI Component | Class `Navbar`: `render(container, viewName, onProxyChange)` header for main dashboard, includes active-proxy `<select>`. |
| `js/ui/components/sidebar.js` | UI Component | Class `Sidebar`: `render(container, activeView, onNavigate)` main dashboard navigation sidebar with collapsible icon-only toggle (persisted via `localStorage['sidebar_collapsed']`). |
| `js/ui/views/charactersView.js` | UI View | Class `CharactersView`: `render(container, onStartChat)` AI Character Library grid + `openCharacterModal()` create/edit form, JSON card import/export. |
| `js/ui/views/chatView.js` | UI View | Class `ChatView`: `render(container, charId, callbacks)` — the whole fullscreen chat page: sessions, message stream, streaming/non-streaming generation, swipes, fork, inline edit, thinking blocks, right drawer (Sessions/Options tabs). See **chatView internals** below. |
| `js/ui/views/personasView.js` | UI View | Class `PersonasView`: `render(container)` Player User Persona Manager. |
| `js/ui/views/proxiesView.js` | UI View | Class `ProxiesView`: `render(container)` Multi-Proxy API Key & Model Configuration, plus full-data export/import buttons (delegates to `BackupService`). |
| `js/ui/views/settingsView.js` | UI View | Class `SettingsView`: `render(container)` Global system prompt + preset manager (save/save-as-new/delete), font size, streaming toggle, prefill, sampling sliders, reasoning effort/budget, backup export/import. |
| `js/ui/views/mcpView.js` | UI View (Experimental) | Class `MCPView`: `render(container)` Custom MCP Server list/CRUD + `openMCPModal()` (transport-aware form with a live "Discover Tools" test button) + `openJSONEditorModal()` (`mcp_config.json` paste/edit). Routed at `#mcp`, nav item "Custom MCP (Exp)" in `sidebar.js`. |

---

## 🧠 chatView.js internals (worth knowing before touching it)

- **Module-level singleton generation state**: `activeAbortController` and `isGenerating` are module-scope variables, not instance state — deliberate, since only one `ChatView` is ever mounted at a time in this SPA (see comment at top of the file). Don't refactor this into per-instance state without re-checking that assumption still holds.
- **Streaming vs non-streaming** both funnel through `AgentRunner.run()` (which internally calls `ProviderManager.sendChatCompletion`/`streamChatCompletion` in a loop for MCP tool-calling — see **MCP tool-calling** below), then `mergePrefillResult()` re-splits `<think>` tags after gluing the prefill text back onto the model's first-round continuation only (passed to `AgentRunner` as `transformFirstResult`, not applied to later tool-result-driven rounds).
- **Swipes**: `handleSwipeNext` only allows generating a *new* variation on the last assistant message; older messages must be forked first (`ChatStore.forkChat`) before they can be regenerated.
- **`formatRoleplayMarkdown()`** always `escapeHtml()`s raw text *before* running it through `marked.parse()` — this is the load-bearing XSS guard for chat content (AI output and user input both flow through here). Don't bypass it.

---

## 🔌 MCP (Model Context Protocol) tool-calling

A first attempt at this (commit `138bf8e`) was fully reverted (`693754f`) because it only ever **injected a text description of tools into the system prompt** with no actual function-calling wire-up — the model had no structured way to call anything, so it either narrated pretending to or ignored the instruction. The current implementation (rebuilt from scratch, same file names, different contents) does real provider-native function-calling instead:

- **Trust boundary**: the LLM can only ever choose *which already-user-configured tool to call* and *what JSON arguments to pass*. It never configures, launches, or points at a new MCP server itself — `command`/`args`/`env`/`endpointUrl` are only ever written by the user through `mcpView.js`.
- **Transports**: `http` (direct `fetch()` JSON-RPC from the renderer, `mcpClient.js`) and `command`/stdio (spawned as a child process from `main.js`, talked to via the `window.electronAPI.mcp` bridge from `preload.js` — newline-delimited JSON-RPC over stdin/stdout, request/response correlated by `id` in `main.js`'s `mcpProcesses` map).
- **Flow per chat generation** (`chatView.js` → `triggerAIGeneration`/`handleSwipeNext`): `MCPToolRegistry.getActiveTools()` → `PromptBuilder.buildPromptPayload({..., tools})` → `AgentRunner.run({proxy, initialPayload, tools, streaming, ...})`. `AgentRunner` calls `ProviderManager`, and whenever the response includes `toolCalls`, executes them via `MCPToolRegistry.executeTool()` and loops (bounded by `settings.mcpMaxToolIterations`, default 6) — this is what lets a character call tools more than once per user turn.
- **Per-provider wire format** lives entirely in `providerManager.js` (`toOpenAIMessages`/`toAnthropicMessages`/`toGeminiContents` + matching `build*ToolsParam` builders) — `AgentRunner`/`chatView.js` stay provider-agnostic and only ever see the normalized `{role, content, toolCalls?}` / `{role:'tool', toolCallId, toolName, content}` shape. Streaming tool-call deltas (fragmented JSON args for OpenAI/Anthropic, whole objects for Gemini) are assembled by `js/utils/toolCallAccumulator.js`.
- **Regression invariant**: when `tools` is empty (no MCP servers enabled), every one of these code paths is a no-op passthrough — `buildXToolsParam` returns `undefined`, the message translators return the exact same shape as before, and `AgentRunner`'s loop exits after one iteration. A tool-less character/session should behave byte-for-byte like it did before this feature existed; if you're debugging a regression in plain (non-MCP) chat, suspect a bug in one of these translators before suspecting unrelated code.
- **UI**: `mcpView.js` (`#mcp` route) for full CRUD + a live "Discover Tools" test button; the chat right-drawer's 3rd tab ("MCP (Exp)") for a lighter per-session enable/disable + status check. A message's `toolTrace` (if any) renders as a collapsible "Tools Used" chip next to the thinking block (`.tool-trace-block` — deliberately a *different* CSS class from `.thinking-block` so the live-streaming `syncThinkingBlock()` DOM lookup can never accidentally grab it).

---

## ⚠️ Known dead code / latent bugs (don't be surprised, and clean up if you touch these areas)

1. **`ProxyStore.getSystemPromptPresets()`** (`js/storage/proxyStore.js`) falls back to `APP_CONFIG.DEFAULT_SYSTEM_PROMPT_PRESETS` if the `systemPromptPresets` settings record is missing — but `APP_CONFIG` is never imported in that file. This only matters if that IndexedDB record is ever absent; `initDatabase()` always seeds it on first run, so the buggy branch isn't currently reachable in normal use. If you ever see `ReferenceError: APP_CONFIG is not defined` from this file, this is why.
2. **`db.js`'s disk-sync path is dead under Electron**: `syncToDisk()` and the restore-from-disk block in `initDatabase()` only run `if (window.location.protocol.startsWith('http'))` — true only for the old `server.py` setup, never true for the Electron `file://` renderer. `data/nnzrp_data.json` is not being kept in sync anymore; the only persistence today is IndexedDB itself plus manual export via `BackupService`/Settings → "Export All Data".
3. **Swipe variations don't retain their own `thoughts`/`toolTrace`** — `message.swipes` only stores content strings; `thoughts`/`toolTrace` are single fields on the message, overwritten on every new generation and reset to empty when swiping backward (`handleSwipePrev`). Fixing this properly would mean storing `{content, thoughts, toolTrace}` per swipe instead of a flat string array — a real data-model change, not attempted as part of the MCP work that touched this file.

---

## 🔒 XSS / sanitization approach

- `js/utils/sanitize.js` exports `escapeHtml`/`escapeAttr`; nearly every view escapes character/persona/message/proxy fields before interpolating into `innerHTML` template strings. This is the app's only XSS defense (no DOM-diffing framework, no CSP meta tag) — when adding new UI that renders character-card, persona, or chat-message fields, escape them the same way existing code does nearby.
- `Modal.open({ title, contentHTML })` does **not** escape `title` or `contentHTML` itself — every current call site pre-escapes any dynamic (character/persona-controlled) title with `escapeHtml()` before passing it in. If you add a new `Modal.open()` call with a dynamic title, escape it manually — the same way `chatView.js`/`charactersView.js`/`personasView.js`/`proxiesView.js` already do.

---

## ⚙️ Rules & Guidelines for Code Modders

1. **No Emojis**: Always use clean text labels or SVG icons in UI buttons, toasts, and headers.
2. **Flat Light Theme**: Maintain flat slate colors (`#f1f5f9` BG, `#ffffff` cards, `#e2e8f0` borders, `#0f172a` text).
3. **Dedicated Chat View**: Keep the chat view fullscreen with back-button navigation.
4. **Floating Input Box**: Keep the chat input box floating over the bottom area (`bottom: 24px`) with a full-height message stream behind it.
5. **Right Drawer Tabs**: Keep Sessions and Options separated into distinct tabs in the right drawer.
6. **Escape before interpolating**: any new template string that embeds character/persona/message/import-derived data must go through `escapeHtml`/`escapeAttr` (see XSS section above) — this is the only sanitization layer in the app.
7. **Electron IPC surface stays minimal**: don't add new `ipcMain`/`contextBridge` handlers without a real need — the app's whole security model relies on `nodeIntegration: false` + a narrow, fully-typed `preload.js` (currently: window controls + the 3-method MCP stdio bridge). Never expose a generic/passthrough IPC channel.

---

## Note on other docs in this repo

`README.md` and `AGENTS.md` both still describe the old `server.py` + "Windows Desktop WebView App via `python app.py`" architecture, which no longer exists (the app is Electron now, see above). Treat this `CLAUDE.md` as the source of truth for current architecture; the other two are stale and due for a rewrite if anyone gets to it.

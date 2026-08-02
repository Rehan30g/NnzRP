# CLAUDE.md — Agent System Guide & Code Function Index

This document provides a concise architectural sitemap and function lookup table for **Aetheria RP Studio**. AI agents reading this file can instantly understand the codebase structure without reading every file individually.

---

## 🎯 Architecture Summary

- **App Name**: Aetheria RP Studio (Client-Side BYOK AI Roleplay Studio)
- **Backend**: None (100% Client-Side, Browser BYOK)
- **Database**: Native IndexedDB (`AetheriaRoleplayDB_v2`)
- **Routing**: ES6 Module Router in `js/app.js`
- **UI Style**: Flat Grayish Slate Light Theme, No Emojis, Dedicated Fullscreen Chat Page, Storybook Per-Block Layout, Floating Input Box

---

## 📂 Directory Sitemap & Module Map

| File Path | Component / Layer | Primary Purpose & Key Functions |
|---|---|---|
| `index.html` | Entry Point | Mounts `#app` shell, imports fonts, marked.js, CSS stylesheets with `?v=X` cache-busting parameters. |
| `server.py` | Local Server | Custom Python HTTP server adding `Cache-Control: no-cache` headers for hot updates. |
| `run.bat` / `start.bat` | Launcher | Windows 1-click execution script launching `server.py` and auto-opening `http://localhost:8080`. |
| `css/variables.css` | Design Tokens | Colors (`--bg-primary: #f1f5f9`, `--accent-primary: #4f46e5`), typography, spacing, shadows. |
| `css/base.css` | Global CSS | Typography, resets, light custom scrollbars, flat text badges (`.badge-emerald`, `.badge-rose`, `.badge-cyan`). |
| `css/components.css` | UI Elements | Flat buttons (`.btn-primary`, `.btn-secondary`), inputs (`.input`, `.textarea`, `.select`), cards (`.card`), modals, toasts. |
| `css/layout.css` | Shell Layout | Main dashboard container, navigation sidebar (`.app-sidebar.collapsed`), header navbar, responsive grid. |
| `css/chat.css` | Chat Layout | Storybook per-block rows (`.message-block`), centered 880px header column, floating overlay input (`.chat-input-container`), right drawer tabs. |
| `js/app.js` | App Core / Router | Class `App`: `init()`, `renderShell()`, `navigate(view, params)`. Manages dedicated fullscreen chat view vs main dashboard views. |
| `js/config.js` | App Config | `APP_CONFIG`: sample characters (*Vespera Zenith*, *Archmage Aurelia*), default personas, default proxy presets (OpenRouter, Gemini, OpenAI, Ollama), system prompts. |
| `js/storage/db.js` | Database | Class `NativeDB`: `open()`, `getAll()`, `get()`, `put()`, `delete()`, `getByIndex()`. IndexedDB database `AetheriaRoleplayDB_v2`. Function `initDatabase()`. |
| `js/storage/characterStore.js` | Storage CRUD | Class `CharacterStore`: `getAll()`, `getById(id)`, `save(data)`, `delete(id)`. |
| `js/storage/chatStore.js` | Storage CRUD | Class `ChatStore`: `getChatsByCharacter(charId)`, `createChat()`, `deleteChat()`, `getMessages()`, `addMessage()`, `updateMessageSwipes()`. |
| `js/storage/personaStore.js` | Storage CRUD | Class `PersonaStore`: `getAll()`, `getById()`, `getDefault()`, `save()`, `delete()`. |
| `js/storage/proxyStore.js` | Storage CRUD | Class `ProxyStore`: `getAll()`, `getDefault()`, `save()`, `delete()`, `getGenerationSettings()`, `getGlobalSystemPrompt()`. |
| `js/services/providerManager.js` | Service Layer | Class `ProviderManager`: `testConnection(proxy)`, `sendChatCompletion(proxy, promptPayload, settings)` for OpenAI, Anthropic, Gemini, OpenRouter, Custom/Ollama. |
| `js/services/promptBuilder.js` | Service Layer | Class `PromptBuilder`: `buildPromptPayload({ character, persona, globalSystemPrompt, messages, contextLimit })`. |
| `js/services/lorebookEngine.js` | Service Layer | Class `LorebookEngine`: `getMatchingLore(lorebooks, messages, scanCount)` keyword trigger scanner. |
| `js/services/cardImporter.js` | Service Layer | Class `CardImporter`: `parseJSONFile(file)` & `exportToJSON(character)` for Janitor AI / SillyTavern Card V2 JSON standard. |
| `js/ui/components/toast.js` | UI Component | Class `Toast`: `success(msg)`, `error(msg)`, `info(msg)` notifications without emojis. |
| `js/ui/components/modal.js` | UI Component | Class `Modal`: `open({ title, contentHTML, buttons, onClose })`, `close()`. |
| `js/ui/components/navbar.js` | UI Component | Class `Navbar`: `render(container, viewName, onProxyChange)` header for main dashboard. |
| `js/ui/components/sidebar.js` | UI Component | Class `Sidebar`: `render(container, activeView, onNavigate)` main dashboard navigation sidebar with collapsible icon-only toggle. |
| `js/ui/views/charactersView.js` | UI View | Class `CharactersView`: `render(container, onStartChat)` AI Character Library & creation/edit form modal. |
| `js/ui/views/chatView.js` | UI View | Class `ChatView`: `render(container, charId, callbacks)` Dedicated Fullscreen Roleplay Chat Page with centered 880px reading column, per-block messages, floating input, and right drawer with Sesi Chat & Opsi Chat tabs. |
| `js/ui/views/personasView.js` | UI View | Class `PersonasView`: `render(container)` Player User Persona Manager. |
| `js/ui/views/proxiesView.js` | UI View | Class `ProxiesView`: `render(container)` Multi-Proxy API Key & Model Configuration. |
| `js/ui/views/settingsView.js` | UI View | Class `SettingsView`: `render(container)` Global Instructions & Generation Parameter Sliders. |

---

## ⚙️ Rules & Guidelines for Code Modders

1. **No Emojis**: Always use clean text labels or SVG icons in UI buttons, toasts, and headers.
2. **Flat Light Theme**: Maintain flat slate colors (`#f1f5f9` BG, `#ffffff` cards, `#e2e8f0` borders, `#0f172a` text).
3. **Dedicated Chat View**: Keep the chat view fullscreen with `Kembali` button navigation.
4. **Floating Input Box**: Keep the chat input box floating over the bottom area (`bottom: 24px`) with a full-height message stream behind it.
5. **Right Drawer Tabs**: Keep Sesi Chat and Opsi Chat separated into distinct tabs in the right drawer.

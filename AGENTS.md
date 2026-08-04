# AGENTS.md — Codebase Map & AI Operating Manual

> **Project Name**: NnzRP  
> **Type**: 100% Client-Side BYOK AI Roleplay Web Application (Zero Backend Required)  
> **Design Philosophy**: Flat Grayish Slate Light Theme, Minimalist UI, Dedicated Fullscreen Chat, Per-Block Storybook Formatting, Floating Overlay Input.

---

## 🚀 Quick Start / How to Run

```cmd
:: Double-click run.bat in project root to launch native Windows Desktop WebView App
run.bat
```

Or run Python desktop launcher directly:
```cmd
python app.py
```

---

## 🏗️ Architecture & Technology Stack

- **Core**: Vanilla JavaScript (ES6+ Modules) + HTML5 + Vanilla CSS3.
- **Database**: Native Browser `IndexedDB` (`AetheriaRoleplayDB_v2`), zero external dependencies.
- **Markdown Parsing**: `marked.js` (loaded via CDN with clean native fallback).
- **Icons & Styling**: Pure CSS SVG icons & clean text labels. **NO EMOJIS IN UI TEXT**.
- **API Routing**: Direct browser `fetch()` to AI Providers (OpenAI, Anthropic Claude, Google Gemini, OpenRouter, Custom OpenAI-Compatible / Local Ollama).

---

## 🗺️ Codebase Map & Function Reference

```text
D:\CODEY\
├── index.html                 # Main App Entry Point & Font/Script imports
├── server.py                  # Custom Python HTTP Server (no-cache headers)
├── run.bat / start.bat        # Windows 1-click execution scripts
├── AGENTS.md                  # AI Operating Manual & Function Map (This file)
├── CLAUDE.md                  # Claude / AGY Agent Instructions & Code Index
├── css/
│   ├── variables.css          # Design Tokens (Flat Grayish slate color palette)
│   ├── base.css               # Global Resets, Typography, Scrollbars, Badges
│   ├── components.css         # Flat Buttons, Form Inputs, Cards, Modals, Toasts
│   ├── layout.css             # Main Dashboard Shell, Navbar, Sidebar, Grid Layout
│   └── chat.css               # Per-Block Story Chat Stream, Floating Overlay Input, Right Drawer
└── js/
    ├── app.js                 # Application Router, Bootstrapper, Shell Controller
    ├── config.js              # Defaults, Sample Characters, Default Proxies, Global Prompts
    ├── storage/
    │   ├── db.js              # NativeDB IndexedDB Class & Initial Data Seeding
    │   ├── characterStore.js  # AI Character CRUD
    │   ├── chatStore.js       # Multi-Session Chat Threads & Messages CRUD
    │   ├── personaStore.js    # User Player Persona CRUD
    │   └── proxyStore.js      # Multi-Proxy Config & Generation Settings Storage
    ├── services/
    │   ├── providerManager.js # Multi-Proxy API Dispatcher & Connection Test Ping
    │   ├── promptBuilder.js   # Dynamic Prompt Assembler (System + Char + Persona + Lore + History)
    │   ├── lorebookEngine.js  # Keyword Scanner & World Info Injection Engine
    │   └── cardImporter.js    # Character Card V2 JSON Parser & Exporter
    └── ui/
        ├── components/
        │   ├── toast.js        # Notification Toast Manager
        │   ├── modal.js        # Dynamic Reusable Modal Component
        │   ├── navbar.js       # Dashboard Header Navbar & Active Proxy Selector
        │   └── sidebar.js      # Collapsible Main Navigation Sidebar
        └── views/
            ├── charactersView.js # AI Character Library & Character Creation/Edit Form
            ├── chatView.js       # Dedicated Fullscreen Story Chat Workspace with Right Drawer Tabs
            ├── personasView.js   # User Player Persona Manager
            ├── proxiesView.js    # Multi-Proxy API Key & Model Configuration
            └── settingsView.js   # Global Instructions & Generation Parameter Sliders
```

---

## 🔍 Detailed Function & Module Specifications

### 1. Storage Layer (`js/storage/`)
- **`db.js` (`NativeDB`)**:
  - `open()`: Opens IndexedDB `AetheriaRoleplayDB_v2`. Creates stores: `characters`, `chats`, `messages`, `personas`, `proxies`, `settings`.
  - `getAll(store)` / `get(store, key)` / `put(store, value)` / `delete(store, key)` / `count(store)` / `getByIndex(store, index, value)`: Asynchronous IndexedDB wrappers.
  - `initDatabase()`: Seeds sample characters (*Vespera Zenith*, *Archmage Aurelia*), default persona, default proxy profiles, and initial generation settings.

- **`characterStore.js` (`CharacterStore`)**:
  - `getAll()`: Returns all characters sorted by `updatedAt` descending.
  - `getById(id)`: Returns single character record.
  - `save(charData)`: Creates or updates character record in `characters` store.
  - `delete(id)`: Deletes character and cascades deletion to associated chats and messages.

- **`chatStore.js` (`ChatStore`)**:
  - `getChatsByCharacter(charId)`: Retrieves all chat sessions for a specific character.
  - `createChat(charId, personaId, title)`: Spawns a new chat session thread.
  - `deleteChat(chatId)`: Deletes chat session and all messages in that session.
  - `getMessages(chatId)`: Gets ordered messages for a chat session.
  - `addMessage(chatId, role, content, thoughts, swipes)`: Adds a new message record with swipe history array.
  - `updateMessageSwipes(msgId, swipes, activeIndex)`: Updates swipe response variations.

- **`personaStore.js` (`PersonaStore`)**:
  - `getAll()` / `getById(id)` / `getDefault()` / `save(data)` / `delete(id)`: Manages player user personas.

- **`proxyStore.js` (`ProxyStore`)**:
  - `getAll()` / `getDefault()` / `save(data)` / `delete(id)`: Manages API proxy profiles.
  - `getGenerationSettings()` / `saveGenerationSettings()`: Manages Temp, TopP, MaxTokens, RepetitionPenalty, ContextLimit.
  - `getGlobalSystemPrompt()` / `saveGlobalSystemPrompt()`: Manages global system prompt instructions.

---

### 2. Services Layer (`js/services/`)
- **`providerManager.js` (`ProviderManager`)**:
  - `testConnection(proxy)`: Dispatches ping/models request to test API key validity.
  - `sendChatCompletion(proxy, promptPayload, settings)`: Dispatches chat completions to OpenAI, Anthropic Claude (`/v1/messages`), Google Gemini (`generateContent`), OpenRouter, or Custom/Ollama endpoints.

- **`lorebookEngine.js` (`LorebookEngine`)**:
  - `getMatchingLore(lorebooks, messages, scanCount)`: Scans recent messages for trigger keys defined in character lorebooks and compiles active World Info context strings.

- **`promptBuilder.js` (`PromptBuilder`)**:
  - `buildPromptPayload({ character, persona, globalSystemPrompt, messages, contextLimit })`: Assembles structured prompt messages combining System Prompt, Character Card definitions, User Persona details, matched Lorebook entries, Example Dialogue, and filtered Chat History.

- **`cardImporter.js` (`CardImporter`)**:
  - `parseJSONFile(file)`: Parses imported Tavern/SillyTavern/Janitor AI Character Card V2 JSON file.
  - `exportToJSON(character)`: Exports character card to downloadable Character Card V2 JSON format.

---

### 3. UI Views & Components Layer (`js/ui/`)
- **`app.js` (`App`)**:
  - `init()`: Boots database and renders initial layout shell.
  - `navigate(viewName, params)`: Routes between `characters`, `personas`, `proxies`, `settings`, and dedicated fullscreen `chat`.
  - Hides main dashboard sidebar and header during `chat` view for 100% fullscreen story focus.

- **`chatView.js` (`ChatView`)**:
  - Fullscreen story workspace with centered 880px reading column.
  - Header: `Kembali` button (returns to dashboard), Character Avatar + Name & Tagline, `Sesi & Opsi` button.
  - Messages Stream: `.message-block` full-width storybook rows (User & Assistant).
  - Floating Input Box: `.chat-input-container` positioned absolutely over bottom screen area (`bottom: 24px`).
  - Right Drawer (`#right-drawer-overlay`): Slide-over drawer with 2 tabs:
    - **Tab 1: Sesi Chat**: List of sessions + "+ Sesi Roleplay Baru" button + per-session delete.
    - **Tab 2: Opsi Chat**: Player Persona switcher, Active AI Proxy switcher, Character Info summary card, Delete current session button.

---

## 🎨 Design System Guidelines for AI Code Modifications

1. **Theme Palette**:
   - Primary BG: `#f1f5f9` (Slate-100)
   - Secondary BG: `#ffffff` (Flat White)
   - Surface/Cards: `#ffffff` with `#e2e8f0` crisp borders.
   - Text: `#0f172a` (Slate-900 main text), `#334155` (Slate-700 muted), `#6d28d9` (Violet roleplay action text).
   - Accents: Flat Indigo `#4f46e5`, Flat Violet `#7c3aed`.

2. **UI Constraints**:
   - **NO EMOJIS IN UI TEXT**. Use SVG icons or clean text labels.
   - Keep chat messages in **Per-Block Storybook format** (`.message-block`), not rounded speech bubbles.
   - Keep chat input box as an **Absolute Floating Overlay Card** over the bottom screen area.
   - Maintain the **Dedicated Fullscreen Chat Page** with `Kembali` button navigation.

3. **Mandatory Testing & Visual Verification Directive**:
   - **ALWAYS TEST VISUALLY BEFORE DECLARING COMPLETED**: Before finishing any task or reporting to the user, ALWAYS use MCP Browser (`browser_navigate`, `browser_snapshot`, `browser_screenshot`) to verify that the UI renders cleanly, visual layout is harmonious, text/elements are not clipped, and interactive elements work as expected.


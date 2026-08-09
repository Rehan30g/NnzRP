<div align="center">

<img src="src/icon.png" width="120" alt="NnzRP">

# NnzRP

### Roleplay with AI characters that can actually *use tools* — mid-scene, in character.

A 100% client-side, BYOK AI roleplay desktop app with real MCP tool-calling.<br>
No backend. No account. No telemetry.

<br>

[![MCP](https://img.shields.io/badge/MCP-native%20tool%20calling-8B5CF6?style=flat-square)](#the-part-that-makes-this-different)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-31-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square)](#getting-started)
[![Backend](https://img.shields.io/badge/backend-none-success?style=flat-square)](#data--privacy)

<br>

<img src="src/screenshot_chat.png" width="900" alt="A character browsing the web mid-roleplay via MCP">

</div>

---

## The part that makes this different

Most roleplay frontends stop at text generation. The model can *describe* looking something up, but it cannot actually go and look.

NnzRP wires [Model Context Protocol](https://modelcontextprotocol.io/) servers directly into the generation loop using **provider-native function calling** — so a character can browse the web, read files, or hit an API *in the middle of a scene*, and narrate it as part of the story.

In the screenshot above, Mr. Wolf gets handed a GitHub URL. He doesn't break character to announce a tool call. He pulls out a phone:

> *He pulls out a phone anyway, one clawed thumb scrolling.*
>
> **Mr. Wolf:** "Let's see what we got here..."
>
> &nbsp;&nbsp;&nbsp;&nbsp;<sub>`browsermcp__browser_navigate`</sub>
>
> *Mr. Wolf squints at the phone, scrolling slowly. The grin fades a little, replaced by something almost like actual curiosity.*
>
> **Mr. Wolf:** "Huh. A roleplay thing. Client-side, bring-your-own-key..." *He mutters, thumb swiping.* "Character cards. Lorebooks. Thought-block extraction..."

That reply took **six tool calls**. He really did read the repo. The scepticism before, the browsing, and the reaction after are all **one message** — told the way a person would tell it.

|  | |
|---|---|
| **Agentic, not one-shot** | The model chains multiple tool calls per turn, feeding each result back and deciding what to reach for next — bounded by a safety limit of 6 rounds, or your own custom cap if you turn that on. |
| **One message, however many rounds** | Narration written before a tool call and narration written after it land in a single message, not fragmented into robotic separate turns. |
| **Inline markers** | A small marker sits at the exact point in the prose where each tool fired, so you can see what happened where without it interrupting the read. Back-to-back calls collapse into one marker with a count. |
| **Live while it runs** | A tool box appears while a call is in flight, then the marker settles into place once the result lands — you're never staring at a frozen bubble wondering what happened. |
| **Immersive Roleplay mode** | An opt-in nudge for characters to reach for tools *proactively and in-character* — "browsing" when the scene calls for it — instead of waiting to be told. Three intensity levels (Medium / High / MAX) control how eagerly, from natural openings only up to constant, unprompted tool use. |
| **Permission-gated** | Every tool defaults to **Ask**. Approve per call, or set Allow / Decline per tool. Global kill switch included. |
| **HTTP + local stdio** | Connect a hosted JSON-RPC endpoint, or let NnzRP spawn a local MCP server as a child process. |

<br>

<div align="center">
<sub><strong>Thinking blocks and tool traces are collapsible</strong> — the reasoning and the full argument/result log are one click away, and folded out of sight the rest of the time.</sub>
</div>

---

## Tools that work with zero setup

Two tools ship built in. No MCP server, no config file — they go through the exact same permission gate and tool loop as a real MCP tool.

| | |
|---|---|
| **See an image** | Hand a character a direct image URL and it actually *looks* at it, rather than reasoning about the link text. Offered automatically when your active model supports vision, and it can pull up the character's own avatar too. |
| **Embed HTML** | Let a character render a small self-contained HTML/CSS/JS snippet **inline in the chat** — a chart, a canvas animation, an interactive diagram, or clickable dialogue choices that drop their text straight into your input box. Renders inside a locked-down sandboxed iframe with no network access and no same-origin privileges, and inherits your current light/dark theme. |

> [!WARNING]
> **Embed HTML is off by default and stays that way until you turn it on** (Custom MCP page → *Embed HTML (Eksperimental)*). Unlike every other tool, it means AI-authored script actually running inside the app — sandboxed, but running. Enable it only if that trade is one you want.

---

<div align="center">

**Works with**

<img src="https://img.shields.io/badge/OpenAI-412991?style=for-the-badge" alt="OpenAI">
<img src="https://img.shields.io/badge/Anthropic-D97757?style=for-the-badge&logo=anthropic&logoColor=white" alt="Anthropic">
<img src="https://img.shields.io/badge/Gemini-4285F4?style=for-the-badge&logo=googlegemini&logoColor=white" alt="Gemini">
<img src="https://img.shields.io/badge/OpenRouter-6467F2?style=for-the-badge&logo=openrouter&logoColor=white" alt="OpenRouter">
<img src="https://img.shields.io/badge/Ollama-000000?style=for-the-badge&logo=ollama&logoColor=white" alt="Ollama">

<sub>…and any other OpenAI-compatible endpoint. Tool-calling works across all of them.</sub>

</div>

---

## Everything else

|  | |
|---|---|
| **BYOK, no middleman** | Configure as many providers as you like as named profiles, and switch between them mid-conversation. |
| **Storybook chat** | Centered stream, floating composer, live streaming, swipe-to-regenerate, session forking, inline editing. |
| **Send images** | Attach pictures straight from the composer when your model can see them — the attach button only appears for vision-capable models. |
| **Nothing gets silently dropped** | Instead of quietly truncating old messages, a capacity gauge shows how full the model's context window is, and **Compact Chat** summarizes the middle of a long session into a fresh one — keeping the opening and the most recent exchanges word-for-word. |
| **Generate as long as you want** | Cap the response length, or flip on **Unlimited** and let the model finish. |
| **Readable code blocks** | Fenced code in a reply gets real syntax highlighting and a one-click copy button — no CDN, no external highlighter. |
| **AI-personalized greetings** | Regenerate a fresh chat's opening line through a short back-and-forth with the AI — one question at a time, three quick options or type your own — instead of settling for the character's default. |
| **Never blocks you** | Keep typing while a reply generates — your next message queues and fires automatically. |
| **Character Card V2** | Import and export cards compatible with Tavern / SillyTavern / Janitor AI. |
| **Characters & personas** | Avatars by URL or upload, keyword-triggered lorebooks, switchable system prompt presets. |
| **Themeable** | Light, dark, or follow-the-OS, with a custom accent color. |
| **Backup & restore** | Export everything to one JSON file and re-import it anywhere. |

---

## Getting Started

> **Requires** [Node.js](https://nodejs.org/) 18 or newer.

```bash
git clone https://github.com/Rehan30g/NnzRP.git
cd NnzRP
npm install
npm start
```

On Windows, double-clicking `run.bat` does the same thing.

<details>
<summary><b>Build a Windows distributable</b></summary>

<br>

```bash
npm run build:exe
```

Outputs an NSIS installer, a `.zip`, and a portable `.exe` to `dist/`.

</details>

---

## Setting Up

**1. Add a provider.** Go to **Settings → Proxies**, add a profile, pick your provider, and paste your API key and model.

- `custom` and `openrouter` profiles can hold several model IDs, selectable from a dropdown in the chat composer without leaving the conversation.
- OpenRouter profiles get a **Browse Providers** button to inspect and pin preferred upstream providers by context length, price, uptime, and throughput.
- Vision support and context-window size are guessed from the model ID. Both have an override field on the profile for when the guess is wrong or your model is too new to be recognized.

**2. Add MCP servers** *(optional — the built-in tools work without this).* On the **Custom MCP** page, connect either an HTTP JSON-RPC endpoint or a local command NnzRP spawns as a child process:

```bash
npx -y @modelcontextprotocol/server-filesystem /your/path
```

Once enabled, that server's tools are available to every character in every chat. Toggle servers on and off from the chat drawer without leaving the scene.

> [!IMPORTANT]
> **The model can only call tools you already configured**, with arguments it chooses. It can never register a server or point itself at a new one — that is always a manual step you take. Every tool defaults to **Ask**, so nothing runs without your say-so until you decide otherwise.
>
> *Immersive Roleplay* changes how eagerly a character reaches for tools. It does **not** bypass permissions.

> [!TIP]
> Tool-calling quality varies a lot by model. A model with strong native function-calling will weave tools into prose naturally; a weaker one may call tools it doesn't need or narrate a call without making one.

---

## More Screenshots

<details>
<summary><b>Character library, MCP servers, and provider setup</b></summary>

<br>
<div align="center">

<img src="src/screenshot_characters.png" width="880" alt="AI Character Library">
<br><sub><em>AI Character Library</em></sub>
<br><br>

<img src="src/screenshot_mcp.png" width="880" alt="MCP server configuration">
<br><sub><em>MCP servers — HTTP or local stdio, with per-tool permissions</em></sub>
<br><br>

<img src="src/screenshot_proxies.png" width="880" alt="Provider configuration">
<br><sub><em>Provider setup — now lives under Settings → Proxies</em></sub>

</div>
</details>

---

## Tech Stack

[Electron](https://www.electronjs.org/) shell (frameless, `contextIsolation: true`, `nodeIntegration: false`, minimal IPC surface) around a vanilla ES6-module renderer — no framework, no build step. Storage is native IndexedDB; markdown via [`marked.js`](https://marked.js.org/); packaging via [`electron-builder`](https://www.electron.build/).

Provider calls are direct `fetch()` requests in each provider's native shape — including each one's own streaming format, reasoning format, and function-calling wire format, normalized behind a single interface.

---

## Chat Shortcuts

| Keybinding | Action |
|---|---|
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>.</kbd> · <kbd>Alt</kbd> + <kbd>C</kbd> | Toggle right drawer (Sessions / Options / MCP) |
| <kbd>Esc</kbd> | Close drawer or modal |
| <kbd>Enter</kbd> | Send |
| <kbd>Shift</kbd> + <kbd>Enter</kbd> | Newline |

---

## Data & Privacy

Everything — characters, personas, chat history, provider configs, API keys, uploaded avatars and images — is stored locally in the app's IndexedDB. NnzRP uploads nothing. Outbound traffic goes only to the provider endpoints, MCP servers, and image URLs you or your characters point it at.

> [!WARNING]
> **Settings → Data → Export All Data** produces a single JSON backup containing your API keys **in plaintext**. Keep that file somewhere safe.

---

## Contributing

Issues and PRs welcome. [`CLAUDE.md`](CLAUDE.md) is the source of truth for architecture and is kept current — read it before making changes.

---

<div align="center">

**MIT License**

<sub>Built by <a href="https://github.com/Rehan30g">Rehan</a></sub>

</div>

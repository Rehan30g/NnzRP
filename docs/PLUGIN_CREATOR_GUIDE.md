# NnzRP Plugin Creator Guide

How to build a plugin for NnzRP. This is the authoring reference; for the
runtime architecture (how the app loads and isolates plugins) see the
**Plugin system** section of [`CLAUDE.md`](../CLAUDE.md).

---

## 1. What a plugin is (and the hard rules)

A plugin is a packaged extension that adds tabs, buttons, per-character fields,
event listeners, request/response hooks, and optionally a Node child process —
**without editing any file under `js/`, `css/`, or `index.html`**.

Three constraints are absolute:

| Rule | Why |
|---|---|
| **Desktop / Electron only.** | The whole subsystem is gated on `pluginManager.isSupported()` (`!!window.electronAPI`). On the PWA, a plain browser tab, and the Android APK there is no "Plugins" settings tab, no plugin nav items, no events — every `pluginManager.*` method is a safe no-op. Your plugin code never runs there. |
| **Additive only.** | With no plugin enabled (the only possible state off-Electron, and the default on it) the app must behave byte-for-byte as if the plugin system did not exist. Never assume your extension point fires. |
| **Isolation.** | A plugin that throws — in `activate()`, an event handler, a `render()`, an `onClick`, a transform — is caught, logged as `[plugin:<id>]`, and the plugin is flagged `hasError`. It must not break app boot or another plugin. The host wraps every callback you hand it in a `guard()` for you, but don't rely on that to paper over real bugs. |

---

## 2. Package format

A plugin is distributed as a **`.nnzplugin` file — a plain ZIP** with the
plugin's files **at the archive root** (`plugin.json` at top level, *not* nested
in a folder). The installer also accepts a single top-level folder wrapper, but
the build script always produces a root layout.

```
my-plugin.nnzplugin  (zip)
├── plugin.json          required — the manifest
├── renderer/
│   └── index.js         required — ES module, exports activate(host)
├── backend/
│   └── index.js         optional — Node module, runs as a child process
├── assets/
│   └── icon.svg         optional — referenced by plugin.json "icon"
└── README.md            optional
```

### Building the ZIP

```
npm run build:plugin <dir-name-under-plugins/>
# e.g.  npm run build:plugin conversation-voice
# → dist-plugins/<dir-name>.nnzplugin   (git-ignored)
```

`scripts/build-plugin.mjs` zips `plugins/<name>/`, excluding `node_modules/`,
`.git/`, and any `*.nnzplugin`. It needs `adm-zip` (`npm install adm-zip` once —
it is not a committed dependency).

During development you don't need to rebuild the ZIP every time — see
[§10 Development workflow](#10-development-workflow).

---

## 3. `plugin.json` manifest

```jsonc
{
  "id": "com.example.myplugin",   // required — reverse-DNS, UNIQUE, also the on-disk dir name
  "name": "My Plugin",            // required
  "version": "1.0.0",             // required — dotted numeric, used for update comparison
  "description": "One line shown in the plugins list.",
  "author": "You",
  "engineApi": "1.0",             // host refuses to load if major version != "1"
  "icon": "assets/icon.svg",      // relative path inside the package
  "renderer": "renderer/index.js",// default if omitted
  "backend": "backend/index.js",  // omit if the plugin has no backend
  "permissions": ["network", "storage"],
  "minAppVersion": "0.0.0"        // advisory only
}
```

### Validation rules (enforced at install time — `main.js` `validatePluginManifest`)

- **`id`** must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` — no `/`, `\`, `..`, and not
  absolute. It is used verbatim as the directory name under
  `userData/plugins/<id>/`, so pick it carefully; it is your plugin's identity
  forever.
- **`name`** and **`version`** must be non-empty strings.
- **`permissions`**, if present, must be an array and every entry must be one of
  `"network"`, `"storage"`, `"child_process"`, `"fs-read"`, `"fs-write"`. An
  unknown entry fails the install. Default is `[]`.
- **`renderer`**, **`backend`**, **`icon`** must be relative paths that stay
  inside the package (no absolute path, no drive letter, no `..` segment).
- **`engineApi`** — the host loads only major version `1` (`"1"`, `"1.0"`,
  `"1.x"` all fine; `"2.0"` is refused with a `hasError`).

---

## 4. The renderer entry

`renderer/index.js` is an **ES module**. Two exports:

```js
export async function activate(host) {
  // Called once when the plugin is enabled (and on app boot for an
  // already-enabled plugin, right after initTheme()). May be async — the
  // manager awaits it. Register everything here.
}

export function deactivate() {
  // Optional. Called on disable / uninstall / reload. Tear down anything
  // activate() created that the host does NOT auto-dispose (timers, global
  // DOM nodes, window listeners, backend processes you started).
}
```

Everything you register through `host` returns a disposer that the host tracks
and runs automatically on deactivate — so for the common case `deactivate()` can
be empty. You only need it for side effects the host doesn't know about.

If `activate()` throws, the host disposes whatever you managed to register,
marks the plugin `hasError`, and shows a toast. A half-registered plugin never
stays half-registered.

---

## 5. The `host` object — full API

`host` is the entire capability surface. Built per-plugin by
`js/plugins/pluginHost.js`.

### 5.1 Identity & logging

| Member | Type | Notes |
|---|---|---|
| `host.apiVersion` | `"1.0"` | The host API version, not your manifest's. |
| `host.pluginId` | `string` | Your `id`. |
| `host.manifest` | `object` | A **deep-frozen** copy of your `plugin.json`. |
| `host.pluginPath` | `string` | Absolute path of your installed package dir. |
| `host.log(...args)` | `fn` | `console.log` prefixed with `[plugin:<id>]`. Use this, not bare `console.log`. |

### 5.2 `host.ui` — extension points

Every `register*` returns a **disposer** `() => void`. All are auto-run on
deactivate; call one early only if you need to remove a contribution while the
plugin stays active (e.g. refreshing character fields — see §7).

#### `host.ui.registerNavTab({ id, label, icon, render })`

Adds a left-sidebar nav item after the 5 built-ins. Route is
`#plugin:<pluginId>:<id>`. `render(containerEl)` is called with a cleared
container element when the user navigates to it. `icon` is an SVG string
(injected raw, like the built-in nav icons).

#### `host.ui.registerSettingsTab({ id, label, render })`

Adds a tab to the Settings page (desktop tab bar **and** the mobile settings
menu). `render(containerEl)` mounts lazily on first open. The tab is treated as
self-saving — the sticky Save bar is hidden for it, so persist changes yourself
(typically via `host.storage`). Installing/enabling/disabling any plugin
re-renders the Settings "Plugins" tab so contributed tabs appear/disappear.

#### `host.ui.registerChatDrawerTab({ id, label, render })`

Adds a tab to the chat right-drawer after Sessions / Options / MCP.
`render(bodyEl, { chatId, character })` mounts lazily on first open; the context
object is captured at that first open.

#### `host.ui.registerComposerButton({ id, icon, title, onClick })`

Adds an icon button to the chat composer toolbar (next to the model picker).
`onClick({ chatId, character, inputEl })` — `inputEl` is the live
`#chat-input` textarea. `icon` is an SVG string.

> **Note:** composer buttons are rendered once when the chat view builds and are
> **not** re-rendered on state changes. A button that needs to appear/disappear
> based on playback or generation state can't do it through this API — the
> bundled voice plugin works around this by managing its own DOM node parked
> inside `.chat-input-container` (see its `showStopButton`/`hideStopButton`).

#### `host.ui.registerMessageAction({ id, icon, title, visible, onClick })`

Adds a button to each assistant message's footer.

- `visible(msg) => boolean` — called per message. If you omit it, the default
  shows the action only on `msg.role === 'assistant'`. A `visible` that throws
  is treated as `false` (fail hidden).
- `onClick(msg, { chatId, character })` — `msg` is re-read from the store at
  click time, so a swipe that only patched the DOM can't hand you a stale
  variation.
- `icon` is an SVG string.

#### `host.ui.registerCharacterFields(fields)`

Adds a form section (grouped under your plugin name) to the character
create/edit modal. See [§7](#7-character-fields-in-depth) for the field shape
and where values are stored. Returns one disposer for the whole batch.

#### `host.ui.toast` / `host.ui.modal` / `host.ui.confirm`

```js
host.ui.toast.success(msg);   // also .error(msg) / .info(msg)
host.ui.modal;                 // the app Modal class: Modal.open({...}), Modal.closeOverlay(ov), ...
await host.ui.confirm('Delete this?');  // Promise<boolean>, OK/Cancel dialog
```

`host.ui.toast.success` / `.info` are **`display:none` on mobile viewports** —
if your UI can render on a phone, use inline status text for anything the user
must see. `host.ui.toast.error` does show on mobile.

`host.ui.confirm`'s message is injected as `textContent` (safe). If you call
`host.ui.modal.open({ title, contentHTML })` directly, **you** must escape any
dynamic title/HTML — `Modal.open` does not.

### 5.3 `host.events` — app event bus

```js
const off = host.events.on('assistant-message-chunk', (payload) => { ... });
// off() removes it; also auto-disposed on deactivate.
```

Events fanned in from the app (all payloads are plain objects):

| Event | Payload | Fires when |
|---|---|---|
| `chat-opened` | `{ chatId, character }` | A chat view finished resolving its session + character. Also sets `host.data.getActiveChat()`. |
| `chat-closed` | `{ chatId }` | Chat view torn down. Clears the active-chat context. |
| `user-message-sent` | `{ chatId, character, message }` | After the user's message is persisted, before generation. |
| `assistant-generation-started` | `{ chatId, character }` | Just before a generation turn begins — **every** entry point: send, "Generate AI response", and swipe/regenerate. Use this to reset per-turn state. |
| `assistant-message-chunk` | `{ chatId, character, messageId, fullText }` | ~50 ms-throttled during streaming. `fullText` is the whole accumulated reply so far. `messageId` is `null` for a fresh turn, set for a swipe-regenerate. Never fires per raw SSE chunk. |
| `assistant-message-complete` | `{ chatId, character, message }` | After a completed assistant message is persisted. **Not** emitted on abort or hard error. |
| `assistant-generation-ended` | `{ chatId, character, aborted }` | A turn that died without `complete` — user abort (`aborted: true`) or hard error (`aborted: false`). |
| `navigate` | `{ view, params }` | Any route change. |

> A generation turn can span several MCP tool rounds but is always **one**
> `assistant-message-complete` and **one** message. During those rounds
> `assistant-message-chunk.fullText` is re-seeded to the joined text of all
> rounds so far and **can shrink by a few characters** at a round boundary
> (whitespace-only round dropped, `<think>`/prefill re-split). Don't treat a
> small shrink as a new turn — rely on `assistant-generation-started` /
> `user-message-sent` for that.

### 5.4 `host.pipeline` — request/response transforms

```js
host.pipeline.addRequestTransform((payload, ctx) => modifiedPayload);
host.pipeline.addResponseTransform((result, ctx) => modifiedResult);
```

A transform returning `undefined` is skipped (prior value kept); one that throws
is skipped and the plugin flagged.

> **Status:** these registries exist and are disposed correctly, but the
> generation path does **not** call `applyRequestTransforms` /
> `applyResponseTransforms` yet. Registering a transform today is inert. Treat
> this as reserved API until the chat pipeline wires it.

### 5.5 `host.storage` — namespaced key/value

```js
await host.storage.set('key', anyStructuredCloneable);
const v = await host.storage.get('key');   // undefined if never set
await host.storage.delete('key');
const keys = await host.storage.keys();    // string[] (short keys, no prefix)
```

Persisted as individual rows `plugin:<id>:<key>` in the existing `settings`
IndexedDB store. Survives a package reinstall/update. Wiped only on explicit
uninstall (and only by callers that opt in — the manager currently leaves it).
This is your config store.

### 5.6 `host.assets` — per-plugin writable file store

```js
await host.assets.write('clip.wav', arrayBuffer);
const ab   = await host.assets.read('clip.wav');   // ArrayBuffer
const list = await host.assets.list();             // [{ name, size }, ...]
await host.assets.delete('clip.wav');
const abs  = await host.assets.path('clip.wav');    // absolute fs path (string)
```

Files live at `userData/plugin-data/<id>/`, **outside** the package dir, so a
reinstall/update never touches them. `path()` returns a real filesystem path — a
co-located local server (same machine) can read it. This is how the voice plugin
stores uploaded voice-clone `.wav`s. Paths are containment-checked; `..` is
rejected. No permission needed (it's your own sandboxed dir).

### 5.7 `host.data` — read-only app data

```js
await host.data.getCharacter(id);   // full character record or null
host.data.getActiveChat();          // { chatId, character } | null  — SYNC
await host.data.getMessages(chatId);// message array
await host.data.getProxy();         // the default proxy (active provider/model/key)
await host.data.getPersona();       // the default persona
```

`chatView` snapshots the character once when a chat opens. If your plugin
changes something on the character mid-session, re-fetch with
`host.data.getCharacter(id)` before acting on it — don't trust a character
object handed to you at `chat-opened`.

### 5.8 `host.net` — network (permission: `network`)

```js
if (host.net) {
  const res = await host.net.fetch(url, opts);   // real window.fetch, CORS applies
}
```

Present **only** if `plugin.json` declares `"network"`. It is `window.fetch`
bound to `window` — same-origin rules and CORS apply exactly as in a page. A
local server you talk to must send `Access-Control-Allow-Origin`.

### 5.9 `host.backend` — Node child process (manifest: `backend`)

Present only if `plugin.json` has a `"backend"` entry. See
[§8](#8-backend-plugins).

```js
await host.backend.start();          // fork the runner with your permission list
await host.backend.stop();
const reply = await host.backend.request({ ...anyJson });   // RPC round-trip
const off = host.backend.on('some-event', (payload) => { ... });  // or on(null, cb) for all
```

---

## 6. Permissions

Declared in `plugin.json` `"permissions"`. They gate what the host and the
backend runner expose — an undeclared capability is simply `undefined`, not an
error you can catch later.

| Permission | Unlocks (renderer) | Unlocks (backend `ctx`) |
|---|---|---|
| `network` | `host.net.fetch` | `ctx.net.fetch` |
| `storage` | *(host.storage/host.assets are always available; declaring `storage` documents intent)* | — |
| `fs-read` | — | `ctx.fs.readFile` |
| `fs-write` | — | `ctx.fs.readFile` + `ctx.fs.writeFile` |
| `child_process` | — | `ctx.spawn` |

Request the minimum. The management UI shows users what a plugin declared.

---

## 7. Character fields in depth

```js
host.ui.registerCharacterFields([
  {
    key: 'voiceId',                 // stored at character.pluginData['<your id>'].voiceId
    label: 'Voice',
    type: 'select',                 // 'select' | 'toggle' | 'text' | 'textarea'
    options: [                      // 'select' only
      { value: '', label: '(default)' },
      { value: 'alba', label: 'alba' }
    ],
    help: 'Optional helper text under the control.',
    // placeholder: '...'           // 'text' / 'textarea'
    // default: 'alba'              // used when the character has no stored value
  },
  {
    key: 'muted',
    label: 'Mute this character',
    type: 'toggle',
    default: false
  }
]);
```

- Values are read/written at **`character.pluginData[pluginId][key]`**. The
  character modal merges only your plugin's slice — other plugins' `pluginData`
  is untouched. `CharacterStore.save()` persists the whole object; no schema
  change.
- **A `toggle` that should start ON must set `default: true`.** With no stored
  value and no `default`, the control renders unchecked and Save persists
  `false`.
- To refresh options at runtime (e.g. you let the user upload something that
  becomes a new `select` option), keep the disposer from
  `registerCharacterFields`, call it, then register the new list. The bundled
  voice plugin does exactly this after a clone upload/delete.
- Reading a value later: `(await host.data.getCharacter(id))?.pluginData?.[host.pluginId]?.[key]`.

---

## 8. Backend plugins

If `plugin.json` declares `"backend": "backend/index.js"`, the app can `fork()`
a Node child process running **your** `backend/index.js` inside the shipped
wrapper `js/plugins/backendRunner.cjs`. The wrapper — not your code — owns the
IPC channel and hands your module a permission-gated `ctx`.

### Your `backend/index.js`

```js
// CommonJS. Either:
module.exports = function (ctx) { /* ... */ };
// or:
module.exports = {
  activate(ctx) { /* ... */ }
};
```

### `ctx` API

| Member | Requires | Notes |
|---|---|---|
| `ctx.permissions` | — | Copy of your permission array. |
| `ctx.rpc.onRequest(fn)` | — | Register the single handler for `host.backend.request(msg)`. `fn(payload)` may be async; its return value (or thrown error) is sent back. Only the last registered handler wins. |
| `ctx.emit(event, data)` | — | Push an event to the renderer — arrives at `host.backend.on(event, cb)`. |
| `ctx.log(...args)` | — | `console.log` prefixed `[plugin-backend]`. |
| `ctx.net.fetch` | `network` | Node 18+ global `fetch`. |
| `ctx.fs.readFile(path, opts)` | `fs-read` or `fs-write` | `fs/promises.readFile`. |
| `ctx.fs.writeFile(path, data, opts)` | `fs-write` | `fs/promises.writeFile`. |
| `ctx.spawn(command, args, options)` | `child_process` | Returns `{ pid, kill(sig) }`. Streams `stdout` / `stderr` / `exit` back as `ctx.emit` events (`{ pid, data }` / `{ pid, code, signal }`). All spawned children are killed with the runner. |

### Lifecycle

- You start it: `await host.backend.start()` in `activate()` (or lazily). It is
  **not** started automatically.
- The runner exits on the app's `before-quit`, on channel `disconnect`, and on
  `SIGTERM`/`SIGINT`, killing any `ctx.spawn` children first.
- Call `host.backend.stop()` in `deactivate()` if you started it — the host does
  not force-kill a plugin backend on plain disable, only on app quit.
- A backend is **trusted-by-install**: `ctx.fs`/`ctx.spawn` are unrestricted
  (the sandbox is the *renderer* surface). Only ask for what you use.

### Wire protocol (handled for you, documented for debugging)

```
parent → child : { type:'rpc',       id, payload }
child  → parent: { type:'rpc-reply', id, ok, result | error }
child  → parent: { type:'event',     event, data }
```

Newline-delimited JSON over the Node IPC channel, id-correlated — same shape as
the app's MCP stdio bridge.

---

## 9. Lifecycle, disposers, and error handling

- **Auto-dispose:** every `host.ui.register*`, `host.events.on`,
  `host.pipeline.add*`, and `host.backend.on` returns a disposer that the host
  also tracks. On disable / uninstall / reload the host runs all of them and
  clears your event bus. Anything else — `setInterval`, a `window`
  `addEventListener`, a DOM node you appended outside a `render()` container, a
  started backend — is **yours** to undo in `deactivate()`.
- **Guarding:** callbacks you pass in (`render`, `onClick`, `visible`,
  transforms, event handlers) are wrapped so a throw is caught, logged
  `[plugin:<id>]`, and (for most) marks the plugin `hasError` without crashing
  the caller. `visible` that throws → `false`. An async callback's rejection is
  caught too.
- **`hasError`:** shown as a badge in the Settings → Plugins list. Re-enabling a
  plugin that previously errored clears the stale record and retries the import
  + `activate()`.
- **Engine mismatch / import failure:** the plugin loads into the list flagged
  with an error message instead of activating.

---

## 10. Development workflow

The fastest loop uses the **bundled-plugin** path — no ZIP, no install dialog.

1. Put your plugin source at `plugins/<name>/` in the repo (same level as
   `plugins/conversation-voice/`).
2. `package.json` `build.extraResources` already maps `plugins/` →
   `resources/bundled-plugins/`, and `main.js` `seedBundledPlugins()` runs at
   startup.
3. On launch the seeder copies any **missing** plugin into
   `userData/plugins/<id>/` (disabled by default). Enable it once in
   Settings → Plugins.
4. **Re-seeding on change:** the seeder only overwrites an existing install when
   the bundled `plugin.json` `version` is **strictly higher** than the installed
   one (dotted-numeric compare). So bump `version` every time you want your edit
   to reach an already-seeded copy, then relaunch. `plugin-data/<id>/` and the
   enabled/disabled state always survive.
   - Alternatively, uninstall it in the UI and relaunch to get a clean seed at
     the current version.
5. For distribution, `npm run build:plugin <name>` → `.nnzplugin`, installed via
   Settings → Plugins → "Install from .zip".

### On-disk layout (Electron `userData/`)

```
userData/
├── plugins/<id>/           extracted package (wiped & replaced on reinstall/update)
└── plugin-data/<id>/       host.assets files (only an explicit uninstall deletes this)
```

Registry (which plugins exist, enabled flag, last-seen version) lives in the
`settings` IndexedDB store under `plugins.registry`.

---

## 11. Routing a nav tab

A `registerNavTab({ id: 'main', ... })` on plugin `com.example.myplugin` is
reachable at:

```
#plugin:com.example.myplugin:main
```

`app.js` parses `#plugin:<pluginId>:<tabId>`, calls
`pluginManager.resolveNavRoute()`, and invokes your `render(container)` with a
cleared element. An unknown/removed plugin route falls back to the character
library. The sidebar item the host adds already points here.

---

## 12. Security & review checklist

The plugin IPC surface (`window.pluginHostAPI`) is deliberately narrow: every
call is plugin-id-scoped, `realpath`-contained to `userData/plugins/<id>/` (or
`plugin-data/<id>/`), and permission-brokered. The renderer never gets raw
`fs`/`child_process`. Keep your plugin on the same side of that line:

- [ ] Declares the **minimum** permissions; none it doesn't use.
- [ ] Escapes any character/persona/message/user-derived string before putting
      it in `innerHTML` (import `escapeHtml`/`escapeAttr` patterns from the app,
      or build DOM with `textContent`/`createElement`). `host.ui.confirm` is
      safe; `host.ui.modal.open({title, contentHTML})` is not.
- [ ] `deactivate()` undoes every timer / global listener / global DOM node /
      backend it created.
- [ ] Never assumes an event fires or an extension point is mounted — all are
      additive and Electron-only.
- [ ] No secrets committed in the package; user secrets go through
      `host.storage`.
- [ ] Colours come from CSS custom properties (`var(--bg-surface)`,
      `var(--text-main)`, `var(--accent-primary)`, …) — never hardcoded hex — so
      plugin UI follows the app's light/dark theme. Wrap plugin UI in a
      `.plugin-scope` element.
- [ ] A backend asks only for the `fs-*` / `child_process` scope it needs and
      kills its own children.

---

## 13. Minimal example

`plugins/hello-world/plugin.json`

```json
{
  "id": "com.example.hello",
  "name": "Hello World",
  "version": "1.0.0",
  "engineApi": "1.0",
  "permissions": []
}
```

`plugins/hello-world/renderer/index.js`

```js
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="9"/></svg>';

export async function activate(host) {
  // A settings tab that reads/writes plugin storage.
  host.ui.registerSettingsTab({
    id: 'main',
    label: 'Hello',
    render: async (container) => {
      container.textContent = '';
      const saved = (await host.storage.get('note')) || '';

      const input = document.createElement('input');
      input.className = 'input';
      input.value = saved;
      input.placeholder = 'Type something — saved on blur';
      input.style.cssText = 'width:100%;padding:0.5rem 0.65rem;background:var(--bg-surface);color:var(--text-main);border:1px solid var(--border-light);border-radius:var(--radius-md);font:inherit;';
      input.addEventListener('change', () => {
        host.storage.set('note', input.value);
        host.ui.toast.success('Saved');
      });

      const wrap = document.createElement('div');
      wrap.className = 'plugin-scope';
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:0.6rem;max-width:480px;color:var(--text-main);';
      wrap.append(input);
      container.append(wrap);
    }
  });

  // A per-message button.
  host.ui.registerMessageAction({
    id: 'shout',
    icon: ICON,
    title: 'Log this message',
    visible: (msg) => msg.role === 'assistant',
    onClick: (msg) => host.log('message', msg.id, msg.content.slice(0, 80))
  });

  // React to streaming.
  host.events.on('assistant-message-chunk', ({ fullText }) => {
    host.log('streamed chars:', fullText.length);
  });

  host.log('Hello World active');
}

export function deactivate() {
  // Nothing extra to clean up — all registrations auto-dispose.
}
```

Then: relaunch (seeds it), enable it in Settings → Plugins, open Settings →
Hello.

---

## 14. Reference implementation

`plugins/conversation-voice/` (id `com.nnzrp.voice`) is the shipped, non-trivial
example: settings tab, character fields with a runtime-refreshed dropdown,
per-message play/stop button, a plugin-owned floating button, `host.assets` file
uploads, `host.net` HTTP client, replay cache, and speak-while-streaming driven
by `assistant-message-chunk`. Read its `renderer/index.js` alongside this guide.

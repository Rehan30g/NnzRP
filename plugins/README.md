# NnzRP Plugins (Desktop / Electron only)

Plugins add tabs, buttons, message hooks, character fields, and external-app
integrations **without modifying core `js/`**. They only load in the Electron
desktop build (`window.electronAPI` present) — the PWA and Android APK ignore
them entirely.

This folder holds plugin **sources**. Each subfolder is one plugin. Bundled
plugins here are copied into the packaged app (`resources/bundled-plugins/`) and
seeded into the user's data dir on first launch, **disabled** by default.

## Package format (`.nnzplugin`)

A plain zip with files **at the archive root** (not nested in a folder):

```
plugin.json            required — manifest
renderer/index.js      ES module: export function activate(host) [+ deactivate()]
backend/index.js       optional — Node module, runs as a child process
assets/…               optional — icons, css, samples
README.md              optional
```

Build one with:

```
npm run build:plugin <folder-name>      # -> dist-plugins/<folder-name>.nnzplugin
```

Install it from the running app: **Settings → Plugins → Install dari file .zip**.

## `plugin.json`

| field | required | notes |
|---|---|---|
| `id` | yes | reverse-DNS, unique. Also the on-disk dir name — no path separators / `..`. |
| `name`, `version` | yes | |
| `description`, `author`, `icon` | no | `icon` is a path inside the package. |
| `renderer` | no | default `renderer/index.js`. Omit for a backend-only plugin. |
| `backend` | no | path to the Node entry; presence enables `host.backend.*`. |
| `engineApi` | no | host API version this targets. Host refuses if the major differs from `1`. |
| `permissions` | no | subset of `network`, `storage`, `child_process`, `fs-read`, `fs-write`. Default `[]`. Gates `host.net` (renderer) and the `ctx.*` helpers (backend). |
| `minAppVersion` | no | |

## Renderer entry

```js
export async function activate(host) {
  // register contributions; each register* returns a disposer (auto-run on deactivate)
  host.ui.registerSettingsTab({ id: 'main', label: 'My Plugin', render: (el) => { /* build DOM */ } });
  host.ui.registerMessageAction({ id: 'go', icon: '<svg…>', title: 'Do it',
    visible: (msg) => msg.role === 'assistant', onClick: (msg, ctx) => { /* … */ } });

  host.events.on('assistant-message-complete', ({ chatId, character, message }) => { /* … */ });

  const url = await host.storage.get('endpoint');
}

export function deactivate() { /* stop timers / audio; registrations auto-dispose */ }
```

### The `host` object

- `host.apiVersion` (`"1.0"`), `host.pluginId`, `host.manifest`, `host.pluginPath`, `host.log(...)`.
- `host.ui.registerNavTab | registerSettingsTab | registerChatDrawerTab | registerComposerButton | registerMessageAction | registerCharacterFields` — each returns a disposer.
  - `registerCharacterFields([{ key, label, type: 'text'|'select'|'toggle'|'textarea', options?, placeholder?, help?, default? }])` — rendered in the character create/edit modal; values persist at `character.pluginData[<pluginId>][key]` and are present on the `character` passed to your callbacks. `default` is used when the character has no stored value yet — **a `toggle` that should start ON must set `default: true`**, otherwise it renders unchecked and the first Save writes `false`.
  - nav-tab route is `#plugin:<pluginId>:<tabId>`.
- `host.ui.toast.{success,error,info}(msg)`, `host.ui.modal` (the app `Modal`), `host.ui.confirm(msg) => Promise<boolean>`.
- `host.events.on(event, fn) => disposer` — `chat-opened` `{chatId,character}`, `chat-closed` `{chatId}`, `user-message-sent` `{chatId,character,message}`, `assistant-message-complete` `{chatId,character,message}`, `navigate` `{view,params}`. (`assistant-message-chunk` is not currently emitted.)
- `host.pipeline.addRequestTransform(fn)` / `addResponseTransform(fn)` — `async (value, ctx) => value` to rewrite provider payloads / results.
- `host.storage.{get,set,delete,keys}` — async, JSON-serialisable, namespaced to your plugin, persisted in IndexedDB.
- `host.assets.{write(relPath, ArrayBuffer), read(relPath), list(), delete(relPath), path(relPath)}` — async file store at `userData/plugin-data/<pluginId>/`, for files the user adds (uploads etc.). Survives a package reinstall/update; removed only on explicit uninstall. `path()` returns an absolute filesystem path — useful when a co-located local server (same machine as the desktop app) needs to read the file.
- `host.data.{getCharacter(id), getActiveChat(), getMessages(chatId), getProxy(), getPersona()}` — read-only. `getActiveChat()` is sync (`{chatId,character}` or `null`); the rest are async.
- `host.net.fetch` — only if `network` permission. (In the renderer this is just `window.fetch`.)
- `host.backend.{start(), stop(), request(msg), on(event, cb)}` — only if `manifest.backend` is set.

Every callback you pass is wrapped so a throw can't break the app or other
plugins — but it also can't surface, so log your own errors.

## Backend entry (optional)

```js
module.exports = function (ctx) {
  ctx.rpc.onRequest(async (payload) => {
    // ctx.net.fetch      (permission: network)
    // ctx.fs.readFile / ctx.fs.writeFile   (fs-read / fs-write)
    // ctx.spawn(cmd, args)  -> { pid, kill }, emits stdout/stderr/exit via ctx.emit
    return { ok: true };
  });
  ctx.emit('ready', {});   // -> host.backend.on('ready', …) in the renderer
};
```

Runs in a `fork()`ed Node process managed by `main.js`. Only the helpers your
`permissions` allow are present on `ctx`. Killed when the app quits.

## Rules (same as the rest of the app — see `../CLAUDE.md`)

- No emojis. Use SVG icons or plain text.
- No raw hex colours — style plugin UI with the app's CSS custom properties
  (`var(--bg-surface)`, `var(--text-main)`, `var(--border-light)`,
  `var(--accent-primary)`, `var(--accent-rose)`, `var(--accent-emerald)`,
  `var(--radius-md)`, …) so it follows light/dark.
- Escape any dynamic text you put into `innerHTML`.
- Don't reach into core `js/` modules — everything goes through `host`.

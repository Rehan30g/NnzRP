# Pocket TTS Voice

An NnzRP plugin (Electron only) that reads every character reply aloud through a
**[Pocket TTS](https://github.com/kyutai-labs/pocket-tts)** server (Kyutai Labs'
lightweight CPU text-to-speech). The server runs **separately** — this plugin is
a pure HTTP client and never starts, stops, or manages it.

> Renamed from **Conversation Voice** (`com.nnzrp.voice`). Per-character voice
> choices are read back under the old id, but plugin settings and uploaded voice
> clones do not migrate — re-do those in the Voice subtab (Plugins view) after updating.

## Prerequisite: run a Pocket TTS server

Pocket TTS is a normal Python package. Install it and start its server:

```bash
pip install pocket-tts          # or: uv add pocket-tts
pocket-tts serve                 # serves on http://localhost:8000 by default
```

CPU-only Linux wheels: `pip install pocket-tts --extra-index-url https://download.pytorch.org/whl/cpu`

Point the plugin's **Server URL** at wherever it listens (default
`http://127.0.0.1:8000`). If the server is unreachable the plugin shows a
toast and plays nothing.

> The Pocket TTS model has **poor Indonesian support** (Indonesian text is read
> with an English accent). That is a model limitation, not a plugin bug.

### HTTP contract the plugin expects

The plugin only needs a server that speaks this much of Pocket TTS's API:

- `GET {serverUrl}/health` -> `{"status":"healthy"}` — used by "Test connection".
- `POST {serverUrl}/tts` — `multipart/form-data`:
  - `text` — the text to speak.
  - **either** `voice_url` — a built-in voice name, or an `http(s)://` / `hf://`
    URL,
  - **or** `voice_wav` — a `.wav` file part (an uploaded clone).
  - `voice_url` and `voice_wav` are mutually exclusive; there is no `voice`
    field. The response body is a **chunked WAV stream** (44-byte canonical PCM
    header, then little-endian int16 samples at the server's sample rate,
    typically 24 kHz mono). The plugin reads it progressively and plays it with
    a Web Audio scheduler (ported from Pocket TTS's own web UI) that slices the
    PCM and schedules the slices back-to-back on one timeline — so audio starts
    ~0.17 s in and consecutive slices / sentences / requests join with no gap
    and no clipped tail.

Any co-located server implementing that contract works; it does not have to be
`pocket-tts serve` itself.

## What this plugin adds

### "Voice" settings (a subtab in the app's Plugins view)

| Field | Default | Notes |
|---|---|---|
| Server URL | `http://127.0.0.1:8000` | Pocket TTS endpoint. |
| Play automatically | on | Play the voice as soon as a character reply finishes. |
| Play sentence by sentence | on | Read the reply in sentence batches (up to ~600 chars/request), each `/tts` response streamed straight into gapless playback while the next batch synthesises. First audio comes out almost instantly. Turn off to synthesise the whole reply as one request (still streamed). |
| Read while the response is still streaming | on | Start reading each sentence — or, in dialogue mode, each quote — as soon as it is finished, without waiting for the full reply. Needs "Play automatically" + "Play sentence by sentence" on. Turn off to go back to the old behaviour (read only after the reply is done). |
| Read mode | `Whole reply text` | `Whole reply text` or `Only dialogue inside quotes`. In dialogue mode a reply with no `"..."` quotes is skipped (silent) unless "also read narration" is on. Fenced code blocks (<code>```&nbsp;...&nbsp;```</code>) are stripped and never read in either mode. Dialogue mode is read live while streaming too — each quote is spoken the moment its closing `"` arrives. |
| Dialogue mode: also read narration outside the quotes | off | Only applies when Read mode is `Only dialogue inside quotes`. Off: read **only** the quoted dialogue — narration / `**bold**` action text is not read, a quote-less reply stays silent. On: read the whole reply, narration included. |
| Stop audio when a new reply arrives | on | Stop the old playback before the new one starts. |
| Default voice | `alba` | Used when a character has not picked a voice. |
| **Enable multi-voice** *(experimental)* | off | Detect `Name:` speaker prefixes and give each speaker their own voice — see below. |
| **Narrator / unattributed voice** | *(character's own)* | Voice for text with no `Name:` prefix when multi-voice is on. |
| Voice clone | - | **Upload .wav** button — the file is stored in the plugin data directory (`plugin-data/com.nnzrp.pocket-tts/<slug>.wav`) and then appears as a `Clone: ...` option in the per-character voice dropdown. Each entry has a Delete button. |
| Speaker voices *(multi-voice)* | - | One row per auto-detected speaker: name + a voice picker (Auto / built-in / clone) + remove. Plus an "add manually" box and "clear all". |
| Test connection | - | `GET /health`, green (healthy) / red (not connected). |

Every change is saved immediately (`host.storage`, namespaced to the plugin).

### Per-character fields

- **Voice (Pocket TTS)** — dropdown: `(use plugin default)`, 26 built-in voices,
  then one `Clone: <name>` entry per `.wav` uploaded in the Voice subtab. A
  `clone:<slug>` value is sent by `speak()` as the `voice_wav` file part; a
  built-in name is sent as the `voice_url` field.
- **Mute voice for this character** — toggle, default **off** (so the character
  has a voice). Turn it on only when you want a specific character not to be read
  aloud.

Values are stored at `character.pluginData['com.nnzrp.pocket-tts']` (the `voiceId`
dropdown is read from the hidden input `#plugin-field-com-nnzrp-pocket-tts-voiceId`
that `charactersView.js` runs through `wireDropdown` — the save path is correct).
The old "Voice clone (.wav path on the server)" field and the old "Enable voice"
toggle are gone — that old toggle rendered unchecked by default, so every
character edit silently saved `enabled: false` and muted it; the old `enabled`
value is now ignored (`voiceEnabledFor` only checks `muted`). An old
`voiceClonePath` value is still honoured by `resolveVoice()` **only if it is an
`http(s)://` / `hf://` URL** (the `/tts` endpoint rejects local paths) — a plain
path value is logged once and then ignored, falling through to `voiceId` /
default.

Before each autoplay/replay the plugin calls `freshCharacter()` ->
`host.data.getCharacter(id)`, because `chatView` snapshots the character once
when a chat opens; without the refetch, a mid-session voice change would not
take effect until the chat is reopened.

### Uploading a voice clone

A mono `.wav`, roughly 10-20 seconds. The file goes into
`userData/plugin-data/com.nnzrp.pocket-tts/` via `host.assets.write`, not into the
plugin package folder — so a package reinstall/update never removes it (only an
explicit uninstall does). When used, `fetchTTS()` reads it back via
`host.assets.read(<slug>.wav)` and uploads it to the server as the `voice_wav`
multipart file part — not as a path. The `/tts` endpoint rejects a filesystem
path in `voice_url` and rejects `voice_url` + `voice_wav` together.

### Message actions & stop button

- The speaker button on every **assistant** message: click to play that reply;
  click again while that reply is playing to **stop it** (the title stays "Play
  voice" — a message-action icon cannot change per message). Playing another
  message stops the current one and starts the new one.
- The **stop button**: a small round rose-tinted icon button that **only appears
  while audio is playing / being synthesised / queued** and disappears the moment
  playback stops / finishes / is stopped / fails. One click stops any playback
  (including still-queued sentences and, in "read while streaming" mode, the rest
  of this turn's sentences). It is not a `registerComposerButton` (chatView
  renders those once with no refresh, so their visibility cannot be tied to
  playback state).
  - **Position**: `showStopButton()` appends it as the LAST child of
    `.chat-toolbar-left-group` — the flex row inside the floating composer that
    holds the model picker — so it sits inline right next to the model dropdown
    instead of covering the message stream. Sized to match the composer's other
    toolbar chips (40px, `--radius-full`). If that group is not in the DOM (not on
    the chat page) the button stays hidden/detached. `.chat-input-container` is
    `pointer-events: none`, so the button sets `pointer-events: auto` on itself.
  - Built once lazily via `document.createElement`; detached from the DOM when
    idle and re-attached on each `showStopButton()`. Styling uses CSS tokens
    (`--accent-rose-soft`, `--accent-rose`, `--accent-rose-border`,
    `--radius-full`).
  - `showStopButton()` is called at the start of `speak()`, when a clip is
    enqueued, and from the streaming player's first-audio callback.
    `hideStopButton()` is called via `endPlayback()` — one helper that nulls
    `currentMessageId` and hides the button, used by `stopAudio()` and every
    normal/failed completion tail.
- The `chat-closed` event calls `stopAudio()` -> `endPlayback()`, so closing a
  chat while audio is playing also hides the button and clears the replay cache.
  The button element is only removed from the DOM in `deactivate()`.

### Replay cache (in-memory, transient)

Per-message audio Blobs are kept in an in-memory `Map` so a replay click does not
re-synthesise on the server. Key: `msg.id` + a signature of
`{ voice, read mode, sentence mode, hash of the extracted text }` — changing the
voice / read mode / sentence mode / message text (e.g. a swipe) produces a
different signature, so synthesis re-runs. Bounds: at most **12** messages **and**
~**48 MB** total — oldest evicted first. The cache is filled once a message is
fully synthesised (autoplay or manual replay), so the first replay after autoplay
is already instant; a partial result (failed / stopped mid-way) is never cached.
The cache is cleared on `chat-closed` and `deactivate()`. No disk persistence.

## The 26 built-in Pocket TTS voices

```
alba  jean  anna  vera  cosette  marius  javert  fantine  charles  paul
eponine  azelma  george  mary  jane  michael  eve  bill_boerst
peter_yearsley  stuart_bell  caro_davy  giovanni  lola  juergen  rafael  estelle
```

`giovanni` (it), `lola` (es), `juergen` (de), `rafael` (pt), `estelle` (fr) are
the per-language defaults; the rest are English.

## How `speak()` works

1. Resolve the voice -> a `{ kind, ... }` descriptor, in priority order:
   legacy `voiceClonePath` (used **only** if it is an `http(s)://`/`hf://` URL ->
   `{kind:'url'}`; a local path is logged once and ignored) -> `voiceId`
   (`clone:<slug>` -> `{kind:'clone', slug}` if the clone file exists, else
   `{kind:'default'}`; otherwise `{kind:'builtin', name}`) -> `{kind:'default'}`.
2. Take the text from `message.content`. Fenced code blocks (<code>```&nbsp;...&nbsp;```</code>)
   are removed first in every mode — a closed block is dropped, an unclosed
   trailing fence hides everything after it. `dialogue` mode (with "read
   narration" **off**) then joins every span between quotes (straight & curly)
   with newlines, strips markdown markers (`* _ ~ \` # >`) per span, and caps at
   `MAX_TTS_CHARS` — narration and `**bold**` action text are **not** read, and a
   reply with no quotes is left **silent**. Turn "read narration" **on** to read
   the whole reply like `full` mode instead. `full` mode strips markdown,
   collapses whitespace, drops `---` lines, and caps at `MAX_TTS_CHARS`.
3. If **Play sentence by sentence** is on: `splitIntoChunks()` splits into
   sentences (soft cap ~280 chars, very short fragments merged), enqueued onto
   the shared utterance queue. Otherwise: one queue item with the whole text.
4. Check the replay cache (`msg.id` + voice/mode/text signature). On a match,
   every `fetchTTS` is skipped and the stored WAV Blobs are fed back through the
   streaming player (`playCachedSequence`, still respecting epoch / stop).
5. On a cache miss: the single consumer drains the queue, **batching adjacent
   same-voice sentences into as few `/tts` requests as possible** (≤ ~600 chars
   each) and 1-deep prefetching the next batch's request while the current one
   streams. Each request is `POST`ed to `{serverUrl}/tts`
   (`multipart/form-data`: `text`, then **`voice_url`** `<name|URL>` for a
   built-in/URL voice **or** the **`voice_wav`** file part `<slug>.wav` for a
   clone — never both, never a `voice` field). Its response body is read
   progressively and fed straight into the shared `StreamingWavPlayer`, which
   schedules PCM slices back-to-back on one Web Audio timeline so batches join
   gaplessly. `host.log('TTS voice ->', ...)` prints exactly what is being sent.
6. `playEpoch` (module-scoped) + `AbortController` cancel an in-flight pipeline
   on a new `speak()` / `stopAudio()` / stop button / `chat-closed` event —
   `stopAudio()` also tears down the `AudioContext`, instantly silencing every
   scheduled slice. A connect timeout (20 s, no response headers) and a
   stream-idle timeout (25 s, body stalled) abort one request without killing
   the run. Once every batch of the message has streamed without interruption,
   its WAV Blobs go into the replay cache.

A network failure or a non-OK response -> `host.ui.toast.error` (a 400 response
body is included so a wrong voice value can be traced), with no audio played and
no cache written.

## Read while the response is still streaming

When the **"Read while the response is still streaming"** toggle is on (default) —
and "Play automatically" + "Play sentence by sentence" are on and the character
is not muted — the plugin starts reading each sentence **as soon as the model
finishes typing it**, without waiting for the full reply. This works in dialogue
mode too: `extractStreamText()` there yields only the text of quotes that have
already been **closed**, which still grows monotonically, so each quote is read
one chunk after its closing `"` lands. In dialogue mode with "read narration"
off, a reply with no quotes at all is left **silent** — narration is never read.

- **Data source**: `chatView.js` emits `assistant-message-chunk`
  `{ chatId, character, messageId, fullText }` from inside its streaming renderer,
  already throttled to ~50 ms (not per raw SSE chunk). `fullText` = the whole
  assistant text accumulated so far. `messageId` is null for a fresh reply (not
  yet persisted while streaming), and the real id for a swipe regenerate.
- **Shared queue**: the old one-shot `speak()` is replaced by an
  `enqueueUtterance()` queue + a single consumer loop. The consumer uses the same
  depth-1 prefetch pipeline and the same `playEpoch` / `AbortController` / stop
  button / `endPlayback()` / cache machinery as before — so the floating stop
  button, per-message stop, `stopOnNew`, and `chat-closed` teardown all keep
  working unchanged. `speak()` (manual replay, and the non-streaming fallback)
  now just pushes all of its sentences onto the same queue plus one finalize
  marker to write the cache.
- **Sentence boundary detection**: each chunk, `fullText` goes through
  `extractStreamText` (the active read-mode transform, minus the whole-message
  char cap; fenced code blocks stripped), then the part after `streamSpokenLen`
  is scanned for a **certain** boundary — the last fragment is treated as
  unfinished unless it ends with `. ! ? …` or a newline. In dialogue mode the
  quote spans are newline-joined, so each closed quote is its own certain
  boundary. Only sentences/quotes with a certain boundary are enqueued; the
  half-finished remainder waits for the next chunk.
- **Completion**: on `assistant-message-complete`, the unread tail is flushed
  through the queue, then once this turn's queue is truly drained its Blobs are
  written to the replay cache with the **same signature** as a non-streaming turn
  (voice + read mode + sentence mode + text hash), so a later manual replay is a
  cache hit. The `complete` handler then `return`s — it does not call `speak()`
  again (no double audio).
- **Abort / no `complete`**: there is deliberately **no idle timeout**. A
  streaming turn ends only on an explicit signal —
  `assistant-message-complete`, `assistant-generation-ended` (emitted by
  `chatView` on user abort / hard error), `user-message-sent` /
  `assistant-generation-started` (the next turn begins), a user stop,
  `chat-closed`, or `deactivate`. The stop button / per-message stop call
  `stopAudio()`, which clears the queue, sets `streamActive=false`, and discards
  this turn's `streamBlobs` (no partial cache). `assistant-generation-ended`
  marks the turn abandoned but lets whatever is already queued finish playing.
- **Fallback**: if any condition above is not met (toggle off, "Play sentence by
  sentence" off, autoplay off, character muted, or the app is not streaming so
  there are no chunks), `streamActive` stays `false` and
  `assistant-message-complete` runs `speak()` as usual — the old behaviour is
  unchanged.

## Multi-voice (experimental)

Turn on **Enable multi-voice** in the Voice tab. When on, a reply written as a
script gets **one voice per speaker**:

```
The warehouse was empty when they arrived.

Mr. Wolf: "...you delete your copy. Deal?"

Alice: "And if I say no?"
```

→ narration in the narrator voice, `Mr. Wolf`'s line in his voice, `Alice`'s in
hers.

- **Speaker detection**: a `Name:` prefix at the **start of a line**, where the
  name is 1–4 Title-Case (or ALL-CAPS) words, optionally wrapped in `**bold**`,
  and the `:` is followed by a quote or a letter. `Mr. Wolf:`, `ALICE:`,
  `**The Narrator:**` all match; prose colons like `Here's the thing:` and URLs
  (`https://…`) do not. A speaker's turn runs until the next `Name:` line or a
  **blank line** (which reverts to narration — one paragraph per turn).
- **Auto-detected roster**: every speaker seen is saved to a persisted roster
  (`host.storage` key `speakers`) and listed in the Voice tab. It survives across
  sessions; **Clear all speakers** wipes it.
- **Voice assignment**, in order: an explicit pin in the **Speaker voices** list
  (`host.storage` key `voiceMap`, keyed by the normalised name — `mr wolf`) →
  otherwise a **stable auto voice** (the name hashed into the 26 built-ins, so
  the same speaker always sounds the same even before you pin them). You can also
  **add a speaker by hand** before it appears.
- **Narration** (no `Name:` prefix) uses the **Narrator / unattributed voice**
  setting, or the character's own voice when that is left blank.
- Works both for whole-message playback (`speakMultiVoice()`) and **live while
  streaming** (`enqueueMultiVoiceStream()`): whole lines are read as they land,
  and a partial trailing line is held back until its `Name:` prefix has fully
  arrived so a name is never cut across chunks. Read mode (whole / dialogue-only)
  and the replay cache both apply per segment. Off = byte-for-byte the old
  single-voice behaviour.

## Build

From the repo root:

```
npm install                        # installs adm-zip
npm run build:plugin -- pocket-tts
# -> dist-plugins/pocket-tts.nnzplugin
```

Or directly: `node scripts/build-plugin.mjs pocket-tts`.

## Permissions

`network` (calling the TTS server) and `storage` (saving config). No `backend`
component — the server lives outside the app.

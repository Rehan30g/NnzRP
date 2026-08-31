// Pocket TTS Voice — renderer entry
//
// A pure HTTP client for a Pocket TTS server (https://github.com/kyutai-labs/
// pocket-tts) that the user runs themselves (`pip install pocket-tts` then
// `pocket-tts serve`, default http://localhost:8000). This plugin NEVER spawns
// or manages that server. If /health is unreachable it says so.
//
// What this build does:
//  1. Voice-clone LIBRARY: upload .wav files in the Voice settings tab; they
//     are stored in the plugin's own data dir via host.assets and offered as
//     per-character voice options.
//  2. Realtime streaming playback (ported from Pocket TTS's own web UI): every
//     /tts response is a chunked WAV stream (44-byte header + PCM16 at the
//     server's sample rate). The bytes are read progressively with
//     response.body.getReader() and fed into a Web Audio scheduler that plays
//     small PCM slices back-to-back on a single running timeline
//     (`nextStartTime`), so audio starts ~150ms after the first bytes and
//     consecutive slices / sentences / requests join with NO gap and NO
//     clipped tail. Sentences that finish while the model is still typing are
//     batched (up to ~600 chars) into as few requests as possible instead of
//     one HTTP round-trip per sentence.
//  3. Voice actually switches per character. The Pocket TTS /tts endpoint takes
//     `voice_url` (a built-in name, or an http(s)://|hf:// URL) OR a `voice_wav`
//     file part — NOT a `voice` field, and NOT a local filesystem path. A
//     built-in / URL voice goes in `voice_url`; an uploaded clone is sent as the
//     `voice_wav` multipart file. The two are mutually exclusive.
//  4. Stop control: a small round stop button parked next to the model picker
//     inside the chat composer toolbar, visible only while audio is playing /
//     being synthesised; the per-message speaker button also doubles as stop
//     while that same message is playing.
//  5. Replay cache: the synthesised WAV Blobs for a message are kept in a
//     small in-memory cache, so replaying a message is instant (no re-synth)
//     as long as voice / read-mode / chunk-mode / text are unchanged.
//  6. Fenced code blocks (``` ... ```) are stripped before any text is spoken,
//     in every read mode (a closed block is dropped; an unclosed trailing fence
//     hides everything after it). The "Only dialogue inside quotes" read mode
//     now also works while the reply is still streaming — each quote is spoken
//     the moment its closing " arrives — and has a toggle for whether to also
//     read the narration outside the quotes (cfg.dialoguePlainText).
//  7. Multi-voice (experimental, cfg.multiVoiceEnabled, default OFF): a reply
//     written as a script — `Mr. Wolf: "..."` / `Alice: "..."` lines — is split
//     into per-speaker segments, each spoken in that speaker's own voice.
//     Speakers are auto-collected into a persisted roster during the
//     conversation; the Voice tab pins a voice per speaker (or adds one by
//     hand). Unpinned speakers get a stable name-hashed built-in voice.
//     Narration (no "Name:" prefix) uses cfg.narratorVoice or the character's
//     own voice. Works for whole-message playback AND live while streaming.
//
// Host API version targeted: 1.0

const PLUGIN_KEY = 'com.nnzrp.pocket-tts';
// Plugin id before the rename from "Conversation Voice". `pluginDataOf()` still
// reads per-character values stored under this key so an existing character's
// voice choice survives the rename (plugin settings + uploaded clones do not
// migrate automatically — re-do those in the Voice tab).
const LEGACY_PLUGIN_KEY = 'com.nnzrp.voice';
const MAX_TTS_CHARS = 4000;      // hard cap across the whole message
const MAX_CHUNK_CHARS = 280;     // soft cap per split sentence
const MAX_REQUEST_CHARS = 600;   // soft cap per synthesised /tts request (batched sentences)
const MAX_CLONE_BYTES = 12 * 1024 * 1024;

// Replay cache bounds (in-memory, per session).
const CACHE_MAX_ENTRIES = 12;
const CACHE_MAX_BYTES = 48 * 1024 * 1024;

// Streaming playback tuning.
const PLAYER_MIN_SCHED_BYTES = 8000;   // ~0.17s @ 24kHz mono 16-bit — first-audio latency floor
const SCHED_AHEAD_SEC = 1.5;           // how far synth may run ahead of the speaker before pausing intake
const TTS_CONNECT_TIMEOUT_MS = 20000;  // abort if the server sends no response headers in time
const TTS_STREAM_IDLE_MS = 25000;      // abort a request whose body stalls with no new bytes

// The 26 built-in voice names shipped by Pocket TTS
// (pocket_tts/utils/utils.py -> _ORIGINS_OF_PREDEFINED_VOICES). These are the
// only strings the /tts endpoint accepts in `voice_url` without an http/hf URL.
const BUILTIN_VOICES = [
  'alba', 'jean', 'anna', 'vera', 'cosette', 'marius',
  'javert', 'fantine', 'charles', 'paul', 'eponine', 'azelma',
  'george', 'mary', 'jane', 'michael', 'eve',
  'bill_boerst', 'peter_yearsley', 'stuart_bell', 'caro_davy',
  'giovanni', 'lola', 'juergen', 'rafael', 'estelle'
];

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8000',
  autoplay: true,
  readMode: 'full',      // 'full' | 'dialogue'
  dialoguePlainText: false, // in 'dialogue' mode: also read narration outside quotes
  stopOnNew: true,
  streamChunks: true,    // split into sentences and pipeline synth/playback
  speakWhileStreaming: true, // start reading each sentence while the reply is still streaming in
  defaultVoice: 'alba',
  // ----- multi-voice (experimental) -----
  multiVoiceEnabled: false,  // detect "Name:" speaker prefixes -> one voice per speaker
  narratorVoice: '',         // voice for text with no "Name:" prefix ('' = the character's own voice)
  voiceMap: {}               // { speakerKey -> voiceValue } explicit pins (voiceValue like a character voiceId)
};

let host = null;
let cfg = { ...DEFAULTS };

// Clone library: [{ slug, name, size }]. `slug` -> file `<slug>.wav` in the
// plugin data dir; `name` is the user-facing label.
let clones = [];

// Re-registerable so newly uploaded clones show up in the character dropdown.
let charFieldDisposer = null;

// Logged once if a legacy `voiceClonePath` value can't be used any more.
let legacyPathWarned = false;

// Playback engine state (module-scoped: one ChatView, one active playback).
let playEpoch = 0;
let activeAbort = null;
// The single Web Audio streaming scheduler for the current playback run. All
// clips of a turn (and, when stopOnNew is off, of consecutive turns) feed the
// SAME instance so they play on one gapless timeline. Nulled + torn down by
// stopAudio(); persists idle between turns otherwise (a stale nextStartTime in
// the past just means the next feed starts at "now").
let wavPlayer = null;
let wavPlayerBroken = false;   // Web Audio genuinely unavailable — stop retrying
// Id of the message whose audio is playing right now (null when idle) — lets the
// per-message button act as a stop toggle for its own message.
let currentMessageId = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- shared utterance queue + its single consumer -----
// Both speak() (whole message at once) and the streaming path (sentences fed in
// over time as `assistant-message-chunk` fires) push onto this ONE queue; the
// consumer drains it in order, batching adjacent same-voice sentences into as
// few /tts requests as possible and 1-deep prefetching the next request while
// the current one streams. Items are { text, voiceDesc, turnId, epoch, bag } or
// { finalize:fn, epoch }. `epoch` is the playEpoch value captured at enqueue
// time — a stale item (epoch changed by stopAudio()/a newer turn) is skipped.
// `bag`, if set, collects the synthesised Blob so a fully-completed run can be
// written to the replay cache.
let utterQueue = [];
let consumerRunning = false;

// ----- speak-while-streaming per-turn state -----
// `streamTurnId` bumps once per assistant turn. `streamGateEvaluated` flips true
// the first chunk of a turn (after we've decided whether the streaming path
// applies at all). `streamActive` means we ARE reading this turn live.
// `streamSpokenLen` is how many chars of the extracted full text we've already
// turned into queued sentences. `streamBlobs` collects them for the replay
// cache. `streamAbandoned` / `streamStoppedByUser` mark a turn that must not be
// cached and must not fall back to a whole-message speak() on completion.
let streamTurnId = 0;
let streamGateEvaluated = false;
let streamActive = false;
let streamAbandoned = false;
let streamStoppedByUser = false;
let streamTurnEnded = false;
let streamSpokenLen = 0;
let streamVoiceDesc = null;
let streamBlobs = [];
let streamEpoch = 0;
// Multi-voice streaming: the fresh character snapshot for this turn, and the
// speaker that was "in effect" at the current streamSpokenLen offset (so a
// chunk that continues a speaker's paragraph mid-line keeps their voice).
let streamChar = null;
let streamSpeaker = null;

// ----- multi-voice speaker roster (auto-detected during the conversation) -----
// [{ key, name, count, firstSeen, lastSeen }], persisted to host.storage
// 'speakers'. `voiceMap` (in cfg) holds the explicit voice pins keyed the same.
let speakers = [];
let speakersSaveTimer = null;
// Ref to the live settings custom slot so a brand-new speaker can refresh it.
let lastCustomSlot = null;

// Plugin-owned "Stop voice" button. chatView renders composer buttons exactly
// once (no live refresh), so a registerComposerButton toggle could never be
// shown/hidden per playback state. Built lazily and parked as the LAST child of
// the composer toolbar's left group (`.chat-toolbar-left-group`), right next to
// the model picker, while visible; detached when idle; removed in deactivate().
let stopBtnEl = null;
let stopBtnStyleEl = null;

// Replay cache: msgId -> { sig, blobs: Blob[], bytes }. Insertion-ordered Map,
// oldest evicted first. Purely in-memory; cleared on chat-closed / deactivate.
const audioCache = new Map();

const disposers = [];

// ---------------------------------------------------------------- config i/o

function normalizeCfg(raw) {
  const out = { ...DEFAULTS, ...(raw || {}) };
  if (typeof out.serverUrl !== 'string' || !out.serverUrl.trim()) out.serverUrl = DEFAULTS.serverUrl;
  out.serverUrl = out.serverUrl.trim().replace(/\/+$/, '');
  out.autoplay = out.autoplay !== false;
  out.stopOnNew = out.stopOnNew !== false;
  out.streamChunks = out.streamChunks !== false;
  out.speakWhileStreaming = out.speakWhileStreaming !== false;
  out.readMode = out.readMode === 'dialogue' ? 'dialogue' : 'full';
  out.dialoguePlainText = out.dialoguePlainText === true;
  if (typeof out.defaultVoice !== 'string' || !out.defaultVoice.trim()) out.defaultVoice = DEFAULTS.defaultVoice;
  out.multiVoiceEnabled = out.multiVoiceEnabled === true;
  out.narratorVoice = typeof out.narratorVoice === 'string' ? out.narratorVoice.trim() : '';
  // Always a FRESH object — DEFAULTS.voiceMap is a shared reference and must
  // never be mutated in place.
  out.voiceMap = (out.voiceMap && typeof out.voiceMap === 'object' && !Array.isArray(out.voiceMap))
    ? { ...out.voiceMap } : {};
  return out;
}

async function loadConfig() {
  const raw = {};
  for (const key of Object.keys(DEFAULTS)) {
    try {
      const v = await host.storage.get(key);
      if (v !== undefined && v !== null) raw[key] = v;
    } catch (e) {
      host.log('failed to read config', key, e);
    }
  }
  return normalizeCfg(raw);
}

// ---------------------------------------------------------------- clone library

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')       // drop extension
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'clone';
}

async function loadClones() {
  let stored = [];
  try {
    const v = await host.storage.get('clones');
    if (Array.isArray(v)) stored = v;
  } catch (e) {
    host.log('failed to read clone list', e);
  }
  // Reconcile against what is actually on disk.
  let files = [];
  try {
    files = await host.assets.list();
  } catch (e) {
    host.log('failed to list assets', e);
  }
  const onDisk = new Set((files || []).map((f) => f.name));
  clones = stored.filter((c) => c && c.slug && onDisk.has(c.slug + '.wav'));
  // Surface any orphan .wav that has no metadata entry.
  for (const f of files || []) {
    if (!/\.wav$/i.test(f.name)) continue;
    const slug = f.name.replace(/\.wav$/i, '');
    if (!clones.some((c) => c.slug === slug)) clones.push({ slug, name: slug, size: f.size || 0 });
  }
  return clones;
}

async function saveClones() {
  try {
    await host.storage.set('clones', clones.map((c) => ({ slug: c.slug, name: c.name, size: c.size })));
  } catch (e) {
    host.log('failed to save clone list', e);
  }
}

async function addClone(file) {
  if (!file) return;
  if (file.size > MAX_CLONE_BYTES) {
    host.ui.toast.error('File too large (max ' + Math.round(MAX_CLONE_BYTES / 1048576) + ' MB).');
    return;
  }
  let slug = slugify(file.name);
  const taken = new Set(clones.map((c) => c.slug));
  if (taken.has(slug)) {
    let n = 2;
    while (taken.has(slug + '-' + n)) n++;
    slug = slug + '-' + n;
  }
  let buf;
  try {
    buf = await file.arrayBuffer();
  } catch (e) {
    host.ui.toast.error('Failed to read the file.');
    return;
  }
  try {
    await host.assets.write(slug + '.wav', buf);
  } catch (e) {
    host.log('asset write failed', e);
    host.ui.toast.error('Failed to save the file to the plugin directory.');
    return;
  }
  clones.push({ slug, name: file.name.replace(/\.[a-z0-9]+$/i, '') || slug, size: file.size });
  await saveClones();
  registerCharFields();
  host.ui.toast.success('Voice clone added: ' + slug + '.wav');
}

async function removeClone(slug) {
  try {
    await host.assets.delete(slug + '.wav');
  } catch (e) {
    host.log('asset delete failed', e);
  }
  clones = clones.filter((c) => c.slug !== slug);
  await saveClones();
  registerCharFields();
}

// ---------------------------------------------------------------- toolbar stop button

const STOP_BTN_CLASS = 'cv-inline-stop';

// Build the button once (and its scoped stylesheet). It is a small round icon
// button sized to match the composer's other toolbar chips (attach button /
// model picker: 40px, pill radius), tinted rose. `showStopButton()` parks it as
// the last child of `.chat-toolbar-left-group` so it sits right next to the
// model picker inside the floating composer instead of covering the screen.
function ensureStopButton() {
  if (stopBtnEl) return stopBtnEl;

  stopBtnStyleEl = document.createElement('style');
  stopBtnStyleEl.textContent =
    '.' + STOP_BTN_CLASS + '{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;' +
    'width:40px;height:40px;min-height:40px;padding:0;box-sizing:border-box;' +
    'background:var(--accent-rose-soft);color:var(--accent-rose);' +
    'border:1px solid var(--accent-rose-border);border-radius:var(--radius-full);' +
    'cursor:pointer;pointer-events:auto;transition:filter .12s ease,box-shadow .12s ease;}' +
    '.' + STOP_BTN_CLASS + ':hover{filter:brightness(1.06);box-shadow:var(--shadow-glow,0 0 0 3px var(--accent-rose-soft));}' +
    '.' + STOP_BTN_CLASS + ' svg{width:18px;height:18px;display:block;}' +
    '.' + STOP_BTN_CLASS + '[hidden]{display:none;}';
  document.head.appendChild(stopBtnStyleEl);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = STOP_BTN_CLASS + ' plugin-scope';
  btn.title = 'Stop voice';
  btn.setAttribute('aria-label', 'Stop voice');
  btn.innerHTML = STOP_SVG;
  btn.addEventListener('click', () => stopAudio(true));
  btn.hidden = true;

  stopBtnEl = btn;
  return btn;
}

// Re-anchor every call: the composer (and its toolbar group) is re-created per
// chat. If the toolbar group isn't mounted (not on the chat view) there's
// nothing to sit next to, so stay hidden/detached.
function showStopButton() {
  const btn = ensureStopButton();
  const group = document.querySelector('.chat-input-toolbar .chat-toolbar-left-group')
    || document.querySelector('.chat-toolbar-left-group');
  if (!group) { btn.hidden = true; try { btn.remove(); } catch (e) { /* ignore */ } return; }
  if (btn.parentElement !== group) group.appendChild(btn);
  btn.hidden = false;
}

function hideStopButton() {
  if (stopBtnEl) {
    stopBtnEl.hidden = true;
    try { stopBtnEl.remove(); } catch (e) { /* ignore */ }
  }
}

// Single choke point for "a playback/synth run for the current epoch is over":
// clears the playing-message id and hides the toolbar stop button. Called by
// stopAudio() and by every normal/failed completion tail.
function endPlayback() {
  currentMessageId = null;
  hideStopButton();
}

// ---------------------------------------------------------------- streaming WAV player

// Ported from Pocket TTS's own web UI (pocket_tts/static/index.html,
// `StreamingWavPlayer`). Reads a chunked WAV byte stream (44-byte canonical
// PCM header, then interleaved little-endian int16 samples) and plays it by
// slicing the PCM into fixed-size AudioBuffers scheduled back-to-back on one
// running timeline (`_nextStartTime`). Because every slice — within a request
// AND across requests — is scheduled at exactly the previous slice's end,
// playback is gapless and the tail is never clipped (flush() emits the final
// sub-threshold remainder). First audio comes out as soon as
// PLAYER_MIN_SCHED_BYTES have arrived, not after the whole clip.
class StreamingWavPlayer {
  constructor() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this._ctx = new Ctx({ latencyHint: 'playback' });
    this._gain = this._ctx.createGain();
    this._gain.connect(this._ctx.destination);
    this._sampleRate = 24000;   // pocket-tts default; overwritten from the header
    this._numChannels = 1;
    this._headerParsed = false;
    this._headerBuf = new Uint8Array(44);
    this._headerLen = 0;
    this._pcm = new Uint8Array(0);   // bytes received but not yet scheduled
    this._nextStartTime = 0;
    this._sources = new Set();
    this._started = false;
    this._closed = false;
    this.onFirstAudio = null;
    try { if (this._ctx.state === 'suspended') this._ctx.resume(); } catch (e) { /* ignore */ }
  }

  // Call before feeding the bytes of a NEW WAV clip so its 44-byte header is
  // skipped rather than played as ~1ms of noise. The running timeline
  // (_nextStartTime) is deliberately kept, which is what makes back-to-back
  // clips join with no gap.
  beginClip() {
    this._headerParsed = false;
    this._headerLen = 0;
    // Drop any sub-frame remainder from the previous clip. For PCM16 this is
    // always 0 bytes after a clean flush(); clearing it guarantees the new
    // clip's samples stay byte-aligned even if the previous one was cut off.
    this._pcm = new Uint8Array(0);
  }

  feed(bytes) {
    if (this._closed || !bytes || !bytes.length) return;
    try { if (this._ctx.state === 'suspended') this._ctx.resume(); } catch (e) { /* ignore */ }

    let data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    if (!this._headerParsed) {
      const need = 44 - this._headerLen;
      const take = Math.min(need, data.length);
      this._headerBuf.set(data.subarray(0, take), this._headerLen);
      this._headerLen += take;
      if (this._headerLen < 44) return;
      this._parseHeader();
      data = data.subarray(take);
      if (!data.length) return;
    }

    this._append(data);
    this._schedule(false);
  }

  // Schedule whatever PCM is left even if it's below the streaming threshold —
  // used when a request body ends so its final fragment isn't dropped.
  flush() {
    if (this._closed) return;
    this._schedule(true);
  }

  _parseHeader() {
    const h = this._headerBuf;
    const riff = String.fromCharCode(h[0], h[1], h[2], h[3]);
    const wave = String.fromCharCode(h[8], h[9], h[10], h[11]);
    if (riff === 'RIFF' && wave === 'WAVE') {
      const view = new DataView(h.buffer);
      this._numChannels = view.getUint16(22, true) || 1;
      this._sampleRate = view.getUint32(24, true) || 24000;
    } else {
      // Not a header we recognise — treat these 44 bytes as PCM (defensive;
      // pocket-tts always sends a canonical header).
      this._append(h.slice());
    }
    this._headerParsed = true;
  }

  _append(b) {
    if (!b.length) return;
    const merged = new Uint8Array(this._pcm.length + b.length);
    merged.set(this._pcm);
    merged.set(b, this._pcm.length);
    this._pcm = merged;
  }

  _schedule(isFinal) {
    if (this._closed) return;
    const frameBytes = this._numChannels * 2;
    if (!isFinal && this._pcm.length < PLAYER_MIN_SCHED_BYTES) return;

    const usable = this._pcm.length - (this._pcm.length % frameBytes);
    if (usable <= 0) return;

    const slice = this._pcm.subarray(0, usable);
    const view = new DataView(slice.buffer, slice.byteOffset, usable);
    this._pcm = this._pcm.slice(usable);

    const frames = usable / frameBytes;
    const buf = this._ctx.createBuffer(this._numChannels, frames, this._sampleRate);
    for (let ch = 0; ch < this._numChannels; ch++) {
      const out = buf.getChannelData(ch);
      for (let i = 0; i < frames; i++) {
        out[i] = view.getInt16((i * this._numChannels + ch) * 2, true) / 32768;
      }
    }

    const src = this._ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this._gain);
    const start = Math.max(this._ctx.currentTime + 0.02, this._nextStartTime);
    try { src.start(start); } catch (e) { return; }
    this._nextStartTime = start + buf.duration;
    this._sources.add(src);
    src.onended = () => { this._sources.delete(src); };

    if (!this._started) {
      this._started = true;
      if (this.onFirstAudio) { try { this.onFirstAudio(); } catch (e) { /* ignore */ } }
    }
  }

  // Seconds of already-scheduled audio still to be heard (0 once idle).
  get scheduledEndsIn() {
    if (this._closed) return 0;
    try { return Math.max(0, this._nextStartTime - this._ctx.currentTime); }
    catch (e) { return 0; }
  }

  stop() {
    this._closed = true;
    for (const s of this._sources) {
      try { s.onended = null; } catch (e) { /* ignore */ }
      try { s.stop(); } catch (e) { /* ignore */ }
      try { s.disconnect(); } catch (e) { /* ignore */ }
    }
    this._sources.clear();
    try { this._ctx.close(); } catch (e) { /* ignore */ }
  }
}

function ensurePlayer() {
  if (wavPlayer) return wavPlayer;
  if (wavPlayerBroken) return null;
  try {
    wavPlayer = new StreamingWavPlayer();
    wavPlayer.onFirstAudio = () => { try { showStopButton(); } catch (e) { /* ignore */ } };
  } catch (e) {
    wavPlayerBroken = true;
    host.log('Web Audio unavailable — cannot play TTS', e);
    try { host.ui.toast.error('Audio engine unavailable in this build.'); } catch (e2) { /* ignore */ }
    return null;
  }
  return wavPlayer;
}

// Resolve once every sample scheduled so far has been (or is about to be)
// heard. Bails immediately if the run was superseded or torn down.
async function drainPlayer(myEpoch) {
  while (wavPlayer && !wavPlayer._closed && myEpoch === playEpoch) {
    const left = wavPlayer.scheduledEndsIn;
    if (left <= 0.05) break;
    await sleep(Math.min(left * 1000 + 30, 400));
  }
}

// ---------------------------------------------------------------- audio control

// `userInitiated` = the toolbar stop button or a per-message stop toggle (as
// opposed to stopOnNew firing at the start of the next speak()/turn). A user
// stop also freezes the current streaming turn: no more sentences get queued
// for it and its completion must not fall back to a whole-message speak().
function stopAudio(userInitiated) {
  playEpoch++;                       // invalidate any in-flight request pipeline
  utterQueue = [];                   // drop everything still queued for the old epoch
  streamActive = false;
  streamBlobs = [];
  if (userInitiated) streamStoppedByUser = true;
  endPlayback();                     // clear currentMessageId + hide stop button
  if (activeAbort) {
    try { activeAbort.abort(); } catch (e) { /* ignore */ }
    activeAbort = null;
  }
  if (wavPlayer) {
    try { wavPlayer.stop(); } catch (e) { /* ignore */ }
    wavPlayer = null;
  }
}

// ---------------------------------------------------------------- text prep

function stripMarkdown(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '---')
    .join('\n')
    .replace(/[*_~`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fenced code blocks (``` ... ```) are never spoken — their content is code,
// not prose. A CLOSED block is dropped entirely; an UNCLOSED trailing fence
// (still mid-stream, or the model never closed it) hides everything from the
// opening fence onward so half-written code is never read out. Applied before
// every other transform (full text AND dialogue extraction).
function stripCodeBlocks(text) {
  let s = String(text || '').replace(/```[\s\S]*?```/g, '\n');
  const open = s.indexOf('```');
  if (open !== -1) s = s.slice(0, open);
  return s;
}

// Hard char cap only — for text that is already markdown-stripped.
function capText(text) {
  let t = String(text || '').trim();
  if (t.length > MAX_TTS_CHARS) t = t.slice(0, MAX_TTS_CHARS).trim();
  return t;
}

// Every span between double quotes (straight or curly). Code blocks are removed
// first so a quote inside a code sample is not picked up. Each span is
// markdown-stripped on its own and the spans are joined with NEWLINES, not
// spaces: the sentence splitter and the streaming boundary detector both treat
// a newline as a certain boundary, so each quoted line becomes its own chunk
// and can be read the moment its closing quote arrives. An unclosed trailing
// quote simply is not matched yet, so the streamed result still only ever grows.
function extractDialogue(raw) {
  const norm = stripCodeBlocks(String(raw || '')).replace(/[“”„‟]/g, '"');
  const matches = norm.match(/"([^"]+)"/g);
  if (!matches || !matches.length) return '';
  return matches
    .map((s) => s.slice(1, -1).replace(/[*_~`#>]/g, '').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// Markdown-strip + whitespace-collapse + hard char cap — the 'full' read-mode
// transform, factored out so the streaming path can reuse it verbatim on the
// partial `fullText` it gets each chunk.
function extractFullText(raw) {
  let text = stripMarkdown(stripCodeBlocks(String(raw || '')));
  if (text.length > MAX_TTS_CHARS) text = text.slice(0, MAX_TTS_CHARS).trim();
  return text;
}

// Streaming twin of the read-mode transform WITHOUT the whole-message hard cap:
// an agentic turn stitches many tool rounds into one ever-growing fullText, and
// the 4000-char cap made the reader go permanently silent once the turn text
// grew past it (every further sentence was dropped as "already spoken").
// Per-request safety is preserved anyway — each queued sentence is bounded by
// MAX_CHUNK_CHARS and each request by MAX_REQUEST_CHARS, never by the whole
// turn's length.
//
// In 'dialogue' read mode with "read narration" OFF this returns only the text
// of the quotes that have already been CLOSED — still monotonically growing as
// the reply streams in, so `streamSpokenLen` stays a valid index into it.
function extractStreamText(raw) {
  if (cfg.readMode === 'dialogue' && !cfg.dialoguePlainText) {
    return extractDialogue(raw);
  }
  return stripMarkdown(stripCodeBlocks(String(raw || '')));
}

function extractText(message) {
  const raw = (message && typeof message.content === 'string') ? message.content : '';
  if (!raw) return '';
  if (cfg.readMode === 'dialogue' && !cfg.dialoguePlainText) {
    // Strictly quotes-only. A reply with no "..." dialogue is left SILENT -
    // the "also read narration outside the quotes" toggle is OFF, so narration
    // (incl. **bold** action text) must never be read. It used to fall back to
    // reading the whole reply here; that was the reported bug.
    return capText(extractDialogue(raw));
  }
  return extractFullText(raw);
}

// Split into sentence-ish chunks. Keeps first audio latency ~= synth time of
// the first sentence instead of the whole message. Very short trailing
// fragments are merged back so we never fire a request for "..." alone.
function splitIntoChunks(text) {
  const parts = String(text || '')
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks = [];
  for (let piece of parts) {
    while (piece.length > MAX_CHUNK_CHARS) {
      let cut = piece.lastIndexOf(' ', MAX_CHUNK_CHARS);
      if (cut < MAX_CHUNK_CHARS * 0.5) cut = MAX_CHUNK_CHARS;
      chunks.push(piece.slice(0, cut).trim());
      piece = piece.slice(cut).trim();
    }
    if (!piece) continue;
    const prev = chunks[chunks.length - 1];
    if (prev && (piece.length < 15 || prev.length + piece.length <= MAX_CHUNK_CHARS && piece.length < 40)) {
      chunks[chunks.length - 1] = prev + ' ' + piece;
    } else {
      chunks.push(piece);
    }
  }
  return chunks.length ? chunks : (text ? [String(text)] : []);
}

// ---------------------------------------------------------------- voice resolve

function pluginDataOf(character) {
  const pd = character && character.pluginData;
  if (!pd) return {};
  // Prefer the current id; fall back to the pre-rename id so an existing
  // character's stored voice/mute still applies until it is re-saved.
  return pd[PLUGIN_KEY] || pd[LEGACY_PLUGIN_KEY] || {};
}

function isRemoteVoiceUrl(s) {
  return /^(https?:\/\/|hf:\/\/)/i.test(String(s || ''));
}

// Returns a descriptor the fetch layer knows how to send:
//   { kind: 'builtin', name }  -> voice_url=<name>
//   { kind: 'clone',   slug }  -> voice_wav=<slug>.wav (multipart file)
//   { kind: 'url',     url  }  -> voice_url=<url>            (legacy, http/hf only)
//   { kind: 'default'       }  -> voice_url=<cfg.defaultVoice>
// Precedence: legacy voiceClonePath (URL only) -> voiceId -> plugin defaultVoice.
function resolveVoice(character) {
  const pd = pluginDataOf(character);

  const legacy = typeof pd.voiceClonePath === 'string' ? pd.voiceClonePath.trim() : '';
  if (legacy) {
    if (isRemoteVoiceUrl(legacy)) return { kind: 'url', url: legacy };
    if (!legacyPathWarned) {
      legacyPathWarned = true;
      host.log('legacy voiceClonePath ignored — the /tts endpoint takes no local path, only a built-in name / http(s):// / hf:// URL:', legacy);
    }
    // fall through to voiceId / default
  }

  const v = typeof pd.voiceId === 'string' ? pd.voiceId.trim() : '';
  if (v.startsWith('clone:')) {
    const slug = v.slice(6).trim();
    if (slug && clones.some((c) => c.slug === slug)) return { kind: 'clone', slug };
    host.log('voice clone not found (file missing?), using the default voice:', slug);
    return { kind: 'default' };
  }
  if (v) {
    if (BUILTIN_VOICES.indexOf(v) === -1) {
      host.log('voiceId is not one of the known built-in voices — sent as-is anyway:', v);
    }
    return { kind: 'builtin', name: v };
  }
  return { kind: 'default' };
}

function describeVoice(d) {
  if (!d) return 'default:' + (cfg.defaultVoice || DEFAULTS.defaultVoice);
  if (d.kind === 'clone') return 'clone:' + d.slug + '.wav (voice_wav)';
  if (d.kind === 'url') return 'url:' + d.url + ' (voice_url)';
  if (d.kind === 'builtin') return 'builtin:' + d.name + ' (voice_url)';
  return 'default:' + (cfg.defaultVoice || DEFAULTS.defaultVoice) + ' (voice_url)';
}

// Key ingredient for the replay cache signature — only the identity that
// affects the produced audio, not the descriptor's phrasing.
function voiceDescKey(d) {
  if (!d) return 'default:' + (cfg.defaultVoice || DEFAULTS.defaultVoice);
  if (d.kind === 'clone') return 'clone:' + d.slug;
  if (d.kind === 'url') return 'url:' + d.url;
  if (d.kind === 'builtin') return 'builtin:' + d.name;
  return 'default:' + (cfg.defaultVoice || DEFAULTS.defaultVoice);
}

// Muted only when the per-character "Mute" toggle is explicitly on.
// (Older builds stored an `enabled` flag that a form bug forced to false for
// every edited character - it is deliberately ignored now.)
function voiceEnabledFor(character) {
  return pluginDataOf(character).muted !== true;
}

// chatView snapshots the character once when a chat opens and never refreshes
// it, so a voice change made mid-session would otherwise never take effect.
// Always re-read the latest record before speaking.
async function freshCharacter(character) {
  if (character && character.id && host.data && typeof host.data.getCharacter === 'function') {
    try {
      const f = await host.data.getCharacter(character.id);
      if (f) return f;
    } catch (e) {
      host.log('character refetch failed', e);
    }
  }
  return character;
}

// ---------------------------------------------------------------- replay cache

// Cheap FNV-1a-ish 32-bit rolling hash for the extracted-text part of the key.
function textHash(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function cacheSignature(voiceDesc, text) {
  return [
    voiceDescKey(voiceDesc),
    cfg.readMode,
    (cfg.readMode === 'dialogue' && cfg.dialoguePlainText) ? 'dp1' : 'dp0',
    cfg.streamChunks ? 's1' : 's0',
    String(text.length) + '.' + textHash(text)
  ].join('|');
}

// ---------------------------------------------------------------- multi-voice
//
// Experimental: a reply written as a script — `Mr. Wolf: "..."` / `Alice: "..."`
// lines — is split into per-speaker segments, each spoken in that speaker's own
// voice. Speakers are auto-collected into a persisted roster during the
// conversation; the Voice settings tab lets you pin a voice per speaker or add
// one by hand. An unpinned speaker gets a stable auto voice (name hashed into
// the built-in pool). Text with no `Name:` prefix is "narration" and uses the
// narratorVoice (or the character's own voice when that is blank).

// A "Name:" speaker prefix at the START of a line. Deliberately strict to avoid
// matching prose colons ("Here's the thing: ..."): every word must be
// Title-Case or ALL-CAPS, 1-4 words, first word >= 2 chars, optional wrapping
// **bold**/_italics_, and the ":" must be followed by a quote / letter / digit
// (never "://" or "::"). Group 1 = the speaker name.
const SPEAKER_PREFIX_RE =
  /^[>\s]*(?:\*\*|\*|__|_)?\s*([\p{Lu}][\p{L}\p{M}.'’\-]+(?:[ \t][\p{Lu}][\p{L}\p{M}.'’\-]*){0,3})\s*(?:\*\*|\*|__|_)?\s*:\s*(?:\*\*|\*|__|_)?[ \t]*(?=["“”'‘’(*_]|\p{L}|\p{N})(?![:/])/u;

// Same name shape as above but WITHOUT the trailing ": <dialogue>" — matches a
// speaker name still being typed (`Mr. Wo`, `Mr. Wolf`, `Mr. Wolf:`). Used by
// the streaming path to hold back a partial line that might still become a
// "Name:" prefix, so a name is never cut in half across chunks.
const SPEAKER_NAME_PARTIAL_RE =
  /^[>\s]*(?:\*\*|\*|__|_)?\s*\p{Lu}[\p{L}\p{M}.'’\-]*(?:[ \t][\p{Lu}][\p{L}\p{M}.'’\-]*){0,3}\s*(?:\*\*|\*|__|_)?\s*:?\s*$/u;

// Canonical key for a speaker name: lowercase, periods dropped, spaces
// collapsed — so "Mr. Wolf", "Mr Wolf" and "MR. WOLF" all map to one entry.
function speakerKey(name) {
  return String(name || '')
    .replace(/[*_]/g, '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Ordered speaker segments. Returns { segments: [{ speaker, text }], endSpeaker }.
// Rules: a "Name:" line starts that speaker's turn; a BLANK line ends the
// current speaker's turn and reverts to narration (script-format convention —
// a turn is one paragraph); a leading run before any "Name:" line (or a whole
// reply with none) is narration (speaker=null). `initialSpeaker` seeds the
// state so the streaming path can continue a speaker across chunk boundaries;
// `endSpeaker` is the state to carry into the next chunk.
function splitBySpeaker(text, initialSpeaker) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const segments = [];
  let cur = initialSpeaker || null;
  let buf = [];
  const flush = () => {
    const t = buf.join('\n').trim();
    if (t) segments.push({ speaker: cur, text: t });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(SPEAKER_PREFIX_RE);
    if (m) {
      flush();
      cur = m[1].replace(/[*_]/g, '').trim().replace(/[.:\s]+$/, '');
      buf.push(line.slice(m[0].length));
    } else if (cur && line.trim() === '') {
      flush();
      cur = null;
    } else {
      buf.push(line);
    }
  }
  flush();
  return { segments, endSpeaker: cur };
}

// The active read-mode transform for one already-code-stripped segment.
function applyReadMode(text) {
  if (cfg.readMode === 'dialogue' && !cfg.dialoguePlainText) {
    // Quotes-only: a segment with no "..." dialogue contributes nothing
    // (narration stays silent while the "also read narration" toggle is OFF).
    return capText(extractDialogue(text));
  }
  return capText(stripMarkdown(text));
}

// A voiceValue string (''=default, a built-in name, an http/hf URL, or
// 'clone:<slug>') -> the { kind, ... } descriptor the fetch layer wants.
function voiceValueToDescriptor(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return { kind: 'default' };
  if (isRemoteVoiceUrl(s)) return { kind: 'url', url: s };
  if (s.startsWith('clone:')) {
    const slug = s.slice(6).trim();
    if (slug && clones.some((c) => c.slug === slug)) return { kind: 'clone', slug };
    return { kind: 'default' };
  }
  return { kind: 'builtin', name: s };
}

// Stable auto voice for an unpinned speaker: hash the key into the built-in pool.
function autoVoiceFor(key) {
  const n = parseInt(textHash(String(key || '')), 36);
  const idx = (Number.isFinite(n) ? n : 0) % BUILTIN_VOICES.length;
  return BUILTIN_VOICES[idx];
}

function voiceForSpeaker(speaker, character) {
  if (!speaker) {
    return cfg.narratorVoice ? voiceValueToDescriptor(cfg.narratorVoice) : resolveVoice(character);
  }
  const key = speakerKey(speaker);
  const pinned = cfg.voiceMap && cfg.voiceMap[key];
  if (pinned) return voiceValueToDescriptor(pinned);
  return { kind: 'builtin', name: autoVoiceFor(key) };
}

// Whole message -> [{ speaker, text, voiceDesc }] ready to chunk + enqueue.
// Also feeds every seen speaker into the roster.
function buildSpeechUnits(rawContent, character) {
  const raw = (typeof rawContent === 'string') ? rawContent : '';
  if (!raw) return [];
  const { segments } = splitBySpeaker(stripCodeBlocks(raw), null);
  const units = [];
  let total = 0;
  for (const seg of segments) {
    if (seg.speaker) noteSpeaker(seg.speaker);
    let t = applyReadMode(seg.text);
    if (!t) continue;
    if (total + t.length > MAX_TTS_CHARS) t = t.slice(0, Math.max(0, MAX_TTS_CHARS - total)).trim();
    if (!t) break;
    total += t.length;
    units.push({ speaker: seg.speaker || null, text: t, voiceDesc: voiceForSpeaker(seg.speaker, character) });
  }
  return units;
}

// Replay-cache signature for a multi-voice message: every unit's voice + text.
function speechSignature(units) {
  return [
    'mv1',
    cfg.readMode,
    (cfg.readMode === 'dialogue' && cfg.dialoguePlainText) ? 'dp1' : 'dp0',
    cfg.streamChunks ? 's1' : 's0',
    (units || []).map((u) => voiceDescKey(u.voiceDesc) + ':' + u.text.length + '.' + textHash(u.text)).join('|')
  ].join('~');
}

// Streaming: enqueue `text` (a just-completed slice) as multi-voice units,
// continuing whatever speaker was last in effect. Updates streamSpeaker.
function enqueueMultiVoiceStream(text, character) {
  const { segments, endSpeaker } = splitBySpeaker(text, streamSpeaker);
  for (const seg of segments) {
    if (seg.speaker) noteSpeaker(seg.speaker);
    const t = applyReadMode(seg.text);
    if (!t) continue;
    const vd = voiceForSpeaker(seg.speaker, character);
    for (const c of splitIntoChunks(t)) {
      enqueueUtterance(c, vd, streamTurnId, { epoch: streamEpoch, bag: streamBlobs });
    }
  }
  streamSpeaker = endSpeaker;
}

// ---------------------------------------------------------------- speaker roster

async function loadSpeakers() {
  try {
    const v = await host.storage.get('speakers');
    speakers = Array.isArray(v)
      ? v.filter((s) => s && typeof s.key === 'string' && s.key && typeof s.name === 'string')
      : [];
  } catch (e) {
    speakers = [];
    if (host) host.log('failed to read speakers', e);
  }
  return speakers;
}

function scheduleSpeakersSave() {
  if (speakersSaveTimer) return;
  speakersSaveTimer = setTimeout(() => { speakersSaveTimer = null; saveSpeakersNow(); }, 1200);
}

async function saveSpeakersNow() {
  try {
    await host.storage.set('speakers', speakers.map((s) => ({
      key: s.key,
      name: s.name,
      count: s.count || 1,
      firstSeen: s.firstSeen || Date.now(),
      lastSeen: s.lastSeen || Date.now()
    })));
  } catch (e) {
    if (host) host.log('failed to save speakers', e);
  }
}

function noteSpeaker(name) {
  const key = speakerKey(name);
  if (!key || key.length > 60) return;
  const s = speakers.find((x) => x.key === key);
  if (s) {
    s.count = (s.count || 0) + 1;
    s.lastSeen = Date.now();
  } else {
    speakers.push({ key, name: String(name).trim().slice(0, 60), count: 1, firstSeen: Date.now(), lastSeen: Date.now() });
    refreshCustomSlotIfOpen();
  }
  scheduleSpeakersSave();
}

async function setSpeakerVoice(key, val) {
  const next = { ...(cfg.voiceMap || {}) };
  if (val) next[key] = val; else delete next[key];
  cfg.voiceMap = next;
  try { await host.storage.set('voiceMap', next); } catch (e) { host.log('save voiceMap failed', e); }
}

async function removeSpeaker(key) {
  speakers = speakers.filter((s) => s.key !== key);
  const next = { ...(cfg.voiceMap || {}) };
  delete next[key];
  cfg.voiceMap = next;
  scheduleSpeakersSave();
  try { await host.storage.set('voiceMap', next); } catch (e) { /* ignore */ }
}

async function clearSpeakers() {
  speakers = [];
  cfg.voiceMap = {};
  scheduleSpeakersSave();
  try { await host.storage.set('voiceMap', {}); } catch (e) { /* ignore */ }
}

function refreshCustomSlotIfOpen() {
  const s = lastCustomSlot;
  if (s && s.speakerEl && s.speakerEl.isConnected) {
    try { renderSpeakerVoices(s.speakerEl, s.ctx); } catch (e) { /* ignore */ }
  }
}

function cacheTotalBytes() {
  let t = 0;
  for (const v of audioCache.values()) t += v.bytes || 0;
  return t;
}

function cacheEvict() {
  while (
    audioCache.size > CACHE_MAX_ENTRIES ||
    (audioCache.size > 1 && cacheTotalBytes() > CACHE_MAX_BYTES)
  ) {
    const oldest = audioCache.keys().next().value;
    if (oldest === undefined) break;
    audioCache.delete(oldest);
  }
}

function cacheGet(msgId, sig) {
  if (!msgId) return null;
  const e = audioCache.get(msgId);
  if (!e || e.sig !== sig) return null;
  audioCache.delete(msgId);
  audioCache.set(msgId, e);            // bump recency
  return e.blobs;
}

function cachePut(msgId, sig, blobs) {
  if (!msgId || !Array.isArray(blobs) || !blobs.length) return;
  if (blobs.some((b) => !b || !b.size)) return;   // never cache a partial/empty result
  const bytes = blobs.reduce((s, b) => s + b.size, 0);
  audioCache.delete(msgId);
  audioCache.set(msgId, { sig, blobs: blobs.slice(), bytes });
  cacheEvict();
}

function clearAudioCache() {
  audioCache.clear();
}

// ---------------------------------------------------------------- /tts request

function fetchTTS(text, voiceDesc, outerSignal) {
  const fd = new FormData();
  fd.append('text', text);

  const kind = voiceDesc && voiceDesc.kind;
  let prep;
  if (kind === 'clone') {
    // A clone is uploaded as the `voice_wav` file part — the /tts endpoint
    // rejects a filesystem path in `voice_url`, and never both fields at once.
    prep = host.assets.read(voiceDesc.slug + '.wav').then((ab) => {
      fd.append('voice_wav', new Blob([ab], { type: 'audio/wav' }), voiceDesc.slug + '.wav');
    }, () => {
      const err = new Error('voice clone file "' + voiceDesc.slug + '.wav" could not be read in the plugin directory');
      err._noServer = true;
      throw err;
    });
  } else {
    if (kind === 'url') fd.append('voice_url', voiceDesc.url);
    else if (kind === 'builtin') fd.append('voice_url', voiceDesc.name);
    else fd.append('voice_url', cfg.defaultVoice || DEFAULTS.defaultVoice);
    prep = Promise.resolve();
  }

  // One controller per request. Both the turn's abort (`outerSignal`) and the
  // connect timer feed it; it is ALSO handed back to the caller so the
  // streaming reader can arm its own idle watchdog on the same signal and so a
  // discarded prefetch can be cancelled. The outer-abort listener is left
  // attached through the streaming phase on purpose (a user Stop mid-stream
  // must cancel the body), and is cleaned up when the reader aborts `ctl`.
  const ctl = new AbortController();
  let connectTimedOut = false;
  const onOuterAbort = () => { try { ctl.abort(); } catch (e) { /* ignore */ } };
  if (outerSignal) {
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener('abort', onOuterAbort);
  }
  const connectTimer = setTimeout(() => { connectTimedOut = true; onOuterAbort(); }, TTS_CONNECT_TIMEOUT_MS);

  return prep
    .then(() => host.net.fetch(cfg.serverUrl + '/tts', { method: 'POST', body: fd, signal: ctl.signal }))
    .then(async (res) => {
      clearTimeout(connectTimer);
      if (!res || !res.ok) {
        let body = '';
        if (res) {
          try { body = (await res.text() || '').trim().slice(0, 300); } catch (e) { /* ignore */ }
        }
        const code = res ? res.status : 'no response';
        const err = new Error('server responded ' + code + (body ? ' — ' + body : ''));
        err._http = true;
        throw err;
      }
      return { res, ctl };
    })
    .catch((e) => {
      clearTimeout(connectTimer);
      // A real turn abort (outer signal) stays an AbortError — the consumer
      // treats that as "user stopped, exit now". A connect-timer abort must
      // surface as a plain skippable error instead.
      if (e && e.name === 'AbortError' && !(outerSignal && outerSignal.aborted)) {
        const err = new Error(connectTimedOut
          ? 'TTS server did not respond (' + Math.round(TTS_CONNECT_TIMEOUT_MS / 1000) + 's)'
          : 'TTS request aborted');
        err._timeout = connectTimedOut;
        throw err;
      }
      throw e;
    });
}

// Read a /tts response body progressively, feeding every byte into the shared
// Web Audio scheduler as it arrives (first audio well before the clip is done),
// and collecting the raw bytes into a WAV Blob for the replay cache. An idle
// watchdog aborts a body that stalls with no new data.
async function streamResponseIntoPlayer(got, myEpoch) {
  const res = got.res;
  const ctl = got.ctl;
  const player = ensurePlayer();
  if (!player) throw new Error('audio engine unavailable');
  player.beginClip();

  const parts = [];

  if (!res.body || typeof res.body.getReader !== 'function') {
    // No streaming body available — fall back to a single blob read.
    const ab = await res.arrayBuffer();
    const u = new Uint8Array(ab);
    parts.push(u);
    try { player.feed(u); } catch (e) { host.log('player feed failed', e); }
    player.flush();
  } else {
    const reader = res.body.getReader();
    let idleTimer = null;
    let idleAborted = false;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleAborted = true; try { ctl.abort(); } catch (e) { /* ignore */ } }, TTS_STREAM_IDLE_MS);
    };
    try {
      armIdle();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (myEpoch !== playEpoch) { try { await reader.cancel(); } catch (e) { /* ignore */ } break; }
        if (value && value.length) {
          armIdle();
          parts.push(value);
          try { player.feed(value); } catch (e) { host.log('player feed failed', e); }
        }
      }
    } catch (e) {
      if (idleAborted) {
        const err = new Error('TTS stream stalled (' + Math.round(TTS_STREAM_IDLE_MS / 1000) + 's, no data)');
        err._timeout = true;
        throw err;
      }
      throw e;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      try { player.flush(); } catch (e) { /* ignore */ }
      try { ctl.abort(); } catch (e) { /* ignore */ }   // detach the outer-abort listener
    }
  }

  if (myEpoch !== playEpoch) return null;
  const blob = new Blob(parts, { type: 'audio/wav' });
  return blob.size ? blob : null;
}

// Replay path: feed cached WAV Blobs back through a fresh scheduler, gaplessly.
async function playCachedSequence(blobs, myEpoch) {
  const player = ensurePlayer();
  if (!player) return;
  for (const b of blobs) {
    if (myEpoch !== playEpoch) return;
    if (!b || !b.size) continue;
    player.beginClip();
    try {
      const u = new Uint8Array(await b.arrayBuffer());
      player.feed(u);
      player.flush();
    } catch (e) {
      host.log('cache replay feed failed', e);
    }
  }
  await drainPlayer(myEpoch);
}

// ---------------------------------------------------------------- utterance queue

let lastSynthErrorToast = 0;

function reportSynthError(e, isFirst) {
  // A burst of failures (server down mid-turn) must not toast-spam: one toast
  // per 8s window at most.
  const now = Date.now();
  if (now - lastSynthErrorToast < 8000) return;
  lastSynthErrorToast = now;
  if (e && e._http) {
    host.ui.toast.error('TTS failed: ' + e.message + '. Make sure Pocket TTS is running.');
  } else if (e && e._noServer) {
    host.ui.toast.error('TTS failed: ' + e.message + '.');
  } else if (e && e._timeout) {
    host.ui.toast.error('TTS timed out: ' + (e.message || 'no response') + '.');
  } else if (isFirst) {
    host.ui.toast.error('TTS failed: the Pocket TTS server at ' + cfg.serverUrl + ' is not reachable. Start it with: pocket-tts serve');
  } else {
    host.ui.toast.error('TTS interrupted: ' + (e && e.message ? e.message : 'network error') + '.');
  }
}

function maybeStartConsumer() {
  if (!consumerRunning && utterQueue.length) runConsumer();
}

// Append one sentence to synthesise + play. `opts.epoch` pins it to a playback
// run (defaults to the current epoch); `opts.bag`, if given, collects the synth
// Blob for the replay cache.
function enqueueUtterance(text, voiceDesc, turnId, opts) {
  const o = opts || {};
  const t = String(text == null ? '' : text).trim();
  if (!t) return;
  utterQueue.push({
    text: t,
    voiceDesc,
    turnId,
    epoch: (o.epoch != null ? o.epoch : playEpoch),
    bag: o.bag || null,
    finalize: null
  });
  showStopButton();
  maybeStartConsumer();
}

// Append a zero-audio marker: when the consumer reaches it (all prior utterances
// for this epoch have finished playing) it runs `fn` (which may be async). Used
// to cache a completed run and hide the stop button once the queue drains.
function enqueueFinalize(epoch, fn) {
  utterQueue.push({ finalize: fn, epoch: (epoch != null ? epoch : playEpoch) });
  maybeStartConsumer();
}

// Peek/take the next batch of adjacent queue items that can go in ONE /tts
// request: same epoch, same voice, non-finalize, combined length within
// MAX_REQUEST_CHARS. `mutate` splices them off the queue. Returns
// { text, voiceDesc, turnId, bags } or null when the head isn't a live item.
function nextBatch(mutate) {
  const head = utterQueue[0];
  if (!head || typeof head.finalize === 'function') return null;
  if (head.epoch !== playEpoch) return null;

  let text = head.text;
  const voiceDesc = head.voiceDesc;
  const voiceKey = voiceDescKey(voiceDesc);
  const turnId = head.turnId;
  const bags = head.bag ? [head.bag] : [];
  let i = 1;
  while (i < utterQueue.length) {
    const it = utterQueue[i];
    if (!it || typeof it.finalize === 'function') break;
    if (it.epoch !== playEpoch) break;
    if (voiceDescKey(it.voiceDesc) !== voiceKey) break;
    if (text.length + 1 + it.text.length > MAX_REQUEST_CHARS) break;
    text += '\n' + it.text;
    if (it.bag && bags.indexOf(it.bag) === -1) bags.push(it.bag);
    i++;
  }
  if (mutate) utterQueue.splice(0, i);
  return { text, voiceDesc, turnId, bags };
}

async function runConsumer() {
  if (consumerRunning) return;
  consumerRunning = true;
  const myEpoch = playEpoch;
  let doneCount = 0;
  let prefetch = null;                 // { text, promise } — 1-deep look-ahead request
  try {
    while (utterQueue.length) {
      if (myEpoch !== playEpoch) return;

      // Finalize marker at the head — all prior audio for this epoch has played.
      if (typeof utterQueue[0].finalize === 'function') {
        const f = utterQueue.shift();
        if (f.epoch === playEpoch && typeof f.finalize === 'function') {
          try { await f.finalize(); } catch (e) { host.log('finalize failed', e); }
        }
        prefetch = null;
        continue;
      }

      const batch = nextBatch(true);
      if (!batch) { utterQueue.shift(); prefetch = null; continue; }   // stale head

      const signal = activeAbort ? activeAbort.signal : undefined;

      // --- obtain the response (reuse a matching prefetch, else fetch now) ---
      let got;
      try {
        if (prefetch && prefetch.text === batch.text) {
          got = await prefetch.promise;
        } else {
          if (prefetch) prefetch.promise.then((g) => { try { g.ctl.abort(); } catch (e) { /* ignore */ } }, () => {});
          got = await fetchTTS(batch.text, batch.voiceDesc, signal);
        }
      } catch (e) {
        prefetch = null;
        if (e && e.name === 'AbortError' && signal && signal.aborted) return;   // user stop
        if (myEpoch !== playEpoch) return;
        host.log('TTS request failed — skipping this batch, moving on', e);
        reportSynthError(e, doneCount === 0);
        for (const b of batch.bags) b.push(null);   // poison the replay bag
        doneCount++;
        continue;
      }
      prefetch = null;
      if (myEpoch !== playEpoch) { try { got.ctl.abort(); } catch (e) { /* ignore */ } return; }

      // --- kick the next batch's request BEFORE streaming this one (overlap) ---
      const peek = nextBatch(false);
      if (peek) {
        const pr = fetchTTS(peek.text, peek.voiceDesc, signal);
        pr.catch(() => {});
        prefetch = { text: peek.text, promise: pr };
      }

      // --- stream this batch's audio into the shared gapless scheduler ---
      let blob = null;
      try {
        blob = await streamResponseIntoPlayer(got, myEpoch);
      } catch (e) {
        if (e && e.name === 'AbortError' && signal && signal.aborted) return;
        if (myEpoch !== playEpoch) return;
        host.log('TTS stream failed — skipping this batch, moving on', e);
        reportSynthError(e, doneCount === 0);
        for (const b of batch.bags) b.push(null);
        doneCount++;
        continue;
      }
      if (myEpoch !== playEpoch) return;
      for (const b of batch.bags) b.push(blob || null);

      // --- pace: don't let synth run more than SCHED_AHEAD_SEC ahead of the
      //     speaker, so a Stop wastes little work and memory stays bounded ---
      while (myEpoch === playEpoch && wavPlayer && !wavPlayer._closed && wavPlayer.scheduledEndsIn > SCHED_AHEAD_SEC) {
        await sleep(150);
      }
      doneCount++;
    }
  } finally {
    consumerRunning = false;
    // More arrived (streaming) while we were finishing the last item.
    if (utterQueue.length && playEpoch === myEpoch) maybeStartConsumer();
  }
}

// ---------------------------------------------------------------- speak

// Multi-voice twin of speak(): one whole message, split into per-speaker units,
// each unit's chunks enqueued with that speaker's own voice. Kept a separate
// function so the single-voice path below is byte-for-byte unchanged.
async function speakMultiVoice(message, character) {
  const raw = (message && typeof message.content === 'string') ? message.content : '';
  const units = buildSpeechUnits(raw, character);
  if (!units.length) return;

  if (cfg.stopOnNew) stopAudio();

  const msgId = (message && message.id != null) ? String(message.id) : '';
  const myEpoch = ++playEpoch;
  utterQueue = [];
  activeAbort = new AbortController();
  currentMessageId = msgId || null;
  showStopButton();
  if (myEpoch !== playEpoch) return;

  const sig = speechSignature(units);

  const hit = cacheGet(msgId, sig);
  if (hit && hit.length) {
    host.log('TTS multi-voice | cache hit (' + hit.length + ' clip)');
    try { await playCachedSequence(hit, myEpoch); }
    finally { if (myEpoch === playEpoch) endPlayback(); }
    return;
  }

  host.log('TTS multi-voice ->', units.map((u) => (u.speaker || 'narration') + '=' + describeVoice(u.voiceDesc)).join(' | '));

  const bag = [];
  for (const u of units) {
    const chunks = cfg.streamChunks ? splitIntoChunks(u.text) : [u.text];
    for (const c of chunks) enqueueUtterance(c, u.voiceDesc, myEpoch, { epoch: myEpoch, bag });
  }
  enqueueFinalize(myEpoch, async () => {
    await drainPlayer(myEpoch);
    if (myEpoch !== playEpoch) return;
    if (bag.length && bag.indexOf(null) === -1) cachePut(msgId, sig, bag);
    endPlayback();
  });
}

// Whole-message playback: manual replay button, and the autoplay fallback when
// the streaming path did not engage. Feeds every chunk through the shared queue
// under one fresh epoch; a trailing finalize marker writes the replay cache
// once they've all synthesised + played.
async function speak(message, character) {
  if (cfg.multiVoiceEnabled) return speakMultiVoice(message, character);

  const text = extractText(message);
  if (!text) return;

  if (cfg.stopOnNew) stopAudio();

  const msgId = (message && message.id != null) ? String(message.id) : '';
  const myEpoch = ++playEpoch;
  utterQueue = [];                     // anything left from a prior epoch is stale
  activeAbort = new AbortController();
  currentMessageId = msgId || null;
  showStopButton();                    // show early — synth may lag before first audio

  const voiceDesc = resolveVoice(character);
  if (myEpoch !== playEpoch) return;

  const chunks = cfg.streamChunks ? splitIntoChunks(text) : [text];
  if (!chunks.length) { if (myEpoch === playEpoch) endPlayback(); return; }

  const sig = cacheSignature(voiceDesc, text);

  // ---- cache hit: replay the stored Blobs, no server round-trips ----
  const hit = cacheGet(msgId, sig);
  if (hit && hit.length) {
    host.log('TTS voice ->', describeVoice(voiceDesc), '| cache hit (' + hit.length + ' clip)');
    try {
      await playCachedSequence(hit, myEpoch);
    } finally {
      if (myEpoch === playEpoch) endPlayback();
    }
    return;
  }

  host.log('TTS voice ->', describeVoice(voiceDesc));

  const bag = [];
  for (const c of chunks) enqueueUtterance(c, voiceDesc, myEpoch, { epoch: myEpoch, bag });
  enqueueFinalize(myEpoch, async () => {
    await drainPlayer(myEpoch);
    if (myEpoch !== playEpoch) return;
    if (bag.length && bag.indexOf(null) === -1) cachePut(msgId, sig, bag);
    endPlayback();
  });
}

// ---------------------------------------------------------------- speak while streaming

// There is deliberately NO turn-level idle timeout in the streaming path. The
// old 15s/120s watchdog kept killing the TTS mid-turn whenever a long stretch
// produced no content chunks — slow tool calls, tool-permission prompts
// (a single wedged /tts request IS still bounded — TTS_CONNECT_TIMEOUT_MS and
// TTS_STREAM_IDLE_MS in fetchTTS/streamResponseIntoPlayer — but that only
// skips that one batch, it never ends the turn).
// waiting for the user, long "thinking" pauses (thinking chunks fire no
// content events at all). A turn now ends ONLY through explicit signals:
// `assistant-message-complete`, `assistant-generation-ended` (chatView emits
// it on user abort / hard error — paths that never emit `complete`),
// `user-message-sent` / `assistant-generation-started` (next turn), a user
// stop, `chat-closed`, or deactivate.

function resetStreamTurn() {
  streamTurnId++;
  streamGateEvaluated = false;
  streamActive = false;
  streamAbandoned = false;
  streamStoppedByUser = false;
  streamTurnEnded = false;
  streamSpokenLen = 0;
  streamVoiceDesc = null;
  streamBlobs = [];
  streamEpoch = 0;
  streamChar = null;
  streamSpeaker = null;
}

// Index (exclusive) up to which `s` is made only of finished sentences: the
// char right after the last "terminator + closing quote/paren? + whitespace",
// or the whole length if `s` ends on a terminator with no trailing space.
function lastSafeBoundary(s) {
  let idx = -1;
  const re = /[.!?…]+["'’\)\]]?\s|\n/g;
  let m;
  while ((m = re.exec(s))) idx = re.lastIndex;
  if (/[.!?…]+["'’\)\]]?\s*$/.test(s)) idx = s.length;
  return idx;
}

// From the not-yet-spoken tail, pull the sentences whose end boundary is
// certain, leaving any half-typed final sentence for the next chunk. Returns
// the merged chunk list + how many chars of `pending` they consumed.
function takeCompleteSentences(pending) {
  const cut = lastSafeBoundary(pending);
  if (cut <= 0) return { sentences: [], consumed: 0 };
  return { sentences: splitIntoChunks(pending.slice(0, cut)), consumed: cut };
}

// Fires (throttled ~50ms) from chatView's streaming renderer with the full
// accumulated assistant text so far.
async function onAssistantChunk(payload) {
  const p = payload || {};
  // A new turn is marked ONLY by an explicit signal: `user-message-sent` /
  // `assistant-generation-started` (both fire resetStreamTurn() before the
  // first chunk of every generation entry point), `assistant-message-complete`,
  // `assistant-generation-ended`, `chat-closed`, or a user stop.
  //
  // There used to be an extra "fullText shrank vs streamSpokenLen" guess here
  // that also flipped streamTurnEnded. It MISFIRED mid-turn: on a multi-round
  // tool turn chatView reseeds its live buffer to AgentRunner's re-joined
  // `content` at every round boundary, and that can come back a few chars
  // SHORTER than what we already spoke (joinParts() drops a whitespace-only
  // round, round-1 <think>/prefill re-split, provider-final vs streamed delta
  // diff). The false "new turn" then made the very next chunk call stopAudio()
  // and restart reading the whole reply from the top — the random mid-reply
  // TTS cutout on long, tool-heavy generations.
  if (streamTurnEnded) resetStreamTurn();   // previous turn wrapped up — this chunk starts a new one

  if (!streamGateEvaluated) {
    streamGateEvaluated = true;

    // 'dialogue' read mode streams too now: extractStreamText() there yields
    // only the text of quotes that have already CLOSED, which still grows
    // monotonically, so the same streamSpokenLen bookkeeping works. A quote is
    // simply read one chunk later — the moment its closing " arrives.
    const applies = cfg.autoplay && cfg.speakWhileStreaming && cfg.streamChunks;
    if (!applies) { streamActive = false; return; }

    const ch = await freshCharacter(p.character || null);
    // A reset, or a very fast `assistant-message-complete` that already took the
    // whole-message path, raced in while we awaited — don't also start streaming.
    if (streamGateEvaluated === false || streamTurnEnded) { streamActive = false; return; }
    if (!voiceEnabledFor(ch)) { streamActive = false; return; }

    if (cfg.stopOnNew) stopAudio();
    streamEpoch = ++playEpoch;
    utterQueue = [];
    activeAbort = new AbortController();
    streamStoppedByUser = false;
    streamAbandoned = false;
    streamSpokenLen = 0;
    streamBlobs = [];
    streamVoiceDesc = resolveVoice(ch);
    streamChar = ch;
    streamSpeaker = null;
    currentMessageId = (p.messageId != null) ? String(p.messageId) : null;
    streamActive = true;
    showStopButton();
    host.log('TTS streaming voice ->', cfg.multiVoiceEnabled ? 'multi-voice' : describeVoice(streamVoiceDesc));
  }

  if (streamStoppedByUser || streamAbandoned) return;
  if (!streamActive) return;
  if (streamEpoch !== playEpoch) { streamActive = false; return; }

  // ---- multi-voice: work on the raw (code-stripped) text so "Name:" prefixes
  //      stay visible. Consume whole lines freely; within the trailing partial
  //      line, sentence-split only once its "Name:" prefix (if any) has fully
  //      arrived — never mid-name. ----
  if (cfg.multiVoiceEnabled) {
    const raw = stripCodeBlocks(p.fullText || '');
    if (raw.length <= streamSpokenLen) return;
    const pending = raw.slice(streamSpokenLen);

    let cut = pending.lastIndexOf('\n') + 1;      // whole lines are always safe (0 if none yet)
    const tail = pending.slice(cut);
    const pm = tail.match(SPEAKER_PREFIX_RE);
    if (pm) {
      // Prefix complete — sentence-split only the part AFTER it.
      const afterPrefix = tail.slice(pm[0].length);
      const extra = lastSafeBoundary(afterPrefix);
      if (extra > 0) cut += pm[0].length + extra;
    } else if (!SPEAKER_NAME_PARTIAL_RE.test(tail)) {
      // Not a name-in-progress — ordinary prose, sentence-split it.
      const extra = lastSafeBoundary(tail);
      if (extra > 0) cut += extra;
    }
    // else: a name is still being typed on this line — wait for the rest.

    if (cut <= 0) return;
    enqueueMultiVoiceStream(pending.slice(0, cut), streamChar);
    streamSpokenLen += cut;
    return;
  }

  const full = extractStreamText(p.fullText || '');
  if (full.length <= streamSpokenLen) return;

  const { sentences, consumed } = takeCompleteSentences(full.slice(streamSpokenLen));
  if (!consumed) return;
  for (const s of sentences) {
    enqueueUtterance(s, streamVoiceDesc, streamTurnId, { epoch: streamEpoch, bag: streamBlobs });
  }
  streamSpokenLen += consumed;
}

// ---------------------------------------------------------------- settings UI
//
// Declarative: host.ui.registerSettings(schema) renders + persists every field
// to host.storage under `field.key` (the same keys loadConfig() reads on
// activate). No DOM code for the plain fields. `onChange` keeps the in-memory
// `cfg` live; `custom` hosts the voice-clone library (dynamic list + file
// upload, which a flat field can't express).

const BTN_STYLE =
  'padding:0.45rem 0.85rem;background:var(--bg-surface);color:var(--accent-primary);' +
  'border:1px solid var(--border-light);border-radius:var(--radius-md);font:inherit;font-weight:600;cursor:pointer;';
const HELP_STYLE = 'font-size:0.78rem;color:var(--text-dim);line-height:1.45;';

function el(tag, opts) {
  const o = opts || {};
  const node = document.createElement(tag);
  const style = o.style;
  const children = o.children;
  delete o.style;
  delete o.children;
  Object.assign(node, o);
  if (style) node.style.cssText = style;
  const list = Array.isArray(children) ? children : (children == null ? [] : [children]);
  for (const c of list) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function buildSettingsSchema() {
  return {
    title: 'Voice',
    sections: [
      {
        description:
          'The Pocket TTS server runs separately (pip install pocket-tts, then pocket-tts serve). ' +
          'This plugin is only an HTTP client and never starts it. See github.com/kyutai-labs/pocket-tts.',
        fields: [
          { key: 'serverUrl', type: 'text', label: 'Server URL', default: DEFAULTS.serverUrl, placeholder: DEFAULTS.serverUrl, help: 'Where the Pocket TTS server listens.' }
        ]
      },
      {
        title: 'Playback',
        fields: [
          { key: 'autoplay', type: 'toggle', label: 'Play automatically when a character reply finishes', default: DEFAULTS.autoplay, help: 'When off, voice only plays via the button on each message.' },
          { key: 'streamChunks', type: 'toggle', label: 'Play sentence by sentence (start sooner)', default: DEFAULTS.streamChunks, help: 'The reply is read in sentence batches and each /tts response is streamed straight into playback, gaplessly. Turn off to synthesise the whole reply as one request.' },
          { key: 'speakWhileStreaming', type: 'toggle', label: 'Read while the response is still streaming', default: DEFAULTS.speakWhileStreaming, help: 'Start reading each sentence (or each closed quote, in dialogue mode) as soon as it is finished, without waiting for the whole reply. Needs "Play automatically" + "Play sentence by sentence" on.' },
          { key: 'readMode', type: 'select', label: 'Read mode', default: DEFAULTS.readMode, options: [{ value: 'full', label: 'Whole reply text' }, { value: 'dialogue', label: 'Only dialogue inside quotes' }], help: 'Fenced code blocks (``` ... ```) are never read aloud in either mode. In dialogue mode, a reply with no "..." quotes is skipped (silent) unless you turn on "also read narration" below.' },
          { key: 'dialoguePlainText', type: 'toggle', label: 'Dialogue mode: also read narration outside the quotes', default: DEFAULTS.dialoguePlainText, help: 'Only applies when Read mode is "Only dialogue inside quotes". Off (default): read ONLY the quoted dialogue — narration and **bold** action text are not read, and a reply with no quotes stays silent. On: read the whole reply, narration included.' },
          { key: 'stopOnNew', type: 'toggle', label: 'Stop the currently playing audio when a new reply arrives', default: DEFAULTS.stopOnNew },
          { key: 'defaultVoice', type: 'select', label: 'Default voice', default: DEFAULTS.defaultVoice, options: BUILTIN_VOICES.map((v) => ({ value: v, label: v })), help: BUILTIN_VOICES.length + ' built-in Pocket TTS voices. Used when a character has not picked its own.' }
        ]
      },
      {
        title: 'Multi-voice (experimental)',
        description:
          'Detect "Name:" speaker prefixes in a reply (e.g. Mr. Wolf: "...you delete your copy. Deal?") and give each speaker their own voice. ' +
          'Speakers are collected automatically as the conversation goes; pin a voice per speaker (or add one by hand) in the list below the clone library. ' +
          'An unpinned speaker gets a stable auto voice. Text with no "Name:" prefix is narration.',
        fields: [
          { key: 'multiVoiceEnabled', type: 'toggle', label: 'Enable multi-voice', default: DEFAULTS.multiVoiceEnabled, help: 'Off = the whole reply is read in the character\'s single voice, exactly as before.' },
          { key: 'narratorVoice', type: 'select', label: 'Narrator / unattributed voice', default: DEFAULTS.narratorVoice, options: [{ value: '', label: '(use the character\'s own voice)' }].concat(BUILTIN_VOICES.map((v) => ({ value: v, label: v }))).concat(clones.map((c) => ({ value: 'clone:' + c.slug, label: 'Clone: ' + c.name }))), help: 'Voice for text that has no "Name:" prefix, when multi-voice is on.' }
        ]
      }
    ],
    actions: [
      { id: 'test', label: 'Test connection', onClick: testConnection }
    ],
    custom: renderCustomSlot,
    onChange: (key, value) => {
      cfg[key] = key === 'serverUrl'
        ? (String(value || '').trim().replace(/\/+$/, '') || DEFAULTS.serverUrl)
        : value;
    }
  };
}

async function testConnection(ctx) {
  const base = String(ctx.get('serverUrl') || cfg.serverUrl || DEFAULTS.serverUrl).trim().replace(/\/+$/, '');
  try {
    const r = await host.net.fetch(base + '/health', { method: 'GET' });
    const j = await r.json().catch(() => null);
    if (r.ok && j && j.status === 'healthy') host.ui.toast.success('Pocket TTS server is up (healthy).');
    else host.ui.toast.error('Server responded but is not healthy (HTTP ' + (r ? r.status : '?') + ').');
  } catch (e) {
    host.ui.toast.error('Cannot connect to ' + base + '. Start it with: pocket-tts serve');
  }
}

// The schema's single `custom` slot hosts two independent sub-panels: the
// voice-clone library and (for multi-voice) the speaker->voice map.
function renderCustomSlot(slot, ctx) {
  slot.innerHTML = '';
  const cloneEl = el('div');
  slot.appendChild(cloneEl);
  renderCloneLibrary(cloneEl, ctx);
  const speakerEl = el('div');
  slot.appendChild(speakerEl);
  lastCustomSlot = { speakerEl, ctx };
  renderSpeakerVoices(speakerEl, ctx);
}

// The speaker->voice map editor: one row per detected speaker (name + voice
// picker + remove), an "add manually" row, and "clear all". Re-renders itself
// in place after a change. `noteSpeaker()` refreshes it live via
// `refreshCustomSlotIfOpen()` when a brand-new speaker appears mid-chat.
function renderSpeakerVoices(box, ctx) {
  box.innerHTML = '';
  const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:0.55rem;border-top:1px solid var(--border-light);padding-top:1rem;margin-top:1rem;' });
  wrap.appendChild(el('div', {
    textContent: 'Speaker voices' + (cfg.multiVoiceEnabled ? '' : '  (multi-voice is off)'),
    style: 'font-size:0.9rem;font-weight:700;color:var(--text-main);'
  }));
  wrap.appendChild(el('div', {
    textContent: 'Auto-detected from "Name:" lines during the conversation. Pick a voice to pin it; "Auto" hashes the name to a stable built-in voice. You can also add a speaker before it appears.',
    style: HELP_STYLE
  }));

  const optionList = (autoLabel) =>
    [{ v: '', label: autoLabel }]
      .concat(BUILTIN_VOICES.map((n) => ({ v: n, label: n })))
      .concat(clones.map((c) => ({ v: 'clone:' + c.slug, label: 'Clone: ' + c.name })));

  const selStyle = 'font:inherit;padding:0.25rem 0.4rem;border:1px solid var(--border-light);border-radius:var(--radius-sm);background:var(--bg-app,var(--bg-surface));color:var(--text-main);max-width:170px;';
  const inputStyle = 'flex:1;min-width:0;font:inherit;padding:0.35rem 0.5rem;border:1px solid var(--border-light);border-radius:var(--radius-sm);background:var(--bg-app,var(--bg-surface));color:var(--text-main);';

  const sorted = speakers.slice().sort((a, b) =>
    (b.count || 0) - (a.count || 0) || String(a.name).localeCompare(String(b.name)));

  if (!sorted.length) {
    wrap.appendChild(el('div', { textContent: 'No speakers detected yet.', style: HELP_STYLE }));
  }
  for (const sp of sorted) {
    const key = sp.key;
    const row = el('div', {
      style: 'display:flex;align-items:center;gap:0.5rem;padding:0.35rem 0.5rem;border:1px solid var(--border-light);border-radius:var(--radius-md);background:var(--bg-surface);'
    });
    row.appendChild(el('span', {
      textContent: sp.name,
      title: sp.name + '  (' + (sp.count || 1) + '×)',
      style: 'flex:1;min-width:0;font-size:0.85rem;color:var(--text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
    }));
    const sel = el('select', { style: selStyle });
    for (const o of optionList('Auto (' + autoVoiceFor(key) + ')')) {
      sel.appendChild(el('option', { value: o.v, textContent: o.label }));
    }
    sel.value = (cfg.voiceMap && cfg.voiceMap[key]) || '';
    sel.addEventListener('change', () => { setSpeakerVoice(key, sel.value); });
    row.appendChild(sel);
    const del = el('button', {
      type: 'button', textContent: '×', title: 'Remove this speaker',
      style: BTN_STYLE + 'color:var(--accent-rose);padding:0.15rem 0.55rem;line-height:1;font-size:1rem;'
    });
    del.addEventListener('click', () => { removeSpeaker(key); renderSpeakerVoices(box, ctx); });
    row.appendChild(del);
    wrap.appendChild(row);
  }

  const addRow = el('div', { style: 'display:flex;gap:0.5rem;align-items:center;margin-top:0.15rem;' });
  const nameInput = el('input', { type: 'text', placeholder: 'Add a speaker name…', style: inputStyle });
  const addBtn = el('button', { type: 'button', textContent: 'Add', style: BTN_STYLE });
  const doAdd = () => {
    const n = nameInput.value.trim();
    if (!n) return;
    noteSpeaker(n);
    nameInput.value = '';
    renderSpeakerVoices(box, ctx);
  };
  addBtn.addEventListener('click', doAdd);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
  addRow.appendChild(nameInput);
  addRow.appendChild(addBtn);
  wrap.appendChild(addRow);

  if (sorted.length) {
    const clearBtn = el('button', {
      type: 'button', textContent: 'Clear all speakers',
      style: BTN_STYLE + 'color:var(--accent-rose);align-self:flex-start;'
    });
    clearBtn.addEventListener('click', () => { clearSpeakers(); renderSpeakerVoices(box, ctx); });
    wrap.appendChild(clearBtn);
  }

  box.appendChild(wrap);
}

// Escape-hatch DOM slot for the schema: the voice-clone library (file upload +
// dynamic list). Re-renders itself in place after an add/delete.
function renderCloneLibrary(slot, ctx) {
  slot.innerHTML = '';
  const box = el('div', { style: 'display:flex;flex-direction:column;gap:0.6rem;border-top:1px solid var(--border-light);padding-top:1rem;' });
  box.appendChild(el('div', { textContent: 'Voice clone', style: 'font-size:0.9rem;font-weight:700;color:var(--text-main);' }));
  box.appendChild(el('div', {
    textContent: 'Upload a .wav file (mono, ~10-20s). Stored in the plugin data dir, then offered as a "Clone: ..." option in each character\'s Voice field and sent to the server as the voice_wav part.',
    style: HELP_STYLE
  }));

  const fileInput = el('input', { type: 'file', accept: '.wav,audio/wav,audio/x-wav', style: 'display:none;' });
  const uploadBtn = el('button', { type: 'button', textContent: 'Upload .wav', style: BTN_STYLE });
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    uploadBtn.disabled = true;
    await addClone(f);
    uploadBtn.disabled = false;
    renderCloneLibrary(slot, ctx);
  });
  box.appendChild(el('div', { style: 'display:flex;gap:0.5rem;align-items:center;', children: [uploadBtn, fileInput] }));

  if (!clones.length) {
    box.appendChild(el('div', { textContent: 'No voice clones yet.', style: HELP_STYLE }));
  } else {
    for (const c of clones) {
      const row = el('div', {
        style: 'display:flex;align-items:center;gap:0.6rem;padding:0.4rem 0.55rem;border:1px solid var(--border-light);border-radius:var(--radius-md);background:var(--bg-surface);'
      });
      row.appendChild(el('span', {
        textContent: c.name + '  (' + c.slug + '.wav)',
        style: 'flex:1;font-size:0.85rem;color:var(--text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
      }));
      const del = el('button', { type: 'button', textContent: 'Delete', style: BTN_STYLE + 'color:var(--accent-rose);padding:0.3rem 0.65rem;' });
      del.addEventListener('click', async () => { del.disabled = true; await removeClone(c.slug); renderCloneLibrary(slot, ctx); });
      row.appendChild(del);
      box.appendChild(row);
    }
  }
  slot.appendChild(box);
}

// ---------------------------------------------------------------- icons

const SPEAKER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">' +
  '<path d="M4 7.75A1.75 1.75 0 0 1 5.75 6h1.4l3.2-2.82A1 1 0 0 1 12 3.93v12.14a1 1 0 0 1-1.65.76L7.15 14h-1.4A1.75 1.75 0 0 1 4 12.25v-4.5Z"/>' +
  '<path d="M14.02 6.34a1 1 0 0 1 1.41.06 5.5 5.5 0 0 1 0 7.2 1 1 0 1 1-1.47-1.35 3.5 3.5 0 0 0 0-4.5 1 1 0 0 1 .06-1.41Z"/>' +
  '<path d="M16.1 3.9a1 1 0 0 1 1.42.02 9 9 0 0 1 0 12.16 1 1 0 1 1-1.44-1.38 7 7 0 0 0 0-9.4 1 1 0 0 1 .02-1.4Z"/>' +
  '</svg>';

const STOP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">' +
  '<rect x="5" y="5" width="10" height="10" rx="2"/>' +
  '</svg>';

// ---------------------------------------------------------------- char fields

function registerCharFields() {
  if (typeof charFieldDisposer === 'function') {
    try { charFieldDisposer(); } catch (e) { /* ignore */ }
    charFieldDisposer = null;
  }
  const voiceOptions = [{ value: '', label: '(use plugin default)' }]
    .concat(BUILTIN_VOICES.map((v) => ({ value: v, label: v })))
    .concat(clones.map((c) => ({ value: 'clone:' + c.slug, label: 'Clone: ' + c.name })));

  charFieldDisposer = host.ui.registerCharacterFields([
    {
      key: 'voiceId',
      label: 'Voice (Pocket TTS)',
      type: 'select',
      options: voiceOptions,
      help: 'A built-in Pocket TTS voice, or one of the voice clones uploaded in the Voice tab.'
    },
    {
      key: 'muted',
      label: 'Mute voice for this character',
      type: 'toggle',
      default: false,
      help: 'Leave off so this character has a voice. Turn on only when you want a specific character not to be read aloud.'
    }
  ]);
}

// ---------------------------------------------------------------- lifecycle

export async function activate(pluginHost) {
  host = pluginHost;

  if (host.apiVersion !== '1.0') {
    host.log('warning: unknown host apiVersion:', host.apiVersion);
  }

  cfg = await loadConfig();
  await loadClones();
  await loadSpeakers();

  registerCharFields();

  // Declarative settings — the host renders + persists them and shows them as a
  // subtab in the Plugins view. The plugin writes no settings DOM (except the
  // clone-library escape-hatch slot).
  if (typeof host.ui.registerSettings === 'function') {
    disposers.push(host.ui.registerSettings(buildSettingsSchema()));
  } else {
    host.log('host has no ui.registerSettings — settings UI unavailable');
  }

  // Per-message button — doubles as a stop toggle while ITS OWN message plays.
  disposers.push(host.ui.registerMessageAction({
    id: 'play',
    icon: SPEAKER_SVG,
    title: 'Play voice',
    visible: (msg) => !!msg && msg.role === 'assistant',
    onClick: async (msg, ctx) => {
      // Doubles as a stop toggle ONLY while this message's run is actually
      // live (synthesising or playing). A stale `currentMessageId` left over
      // from an aborted run must not make the button silently stop instead
      // of playing — hence the runLive guard alongside the id match.
      const runLive = (wavPlayer != null && !wavPlayer._closed && wavPlayer.scheduledEndsIn > 0.05)
        || consumerRunning || utterQueue.length > 0;
      if (msg && runLive && currentMessageId != null && String(msg.id) === String(currentMessageId)) {
        stopAudio(true);
        return;
      }
      // Explicit replay ignores the per-character mute on purpose.
      const ch = await freshCharacter((ctx && ctx.character) || null);
      await speak(msg, ch);
    }
  }));

  // The global stop control is a small plugin-owned button (see
  // ensureStopButton / showStopButton) parked next to the model picker inside
  // `.chat-toolbar-left-group`, visible only while a playback/synth run is
  // live. chatView renders composer buttons once with no live refresh, so a
  // registerComposerButton toggle could never work here.

  // New user turn: forget the previous turn's streaming state. Don't touch
  // audio here — the previous turn's tail may still be legitimately playing;
  // stopOnNew handling happens on the first chunk that passes the gate.
  disposers.push(host.events.on('user-message-sent', () => {
    resetStreamTurn();
  }));

  // Regenerate/swipe generations never fire `user-message-sent` (chatView only
  // emits it from the send flow), so this new-turn mark is what re-arms the
  // streaming gate after a regenerate — otherwise `streamGateEvaluated` stays
  // true from the previous turn and the stale `streamStoppedByUser`/
  // `streamAbandoned`/`streamSpokenLen` swallow every chunk silently.
  disposers.push(host.events.on('assistant-generation-started', () => {
    resetStreamTurn();
  }));

  // Fired ~50ms-throttled from chatView's streaming renderer. Reads each
  // just-finished sentence aloud without waiting for the whole reply.
  disposers.push(host.events.on('assistant-message-chunk', (payload) => {
    onAssistantChunk(payload).catch((e) => host.log('streaming chunk failed', e));
  }));

  // chatView emits this when a generation dies without a complete event —
  // the user aborted, or the request errored (chatView never emits
  // `assistant-message-complete` on those paths). The event-driven end-of-turn
  // mark that replaces the old idle watchdog: nothing here times out, a
  // streaming turn runs until one of these explicit signals arrives. Whatever
  // is already queued still finishes playing; a partial turn is never cached.
  disposers.push(host.events.on('assistant-generation-ended', () => {
    if (!streamGateEvaluated || streamTurnEnded) return;
    streamActive = false;
    streamAbandoned = true;
    streamBlobs = [];
    const ep = streamEpoch;
    if (ep === playEpoch) enqueueFinalize(ep, async () => { await drainPlayer(ep); endPlayback(); });
  }));

  disposers.push(host.events.on('assistant-message-complete', async ({ character, message }) => {
    try {
      // ---- streaming path owned (or attempted) this turn ----
      if (streamGateEvaluated && (streamActive || streamAbandoned || streamStoppedByUser)) {
        if (streamActive && !streamAbandoned && !streamStoppedByUser && streamEpoch === playEpoch) {
          // ---- multi-voice: flush the unread tail, cache under a speech
          //      signature that a later speakMultiVoice() replay will match. ----
          if (cfg.multiVoiceEnabled) {
            const chMV = streamChar || character;
            const rawContentMV = (message && message.content) || '';
            const finalRawMV = stripCodeBlocks(rawContentMV);
            const tailMV = finalRawMV.slice(streamSpokenLen);
            const msgIdMV = (message && message.id != null) ? String(message.id) : '';
            if (msgIdMV) currentMessageId = msgIdMV;
            if (tailMV.trim()) enqueueMultiVoiceStream(tailMV, chMV);
            streamSpokenLen = finalRawMV.length;
            const sigMV = speechSignature(buildSpeechUnits(rawContentMV, chMV));
            const bagMV = streamBlobs;
            const epMV = streamEpoch;
            enqueueFinalize(epMV, async () => {
              await drainPlayer(epMV);
              if (msgIdMV && bagMV.length && bagMV.indexOf(null) === -1 && !streamAbandoned) cachePut(msgIdMV, sigMV, bagMV);
              endPlayback();
            });
            streamActive = false;
            streamTurnEnded = true;
            return;
          }

          const finalFull = extractStreamText((message && message.content) || '');

          // Dialogue mode, narration off, and the finished reply had NO quotes
          // at all — nothing to read. The "also read narration outside the
          // quotes" toggle is OFF, so we deliberately stay SILENT rather than
          // fall back to reading the whole reply (that fallback was the
          // reported "still reads the **narration**" bug).
          if (!finalFull && streamSpokenLen === 0 && !streamBlobs.length
              && cfg.readMode === 'dialogue' && !cfg.dialoguePlainText) {
            streamActive = false;
            streamTurnEnded = true;
            endPlayback();
            return;
          }

          const tail = finalFull.slice(streamSpokenLen);
          const tailChunks = tail.trim() ? splitIntoChunks(tail) : [];
          const msgId = (message && message.id != null) ? String(message.id) : '';
          if (msgId) currentMessageId = msgId;   // per-message stop toggle now targets the real record
          const sig = cacheSignature(streamVoiceDesc, finalFull);
          const bag = streamBlobs;
          const ep = streamEpoch;
          for (const c of tailChunks) {
            enqueueUtterance(c, streamVoiceDesc, streamTurnId, { epoch: ep, bag });
          }
          enqueueFinalize(ep, async () => {
            await drainPlayer(ep);
            // Cache the streamed turn under the SAME signature a whole-message
            // speak() would use, so a later manual replay is an instant hit.
            if (msgId && bag.length && bag.indexOf(null) === -1 && !streamAbandoned) cachePut(msgId, sig, bag);
            endPlayback();
          });
          streamSpokenLen = finalFull.length;
        } else {
          endPlayback();
        }
        streamActive = false;
        streamTurnEnded = true;
        return;                          // never ALSO speak() — that's the double-audio bug
      }

      // ---- streaming path did not engage: normal whole-message autoplay ----
      streamTurnEnded = true;
      if (!cfg.autoplay) return;
      const ch = await freshCharacter(character);
      if (!voiceEnabledFor(ch)) return;
      await speak(message, ch);
    } catch (e) {
      host.log('autoplay failed', e);
    }
  }));

  disposers.push(host.events.on('chat-closed', () => {
    stopAudio();
    resetStreamTurn();
    clearAudioCache();
  }));

  host.log('Pocket TTS Voice active. Server:', cfg.serverUrl, '| clones:', clones.length);
}

export function deactivate() {
  stopAudio();
  resetStreamTurn();
  utterQueue = [];
  clearAudioCache();
  if (speakersSaveTimer) { clearTimeout(speakersSaveTimer); speakersSaveTimer = null; saveSpeakersNow(); }
  lastCustomSlot = null;
  if (stopBtnEl) {
    try { stopBtnEl.remove(); } catch (e) { /* ignore */ }
    stopBtnEl = null;
  }
  if (stopBtnStyleEl) {
    try { stopBtnStyleEl.remove(); } catch (e) { /* ignore */ }
    stopBtnStyleEl = null;
  }
  if (typeof charFieldDisposer === 'function') {
    try { charFieldDisposer(); } catch (e) { /* ignore */ }
    charFieldDisposer = null;
  }
  while (disposers.length) {
    const d = disposers.pop();
    try { if (typeof d === 'function') d(); } catch (e) { if (host) host.log('dispose failed', e); }
  }
}

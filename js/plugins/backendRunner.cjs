'use strict';

/* =====================================================================
 * NnzRP plugin backend runner.
 *
 * SHIPPED BY THE APP - this file is NOT part of any plugin. main.js
 * fork()s it (one child per running plugin backend) with:
 *   argv[2] = absolute plugin directory
 *   argv[3] = JSON-encoded permissions array, a subset of
 *             ["network","storage","child_process","fs-read","fs-write"]
 *
 * It reads the plugin's manifest to find the backend entry (default
 * "backend/index.js"), requires it, and hands it a permission-gated ctx.
 * The backend module must either:
 *   module.exports = function (ctx) { ... }
 * or:
 *   module.exports = { activate(ctx) { ... } }
 *
 * RPC and events are relayed to the Electron main process over the Node
 * IPC channel:
 *   parent -> child : { type:'rpc', id, payload }
 *   child  -> parent: { type:'rpc-reply', id, ok, result | error }
 *   child  -> parent: { type:'event', event, data }
 * ===================================================================== */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const childProcess = require('child_process');

const pluginDir = process.argv[2];

let permissions = [];
try {
  const parsed = JSON.parse(process.argv[3] || '[]');
  if (Array.isArray(parsed)) permissions = parsed;
} catch {
  permissions = [];
}

function fatal(message) {
  console.error('[plugin-backend]', message);
  process.exit(1);
}

if (!pluginDir || !fs.existsSync(pluginDir)) {
  fatal('Plugin directory does not exist: ' + pluginDir);
}

// ---- locate the backend entry from the manifest -----------------------
let manifest = {};
try {
  manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf-8'));
} catch (e) {
  fatal('Could not read plugin.json: ' + ((e && e.message) || e));
}

const backendRel = (manifest && typeof manifest.backend === 'string' && manifest.backend) || 'backend/index.js';
if (path.isAbsolute(backendRel) || /^[a-zA-Z]:/.test(backendRel) ||
    backendRel.replace(/\\/g, '/').split('/').includes('..')) {
  fatal('Invalid backend path in plugin.json: ' + backendRel);
}
const backendPath = path.join(pluginDir, backendRel);
if (!fs.existsSync(backendPath)) {
  fatal('Backend entry not found: ' + backendPath);
}

// ---- spawned-child tracking (child_process permission only) ----------
const spawnedChildren = new Set();

function killSpawnedChildren() {
  for (const c of spawnedChildren) {
    try { c.kill(); } catch { /* already gone */ }
  }
  spawnedChildren.clear();
}

// ---- build the permission-gated context ------------------------------
let rpcHandler = null;

const ctx = {
  permissions: permissions.slice(),

  rpc: {
    onRequest(fn) {
      rpcHandler = typeof fn === 'function' ? fn : null;
    }
  },

  emit(event, data) {
    if (process.send) {
      try { process.send({ type: 'event', event, data }); } catch { /* channel closed */ }
    }
  },

  log(...args) {
    console.log('[plugin-backend]', ...args);
  }
};

// network: global fetch (Node 18+).
if (permissions.includes('network')) {
  ctx.net = { fetch: global.fetch };
}

// fs-read / fs-write: unrestricted fs/promises access (a backend is
// trusted-by-install; the renderer-facing surface is what is sandboxed).
if (permissions.includes('fs-read') || permissions.includes('fs-write')) {
  ctx.fs = {
    readFile: (p, opts) => fsp.readFile(p, opts)
  };
  if (permissions.includes('fs-write')) {
    ctx.fs.writeFile = (p, data, opts) => fsp.writeFile(p, data, opts);
  }
}

// child_process: a thin spawn wrapper that streams output back as events
// and is torn down with the runner.
if (permissions.includes('child_process')) {
  ctx.spawn = (command, args, options) => {
    const child = childProcess.spawn(command, Array.isArray(args) ? args : [], options || {});
    spawnedChildren.add(child);
    if (child.stdout) {
      child.stdout.on('data', (d) => ctx.emit('stdout', { pid: child.pid, data: d.toString('utf-8') }));
    }
    if (child.stderr) {
      child.stderr.on('data', (d) => ctx.emit('stderr', { pid: child.pid, data: d.toString('utf-8') }));
    }
    child.on('exit', (code, signal) => {
      spawnedChildren.delete(child);
      ctx.emit('exit', { pid: child.pid, code, signal });
    });
    child.on('error', (err) => {
      ctx.emit('stderr', { pid: child.pid, data: String((err && err.message) || err) });
    });
    return {
      pid: child.pid,
      kill: (sig) => { try { child.kill(sig); } catch { /* already gone */ } }
    };
  };
}

// ---- RPC plumbing ---------------------------------------------------
process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object' || msg.type !== 'rpc') return;
  const replyId = msg.id;
  if (typeof rpcHandler !== 'function') {
    if (process.send) {
      process.send({
        type: 'rpc-reply',
        id: replyId,
        ok: false,
        error: 'Plugin backend did not register an rpc.onRequest handler.'
      });
    }
    return;
  }
  try {
    const result = await rpcHandler(msg.payload);
    if (process.send) process.send({ type: 'rpc-reply', id: replyId, ok: true, result });
  } catch (e) {
    if (process.send) process.send({ type: 'rpc-reply', id: replyId, ok: false, error: String(e) });
  }
});

// ---- lifecycle teardown -------------------------------------------
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  killSpawnedChildren();
  process.exit(0);
}
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---- load & activate the plugin backend --------------------------
(function activateBackend() {
  let mod;
  try {
    mod = require(backendPath);
  } catch (e) {
    fatal('Failed to require backend module: ' + ((e && e.stack) || e));
    return;
  }
  try {
    if (typeof mod === 'function') {
      mod(ctx);
    } else if (mod && typeof mod.activate === 'function') {
      mod.activate(ctx);
    } else {
      fatal('Backend module must export a function or an object with an activate(ctx) method.');
      return;
    }
  } catch (e) {
    fatal('Backend activate() threw: ' + ((e && e.stack) || e));
    return;
  }
  ctx.log('backend ready:', manifest.id || path.basename(pluginDir));
})();

# AGENTS.md

This repo's authoritative, actively-maintained architecture guide, code-function index, and AI-agent operating rules live in **[`CLAUDE.md`](./CLAUDE.md)** — read that file and follow it, not this one.

This file exists only so AI coding tools that specifically look for `AGENTS.md` still find something here. Keeping two independent, hand-written architecture docs in sync by hand is a losing game — this repo tried that for a while, and both files drifted out of date, still describing an old Python-server (`server.py` / WebView2) architecture that was replaced by the current Electron app long ago. Going forward there is exactly one source of truth, and this file just points to it instead of maintaining a second, inevitably-stale copy.

If you're an AI agent working in this repo: open `CLAUDE.md` now and treat everything in it — the system overview, the directory sitemap, the `chatView.js` internals, the MCP tool-calling notes, the known dead code / latent bugs, the XSS/sanitization approach, and the rules for modding the code — as binding for this session.

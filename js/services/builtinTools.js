/* js/services/builtinTools.js - The default tools NnzRP ships without any MCP
 * server configured:
 *   - "view image from URL" - fetch an image from a direct URL so a
 *     vision-capable model can actually "look at" something a character
 *     references (a photo link, a meme, a document scan) instead of only
 *     reasoning about the URL text.
 *   - "embed HTML" - let the model render a small self-contained HTML/CSS/JS
 *     snippet directly in the chat (a chart, a tiny canvas animation, an
 *     interactive diagram) inside a sandboxed iframe. OFF by default (see
 *     MCPStore.getEmbedHtmlEnabled) since, unlike the image tool, this one
 *     means actually executing AI-generated script content in the app.
 * Neither is an MCP tool - there's no server behind them - but both flow
 * through the exact same AgentRunner tool-calling loop and permission gate as
 * one, so they get the same Ask/Allow/Decline safety net (see
 * MCPStore.getBuiltinToolPermission/getEmbedHtmlToolPermission and
 * agentRunner.js's handling of these tools' qualified names).
 */
import { MCPStore } from '../storage/mcpStore.js';
import { supportsVision } from '../utils/modelVision.js';
import { MAX_IMAGE_BYTES, readFileAsDataURL } from '../utils/imageUtils.js';

export const BUILTIN_VIEW_IMAGE_TOOL = 'builtin__view_image_url';
export const BUILTIN_EMBED_HTML_TOOL = 'builtin__embed_html';

// Hard cap on how much HTML a single embed call may carry - not meant to be a
// meaningful sandbox boundary itself (the iframe sandbox attribute is what
// actually matters for safety, see executeBuiltinEmbedHtmlTool below), just a
// sanity limit so one call can't balloon a chat message/IndexedDB record with
// an unbounded string.
const MAX_EMBED_HTML_LENGTH = 20000;
const MAX_EMBED_TITLE_LENGTH = 120;

const VIEW_IMAGE_DESCRIPTOR = {
  qualifiedName: BUILTIN_VIEW_IMAGE_TOOL,
  description: 'Fetch an image from a direct URL so you can actually see its visual content (not just read the URL text). Use this whenever a scene references a photo, screenshot, meme, document, or other image link and its contents matter.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Direct HTTP(S) URL to an image file (jpg, png, gif, webp).' }
    },
    required: ['url']
  },
  isBuiltin: true
};

const EMBED_HTML_DESCRIPTOR = {
  qualifiedName: BUILTIN_EMBED_HTML_TOOL,
  description: 'Render a small self-contained HTML/CSS/JS snippet directly in the chat, shown to the user inside a sandboxed frame. Use this for visual content that genuinely benefits from real HTML/CSS/JS - a chart, a small canvas animation, an interactive diagram - NOT as a substitute for normal in-character prose narration; most replies should still just be written text. Write fully self-contained markup only: inline <style>/<script> tags, no external <script src> or network requests (the sandbox blocks them anyway).',
  inputSchema: {
    type: 'object',
    properties: {
      html: { type: 'string', description: 'Self-contained HTML document/fragment to render (inline <style>/<script> only, no external resources).' },
      title: { type: 'string', description: 'Optional short label shown above the embed.' }
    },
    required: ['html']
  },
  isBuiltin: true
};

/**
 * Both builtin tools share the MCP global master switch as their outermost
 * kill switch (no point offering either one if the user turned tool-use off
 * entirely app-wide). Beyond that:
 *   - the view-image tool is only offered when there's actually a
 *     vision-capable model active (no point letting the model "call" this if
 *     it can't process the result);
 *   - the embed-html tool is only offered when its own dedicated toggle
 *     (MCPStore.getEmbedHtmlEnabled, default OFF) is on. It does NOT need a
 *     vision-capable model - it never sends anything back to the model, it
 *     only renders in the UI - so it is deliberately not gated on supportsVision.
 */
export async function getBuiltinTools(proxy) {
  const globalEnabled = await MCPStore.getGlobalEnabled();
  if (!globalEnabled) return [];

  const tools = [];
  if (supportsVision(proxy)) tools.push(VIEW_IMAGE_DESCRIPTOR);
  if (await MCPStore.getEmbedHtmlEnabled()) tools.push(EMBED_HTML_DESCRIPTOR);
  return tools;
}

/**
 * Fetches `args.url` and returns `{ text, images: [dataUrl] }` for AgentRunner
 * to fold into the next round. Throws on anything not a fetchable http(s)
 * image under the size cap - AgentRunner already wraps tool execution in
 * try/catch and traces the error text back to the model, same as any other
 * tool failure.
 */
export async function executeBuiltinImageTool(args) {
  const url = typeof args?.url === 'string' ? args.url.trim() : '';
  if (!url) throw new Error('Missing required "url" argument.');

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }
  // http(s) only - this fetch runs with the app's own renderer privileges, so
  // a file:/data:/other scheme here would be a local-file-read vector, not an
  // "look at an image on the web" feature.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) image URLs are supported.');
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image (${res.status}).`);

  const blob = await res.blob();
  if (!blob.type.startsWith('image/')) {
    throw new Error(`URL did not return an image (content-type: ${blob.type || 'unknown'}).`);
  }
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large (max ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB).`);
  }

  const dataUrl = await readFileAsDataURL(blob);
  return { text: `Image fetched successfully from ${url}.`, images: [dataUrl] };
}

/**
 * Validates/caps `args.html` (and the optional `args.title`) and returns
 * `{ text, html, title }` for AgentRunner to trace + fold into the persisted
 * message's `embeds` field (see chatView.js's `collectToolEmbeds`). No
 * network I/O, no sanitization of the HTML itself here - that's what the
 * sandboxed `allow-scripts`-only iframe (no `allow-same-origin`) in
 * chatView.js's `messageEmbedsHTML()` is for, not this function. Throws on
 * empty/missing input, same convention as `executeBuiltinImageTool` - a
 * throw here is caught by AgentRunner and traced back to the model as an
 * error result.
 */
export async function executeBuiltinEmbedHtmlTool(args) {
  const html = typeof args?.html === 'string' ? args.html : '';
  if (!html.trim()) throw new Error('Missing required "html" argument.');

  const truncated = html.length > MAX_EMBED_HTML_LENGTH;
  const safeHtml = truncated ? html.slice(0, MAX_EMBED_HTML_LENGTH) : html;
  const title = typeof args?.title === 'string' ? args.title.trim().slice(0, MAX_EMBED_TITLE_LENGTH) : '';

  return {
    text: truncated
      ? `HTML embedded successfully (truncated to ${MAX_EMBED_HTML_LENGTH} characters).`
      : 'HTML embedded successfully.',
    html: safeHtml,
    title
  };
}

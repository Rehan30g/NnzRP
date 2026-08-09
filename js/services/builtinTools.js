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
// an unbounded string. Checked BEFORE `{{char_avatar}}` substitution, so it
// caps the model's own authored markup, not the substituted avatar's size
// (an uploaded avatar can legitimately be a large base64 string).
const MAX_EMBED_HTML_LENGTH = 20000;
const MAX_EMBED_TITLE_LENGTH = 120;

// Placeholder both builtin tools recognize for "the active character's own
// avatar" - resolved from execution context (AgentRunner.run()'s
// `characterAvatar` option, ultimately chatView.js's `activeChar.avatar`),
// never something the model has to know or type out itself. Necessary
// because an uploaded avatar is stored as a base64 `data:` URL that can run
// to hundreds of KB - asking a model to reproduce that verbatim as a tool
// argument would be enormously token-wasteful and likely to get corrupted/
// truncated, on top of it not actually knowing the value in the first place.
const CHAR_AVATAR_PLACEHOLDER = '{{char_avatar}}';

const VIEW_IMAGE_DESCRIPTOR = {
  qualifiedName: BUILTIN_VIEW_IMAGE_TOOL,
  description: `Fetch an image from a direct URL so you can actually see its visual content (not just read the URL text). Use this whenever a scene references a photo, screenshot, meme, document, or other image link and its contents matter. Works with any http(s) URL, including localhost/local-network addresses (e.g. http://localhost:3000/photo.png) - not just public internet URLs. To view the CHARACTER'S OWN avatar/photo (the one set for this character), pass the exact literal string "${CHAR_AVATAR_PLACEHOLDER}" as the url instead of trying to guess or type out the real address.`,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: `Direct HTTP(S) URL to an image file (jpg, png, gif, webp) - localhost/local-network URLs are fine. Use the literal "${CHAR_AVATAR_PLACEHOLDER}" to view the character's own avatar instead of a real URL.` }
    },
    required: ['url']
  },
  isBuiltin: true
};

const EMBED_HTML_DESCRIPTOR = {
  qualifiedName: BUILTIN_EMBED_HTML_TOOL,
  description: `Render a small self-contained HTML/CSS/JS snippet directly in the chat, shown to the user inline in the message with NO visible label/caption around it - it should feel like a natural part of the scene, not an attached technical widget. Use this for visual content that genuinely benefits from real HTML/CSS/JS - a chart, a small canvas animation, an interactive diagram, clickable choices - NOT as a substitute for normal in-character prose narration; most replies should still just be written text. Write fully self-contained markup only: inline <style>/<script> tags, no external <script src> or network requests (the sandbox blocks them anyway). To show the CHARACTER'S OWN avatar/photo inside the embed, use the literal string "${CHAR_AVATAR_PLACEHOLDER}" as an <img> src (e.g. <img src="${CHAR_AVATAR_PLACEHOLDER}">) - it gets substituted with the real image automatically, never type out a real URL/data string yourself for it. INTERACTIVITY (clickable options/decisions/replies, e.g. a scene with three doors rendering three buttons, each filling in a different action): the ONLY correct way is a data-fill-text="..." attribute, e.g. <button data-fill-text="Aku membuka pintu kayu itu.">Buka pintu kayu</button> - clicking it automatically puts that exact text into the user's chat input, ready to send or edit, with NO onclick/JS needed. ALWAYS use a DOUBLE-quoted attribute for data-fill-text and write the dialogue text completely normally (contractions like "don't"/"I'll"/"you're" and apostrophes need NO escaping inside it - HTML attribute parsing only breaks on the attribute's OWN quote character, and this is always double-quoted). Do NOT write onclick="fillChatInput('...')" by hand - a JS string literal like that requires perfectly escaping every single-quote inside the text, and natural dialogue's contractions make that fail constantly (a real generated button broke exactly this way: onclick="fillChatInput('I don't know...')" is a JS SYNTAX ERROR the instant it hits that apostrophe, silently killing the whole button). The global fillChatInput(text) function still exists for advanced custom scripting, but data-fill-text is what you should reach for by default. THEME: the embed already receives the app's current text color and a transparent background matching whatever theme (light or dark) the user currently has active on their device/app, so avoid hardcoding a solid white or black page background that would clash with it. If you need your OWN explicit light/dark handling beyond that (e.g. a chart with colored fills), use the CSS "prefers-color-scheme" media query so it still matches the user's actual device/app theme instead of assuming one.`,
  inputSchema: {
    type: 'object',
    properties: {
      html: { type: 'string', description: `Self-contained HTML document/fragment to render (inline <style>/<script> only, no external resources). Use "${CHAR_AVATAR_PLACEHOLDER}" as an <img> src to show the character's own avatar. For clickable options, add data-fill-text="..." (double-quoted, plain unescaped dialogue text - do NOT write onclick="fillChatInput('...')" by hand, apostrophes in the text will break it) to any element instead. Respect the current light/dark theme - see the tool description.` },
      title: { type: 'string', description: 'Optional short label for this embed. Not shown visibly - only used as an accessibility (screen reader) attribute.' }
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
 *
 * `context.characterAvatar` (see AgentRunner.run()'s matching option): when
 * `args.url` is exactly the `{{char_avatar}}` placeholder, this resolves
 * straight to the character's own avatar instead of treating it as a URL to
 * fetch. If that avatar is already a `data:` URL (an uploaded avatar), it's
 * returned directly with NO network request at all - we already have the
 * image bytes locally, fetching would be pointless and `data:` isn't an
 * http(s) URL anyway. If it's a real http(s) URL (e.g. a dicebear link), it
 * falls through to the normal fetch path below like any other URL would.
 */
export async function executeBuiltinImageTool(args, context = {}) {
  let url = typeof args?.url === 'string' ? args.url.trim() : '';
  if (!url) throw new Error('Missing required "url" argument.');

  if (url === CHAR_AVATAR_PLACEHOLDER) {
    const avatar = context.characterAvatar;
    if (!avatar) throw new Error('This character has no avatar set.');
    if (avatar.startsWith('data:')) {
      return { text: 'Character avatar retrieved.', images: [avatar] };
    }
    url = avatar; // a real URL - fall through to the normal fetch path below
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }
  // http(s) only - this fetch runs with the app's own renderer privileges, so
  // a file:/data:/other scheme here would be a local-file-read vector, not an
  // "look at an image on the web" feature. http(s) covers localhost/local-
  // network addresses fine (they're still the http: scheme) - nothing here
  // singles those out.
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
 *
 * `context.characterAvatar`: every occurrence of the `{{char_avatar}}`
 * placeholder in the HTML is substituted with the real avatar value (a URL
 * or a `data:` URL) AFTER the length cap below, not before - so the cap
 * bounds the model's own authored markup, not an uploaded avatar's
 * (potentially much larger) base64 size. No extra escaping needed here: the
 * substituted characters become part of the same raw HTML string that later
 * gets `escapeAttr()`'d exactly once, as a whole, when chatView.js builds the
 * iframe's `srcdoc` attribute.
 */
export async function executeBuiltinEmbedHtmlTool(args, context = {}) {
  const html = typeof args?.html === 'string' ? args.html : '';
  if (!html.trim()) throw new Error('Missing required "html" argument.');

  const truncated = html.length > MAX_EMBED_HTML_LENGTH;
  let safeHtml = truncated ? html.slice(0, MAX_EMBED_HTML_LENGTH) : html;
  if (context.characterAvatar && safeHtml.includes(CHAR_AVATAR_PLACEHOLDER)) {
    safeHtml = safeHtml.split(CHAR_AVATAR_PLACEHOLDER).join(context.characterAvatar);
  }
  const title = typeof args?.title === 'string' ? args.title.trim().slice(0, MAX_EMBED_TITLE_LENGTH) : '';

  return {
    text: truncated
      ? `HTML embedded successfully (truncated to ${MAX_EMBED_HTML_LENGTH} characters).`
      : 'HTML embedded successfully.',
    html: safeHtml,
    title
  };
}

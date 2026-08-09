/* js/utils/syntaxHighlight.js - Lightweight, dependency-free syntax
 * highlighting for fenced code blocks in chat messages (js/ui/views/chatView.js).
 *
 * No highlighter library is vendored (only marked.min.js is) and this app
 * doesn't fetch anything from a CDN, so this is a small hand-rolled lexer
 * instead of pulling in highlight.js/Prism. It covers the languages a
 * roleplay/coding chat actually produces (HTML was the specific complaint -
 * "kode nya full biru" - plus the other everyday ones); anything unrecognized
 * just falls back to plain escaped text, same as before this existed.
 *
 * IMPORTANT: `code` passed in here must be the RAW, un-escaped source text.
 * The output is always HTML-safe on its own (every literal character is run
 * through escapeHtml before being wrapped in a span) - callers must NOT
 * escape the input themselves first, or entities get escaped twice (that
 * double-escaping is the exact bug this was written to fix).
 */
import { escapeHtml } from './sanitize.js';

/**
 * Scans `code` left to right. At each position, tries every rule's REGEX (in
 * order, each must have the sticky `y` flag) anchored at the current index;
 * the first one that matches wins and its text is wrapped in
 * `<span class="hl-{type}">`. No rule matching just escapes and emits the one
 * character as plain text. This is a standard small hand-rolled lexer shape -
 * simple, and correct by construction (every character is accounted for
 * exactly once, so there's no way to accidentally drop or duplicate text).
 */
function tokenize(code, rules) {
  let out = '';
  let i = 0;
  const len = code.length;
  while (i < len) {
    let matched = false;
    for (const rule of rules) {
      rule.regex.lastIndex = i;
      const m = rule.regex.exec(code);
      if (m && m.index === i && m[0].length > 0) {
        out += `<span class="hl-${rule.type}">${escapeHtml(m[0])}</span>`;
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += escapeHtml(code[i]);
      i++;
    }
  }
  return out;
}

const HTML_RULES = [
  { type: 'comment', regex: /<!--[\s\S]*?-->/y },
  { type: 'keyword', regex: /<!DOCTYPE[^>]*>/iy },
  { type: 'tag', regex: /<\/?[a-zA-Z][a-zA-Z0-9:-]*/y },
  { type: 'punct', regex: /\/?>/y },
  { type: 'attr', regex: /[a-zA-Z_:][a-zA-Z0-9_.:-]*(?=\s*=)/y },
  { type: 'punct', regex: /=/y },
  { type: 'string', regex: /"[^"]*"|'[^']*'/y }
];

const JS_KEYWORD_RE = /\b(const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|class|extends|new|this|super|import|export|from|as|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false|void|yield|static|get|set)\b/y;
const JS_RULES = [
  { type: 'comment', regex: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
  { type: 'string', regex: /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y },
  { type: 'number', regex: /\b\d+(\.\d+)?\b/y },
  { type: 'keyword', regex: JS_KEYWORD_RE }
];

const CSS_RULES = [
  { type: 'comment', regex: /\/\*[\s\S]*?\*\//y },
  { type: 'string', regex: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y },
  { type: 'attr', regex: /[a-zA-Z-]+(?=\s*:)/y },
  { type: 'number', regex: /-?\d+(\.\d+)?(px|em|rem|%|vh|vw|deg|s|ms)?/y },
  { type: 'tag', regex: /[.#]?[a-zA-Z][\w-]*(?=[\s,{])/y },
  { type: 'punct', regex: /[{}:;,]/y }
];

const JSON_RULES = [
  { type: 'attr', regex: /"(?:\\.|[^"\\])*"(?=\s*:)/y },
  { type: 'string', regex: /"(?:\\.|[^"\\])*"/y },
  { type: 'number', regex: /-?\b\d+(\.\d+)?\b/y },
  { type: 'keyword', regex: /\b(true|false|null)\b/y },
  { type: 'punct', regex: /[{}[\],:]/y }
];

const PYTHON_RULES = [
  { type: 'comment', regex: /#[^\n]*/y },
  { type: 'string', regex: /("""[\s\S]*?""")|('''[\s\S]*?''')|("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')/y },
  { type: 'number', regex: /\b\d+(\.\d+)?\b/y },
  { type: 'keyword', regex: /\b(def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|pass|break|continue|lambda|yield|async|await|True|False|None|and|or|not|in|is|global|nonlocal|self)\b/y }
];

const BASH_RULES = [
  { type: 'comment', regex: /#[^\n]*/y },
  { type: 'string', regex: /"(?:\\.|[^"\\])*"|'[^']*'/y },
  { type: 'keyword', regex: /\b(if|then|else|elif|fi|for|do|done|while|function|echo|export|return|local)\b/y }
];

const LANG_RULES = {
  html: HTML_RULES, htm: HTML_RULES, xml: HTML_RULES, svg: HTML_RULES, vue: HTML_RULES,
  js: JS_RULES, javascript: JS_RULES, jsx: JS_RULES, ts: JS_RULES, typescript: JS_RULES, tsx: JS_RULES,
  css: CSS_RULES, scss: CSS_RULES, less: CSS_RULES,
  json: JSON_RULES, json5: JSON_RULES,
  py: PYTHON_RULES, python: PYTHON_RULES,
  bash: BASH_RULES, sh: BASH_RULES, shell: BASH_RULES, zsh: BASH_RULES
};

/**
 * `rawCode` MUST be un-escaped source text (see file header). Returns
 * HTML-safe markup - either highlighted spans, or (for an unrecognized/absent
 * language) plain escapeHtml(rawCode), same behavior as before highlighting existed.
 */
export function highlightCode(rawCode, lang) {
  const rules = LANG_RULES[(lang || '').toLowerCase().trim()];
  if (!rules) return escapeHtml(rawCode);
  return tokenize(rawCode, rules);
}

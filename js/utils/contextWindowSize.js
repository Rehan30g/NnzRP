/* js/utils/contextWindowSize.js - Best-effort context-window-size lookup by
 * model name, feeding the chat header's capacity gauge (chatView.js). Same
 * caveat as js/utils/modelVision.js: there is no generic runtime API this
 * app can call across every provider to ask "what's your context window",
 * so this is a name-based heuristic - wrong in either direction just skews
 * the gauge's percentage, nothing breaks. `proxy.contextWindowOverride`
 * (set in proxiesView.js, same pattern as `visionOverride`) always wins over
 * the guess for whenever a model isn't covered or is misclassified.
 */

// Conservative "don't know" fallback - the middle of what most current
// mid-size open models ship with, rather than assuming either extreme.
const DEFAULT_WINDOW = 32768;

// Patterns are matched in order, first match wins. They're written to be
// mutually exclusive against each other in practice (a model id only ever
// plausibly matches one family here), so ordering mostly doesn't matter
// except for putting more specific patterns before their looser fallback
// (e.g. a specific Gemini/GPT-4 sub-pattern before the bare family name).
const WINDOW_TABLE = [
  [/gemini/i, 1000000],
  [/\bo1\b|\bo3\b|\bo4\b|gpt-5/i, 200000],
  [/gpt-4\.1/i, 1000000],
  [/gpt-4o|chatgpt-4o|gpt-4-turbo|gpt-image/i, 128000],
  [/gpt-4-32k/i, 32000],
  [/^gpt-4$|gpt-4-0314|gpt-4-0613/i, 8192],
  [/gpt-3\.5/i, 16000],
  [/claude-3|claude-4|claude-5|claude-opus|claude-sonnet|claude-haiku/i, 200000],
  [/claude-instant|claude-2/i, 100000],
  [/llama-3\.1|llama-3\.2|llama-4/i, 128000],
  [/llama-3(?!\.)/i, 8000],
  [/mixtral|mistral-large|mistral-small|pixtral/i, 128000],
  [/mistral-7b|mistral-tiny/i, 32000],
  [/deepseek/i, 128000],
  [/qwen2\.5|qwen3/i, 128000],
  [/qwen/i, 32000],
  [/command-r/i, 128000],
  [/grok/i, 128000],
  [/phi-4|phi-3\.5/i, 128000]
];

/** `proxy` is a ProxyStore record ({ provider, selectedModel, contextWindowOverride, ... }). */
export function getContextWindowSize(proxy) {
  if (!proxy) return DEFAULT_WINDOW;

  const override = Number(proxy.contextWindowOverride);
  if (Number.isFinite(override) && override > 0) return override;

  const model = (proxy.selectedModel || '').toLowerCase().trim();
  if (!model) return DEFAULT_WINDOW;

  for (const [pattern, size] of WINDOW_TABLE) {
    if (pattern.test(model)) return size;
  }
  return DEFAULT_WINDOW;
}

/* js/utils/modelVision.js - Best-effort guess at whether a proxy's selected
 * model accepts image input. There is no generic runtime capability API this
 * app can call for every provider/model combo (OpenAI, Anthropic and Gemini
 * all require a real signed request just to introspect a model, and a
 * 'custom'/OpenRouter proxy can point at literally anything) - so this is a
 * model-name heuristic, not a guarantee. Wrong in either direction fails soft:
 * the attach button just becomes available/unavailable, nothing breaks the
 * chat itself if the guess is off.
 */

// Matches model ids/slugs from every currently-known vision-capable family
// across all providers (including ones routed through 'openrouter'/'custom',
// which often carry a vendor prefix like "anthropic/claude-3.5-sonnet" or a
// community model name like "qwen2-vl-7b-instruct"). Deliberately broad - a
// false positive just shows an attach button that a provider then ignores or
// errors on; a false negative silently hides a feature that would have worked.
const VISION_HINTS = /vision|gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|chatgpt-4o|gpt-image|\bo1\b|\bo3\b|\bo4\b|claude-3|claude-4|claude-5|claude-opus-4|claude-sonnet-4|claude-haiku-4|gemini|llava|bakllava|moondream|minicpm-v|qwen.{0,3}-?vl|qwen3|pixtral|llama-4|phi-4|grok-4|grok-2|internvl|cogvlm|yi-vl/i;

// Known models that would otherwise match too loosely, or that are text-only
// despite belonging to an otherwise-vision-capable family.
const NON_VISION_EXCEPTIONS = /claude-2|claude-instant|^gemini-pro$|gemini-1\.0|text-bison|chat-bison|gpt-3\.5|gpt-4-32k|gpt-4-0314|gpt-4-0613/i;

/**
 * `proxy` is a ProxyStore record ({ provider, selectedModel, visionOverride, ... }).
 * `visionOverride` (set via proxiesView.js's "Image Input" field) is checked
 * FIRST and wins outright - the name-heuristic below is necessarily a guess
 * (new model names ship faster than this regex can track, e.g. it originally
 * missed a real vision-capable "qwen3.7-flash" model), so the user always has
 * a way to correct it without waiting on an app update. Returns false for
 * anything unset/unrecognized on 'auto' - the safe default is "don't offer an
 * attach button that will just fail".
 */
export function supportsVision(proxy) {
  if (!proxy) return false;
  if (proxy.visionOverride === true) return true;
  if (proxy.visionOverride === false) return false;
  const model = (proxy.selectedModel || '').toLowerCase().trim();
  if (!model) return false;
  if (NON_VISION_EXCEPTIONS.test(model)) return false;
  if (VISION_HINTS.test(model)) return true;
  // Gemini's current model lineup (1.5+/2.x) is multimodal by default; the
  // explicit text-only exceptions above are already ruled out at this point.
  if (proxy.provider === 'gemini') return true;
  return false;
}

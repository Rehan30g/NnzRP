/* js/services/greetingWizardService.js - AI-driven step-by-step greeting personalization.
 * Two one-off, non-streaming AI calls (same pattern as chatView.js's auto-title
 * generation) that never touch AgentRunner/PromptBuilder - this writes a brand
 * new opening greeting for the CURRENT chat's already-persisted greeting
 * message, not the character's `first_mes` template. There is no JSON-mode
 * support anywhere in providerManager.js, so `nextQuestion()`'s output is
 * parsed defensively (fenced/unfenced/embedded JSON), never trusted as-is. */
import { ProviderManager } from './providerManager.js';
import { replaceMacros } from '../utils/macroReplacer.js';

export const GREETING_WIZARD_TOTAL_QUESTIONS = 3;

const QUESTION_SYSTEM_PROMPT = `You are a scene director interviewing a user before you rewrite the opening message (the very first scene) of an AI roleplay character.

Your ONLY job right now is to produce THE SINGLE NEXT QUESTION to ask the user. Each question must be a real creative decision that visibly changes the opening scene you will later write. Never ask filler.

Reply with VALID JSON ONLY - no prose, no markdown code fence, exactly this shape:
{"question": "<one short question, a single sentence>", "options": ["<choice 1>", "<choice 2>", "<choice 3>"]}

The interview is a fixed escalation of ${GREETING_WIZARD_TOTAL_QUESTIONS} questions. Ask the one matching the question number you are given:

QUESTION 1 - THE PLOT. Always ask what plot/scenario the user wants for this new opening, framed by how far it should move from the character's ORIGINAL opening message. The 3 options must span that distance and each must name a concrete premise drawn from this specific character (never abstract labels like "same" / "different"):
  - one option that stays close to the original setup, same place and situation, just a fresh beat;
  - one option that keeps the character's world but flips the circumstances (different place, different moment, a complication);
  - one option that is a genuinely different scenario for this character (an alternate premise, another life, another kind of meeting).

QUESTION 2 - THE SITUATION. Lock down the concrete starting circumstances INSIDE the plot the user just picked: where and when the scene opens, what is already happening as it opens, or what has just gone wrong. Options must be specific to their chosen plot and must lead to visibly different first scenes.

QUESTION 3 - THE HOOK. Decide how the user enters the scene and what pressure the opening ends on: the user's position/role in the moment, the emotional temperature, or the immediate demand/threat/invitation the character leaves them with. Options must remain consistent with both earlier answers.

Rules:
- "options" must contain EXACTLY 3 short choices (a few words each, ideally under 10 words), clearly distinct, mutually exclusive, and all plausible.
- An option states the actual premise in plain words. Never prefix it with a meta label such as "Close to original:", "Same:", "Twist:" or "Alternate premise:".
- Refer to the user by their persona name inside questions and options only when it reads naturally; never invent facts about them.
- Every question and option must be grounded in THIS character's description, personality, scenario and original opening - use their real names, places and stakes, not generic placeholders.
- Never repeat or rephrase an aspect an earlier answer already settled; build on it instead.
- Never ask about writing length, formatting, point of view, or anything meta about the message itself.
- Write the "question" and "options" VALUES in the requested output language. The JSON keys stay exactly "question" and "options" in English.`;

const GREETING_SYSTEM_PROMPT = `You are a creative writer for AI roleplay characters. Your task: write ONE brand new opening message (the first scene of a chat) for the given character, personalized to the user's stated preferences.

OUTPUT FORMAT - follow this shape exactly:
- Narration and actions go on their own line, wrapped in single asterisks: *like this*
- Spoken dialogue goes on its own line as the speaker's name, a colon, then the line in double quotes: Name: "like this"
- On a dialogue line the double-quoted speech must come IMMEDIATELY after the colon. An action may only follow AFTER the closing quote: Name: "like this" *does something*. Never write Name: *action* "speech".
- Put ONE blank line between every beat (every narration line and every dialogue line).
- Keep each beat short - at most two sentences. Break a long moment into several separate *narration* beats instead of writing one big block.
- Plain unmarked prose paragraphs are NOT allowed. Every single line must be either *narration* or Name: "dialogue".
- Never leave a quote or an asterisk unclosed.
- The user is the reader, not a cast member: their persona name may NEVER appear as a speaker (no line starting with their name and a colon), and narration must call them "you", never their name in third person - no matter how the user's answers were worded.

This is exactly the shape required (an example from another character - copy the FORMAT, never the content):

*You wake up very dizzy, you open your eyes slowly and feel like you are tied to a boxing bag, hands and feet tied tightly, then, you look ahead and you see bright eyes approaching*

*Then, the Bad Guys show up, all with their Machiavellian smiles*

Mr. Wolf: "It was easy to bring this boy to our den"

*Mr. Snake makes a snake noise with his tongue*

Mr. Snake: "You're right, he didn't even notice."

Mr. Shark: "What should we do with him?"

Mr. Piranha: "We must bite him" *Says with his sharp teeth*

Ms. Tarantula: "No, we must ask him where his loot is."

*Mr. Wolf smiled evilly*

Mr. Wolf: "Good idea."

*Mr. Wolf approaches Jack*

Mr. Wolf: "Where are your treasures?" *Says with an intimidating look*

Rules:
- Output ONLY the opening message text - no title, no preamble, no explanation, no surrounding quotes, no code fence.
- Stay fully in character; write the character's dialogue in their own voice. Other named characters present in the scene may speak too, each with their own Name: "line".
- Always address the user in second person ("you") in the narration, even when the user's persona has a name and even when the user's chosen answers referred to them by that name. Never narrate the user in third person, and never write a dialogue line for the user.
- Weave EVERY user preference naturally into the scene instead of naming them literally.
- Build the exact plot/situation/hook the user chose - do not fall back to the character's original opening scene unless the user asked to stay close to it.
- End on an open hook that invites the user to respond (a question, a demand, an approach, a decision left hanging), and make sure that final beat is complete - never stop mid-sentence.
- Length: AT LEAST 8 and at most 14 beats (blank-line-separated lines), mixing narration and dialogue. Count them before you finish - fewer than 8 is a failed answer.
- Write the prose and dialogue in the requested output language, while keeping the *asterisk* and Name: "quote" formatting exactly as specified.`;

/** Best-effort JSON extraction - the model may wrap its answer in a code
 * fence, add stray text around it, or occasionally nothing at all. Returns
 * null (never throws) so the caller can surface one clear error message. */
function extractJSON(text) {
  if (!text) return null;
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const braceMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!braceMatch) return null;
    try {
      return JSON.parse(braceMatch[0]);
    } catch {
      return null;
    }
  }
}

/** Removes the quote pair a model sometimes wraps its whole answer in, WITHOUT
 * eating a legitimate quote that belongs to the text. This matters because the
 * required greeting format ends most scenes on a dialogue line - `Vex: "make it
 * count."` - so a blind trailing-quote strip (what this used to do) silently
 * deleted the closing quote of the last spoken line on nearly every generation.
 * Only unwraps when the entire string is one quoted span with no other quote of
 * the same kind inside it. */
function stripWrappingQuotes(text) {
  if (!text) return text;
  for (const q of ['"', "'"]) {
    if (text.length > 1 && text.startsWith(q) && text.endsWith(q) && !text.slice(1, -1).includes(q)) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

export class GreetingWizardService {
  /**
   * @param {object} opts
   * @param {object} opts.proxy - active AI proxy config
   * @param {object} opts.character
   * @param {object} [opts.persona]
   * @param {Array<{question:string, answer:string}>} opts.answers - every
   *   question answered so far, in order - the next question must build on
   *   this and not repeat an already-covered aspect.
   * @param {string} [opts.language] - output language for the question/option
   *   TEXT only (the JSON keys always stay English). Empty/undefined = English.
   * @returns {Promise<{question:string, options:string[]}>}
   */
  static async nextQuestion({ proxy, character, persona, answers, language }) {
    const answersText = answers.length
      ? answers.map((a, i) => `${i + 1}. Q: ${a.question}\n   A: ${a.answer}`).join('\n')
      : '(no answers yet - this is the first question)';

    const payload = [
      { role: 'system', content: QUESTION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `[Character]
Name: ${character?.name || 'Character'}
Description: ${character?.description || '-'}
Personality: ${character?.personality || '-'}
Scenario: ${character?.scenario || '-'}
Original opening message (the scene we are replacing): ${character?.first_mes || '-'}

[User persona]
Name: ${persona?.name || 'User'}
Info: ${persona?.description || '-'}

[Answers so far]
${answersText}

Output language: ${language || 'English'}

Write personalization question number ${answers.length + 1} of ${GREETING_WIZARD_TOTAL_QUESTIONS}. Reply with JSON ONLY.`
      }
    ];

    // Reasoning-capable models (confirmed live with DeepSeek V4 Flash on
    // OpenRouter, which reasons by default with no explicit opt-in/opt-out
    // exposed by providerManager.js) spend an unpredictable, non-deterministic
    // chunk of `max_tokens` on hidden reasoning content BEFORE ever emitting
    // the actual JSON - reasoning length varied 0-1989 chars across identical
    // back-to-back calls in testing. At maxTokens:350 that reasoning alone
    // regularly consumed the entire budget, truncating/emptying `content`
    // (finish_reason:'length') and making this throw on ~60% of calls. 1200
    // covers every reasoning length observed in testing with headroom to
    // spare; the retry at 2400 is a safety net for the rare heavier burst
    // instead of failing the whole wizard step on one unlucky call.
    const attempt = async (maxTokens) => {
      const result = await ProviderManager.sendChatCompletion(proxy, payload, { maxTokens, temperature: 0.8 });
      const parsed = extractJSON(result.content || '');
      const question = (parsed?.question ?? '').toString().trim();
      const options = Array.isArray(parsed?.options)
        ? parsed.options.map(o => (o ?? '').toString().trim()).filter(Boolean).slice(0, 3)
        : [];
      return question && options.length ? { question, options } : null;
    };

    const out = (await attempt(1200)) || (await attempt(2400));
    if (!out) {
      throw new Error('The AI did not return a valid question. Please try again.');
    }
    return out;
  }

  /**
   * @param {object} opts
   * @param {object} opts.proxy
   * @param {object} [opts.genSettings] - the proxy's configured generation
   *   settings, used only as a floor for maxTokens/temperature so a very low
   *   configured maxTokens can't truncate the greeting.
   * @param {object} opts.character
   * @param {object} [opts.persona]
   * @param {Array<{question:string, answer:string}>} opts.answers
   * @param {string} [opts.language] - output language for the greeting TEXT
   *   only (the *action* / Name: "dialogue" formatting is language-independent
   *   and always stays). Empty/undefined = English.
   * @returns {Promise<string>} the finished greeting text, macro-replaced
   */
  static async generateGreeting({ proxy, genSettings, character, persona, answers, language }) {
    const userName = persona?.name || 'User';
    const charName = character?.name || 'Character';
    const answersText = answers.length
      ? answers.map(a => `- ${a.question} -> ${a.answer}`).join('\n')
      : '(no specific preferences given)';

    const payload = [
      { role: 'system', content: GREETING_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `[Character: ${charName}]
Description: ${character?.description || '-'}
Personality: ${character?.personality || '-'}
Scenario: ${character?.scenario || '-'}
Example dialogue style: ${character?.example_dialogue || '-'}
ORIGINAL opening message (context only - do NOT copy it): ${character?.first_mes || '-'}

[User persona: ${userName}]
${persona?.description || '-'}

[The user's personalization choices]
${answersText}

Output language: ${language || 'English'}

Write ONE new opening message now, in character as ${charName}, in the required *action* / Name: "dialogue" format. The reader is ${userName} - address them as "you" and never give them a "${userName}:" dialogue line.`
      }
    ];

    // Same reasoning-token-truncation risk as nextQuestion() above - a
    // reasoning-capable model can burn a large, unpredictable chunk of
    // `max_tokens` before writing the actual greeting. The floor is higher
    // here than nextQuestion()'s 1200 because what follows the reasoning is
    // not a one-line JSON object but a full 8-14 beat scene: measured live on
    // DeepSeek V4 Flash, one greeting call spends ~250-400 reasoning tokens
    // AND ~250-350 content tokens, which leaves almost no margin at 1200 -
    // and the retry below cannot rescue a truncation anyway, since it only
    // fires on an EMPTY result and a cut-off greeting is a non-empty string.
    const baseMaxTokens = Math.max(genSettings?.maxTokens || 0, 2400);
    const temperature = genSettings?.temperature ?? 0.9;

    const attempt = async (maxTokens) => {
      const result = await ProviderManager.sendChatCompletion(proxy, payload, { maxTokens, temperature });
      return stripWrappingQuotes((result.content || '').trim());
    };

    const text = (await attempt(baseMaxTokens)) || (await attempt(baseMaxTokens * 2));
    if (!text) {
      throw new Error('The AI did not generate any opening message text. Please try again.');
    }
    return replaceMacros(text, userName, charName);
  }
}

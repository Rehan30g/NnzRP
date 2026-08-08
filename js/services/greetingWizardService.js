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

const QUESTION_SYSTEM_PROMPT = `Anda adalah asisten kreatif yang membantu mempersonalisasi pesan pembuka (opening greeting) sebuah karakter roleplay AI untuk seorang pengguna.

Tugas Anda HANYA membuat SATU pertanyaan singkat berikutnya untuk ditanyakan ke pengguna, agar pesan pembuka baru nanti bisa lebih personal dan sesuai keinginan mereka.

Balas HANYA dengan JSON valid, tanpa teks lain, tanpa markdown code fence, PERSIS format ini:
{"question": "<pertanyaan singkat, satu kalimat>", "options": ["<opsi 1>", "<opsi 2>", "<opsi 3>"]}

Aturan:
- "options" harus berisi TEPAT 3 pilihan singkat (maksimal beberapa kata), berbeda satu sama lain.
- Pertanyaan dan opsi harus relevan dengan karakter serta mengikuti konteks jawaban-jawaban sebelumnya (jika ada) - jangan mengulang aspek yang sudah ditanyakan.
- Fokus ke detail konkret yang bisa memengaruhi isi pesan pembuka baru (contoh aspek: suasana/mood adegan, lokasi, apa yang sedang dilakukan karakter saat itu, hubungan/kedekatan dengan user) - pilih SATU aspek yang belum ditanyakan.`;

const GREETING_SYSTEM_PROMPT = `Anda adalah penulis kreatif untuk karakter roleplay AI. Tugas Anda: tulis SATU pesan pembuka (opening greeting) BARU untuk karakter ini, dipersonalisasi berdasarkan preferensi pengguna yang diberikan.

Aturan:
- Tulis HANYA teks pesan pembukanya sendiri - tanpa judul, tanpa penjelasan, tanpa tanda kutip pembungkus.
- Tulis sepenuhnya in-character sebagai karakter tersebut, dengan gaya narasi yang sama seperti pesan pembuka asli (misalnya aksi dalam *tanda bintang* jika itu gaya aslinya).
- Refleksikan semua preferensi pengguna secara natural ke dalam adegan, jangan hanya menyebutkannya secara harfiah.
- Panjang wajar: 1-4 paragraf.`;

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

export class GreetingWizardService {
  /**
   * @param {object} opts
   * @param {object} opts.proxy - active AI proxy config
   * @param {object} opts.character
   * @param {object} [opts.persona]
   * @param {Array<{question:string, answer:string}>} opts.answers - every
   *   question answered so far, in order - the next question must build on
   *   this and not repeat an already-covered aspect.
   * @returns {Promise<{question:string, options:string[]}>}
   */
  static async nextQuestion({ proxy, character, persona, answers }) {
    const answersText = answers.length
      ? answers.map((a, i) => `${i + 1}. Q: ${a.question}\n   A: ${a.answer}`).join('\n')
      : '(belum ada jawaban)';

    const payload = [
      { role: 'system', content: QUESTION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `[Karakter]
Nama: ${character?.name || 'Character'}
Deskripsi: ${character?.description || '-'}
Kepribadian: ${character?.personality || '-'}
Skenario: ${character?.scenario || '-'}
Pesan pembuka asli (referensi gaya menulis): ${character?.first_mes || '-'}

[Persona User]
Nama: ${persona?.name || 'User'}
Info: ${persona?.description || '-'}

[Jawaban sebelumnya]
${answersText}

Buat pertanyaan personalisasi berikutnya (pertanyaan ke-${answers.length + 1}). Balas HANYA JSON.`
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
      throw new Error('AI tidak mengembalikan pertanyaan yang valid. Coba lagi.');
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
   * @returns {Promise<string>} the finished greeting text, macro-replaced
   */
  static async generateGreeting({ proxy, genSettings, character, persona, answers }) {
    const userName = persona?.name || 'User';
    const charName = character?.name || 'Character';
    const answersText = answers.length
      ? answers.map(a => `- ${a.question} -> ${a.answer}`).join('\n')
      : '(tidak ada preferensi khusus)';

    const payload = [
      { role: 'system', content: GREETING_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `[Karakter: ${charName}]
Deskripsi: ${character?.description || '-'}
Kepribadian: ${character?.personality || '-'}
Skenario: ${character?.scenario || '-'}
Contoh gaya dialog: ${character?.example_dialogue || '-'}
Pesan pembuka ASLI (referensi gaya/format saja, JANGAN disalin mentah): ${character?.first_mes || '-'}

[Persona User: ${userName}]
${persona?.description || '-'}

[Preferensi personalisasi dari user]
${answersText}

Tulis SATU pesan pembuka baru sekarang, in-character sebagai ${charName}.`
      }
    ];

    // Same reasoning-token-truncation risk as nextQuestion() above - a
    // reasoning-capable model can burn a large, unpredictable chunk of
    // `max_tokens` before writing the actual greeting.
    const baseMaxTokens = Math.max(genSettings?.maxTokens || 0, 1200);
    const temperature = genSettings?.temperature ?? 0.9;

    const attempt = async (maxTokens) => {
      const result = await ProviderManager.sendChatCompletion(proxy, payload, { maxTokens, temperature });
      return (result.content || '').trim().replace(/^["']+|["']+$/g, '');
    };

    const text = (await attempt(baseMaxTokens)) || (await attempt(baseMaxTokens * 2));
    if (!text) {
      throw new Error('AI tidak menghasilkan teks pesan pembuka. Coba lagi.');
    }
    return replaceMacros(text, userName, charName);
  }
}

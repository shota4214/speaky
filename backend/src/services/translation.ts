/**
 * 翻訳系の LLM 呼び出し(日本語/混在 → 英語、英語 → 日本語)。
 *
 * 非ストリーミング経路とストリーミング経路の両方から使うため routes から
 * services へ切り出した。**中身は routes/chat.ts にあった時点から変えていない。**
 */
import type { Level } from './conversation-prompt.js'
import { looksLikeJsonScaffold, matchJsonStringField } from './json-salvage.js'
import { chatWithOllama, OllamaError, RETRY_SEED, type OllamaChatMessage } from './ollama.js'

/**
 * japanese_help / mixed モードは LLM のシステムプロンプトに「翻訳して」と書くだけでは
 * 小型モデル(Llama 3.2 3B 等)が会話継続に流れてしまうため、
 * バックエンドで専用の翻訳プロンプトに完全分離する。
 *
 * - 会話の system prompt と履歴は一切渡さない(会話継続の引力を断つ)
 * - 単一タスク「日本語/混在文を自然な英語に翻訳する」だけを LLM に依頼
 * - 出力 string をそのまま reply_en として返し、reply_ja はサーバー側で組み立てる
 */
/**
 * 学習者レベルに応じた語彙・文の複雑さガイドを返す。
 * 翻訳経路で会話経路の buildSystemPrompt のレベル制御に相当する役割を担う。
 */
function buildTranslationLevelInstruction(level: Level | undefined): string {
  switch (level) {
    case 'beginner':
      return 'Target learner level: BEGINNER (CEFR A1-A2). Use very simple, common vocabulary and short sentence structures. Avoid idioms, slang, and complex grammar.'
    case 'advanced':
      return 'Target learner level: ADVANCED (CEFR C1-C2). Use natural, varied expressions; idioms, slang, and nuanced phrasing with richer vocabulary are welcome.'
    case 'intermediate':
    default:
      return 'Target learner level: INTERMEDIATE (CEFR B1-B2). Use natural conversational tone. Common idioms are fine; avoid overly formal or overly slangy expressions.'
  }
}

export function buildTranslationSystemPrompt(level: Level | undefined): string {
  const levelInstruction = buildTranslationLevelInstruction(level)
  return `You are a translator helping a Japanese learner of English speak more naturally.

Your task: take the user's input (which may be Japanese only, or a mix of Japanese and English) and produce a single natural conversational English sentence that expresses what they meant — the sentence they should say out loud.

${levelInstruction}

Rules — follow these exactly:
- Output ONLY the English sentence. No quotes, no preamble like "Output:" or "Translation:", no explanation, no follow-up notes.
- Keep the meaning faithful to the original.
- Match the vocabulary and sentence complexity to the target learner level above.
- Do NOT respond to the content of the message. Just produce the English sentence.
- For mixed Japanese+English input: if the English portions are already natural and grammatical, keep them and only translate the Japanese parts. If the English portions are awkward or ungrammatical, REWRITE the whole sentence so it sounds natural to a native speaker. The result should always be a polished, native-sounding sentence.

Examples:
  Input: 今日は朝から雨で気分が下がっています
  Output: It's been raining since this morning, and it's bringing my mood down.

  Input: I want to eat 寿司 for dinner tonight
  Output: I want to eat sushi for dinner tonight.

  Input: I want eating 寿司 tonight
  Output: I want to eat sushi tonight.

  Input: 週末は友達と movie を見に行ったよ
  Output: I went to a movie with my friends over the weekend.

  Input: 明日は meeting があるんだ
  Output: I have a meeting tomorrow.`
}

/**
 * モデルが返す自然文の前置き(「Sure! Here's the translation: ...」「Translation: ...」
 * 「"..."」 等)を剥がして純粋な英文だけを残す。
 *
 * 順序が重要:
 *  1) 前置きを先に剥がす(同行 / 直後改行 どちらにも対応)
 *  2) 残りが複数行なら「最初の英語っぽい行」だけ採用する。
 *     ※ 末尾を拾うと "This is a natural way to say it." のような
 *     モデルの補足説明が翻訳結果として返ってしまうため、必ず先頭側を拾う。
 *  3) 全体を囲う引用符を剥がす
 */
export function stripTranslationPreamble(raw: string): string {
  let out = raw.trim()

  // 1) 典型的な前置きパターン(同行末コロン + オプションの直後改行)を順に剥がす。
  //    "Sure" / "Of course" / "OK" 等の interjection は単独では削らない:
  //    「もちろん行くよ」→ "Sure, I'll go." の "Sure," まで削ってしまうため。
  //    後続に "Here's the translation" / "I'd translate that as" / "Translation:"
  //    などの明確な前置きが続く場合だけ、合わせて剥がす。
  const INTERJECTION_PREFIX = '(?:(?:Sure|Of course|Certainly|Got it|Okay|OK)[!.,]?\\s+)?'
  // 前置きと本文を分ける区切り文字を「必須」にする:
  //   - ASCII コロン `:` (U+003A) / 全角コロン `:` (U+FF1A)
  //   - 改行
  //   - 直後に引用符(本文を囲っているケース。引用符は step 3 で剥がす)
  //
  // optional にすると `Here's my sentence.` のような正しい翻訳本文を
  // `Here's my sentence` までマッチして `.` だけ残してしまうリスクがある。
  const SEPARATOR = '(?:\\s*[:：]\\s*|\\s*\\n|\\s+(?=["\'「『]))'
  const PREAMBLE_PATTERNS: RegExp[] = [
    new RegExp(
      `^\\s*${INTERJECTION_PREFIX}Here\\s*(?:'s|is|are|you go)\\s+(?:the\\s+|my\\s+|a\\s+)?(?:suggested\\s+|natural\\s+)?(?:translation|English(?:\\s+version)?|version|sentence)${SEPARATOR}`,
      'i',
    ),
    new RegExp(
      `^\\s*${INTERJECTION_PREFIX}I\\s*(?:'d|would)\\s+(?:translate\\s+(?:that|it)\\s+as|say|put\\s+(?:that|it))${SEPARATOR}`,
      'i',
    ),
    new RegExp(
      `^\\s*${INTERJECTION_PREFIX}(?:The\\s+)?(?:Output|Translation|English|Answer|Result|In\\s+English)${SEPARATOR}`,
      'i',
    ),
  ]
  for (const pat of PREAMBLE_PATTERNS) {
    out = out.replace(pat, '').trim()
  }

  // 2) 残りが複数行なら、明らかにメタ説明と分かる行(Note:, This sentence...,
  //    括弧書き 等)を除外したうえで先頭の行を採用する。
  //    ASCII 比率では "I'm 30." のような短く数字を含む正しい翻訳を弾いて
  //    後続の説明文を拾うリスクがあるため、比率は使わない。
  //    一方 "This is ..." / "It means ..." / "That means ..." は翻訳本文として
  //    自然に出るため META 判定から外す(`This sentence`/`This phrase` 等の
  //    明確に説明と分かる表現のみを除外する)。
  if (out.includes('\n')) {
    const META_LINE_PATTERN =
      /^(Note|Notice|Tip|Explanation|Translation note|This (?:sentence|phrase|expression|translation|wording)|In other words|\(|\*|—|–)/i
    const lines = out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const line of lines) {
      if (!META_LINE_PATTERN.test(line)) {
        out = line
        break
      }
    }
  }

  // 3) 全体を囲う引用符/括弧を剥がす
  out = out.replace(/^["'「『]\s*|\s*["'」』]\s*$/g, '').trim()
  return out
}

export async function translateToNaturalEnglish(
  userText: string,
  options: { model?: string; level?: Level; numCtx?: number; signal?: AbortSignal },
): Promise<string> {
  const messages: OllamaChatMessage[] = [
    { role: 'system', content: buildTranslationSystemPrompt(options.level) },
    { role: 'user', content: userText },
  ]
  // 1 回失敗したら 1 回だけリトライ。瞬時の空応答で 502 を返さないための保険。
  //
  // 2 回目は温度を **下げて** seed を固定する。かつてはここだけ温度を上げていたが、
  // それは「同じ分布からの引き直し」= 独立した宝くじで、(a) 失敗が再現できない
  // (b) 運が悪ければ同じ壊れ方を繰り返す、という会話経路で潰したのと同じ欠陥。
  // 翻訳は決定的な 1 本が欲しい処理なので、なおさら上げる理由が無い。
  const attempts: { temperature: number; seed?: number }[] = [
    { temperature: 0.3 },
    { temperature: 0.1, seed: RETRY_SEED },
  ]
  let lastTranslated = ''
  for (const a of attempts) {
    const ollamaRes = await chatWithOllama(messages, {
      model: options.model,
      numCtx: options.numCtx,
      firstTokenTimeoutMs: 60_000,
      // 翻訳は再現性重視で低温度(会話経路の 0.85 より低い)。
      temperature: a.temperature,
      ...(a.seed !== undefined && { seed: a.seed }),
      topP: 0.9,
      numPredict: 300,
      // 自然文を返してほしいので Ollama の JSON モードを必ず OFF にする。
      // ここを忘れると format:'json' が送られてモデルが {"sentence":"..."}
      // のような JSON を返し、reply_en にそのまま入って UI 表示が壊れる。
      jsonFormat: false,
      signal: options.signal,
    })
    const raw = ollamaRes.message?.content ?? ''
    lastTranslated = stripTranslationPreamble(raw)
    if (lastTranslated) return lastTranslated
    console.warn(`[chat:translate] empty result at temperature=${a.temperature}; retrying`)
  }
  return lastTranslated
}

/**
 * 英文を自然な日本語に翻訳する。会話 LLM が reply_ja を省略した場合の補完用。
 * 「日本語訳を必ず表示」設定を保証するため、空のときだけ呼ぶ。
 */
const EN_TO_JA_SYSTEM_PROMPT = `You are a translator. Translate the given English sentence into natural, conversational Japanese.

Rules:
- Output ONLY the Japanese translation. No quotes, no preamble, no explanation, no romaji.
- Keep it natural and friendly, matching spoken Japanese.`

/**
 * 日本語訳として使ってよい文字列か確かめる。
 *
 * このプロンプトはプレーンテキストを求めているが、小型モデルは JSON
 * エンベロープ(`{"reply_ja": "..."}`)で返すことがある。そのまま通すと
 * **その JSON が日本語訳として画面に出て DB にも保存される**。
 * 中の reply_ja を拾えれば拾い、拾えなければ空にする(空 = 取得失敗として
 * 扱われ、UI に再取得ボタンが出る。JSON を見せるよりはるかにまし)。
 */
export function sanitizeJapaneseTranslation(raw: string): string {
  const stripped = stripTranslationPreamble(raw)
  if (!looksLikeJsonScaffold(stripped)) return stripped
  const inner = matchJsonStringField(stripped, 'reply_ja')
  if (inner?.trim()) return inner.trim()
  console.warn('[chat] en→ja 翻訳が JSON で返ってきたので破棄した')
  return ''
}

export async function translateEnglishToJapanese(
  englishText: string,
  options: { model?: string; numCtx?: number; signal?: AbortSignal },
): Promise<string> {
  const messages: OllamaChatMessage[] = [
    { role: 'system', content: EN_TO_JA_SYSTEM_PROMPT },
    { role: 'user', content: englishText },
  ]
  try {
    const ollamaRes = await chatWithOllama(messages, {
      model: options.model,
      numCtx: options.numCtx,
      firstTokenTimeoutMs: 60_000,
      temperature: 0.3,
      topP: 0.9,
      numPredict: 300,
      jsonFormat: false,
      signal: options.signal,
    })
    return sanitizeJapaneseTranslation(ollamaRes.message?.content ?? '')
  } catch (e) {
    // 中断は「失敗」ではない。空文字を返して先へ進むと、切れたソケットへ
    // レスポンスを組み立てる無駄な処理が続くので、呼び出し元へ投げ返す。
    if (e instanceof OllamaError && e.code === 'ABORTED') throw e
    console.warn('[chat] en→ja fallback translation failed:', e)
    return ''
  }
}

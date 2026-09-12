import { Router, type Request, type Response } from 'express'
import {
  buildOpeningUserPrompt,
  buildSystemPrompt,
  type Level,
  type Mode,
  type PersonalityPreset,
} from '../services/conversation-prompt.js'
import {
  chatWithOllama,
  OllamaError,
  RETRY_SEED,
  type ChatWithOllamaOptions,
  type OllamaChatMessage,
} from '../services/ollama.js'
import { extractJsonObjectSlice, matchJsonStringField } from '../services/json-salvage.js'

const MAX_HISTORY_TURNS = 10 // user + ai pairs to keep in context

/**
 * 生成トークン上限。**リトライで倍化しない**(フラット予算)。
 *
 * 旧実装は 500 → 1000 → 2000 と倍化していた。倍化は「length 切断で JSON が壊れた」
 * ケースを救うためのものだったが、
 *   - 切断された返答も返答としては使える(= salvage で拾える)
 *   - 倍化は「失敗するターンほど遅くなる」という最悪の性質を持つ
 * ため廃止した。失敗ターンの最悪生成量は 3500 → 1280 トークンになる。
 *
 * 640 の根拠(JSON エンベロープ最大構成の見積り。日本語は 1 文字 ≒ 1.5 トークン):
 *   reply_en 約 50 / reply_ja 約 120 / feedback(user_said+corrected+日本語 explanation)
 *   約 135 / vocabulary 3 件 約 180 / JSON のキー・記号 約 45  ≒ 530 トークン。
 * 旧初期値 500 はこの最大構成にわずかに足りず、それが倍化リトライを常態化させていた。
 * 640 は最大構成 + 約 20% の余裕で、典型ターン(feedback/vocab なし、約 200 トークン)
 * の速度には影響しない(num_predict は上限であって目標ではない)。
 */
const CHAT_NUM_PREDICT = 640

/** opening は feedback / vocabulary を出さない(= reply_en + reply_ja のみ)ので小さくてよい。 */
const OPENING_NUM_PREDICT = 400

/**
 * 1 ターンの試行設定。**2 回まで**。
 *
 * 2 回目は「同じ分布からの引き直し」ではなく、意図的に保守的なサンプルにする:
 * 温度を下げ、top_p / repeat_penalty も絞り、seed を固定する。
 * こうしないとリトライは独立した宝くじを引き直すだけで、失敗も再現できない。
 */
type AttemptSampling = Pick<
  ChatWithOllamaOptions,
  'temperature' | 'topP' | 'repeatPenalty' | 'seed'
>

/** リトライ時の温度。JSON の構造が崩れにくい側に寄せる。 */
const RETRY_TEMPERATURE = 0.5

const CHAT_ATTEMPTS: AttemptSampling[] = [
  // 1 回目: バリエーション重視(seed は ollama.ts 側でランダム)
  { temperature: 0.85, topP: 0.92, repeatPenalty: 1.15 },
  // 2 回目: 決定的で保守的な 1 本
  { temperature: RETRY_TEMPERATURE, topP: 0.85, repeatPenalty: 1.05, seed: RETRY_SEED },
]

const OPENING_ATTEMPTS: AttemptSampling[] = [
  // 挨拶はバリエーション最重視
  { temperature: 0.95, topP: 0.95, repeatPenalty: 1.2 },
  { temperature: RETRY_TEMPERATURE, topP: 0.85, repeatPenalty: 1.05, seed: RETRY_SEED },
]

/**
 * 会話経路の first-token 予算。
 *
 * 注意: 非ストリーミング経路では応答が一括で返るため、この予算は
 * 「最初のトークンまで」ではなく「生成完了まで」に効く。
 * 640 トークンの生成は低速機で 40〜60 秒かかり、keep_alive 失効後や
 * メモリ逼迫でモデルが evict されているとコールドロードが上乗せされる。
 * よって v1.1.0 と同じ 90 秒を維持する。
 * ストリーミング導入後は first-token と全体が分離するため、
 * ここを 60 秒へ下げ、stall 予算側で停止を検出する。
 */
const CHAT_FIRST_TOKEN_TIMEOUT_MS = 90_000

/**
 * opening だけは別枠で長め。セッション最初の LLM 呼び出しであり、
 * 8GB 機ではここだけモデルのコールドロード(数十秒)を確実に踏む。
 * ここを 60 秒にすると「動くはずの初回起動」を落としかねない。
 */
const OPENING_FIRST_TOKEN_TIMEOUT_MS = 90_000

interface HistoryItem {
  role: 'user' | 'ai'
  text: string
}

interface ChatContext {
  aiName?: string
  level?: Level
  topic?: string
  topicDescription?: string
  mode?: Mode
  vocabFocus?: string[]
  userProfile?: string[]
  lastConversationSummary?: string | null
  conversationHistory?: HistoryItem[]
  /** 明示的に指定されたLLMモデル(allowlist内のみ採用、それ以外は default) */
  model?: string
  /** AI の性格プリセット。未指定時は buildSystemPrompt 側で 'friendly' にフォールバック。 */
  personality?: PersonalityPreset
}

interface ChatRequestBody {
  userText?: string
  context?: ChatContext
}

interface Feedback {
  user_said: string
  corrected: string
  explanation: string
}

interface VocabItem {
  word: string
  meaning: string
  example?: string | null
}

interface ChatReply {
  reply_en: string
  reply_ja: string
  feedback: Feedback | null
  vocabulary: VocabItem[]
  mode: Mode
}

function isFeedback(x: unknown): x is Feedback {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  return (
    typeof r.user_said === 'string' &&
    typeof r.corrected === 'string' &&
    typeof r.explanation === 'string'
  )
}

// ひらがな / カタカナ / 漢字。explanation は設計上日本語なので判定対象に含めない。
const JP_CHAR_REGEX = /[぀-ゟ゠-ヿ一-龯]/

/**
 * normal モード(英語入力)の添削が妥当かを判定する。
 * 小型モデル(Llama 3.2 3B 等)は英語入力なのに「私の名前はショータです →
 * 私の名前はShotaです」のような日本語の添削を幻覚することがある。
 * 添削対象の英文(corrected)に日本語が混ざっていたらデタラメ添削とみなして破棄する。
 * (explanation は日本語が正常なので見ない。user_said も補助的にチェックする)
 */
function isValidEnglishFeedback(fb: Feedback): boolean {
  if (JP_CHAR_REGEX.test(fb.corrected)) return false
  if (JP_CHAR_REGEX.test(fb.user_said)) return false
  return true
}

function isVocabItem(x: unknown): x is VocabItem {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  return typeof r.word === 'string' && typeof r.meaning === 'string'
}

function parseChatReply(content: string, fallbackMode: Mode): ChatReply | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    // reply_en は必須。reply_ja は欠落/非文字列でも parse 失敗にせず空文字に正規化する。
    // (小型モデルが reply_ja を省略するケースを救い、後段の en→ja 補完に回すため)
    if (typeof parsed.reply_en !== 'string') {
      return null
    }
    const replyJa = typeof parsed.reply_ja === 'string' ? parsed.reply_ja : ''

    let feedback = isFeedback(parsed.feedback) ? parsed.feedback : null
    // 英語入力なのに日本語の添削が返ってきたら(小型モデルの幻覚)破棄する。
    if (feedback && !isValidEnglishFeedback(feedback)) {
      console.warn('[chat] dropping feedback with Japanese in corrected/user_said:', {
        user_said: feedback.user_said,
        corrected: feedback.corrected,
      })
      feedback = null
    }
    const vocabulary: VocabItem[] = Array.isArray(parsed.vocabulary)
      ? parsed.vocabulary
          .filter(isVocabItem)
          .slice(0, 3)
          .map((v) => ({
            word: v.word,
            meaning: v.meaning,
            example: v.example ?? null,
          }))
      : []

    const mode: Mode =
      parsed.mode === 'japanese_help' || parsed.mode === 'mixed' || parsed.mode === 'normal'
        ? parsed.mode
        : fallbackMode

    return {
      reply_en: parsed.reply_en,
      reply_ja: replyJa,
      feedback,
      vocabulary,
      mode,
    }
  } catch {
    return null
  }
}

/** salvage で受け入れる reply_en の最大長(これを超えるものは暴走出力とみなす)。 */
const MAX_SALVAGED_REPLY_LENGTH = 1200

/**
 * salvage した英文が「返答として出して恥ずかしくないか」を判定する。
 * ラテン文字を 1 つも含まない / 極端に短い / 極端に長いものは弾く。
 */
function isSaneSalvagedReplyEn(text: string): boolean {
  const t = text.trim()
  if (t.length < 2 || t.length > MAX_SALVAGED_REPLY_LENGTH) return false
  return /[A-Za-z]/.test(t)
}

/**
 * 厳密 parse に失敗した出力から、使える返答を救出する。
 *
 * リトライ(= もう一度フル生成を待たせる)より圧倒的に安い。小型モデルの失敗の
 * 大半は「返答自体は出来ているが包装が壊れている」ケースなので、まずここで拾う。
 *
 *  1) コードフェンス / 前置き付き → `{...}` を切り出して厳密 parse し直す
 *     (この経路なら feedback / vocabulary も含めて完全に復元できる)
 *  2) num_predict 上限で途中切断 → reply_en / reply_ja を正規表現で拾う
 *     (閉じ引用符まで揃っているものだけ。文の途中で切れた英文は採らない)
 *
 * 2) の経路では feedback / vocabulary は捨てて null / [] にする。
 * これらは JSON の後半に出るため切断時は信用できず、欠けても会話は成立するため。
 * レスポンスの形(ChatReply)は常に維持する。
 */
function salvageChatReply(content: string, fallbackMode: Mode): ChatReply | null {
  if (!content) return null

  // 1) 包装を剥がして厳密 parse
  const slice = extractJsonObjectSlice(content)
  if (slice) {
    const parsed = parseChatReply(slice, fallbackMode)
    if (parsed) return parsed
  }

  // 2) 切断された JSON から本文だけ拾う
  const replyEn = matchJsonStringField(content, 'reply_en')
  if (!replyEn || !isSaneSalvagedReplyEn(replyEn)) return null

  const replyJa = matchJsonStringField(content, 'reply_ja') ?? ''
  return {
    reply_en: replyEn.trim(),
    // reply_ja が切断されていれば空になる。呼び出し側の en→ja 補完が埋める。
    reply_ja: replyJa.trim().slice(0, MAX_SALVAGED_REPLY_LENGTH),
    feedback: null,
    vocabulary: [],
    mode: fallbackMode,
  }
}

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

function buildTranslationSystemPrompt(level: Level | undefined): string {
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
function stripTranslationPreamble(raw: string): string {
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

async function translateToNaturalEnglish(
  userText: string,
  options: { model?: string; level?: Level },
): Promise<string> {
  const messages: OllamaChatMessage[] = [
    { role: 'system', content: buildTranslationSystemPrompt(options.level) },
    { role: 'user', content: userText },
  ]
  // 1 回失敗したら温度を上げて 1 回だけリトライ。会話経路ほどタフな
  // リトライは不要だが、瞬時の空応答で 502 を返さないための保険。
  const attempts: { temperature: number }[] = [{ temperature: 0.3 }, { temperature: 0.6 }]
  let lastTranslated = ''
  for (const a of attempts) {
    const ollamaRes = await chatWithOllama(messages, {
      model: options.model,
      firstTokenTimeoutMs: 60_000,
      // 翻訳は再現性重視で低温度(会話経路の 0.85 より低い)。
      temperature: a.temperature,
      topP: 0.9,
      numPredict: 300,
      // 自然文を返してほしいので Ollama の JSON モードを必ず OFF にする。
      // ここを忘れると format:'json' が送られてモデルが {"sentence":"..."}
      // のような JSON を返し、reply_en にそのまま入って UI 表示が壊れる。
      jsonFormat: false,
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

async function translateEnglishToJapanese(
  englishText: string,
  options: { model?: string },
): Promise<string> {
  const messages: OllamaChatMessage[] = [
    { role: 'system', content: EN_TO_JA_SYSTEM_PROMPT },
    { role: 'user', content: englishText },
  ]
  try {
    const ollamaRes = await chatWithOllama(messages, {
      model: options.model,
      firstTokenTimeoutMs: 60_000,
      temperature: 0.3,
      topP: 0.9,
      numPredict: 300,
      jsonFormat: false,
    })
    return stripTranslationPreamble(ollamaRes.message?.content ?? '')
  } catch (e) {
    console.warn('[chat] en→ja fallback translation failed:', e)
    return ''
  }
}

export const chatRouter = Router()

chatRouter.post('/chat', async (req: Request, res: Response) => {
  const { userText, context = {} } = (req.body ?? {}) as ChatRequestBody

  if (typeof userText !== 'string' || userText.trim().length === 0) {
    return res.status(400).json({ error: 'userText is required (non-empty string)' })
  }

  const mode: Mode = context.mode ?? 'normal'

  // 翻訳モード(japanese_help / mixed)は会話 LLM 経路ではなく専用翻訳経路へ。
  // システムプロンプトで指示してもらうだけだと 3B クラスは無視して会話継続して
  // しまうため、ここで完全分離する。
  if (mode === 'japanese_help' || mode === 'mixed') {
    try {
      const translated = await translateToNaturalEnglish(userText, {
        model: context.model,
        level: context.level,
      })
      if (!translated) {
        console.warn('[chat:translate] empty translation result')
        return res.status(502).json({ error: 'Translation produced empty output.' })
      }
      return res.json({
        reply_en: translated,
        reply_ja: `「${translated}」と言えますよ。声に出して言ってみて!`,
        feedback: null,
        vocabulary: [],
        mode,
      })
    } catch (e) {
      if (e instanceof OllamaError) {
        if (e.code === 'NOT_RUNNING' || e.code === 'MODEL_NOT_FOUND' || e.code === 'TIMEOUT') {
          return res.status(503).json({ error: e.message, code: e.code })
        }
      }
      console.error('[chat:translate] unexpected error:', e)
      return res.status(500).json({ error: (e as Error).message })
    }
  }

  const systemPrompt = buildSystemPrompt({
    aiName: context.aiName,
    level: context.level,
    topic: context.topic,
    topicDescription: context.topicDescription,
    mode,
    vocabFocus: context.vocabFocus,
    userProfile: context.userProfile,
    lastConversationSummary: context.lastConversationSummary,
    personality: context.personality,
  })

  const messages: OllamaChatMessage[] = [{ role: 'system', content: systemPrompt }]

  // 直近のN往復を文脈として渡す
  const history = (context.conversationHistory ?? []).slice(-MAX_HISTORY_TURNS * 2)
  for (const h of history) {
    messages.push({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.text,
    })
  }

  messages.push({ role: 'user', content: userText })

  let lastRawContent: string | undefined

  for (let attempt = 1; attempt <= CHAT_ATTEMPTS.length; attempt++) {
    const sampling = CHAT_ATTEMPTS[attempt - 1]!
    try {
      const ollamaRes = await chatWithOllama(messages, {
        model: context.model,
        firstTokenTimeoutMs: CHAT_FIRST_TOKEN_TIMEOUT_MS,
        // 倍化しないフラット予算。切断は salvage で拾う。
        numPredict: CHAT_NUM_PREDICT,
        ...sampling,
      })
      lastRawContent = ollamaRes.message?.content ?? ''
      // 厳密 parse → ダメなら salvage。salvage で拾えたらリトライしない
      // (もう一度フル生成を待たせるより、包装が壊れただけの返答を使う方が速い)。
      let reply = parseChatReply(lastRawContent, mode)
      if (!reply) {
        reply = salvageChatReply(lastRawContent, mode)
        if (reply) {
          console.warn(
            `[chat] salvaged reply from malformed JSON (attempt ${attempt}/${CHAT_ATTEMPTS.length}).`,
          )
        }
      }
      if (reply) {
        // 会話 LLM が reply_ja を省略することがある(特に 3B)。
        // フロントの「日本語訳を必ず表示」を保証するため、reply_en があるのに
        // reply_ja が空なら en→ja で補完する。
        if (reply.reply_en?.trim() && !reply.reply_ja?.trim()) {
          reply.reply_ja = await translateEnglishToJapanese(reply.reply_en, {
            model: context.model,
          })
        }
        return res.json(reply)
      }
      console.warn(
        `[chat] JSON parse + salvage failed (attempt ${attempt}/${CHAT_ATTEMPTS.length}, ` +
          `numPredict=${CHAT_NUM_PREDICT}, temperature=${sampling.temperature}). raw=`,
        lastRawContent.slice(0, 200),
      )
    } catch (e) {
      if (e instanceof OllamaError) {
        if (e.code === 'NOT_RUNNING' || e.code === 'MODEL_NOT_FOUND' || e.code === 'TIMEOUT') {
          return res.status(503).json({ error: e.message, code: e.code })
        }
      }
      console.error('[chat] unexpected error:', e)
      return res.status(500).json({ error: (e as Error).message })
    }
  }

  return res.status(502).json({
    error: `Ollama did not return valid JSON after ${CHAT_ATTEMPTS.length} attempts.`,
    rawContent: lastRawContent,
  })
})

// 会話開始時に AI から最初に話しかけてもらうための endpoint。
// userText を受け取らず、合成プロンプトで AI に挨拶+話題切り出しを生成させる。
chatRouter.post('/chat/opening', async (req: Request, res: Response) => {
  const { context = {} } = (req.body ?? {}) as { context?: ChatContext }
  const mode: Mode = 'normal'

  const systemPrompt = buildSystemPrompt({
    aiName: context.aiName,
    level: context.level,
    topic: context.topic,
    topicDescription: context.topicDescription,
    mode,
    vocabFocus: context.vocabFocus,
    userProfile: context.userProfile,
    lastConversationSummary: context.lastConversationSummary,
    personality: context.personality,
  })

  const openingUserPrompt = buildOpeningUserPrompt({
    aiName: context.aiName,
    topic: context.topic,
    userProfile: context.userProfile,
    lastConversationSummary: context.lastConversationSummary,
    // personality を渡して opening の挨拶トーンを人格に合わせる。
    // system prompt と user prompt の双方を整合させないと、teacher などを
    // 選んだのに最初の一言だけ friend-like になる矛盾が出る。
    personality: context.personality,
  })

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: openingUserPrompt },
  ]

  let lastRawContent: string | undefined

  for (let attempt = 1; attempt <= OPENING_ATTEMPTS.length; attempt++) {
    const sampling = OPENING_ATTEMPTS[attempt - 1]!
    try {
      const ollamaRes = await chatWithOllama(messages, {
        model: context.model,
        firstTokenTimeoutMs: OPENING_FIRST_TOKEN_TIMEOUT_MS,
        // 倍化しないフラット予算。切断は salvage で拾う。
        numPredict: OPENING_NUM_PREDICT,
        ...sampling,
      })
      lastRawContent = ollamaRes.message?.content ?? ''
      let reply = parseChatReply(lastRawContent, mode)
      if (!reply) {
        reply = salvageChatReply(lastRawContent, mode)
        if (reply) {
          console.warn(
            `[chat/opening] salvaged reply from malformed JSON (attempt ${attempt}/${OPENING_ATTEMPTS.length}).`,
          )
        }
      }
      if (reply) {
        if (reply.reply_en?.trim() && !reply.reply_ja?.trim()) {
          reply.reply_ja = await translateEnglishToJapanese(reply.reply_en, {
            model: context.model,
          })
        }
        return res.json(reply)
      }
      console.warn(
        `[chat/opening] JSON parse + salvage failed (attempt ${attempt}/${OPENING_ATTEMPTS.length}, ` +
          `numPredict=${OPENING_NUM_PREDICT}, temperature=${sampling.temperature}). raw=`,
        lastRawContent.slice(0, 200),
      )
    } catch (e) {
      if (e instanceof OllamaError) {
        if (e.code === 'NOT_RUNNING' || e.code === 'MODEL_NOT_FOUND' || e.code === 'TIMEOUT') {
          return res.status(503).json({ error: e.message, code: e.code })
        }
      }
      console.error('[chat/opening] unexpected error:', e)
      return res.status(500).json({ error: (e as Error).message })
    }
  }

  return res.status(502).json({
    error: `Ollama did not return valid JSON after ${OPENING_ATTEMPTS.length} attempts.`,
    rawContent: lastRawContent,
  })
})

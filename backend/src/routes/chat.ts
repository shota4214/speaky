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
import { parseChatReply, salvageChatReply } from '../services/chat-reply.js'
import { endAborted, isAbortedError, watchClientAbort } from '../services/client-abort.js'
import { translateEnglishToJapanese, translateToNaturalEnglish } from '../services/translation.js'

export const MAX_HISTORY_TURNS = 10 // user + ai pairs to keep in context

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

export interface HistoryItem {
  role: 'user' | 'ai'
  text: string
}

export interface ChatContext {
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

export const chatRouter = Router()

chatRouter.post('/chat', async (req: Request, res: Response) => {
  const { userText, context = {} } = (req.body ?? {}) as ChatRequestBody

  if (typeof userText !== 'string' || userText.trim().length === 0) {
    return res.status(400).json({ error: 'userText is required (non-empty string)' })
  }

  // 会話を終えた瞬間に Ollama の生成も止める。signal を渡さないと
  // ブラウザ側の abort は「backend までの HTTP」しか切らず、生成は走り続ける。
  const { signal, dispose } = watchClientAbort(res)
  try {
    return await handleChatTurn(res, userText, context, signal)
  } finally {
    dispose()
  }
})

async function handleChatTurn(
  res: Response,
  userText: string,
  context: ChatContext,
  signal: AbortSignal,
): Promise<Response | void> {
  const mode: Mode = context.mode ?? 'normal'

  // 翻訳モード(japanese_help / mixed)は会話 LLM 経路ではなく専用翻訳経路へ。
  // システムプロンプトで指示してもらうだけだと 3B クラスは無視して会話継続して
  // しまうため、ここで完全分離する。
  if (mode === 'japanese_help' || mode === 'mixed') {
    try {
      const translated = await translateToNaturalEnglish(userText, {
        model: context.model,
        level: context.level,
        signal,
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
      // 中断はユーザー起因の正常系。タイムアウト扱いで 503 を返してはいけない。
      if (isAbortedError(e)) return endAborted(res)
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
    // 中断済みならもう 1 本生成を始めない(2 回目の attempt がゾンビ生成になる)。
    if (signal.aborted) return endAborted(res)
    const sampling = CHAT_ATTEMPTS[attempt - 1]!
    try {
      const ollamaRes = await chatWithOllama(messages, {
        model: context.model,
        firstTokenTimeoutMs: CHAT_FIRST_TOKEN_TIMEOUT_MS,
        // 倍化しないフラット予算。切断は salvage で拾う。
        numPredict: CHAT_NUM_PREDICT,
        signal,
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
            signal,
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
      if (isAbortedError(e)) return endAborted(res)
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
}

// 会話開始時に AI から最初に話しかけてもらうための endpoint。
// userText を受け取らず、合成プロンプトで AI に挨拶+話題切り出しを生成させる。
chatRouter.post('/chat/opening', async (req: Request, res: Response) => {
  const { context = {} } = (req.body ?? {}) as { context?: ChatContext }
  const { signal, dispose } = watchClientAbort(res)
  try {
    return await handleOpeningTurn(res, context, signal)
  } finally {
    dispose()
  }
})

async function handleOpeningTurn(
  res: Response,
  context: ChatContext,
  signal: AbortSignal,
): Promise<Response | void> {
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
    if (signal.aborted) return endAborted(res)
    const sampling = OPENING_ATTEMPTS[attempt - 1]!
    try {
      const ollamaRes = await chatWithOllama(messages, {
        model: context.model,
        firstTokenTimeoutMs: OPENING_FIRST_TOKEN_TIMEOUT_MS,
        // 倍化しないフラット予算。切断は salvage で拾う。
        numPredict: OPENING_NUM_PREDICT,
        signal,
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
            signal,
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
      if (isAbortedError(e)) return endAborted(res)
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
}

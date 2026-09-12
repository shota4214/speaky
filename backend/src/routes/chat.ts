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
import { endAborted, isClientAbort, watchClientAbort } from '../services/client-abort.js'
import { resolveTurnModelAndProfile, type ModelProfile } from '../services/model-profile.js'
import type { ModelProfilePref } from '../shared/llm-models.js'
import { OLLAMA_BUDGET_MS } from '../shared/request-budget.js'
import { translateEnglishToJapanese, translateToNaturalEnglish } from '../services/translation.js'

/**
 * プロンプトに載せる会話履歴の往復数の **上限**(standard の値)。
 * 実際に使う値はプロファイル(`ModelProfile.maxHistoryTurns`)側にあり、
 * small では 4 往復まで減る。ここは「これ以上は絶対に載せない」の天井。
 */
export const MAX_HISTORY_TURNS = 10 // user + ai pairs to keep in context

/**
 * 生成トークン上限は **プロファイル**(services/model-profile.ts)が持つ。
 * **リトライで倍化しない**(フラット予算)。
 *
 * 旧実装は 500 → 1000 → 2000 と倍化していた。倍化は「length 切断で JSON が壊れた」
 * ケースを救うためのものだったが、
 *   - 切断された返答も返答としては使える(= salvage で拾える)
 *   - 倍化は「失敗するターンほど遅くなる」という最悪の性質を持つ
 * ため廃止した。
 *
 * standard の 640 の根拠(JSON エンベロープ最大構成の見積り。日本語は 1 文字 ≒ 1.5 トークン):
 *   reply_en 約 50 / reply_ja 約 120 / feedback(user_said+corrected+日本語 explanation)
 *   約 135 / vocabulary 3 件 約 180 / JSON のキー・記号 約 45  ≒ 530 トークン。
 * 旧初期値 500 はこの最大構成にわずかに足りず、それが倍化リトライを常態化させていた。
 * 640 は最大構成 + 約 20% の余裕で、典型ターン(feedback/vocab なし、約 200 トークン)
 * の速度には影響しない(num_predict は上限であって目標ではない)。
 * small は feedback / vocabulary を出さない契約なので 320 で足りる。
 */

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

/** 2 回目(決定的で保守的な 1 本)はプロファイルに依らず共通。 */
const CONSERVATIVE_RETRY: AttemptSampling = {
  temperature: RETRY_TEMPERATURE,
  topP: 0.85,
  repeatPenalty: 1.05,
  seed: RETRY_SEED,
}

/**
 * ⚠️ attempts の **本数** は `shared/request-budget.ts` の OLLAMA_ATTEMPTS.chat と
 * 一致していなければならない(クライアント締め切りがそこから計算される)。
 * 本数を変えたら request-budget.ts も直すこと。ズレは request-budget.test.ts が落とす。
 */
export function chatAttempts(profile: ModelProfile): AttemptSampling[] {
  return [
    // 1 回目: プロファイルの既定(seed は ollama.ts 側でランダム)
    { temperature: profile.temperature, topP: profile.topP, repeatPenalty: profile.repeatPenalty },
    CONSERVATIVE_RETRY,
  ]
}

/** ⚠️ 本数は OLLAMA_ATTEMPTS.opening と一致させること(chatAttempts と同じ理由)。 */
export function openingAttempts(profile: ModelProfile): AttemptSampling[] {
  return [
    // 挨拶はバリエーション最重視(standard 0.95 / small 0.8)
    {
      temperature: profile.openingTemperature,
      topP: Math.min(profile.topP + 0.03, 0.95),
      repeatPenalty: profile.repeatPenalty + 0.05,
    },
    CONSERVATIVE_RETRY,
  ]
}

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
 *
 * ⚠️ **値は `shared/request-budget.ts` が持つ**。クライアント側の締め切りは
 * この予算 × attempt 数 + 翻訳 1 回から計算されており、ここだけ直すと
 * 「backend より先にクライアントが諦める」状態に戻る(v1.1.0 の事故)。
 */
const CHAT_FIRST_TOKEN_TIMEOUT_MS = OLLAMA_BUDGET_MS.chat

/**
 * opening だけは別枠で長め。セッション最初の LLM 呼び出しであり、
 * 8GB 機ではここだけモデルのコールドロード(数十秒)を確実に踏む。
 * ここを 60 秒にすると「動くはずの初回起動」を落としかねない。
 */
const OPENING_FIRST_TOKEN_TIMEOUT_MS = OLLAMA_BUDGET_MS.opening

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
  /**
   * 会話プロファイルの指定。'auto'(既定)はモデル名のパラメータ数から推定する。
   * 推定は **backend が唯一の出典**(shared/llm-models.ts)。
   */
  modelProfile?: ModelProfilePref
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
  // プロファイルはこのターンで 1 回だけ解決する(翻訳経路と会話経路で
  // 別々に解決すると、将来どちらかだけ条件が変わったときに静かに食い違う)。
  // ⚠️ **リクエストされた名前ではなく解決後の名前**から決めること。
  // allowlist で落ちた名前(古い設定に残った mistral:7b 等)をそのまま渡すと、
  // 実際に走るのは同梱 1B なのに 7B 用の長いプロンプトで回してしまい、
  // 設定画面のプレビュー(解決後の名前で判定)とも食い違う。
  const { profile } = resolveTurnModelAndProfile(context.modelProfile, context.model)

  // 翻訳モード(japanese_help / mixed)は会話 LLM 経路ではなく専用翻訳経路へ。
  // システムプロンプトで指示してもらうだけだと 3B クラスは無視して会話継続して
  // しまうため、ここで完全分離する。
  if (mode === 'japanese_help' || mode === 'mixed') {
    try {
      const translated = await translateToNaturalEnglish(userText, {
        model: context.model,
        level: context.level,
        numCtx: profile.numCtx,
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
        // ストリーミング側の meta と揃える。ここを落とすと、日本語入力の
        // ターンだけクライアントのプロファイル表示が更新されない。
        profile: profile.level,
      })
    } catch (e) {
      // 中断はユーザー起因の正常系。タイムアウト扱いで 503 を返してはいけない。
      if (isClientAbort(e, signal)) return endAborted(res)
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
    profile: profile.promptVariant,
  })

  const messages: OllamaChatMessage[] = [{ role: 'system', content: systemPrompt }]

  // 直近のN往復を文脈として渡す(プロファイルごとの上限。天井は MAX_HISTORY_TURNS)
  const historyTurns = Math.min(profile.maxHistoryTurns, MAX_HISTORY_TURNS)
  const history = (context.conversationHistory ?? []).slice(-historyTurns * 2)
  for (const h of history) {
    messages.push({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.text,
    })
  }

  messages.push({ role: 'user', content: userText })

  const attempts = chatAttempts(profile)
  let lastRawContent: string | undefined

  for (let attempt = 1; attempt <= attempts.length; attempt++) {
    // 中断済みならもう 1 本生成を始めない(2 回目の attempt がゾンビ生成になる)。
    if (signal.aborted) return endAborted(res)
    const sampling = attempts[attempt - 1]!
    try {
      const ollamaRes = await chatWithOllama(messages, {
        model: context.model,
        firstTokenTimeoutMs: CHAT_FIRST_TOKEN_TIMEOUT_MS,
        // 倍化しないフラット予算。切断は salvage で拾う。
        numPredict: profile.chatNumPredict,
        numCtx: profile.numCtx,
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
            `[chat] salvaged reply from malformed JSON (attempt ${attempt}/${attempts.length}).`,
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
            numCtx: profile.numCtx,
            signal,
          })
        }
        // どのプロファイルで動いたかをクライアントへ返す(UI の「軽量モード」表示用)。
        return res.json({ ...reply, profile: profile.level })
      }
      console.warn(
        `[chat] JSON parse + salvage failed (attempt ${attempt}/${attempts.length}, ` +
          `profile=${profile.level}, numPredict=${profile.chatNumPredict}, ` +
          `temperature=${sampling.temperature}). raw=`,
        lastRawContent.slice(0, 200),
      )
    } catch (e) {
      if (isClientAbort(e, signal)) return endAborted(res)
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
    error: `Ollama did not return valid JSON after ${attempts.length} attempts.`,
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
  const { profile } = resolveTurnModelAndProfile(context.modelProfile, context.model)

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
    profile: profile.promptVariant,
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
    profile: profile.promptVariant,
  })

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: openingUserPrompt },
  ]

  const attempts = openingAttempts(profile)
  let lastRawContent: string | undefined

  for (let attempt = 1; attempt <= attempts.length; attempt++) {
    if (signal.aborted) return endAborted(res)
    const sampling = attempts[attempt - 1]!
    try {
      const ollamaRes = await chatWithOllama(messages, {
        model: context.model,
        firstTokenTimeoutMs: OPENING_FIRST_TOKEN_TIMEOUT_MS,
        // 倍化しないフラット予算。切断は salvage で拾う。
        numPredict: profile.openingNumPredict,
        numCtx: profile.numCtx,
        signal,
        ...sampling,
      })
      lastRawContent = ollamaRes.message?.content ?? ''
      let reply = parseChatReply(lastRawContent, mode)
      if (!reply) {
        reply = salvageChatReply(lastRawContent, mode)
        if (reply) {
          console.warn(
            `[chat/opening] salvaged reply from malformed JSON (attempt ${attempt}/${attempts.length}).`,
          )
        }
      }
      if (reply) {
        if (reply.reply_en?.trim() && !reply.reply_ja?.trim()) {
          reply.reply_ja = await translateEnglishToJapanese(reply.reply_en, {
            model: context.model,
            numCtx: profile.numCtx,
            signal,
          })
        }
        return res.json({ ...reply, profile: profile.level })
      }
      console.warn(
        `[chat/opening] JSON parse + salvage failed (attempt ${attempt}/${attempts.length}, ` +
          `profile=${profile.level}, numPredict=${profile.openingNumPredict}, ` +
          `temperature=${sampling.temperature}). raw=`,
        lastRawContent.slice(0, 200),
      )
    } catch (e) {
      if (isClientAbort(e, signal)) return endAborted(res)
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
    error: `Ollama did not return valid JSON after ${attempts.length} attempts.`,
    rawContent: lastRawContent,
  })
}

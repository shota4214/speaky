import { Router, type Request, type Response } from 'express'
import {
  buildOpeningUserPrompt,
  buildSystemPrompt,
  type Level,
  type Mode,
  type PersonalityPreset,
} from '../services/conversation-prompt.js'
import { chatWithOllama, OllamaError, type OllamaChatMessage } from '../services/ollama.js'

const MAX_RETRIES = 3
const MAX_HISTORY_TURNS = 10 // user + ai pairs to keep in context

// reply_en + reply_ja + feedback + 最大3件 vocabulary + JSONオーバーヘッドの上限を
// 安全側に見積もり、220 では足りないケースが出るので 500 を初期値にする。
// リトライ時はさらに倍化(500 → 1000 → 2000)し、length 切断による失敗を確実に救う。
const CHAT_BASE_NUM_PREDICT = 500
const OPENING_BASE_NUM_PREDICT = 400

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

function isVocabItem(x: unknown): x is VocabItem {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  return typeof r.word === 'string' && typeof r.meaning === 'string'
}

function parseChatReply(content: string, fallbackMode: Mode): ChatReply | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (typeof parsed.reply_en !== 'string' || typeof parsed.reply_ja !== 'string') {
      return null
    }

    const feedback = isFeedback(parsed.feedback) ? parsed.feedback : null
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
      reply_ja: parsed.reply_ja,
      feedback,
      vocabulary,
      mode,
    }
  } catch {
    return null
  }
}

export const chatRouter = Router()

chatRouter.post('/chat', async (req: Request, res: Response) => {
  const { userText, context = {} } = (req.body ?? {}) as ChatRequestBody

  if (typeof userText !== 'string' || userText.trim().length === 0) {
    return res.status(400).json({ error: 'userText is required (non-empty string)' })
  }

  const mode: Mode = context.mode ?? 'normal'
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

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // length 切断対策: リトライごとに上限を倍化(500 → 1000 → 2000)
    const numPredict = CHAT_BASE_NUM_PREDICT * (1 << (attempt - 1))
    try {
      const ollamaRes = await chatWithOllama(messages, {
        model: context.model,
        timeoutMs: 90_000,
        // バリエーション重視: 高め temperature + 繰り返しペナルティ
        temperature: 0.85,
        topP: 0.92,
        repeatPenalty: 1.15,
        numPredict,
      })
      lastRawContent = ollamaRes.message?.content ?? ''
      const reply = parseChatReply(lastRawContent, mode)
      if (reply) {
        return res.json(reply)
      }
      console.warn(
        `[chat] JSON parse failed (attempt ${attempt}/${MAX_RETRIES}, numPredict=${numPredict}). raw=`,
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
    error: `Ollama did not return valid JSON after ${MAX_RETRIES} attempts.`,
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

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // length 切断対策: リトライごとに倍化(400 → 800 → 1600)
    const numPredict = OPENING_BASE_NUM_PREDICT * (1 << (attempt - 1))
    try {
      const ollamaRes = await chatWithOllama(messages, {
        model: context.model,
        timeoutMs: 90_000,
        // 挨拶はバリエーション最重視
        temperature: 0.95,
        topP: 0.95,
        repeatPenalty: 1.2,
        numPredict,
      })
      lastRawContent = ollamaRes.message?.content ?? ''
      const reply = parseChatReply(lastRawContent, mode)
      if (reply) return res.json(reply)
      console.warn(
        `[chat/opening] JSON parse failed (attempt ${attempt}/${MAX_RETRIES}, numPredict=${numPredict}). raw=`,
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
    error: `Ollama did not return valid JSON after ${MAX_RETRIES} attempts.`,
    rawContent: lastRawContent,
  })
})

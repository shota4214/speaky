import { Router, type Request, type Response } from 'express'
import {
  buildSystemPrompt,
  type Level,
  type Mode,
} from '../services/conversation-prompt'
import {
  chatWithOllama,
  OllamaError,
  type OllamaChatMessage,
} from '../services/ollama'

const MAX_RETRIES = 3
const MAX_HISTORY_TURNS = 10 // user + ai pairs to keep in context

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
    if (
      typeof parsed.reply_en !== 'string' ||
      typeof parsed.reply_ja !== 'string'
    ) {
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
      parsed.mode === 'japanese_help' ||
      parsed.mode === 'mixed' ||
      parsed.mode === 'normal'
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
    return res
      .status(400)
      .json({ error: 'userText is required (non-empty string)' })
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
  })

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ]

  // 直近のN往復を文脈として渡す
  const history = (context.conversationHistory ?? []).slice(
    -MAX_HISTORY_TURNS * 2,
  )
  for (const h of history) {
    messages.push({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.text,
    })
  }

  messages.push({ role: 'user', content: userText })

  let lastRawContent: string | undefined

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const ollamaRes = await chatWithOllama(messages)
      lastRawContent = ollamaRes.message?.content ?? ''
      const reply = parseChatReply(lastRawContent, mode)
      if (reply) {
        return res.json(reply)
      }
      console.warn(
        `[chat] JSON parse failed (attempt ${attempt}/${MAX_RETRIES}). raw=`,
        lastRawContent.slice(0, 200),
      )
    } catch (e) {
      if (e instanceof OllamaError) {
        if (e.code === 'NOT_RUNNING' || e.code === 'MODEL_NOT_FOUND') {
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

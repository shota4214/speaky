import { Router, type Request, type Response } from 'express'
import {
  chatWithOllama,
  OllamaError,
  type OllamaChatMessage,
} from '../services/ollama'

const SYSTEM_PROMPT = `You are a friendly native English-speaking friend.
Respond ONLY with valid JSON in this exact format: {"reply_en": "...", "reply_ja": "..."}.
reply_en is your English response (1-2 short, friendly sentences). reply_ja is its Japanese translation.`

const MAX_RETRIES = 3

type ChatRequestBody = {
  userText?: string
}

type ChatReply = {
  reply_en: string
  reply_ja: string
}

function parseChatReply(content: string): ChatReply | null {
  try {
    const parsed = JSON.parse(content) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'reply_en' in parsed &&
      'reply_ja' in parsed &&
      typeof (parsed as ChatReply).reply_en === 'string' &&
      typeof (parsed as ChatReply).reply_ja === 'string'
    ) {
      return parsed as ChatReply
    }
    return null
  } catch {
    return null
  }
}

export const chatRouter = Router()

chatRouter.post('/chat', async (req: Request, res: Response) => {
  const { userText } = (req.body ?? {}) as ChatRequestBody

  if (typeof userText !== 'string' || userText.trim().length === 0) {
    return res
      .status(400)
      .json({ error: 'userText is required (non-empty string)' })
  }

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userText },
  ]

  let lastRawContent: string | undefined

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const ollamaRes = await chatWithOllama(messages)
      lastRawContent = ollamaRes.message?.content ?? ''
      const reply = parseChatReply(lastRawContent)
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
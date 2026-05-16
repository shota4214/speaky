import { Router, type Request, type Response } from 'express'
import { chatWithOllama, OllamaError, type OllamaChatMessage } from '../services/ollama.js'

interface TranscriptItem {
  role: 'user' | 'ai'
  text: string
}

interface ExtractFactsBody {
  transcript?: TranscriptItem[]
  existingFacts?: string[]
  existingName?: string | null
  model?: string
}

interface ExtractFactsResult {
  newFacts: string[]
  updatedName: string | null
}

const SYSTEM_PROMPT = `You are an assistant that extracts user information from English conversation transcripts.
Given the transcript between a Japanese English learner (the user) and an AI tutor, find any NEW factual information the user explicitly shared about themselves.

Output JSON ONLY in this exact format:
{ "newFacts": ["..."], "updatedName": "..." | null }

Rules:
- newFacts: list of facts in **Japanese**, concise sentences. e.g., "Web開発者として働いている", "京都に住んでいる", "犬を飼っている"
- Skip facts that already exist in the user's known profile (provided to you).
- Skip vague or temporary statements (e.g., "今日は疲れた").
- Skip things said by the AI (only count things said by the user).
- updatedName: if the user revealed their name AND the existing name is null/empty, include the name. Otherwise null.
- If no new facts, output: { "newFacts": [], "updatedName": null }`

export const extractFactsRouter = Router()

extractFactsRouter.post('/extract-facts', async (req: Request, res: Response) => {
  const {
    transcript,
    existingFacts = [],
    existingName,
    model,
  } = (req.body ?? {}) as ExtractFactsBody

  if (!Array.isArray(transcript) || transcript.length === 0) {
    return res.status(400).json({ error: 'transcript is required (non-empty array)' })
  }

  const dialogText = transcript
    .map((t) => `${t.role === 'user' ? 'User' : 'AI'}: ${t.text}`)
    .join('\n')

  const userPrompt = `Existing known facts about the user:
${existingFacts.length > 0 ? existingFacts.map((f) => `- ${f}`).join('\n') : '(none)'}

Existing known name: ${existingName ?? '(unknown)'}

Transcript:
${dialogText}

Extract new facts the user revealed in this transcript.`

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ]

  try {
    const ollamaRes = await chatWithOllama(messages, {
      jsonFormat: true,
      model,
      timeoutMs: 60_000,
      // 事実抽出は安定性重視: 低 temperature
      temperature: 0.2,
      topP: 0.8,
    })
    const raw = ollamaRes.message?.content ?? ''
    try {
      const parsed = JSON.parse(raw) as ExtractFactsResult
      const newFacts = Array.isArray(parsed.newFacts)
        ? parsed.newFacts.filter((f): f is string => typeof f === 'string' && f.length > 0)
        : []
      const updatedName =
        typeof parsed.updatedName === 'string' && parsed.updatedName.length > 0
          ? parsed.updatedName
          : null
      return res.json({ newFacts, updatedName })
    } catch {
      return res.json({ newFacts: [], updatedName: null })
    }
  } catch (e) {
    if (e instanceof OllamaError) {
      if (e.code === 'NOT_RUNNING' || e.code === 'MODEL_NOT_FOUND' || e.code === 'TIMEOUT') {
        return res.status(503).json({ error: e.message, code: e.code })
      }
    }
    console.error('[extract-facts] error:', e)
    return res.status(500).json({ error: (e as Error).message })
  }
})

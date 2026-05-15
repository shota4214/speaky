import type { Level, Mode, VocabItem } from '../db/types'

export interface TranscribeResult {
  text: string
  language: 'en' | 'ja' | 'mixed' | 'unknown'
  durationMs: number
}

export interface ChatHistoryItem {
  role: 'user' | 'ai'
  text: string
}

export interface ChatRequestContext {
  aiName?: string
  level?: Level
  topic?: string
  topicDescription?: string
  mode?: Mode
  vocabFocus?: string[]
  userProfile?: string[]
  lastConversationSummary?: string | null
  conversationHistory?: ChatHistoryItem[]
}

export interface FeedbackResponse {
  user_said: string
  corrected: string
  explanation: string
}

export interface ChatReply {
  reply_en: string
  reply_ja: string
  feedback: FeedbackResponse | null
  vocabulary: VocabItem[]
  mode: Mode
}

export class ApiError extends Error {
  status: number
  code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function asJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  if (!res.ok) {
    let code: string | undefined
    let message = `HTTP ${res.status}`
    try {
      const data = JSON.parse(text) as { error?: string; code?: string }
      message = data.error ?? message
      code = data.code
    } catch {
      message = text || message
    }
    throw new ApiError(res.status, message, code)
  }
  return JSON.parse(text) as T
}

export async function transcribeAudio(
  blob: Blob,
  filename = 'recording.webm',
): Promise<TranscribeResult> {
  const form = new FormData()
  form.append('audio', blob, filename)
  const res = await fetch('/api/transcribe', { method: 'POST', body: form })
  return asJson<TranscribeResult>(res)
}

export async function chat(
  userText: string,
  context: ChatRequestContext = {},
): Promise<ChatReply> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userText, context }),
  })
  return asJson<ChatReply>(res)
}

export async function summarize(
  transcript: ChatHistoryItem[],
  topic?: string,
): Promise<{ summary: string }> {
  const res = await fetch('/api/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, topic }),
  })
  return asJson<{ summary: string }>(res)
}

export interface ExtractFactsResult {
  newFacts: string[]
  updatedName: string | null
}

export async function extractFacts(
  transcript: ChatHistoryItem[],
  existingFacts: string[],
  existingName: string | null,
): Promise<ExtractFactsResult> {
  const res = await fetch('/api/extract-facts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, existingFacts, existingName }),
  })
  return asJson<ExtractFactsResult>(res)
}

export interface OllamaHealth {
  ok: boolean
  baseUrl?: string
  models?: string[]
  defaultModel?: string
  hasDefaultModel?: boolean
  error?: string
}

export async function checkOllamaHealth(): Promise<OllamaHealth> {
  try {
    const res = await fetch('/api/health/ollama')
    return (await res.json()) as OllamaHealth
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

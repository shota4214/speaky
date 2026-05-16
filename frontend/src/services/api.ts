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
  /** 使用するLLMモデル(allowlist内のみサーバ側で採用) */
  model?: string
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
  options: {
    filename?: string
    model?: string
    signal?: AbortSignal
  } = {},
): Promise<TranscribeResult> {
  const form = new FormData()
  form.append('audio', blob, options.filename ?? 'recording.webm')
  if (options.model) form.append('model', options.model)
  const res = await fetch('/api/transcribe', {
    method: 'POST',
    body: form,
    signal: options.signal,
  })
  return asJson<TranscribeResult>(res)
}

export async function chat(
  userText: string,
  context: ChatRequestContext = {},
  options: { signal?: AbortSignal } = {},
): Promise<ChatReply> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userText, context }),
    signal: options.signal,
  })
  return asJson<ChatReply>(res)
}

export async function summarize(
  transcript: ChatHistoryItem[],
  topic?: string,
  options: { model?: string; signal?: AbortSignal } = {},
): Promise<{ summary: string }> {
  const res = await fetch('/api/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, topic, model: options.model }),
    signal: options.signal,
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
  options: { model?: string; signal?: AbortSignal } = {},
): Promise<ExtractFactsResult> {
  const res = await fetch('/api/extract-facts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transcript,
      existingFacts,
      existingName,
      model: options.model,
    }),
    signal: options.signal,
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

// ----- Admin token (for management API auth) -----

let _adminTokenCache: string | null = null

export async function fetchAdminToken(force = false): Promise<string> {
  if (_adminTokenCache && !force) return _adminTokenCache
  const res = await fetch('/api/auth/admin-token')
  const data = await asJson<{ token: string }>(res)
  _adminTokenCache = data.token
  return _adminTokenCache
}

async function adminHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await fetchAdminToken()
  return { 'X-Admin-Token': token, ...extra }
}

export interface InstalledModel {
  name: string
  sizeBytes: number
  sizeMB: number
  modifiedAt: string
}

export interface OllamaModelsResponse {
  models: InstalledModel[]
  defaultModel: string
}

export interface WhisperModelsResponse {
  models: InstalledModel[]
  dir: string
}

export async function listOllamaModels(): Promise<OllamaModelsResponse> {
  const res = await fetch('/api/models/ollama')
  return asJson<OllamaModelsResponse>(res)
}

export async function deleteOllamaModel(name: string): Promise<void> {
  const res = await fetch(`/api/models/ollama/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: await adminHeaders(),
  })
  await asJson<{ ok: boolean }>(res)
}

export async function listWhisperModels(): Promise<WhisperModelsResponse> {
  const res = await fetch('/api/models/whisper')
  return asJson<WhisperModelsResponse>(res)
}

export async function deleteWhisperModel(filename: string): Promise<void> {
  const res = await fetch(`/api/models/whisper/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
    headers: await adminHeaders(),
  })
  await asJson<{ ok: boolean }>(res)
}

// ----- SSE Streaming download / build helpers -----

async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error('No response body for SSE')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)

        for (const line of event.split('\n')) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (!data) continue
          try {
            yield JSON.parse(data) as Record<string, unknown>
          } catch {
            // skip
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export interface OllamaPullProgress {
  status?: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}

export async function pullOllamaModel(
  name: string,
  onProgress: (p: OllamaPullProgress) => void,
): Promise<void> {
  const res = await fetch('/api/models/ollama/pull', {
    method: 'POST',
    headers: await adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name }),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  }
  for await (const event of parseSSE(res)) {
    const p = event as OllamaPullProgress
    onProgress(p)
    if (p.error) throw new Error(p.error)
  }
}

export interface WhisperDownloadProgress {
  status?: string
  completed?: number
  total?: number
  error?: string
}

export async function downloadWhisperModelStream(
  name: string,
  onProgress: (p: WhisperDownloadProgress) => void,
): Promise<void> {
  const res = await fetch('/api/models/whisper/download', {
    method: 'POST',
    headers: await adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name }),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  }
  for await (const event of parseSSE(res)) {
    const p = event as WhisperDownloadProgress
    onProgress(p)
    if (p.error) throw new Error(p.error)
  }
}

export interface WhisperCppStatus {
  built: boolean
  dir: string
}

export async function getWhisperCppStatus(): Promise<WhisperCppStatus> {
  const res = await fetch('/api/setup/whisper-cpp-status')
  return asJson<WhisperCppStatus>(res)
}

export interface WhisperBuildProgress {
  step?: string
  status?: string
  stdout?: string
  stderr?: string
  command?: string
  error?: string
}

export async function buildWhisperCpp(
  onProgress: (p: WhisperBuildProgress) => void,
): Promise<void> {
  const res = await fetch('/api/setup/build-whisper-cpp', {
    method: 'POST',
    headers: await adminHeaders(),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  }
  for await (const event of parseSSE(res)) {
    const p = event as WhisperBuildProgress
    onProgress(p)
    if (p.error) throw new Error(p.error)
  }
}

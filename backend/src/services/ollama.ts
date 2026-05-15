const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma2:9b'

export type OllamaChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type OllamaChatRequest = {
  model: string
  messages: OllamaChatMessage[]
  format?: 'json'
  stream?: boolean
  options?: { temperature?: number }
}

export type OllamaChatResponse = {
  model: string
  created_at: string
  message: { role: string; content: string }
  done: boolean
}

export type OllamaErrorCode = 'NOT_RUNNING' | 'MODEL_NOT_FOUND' | 'UNKNOWN'

export class OllamaError extends Error {
  constructor(
    public code: OllamaErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'OllamaError'
  }
}

export interface ChatWithOllamaOptions {
  jsonFormat?: boolean
  temperature?: number
}

export async function chatWithOllama(
  messages: OllamaChatMessage[],
  options: ChatWithOllamaOptions = {},
): Promise<OllamaChatResponse> {
  const jsonFormat = options.jsonFormat ?? true
  const temperature = options.temperature ?? 0.7

  let response: Response
  try {
    const body: OllamaChatRequest = {
      model: OLLAMA_MODEL,
      messages,
      stream: false,
      options: { temperature },
    }
    if (jsonFormat) body.format = 'json'

    response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new OllamaError(
      'NOT_RUNNING',
      `Ollamaに接続できませんでした(${OLLAMA_BASE_URL})。'ollama serve' で起動してください。`,
      e,
    )
  }

  if (!response.ok) {
    const text = await response.text()
    const looksLikeModelMissing =
      response.status === 404 || /model.*not found/i.test(text)
    if (looksLikeModelMissing) {
      throw new OllamaError(
        'MODEL_NOT_FOUND',
        `モデル '${OLLAMA_MODEL}' が見つかりません。'ollama pull ${OLLAMA_MODEL}' で取得してください。`,
        text,
      )
    }
    throw new OllamaError('UNKNOWN', `Ollama APIエラー: ${response.status} ${text}`, text)
  }

  return (await response.json()) as OllamaChatResponse
}

export const ollamaConfig = {
  baseUrl: OLLAMA_BASE_URL,
  model: OLLAMA_MODEL,
}
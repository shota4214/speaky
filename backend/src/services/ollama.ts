const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2:3b'

// 許可するLLMモデルの allowlist。フロントから指定された場合のみ
// この中に含まれていなければ default にフォールバック。
export const ALLOWED_LLM_MODELS = new Set<string>([
  'llama3.2:3b',
  'llama3.1:8b',
  'gemma2:9b',
  'gemma2:2b',
  'qwen2.5:7b',
  'qwen2.5:14b',
])

export function resolveLlmModel(requested?: string): string {
  if (requested && ALLOWED_LLM_MODELS.has(requested)) return requested
  return OLLAMA_MODEL
}

export type OllamaChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type OllamaChatRequest = {
  model: string
  messages: OllamaChatMessage[]
  format?: 'json'
  stream?: boolean
  options?: {
    temperature?: number
    top_p?: number
    top_k?: number
    seed?: number
    repeat_penalty?: number
    num_predict?: number
  }
}

export type OllamaChatResponse = {
  model: string
  created_at: string
  message: { role: string; content: string }
  done: boolean
}

export type OllamaErrorCode = 'NOT_RUNNING' | 'MODEL_NOT_FOUND' | 'TIMEOUT' | 'UNKNOWN'

export class OllamaError extends Error {
  code: OllamaErrorCode
  details?: unknown
  constructor(code: OllamaErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'OllamaError'
    this.code = code
    this.details = details
  }
}

export interface ChatWithOllamaOptions {
  jsonFormat?: boolean
  temperature?: number
  /** nucleus sampling: 0.0-1.0. 高いほど候補が広い。デフォルト 0.9 */
  topP?: number
  /** Top-K サンプリング。0で無効化。デフォルト 40 */
  topK?: number
  /** 同じ入力でも異なる結果を得るための seed。省略時は毎回ランダム */
  seed?: number
  /** 繰り返しペナルティ。1.1 程度で同じフレーズの再使用を抑制 */
  repeatPenalty?: number
  /**
   * 生成する最大トークン数。短く切ることで応答速度が上がる。
   * 現在の運用値(routes 側で設定):
   * - /chat:           初期 500 → リトライで 1000 → 2000(length 切断時の自動倍化)
   * - /chat/opening:   初期 400 → リトライで 800 → 1600(同上)
   * - /summarize:      300(plain text なので切断 = 短い要約)
   * - /extract-facts:  初期 700 → 失敗時 1400(JSON が事実多数で切れることがあるため大きめ)
   * デフォルトは未指定(モデルの判断、長くなりがち)
   */
  numPredict?: number
  model?: string
  /** タイムアウト (ms)。0で無効化。デフォルト90秒 */
  timeoutMs?: number
  /** 外部から渡せる AbortSignal(UIキャンセル用) */
  signal?: AbortSignal
}

export async function chatWithOllama(
  messages: OllamaChatMessage[],
  options: ChatWithOllamaOptions = {},
): Promise<OllamaChatResponse> {
  const jsonFormat = options.jsonFormat ?? true
  const temperature = options.temperature ?? 0.7
  const topP = options.topP ?? 0.9
  const topK = options.topK ?? 40
  const repeatPenalty = options.repeatPenalty ?? 1.1
  // 同じプロンプトでも毎回違う返答を引き出すため、seed を毎回ランダム化。
  // 固定したい場合は呼び出し側で seed を渡す。
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31)
  const model = resolveLlmModel(options.model)
  const timeoutMs = options.timeoutMs ?? 90_000

  const ctrl = new AbortController()
  const timeoutId = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null

  // 外部signalがある場合はそれにもチェーン
  if (options.signal) {
    if (options.signal.aborted) ctrl.abort()
    else options.signal.addEventListener('abort', () => ctrl.abort(), { once: true })
  }

  let response: Response
  try {
    const body: OllamaChatRequest = {
      model,
      messages,
      stream: false,
      options: {
        temperature,
        top_p: topP,
        top_k: topK,
        seed,
        repeat_penalty: repeatPenalty,
        ...(options.numPredict !== undefined && { num_predict: options.numPredict }),
      },
    }
    if (jsonFormat) body.format = 'json'

    response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new OllamaError('TIMEOUT', `Ollama 呼び出しがタイムアウトしました(${timeoutMs}ms)`, e)
    }
    throw new OllamaError(
      'NOT_RUNNING',
      `Ollamaに接続できませんでした(${OLLAMA_BASE_URL})。'ollama serve' で起動してください。`,
      e,
    )
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId)
  }

  if (!response.ok) {
    const text = await response.text()
    const looksLikeModelMissing = response.status === 404 || /model.*not found/i.test(text)
    if (looksLikeModelMissing) {
      throw new OllamaError(
        'MODEL_NOT_FOUND',
        `モデル '${model}' が見つかりません。'ollama pull ${model}' で取得してください。`,
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

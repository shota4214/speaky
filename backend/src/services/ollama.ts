// env は `??` ではなく `||`(+ trim)で評価する。`??` は null/undefined しか弾かないため、
// 空文字や空白だけの env(シェルの `VAR=` や Electron から空文字で渡した場合)が
// そのまま採用されて Ollama に不正な値が飛ぶ。
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL?.trim() || 'llama3.2:3b'

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
  /**
   * モデルをメモリに保持する時間。省略すると Ollama の既定 5 分で unload され、
   * 会話が少し途切れただけで次ターンがフルのコールドロードになる。
   */
  keep_alive?: string
  options?: {
    temperature?: number
    top_p?: number
    top_k?: number
    seed?: number
    repeat_penalty?: number
    num_predict?: number
    num_ctx?: number
  }
}

/**
 * モデルをロードしたままにする時間。electron/src/main.ts の OLLAMA_KEEP_ALIVE と
 * 揃えているが、リクエストごとの指定の方が強いのでこちらが実効値になる。
 */
// `??` だと OLLAMA_KEEP_ALIVE='' のとき keep_alive:'' を送ってしまい、
// Ollama が duration として解釈できず全チャットが 400 になる。空文字は既定値に落とす。
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE?.trim() || '30m'

/**
 * コンテキスト長。ここ 1 箇所で調整する。
 * system prompt が約 900 トークン + 履歴最大 20 メッセージあるため、
 * 既定(2048)だと静かに溢れて JSON 崩れの一因になっていた疑いがある。
 * 計測せずにこれ以上下げないこと(RAM と品質のトレードオフ)。
 */
const DEFAULT_NUM_CTX = 4096
const NUM_CTX = (() => {
  const raw = process.env.OLLAMA_NUM_CTX?.trim()
  if (!raw) return DEFAULT_NUM_CTX
  const parsed = Number(raw)
  // 0 / 負数 / 小数 / 非数値はすべて拒否する(num_ctx は正の整数のみ)。
  // Number('') === 0、Number('1.5') === 1.5 なので isFinite だけでは足りない。
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[ollama] OLLAMA_NUM_CTX="${raw}" は正の整数ではないため無視します (num_ctx=${DEFAULT_NUM_CTX} を使用)`,
    )
    return DEFAULT_NUM_CTX
  }
  return parsed
})()

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
      keep_alive: KEEP_ALIVE,
      options: {
        num_ctx: NUM_CTX,
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

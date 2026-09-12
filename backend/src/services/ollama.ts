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

/**
 * 最初のトークンが返るまでの既定の許容時間。
 * メモリ逼迫した 8GB Air ではモデルのコールドロード + prompt eval だけで
 * 20〜40 秒かかることが普通にあるため、ここは意図的に寛容に取る。
 */
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 60_000

/**
 * トークンとトークンの間が空いてよい既定の時間。
 * 生成が始まった後に 15 秒も無音なら、それは「遅い」ではなく「壊れている」。
 */
export const DEFAULT_STALL_TIMEOUT_MS = 15_000

/**
 * リトライ時に固定する seed。
 *
 * 既定では seed を毎回ランダム化しているため、リトライは「同じ分布からの引き直し」に
 * なってしまい、(a) 失敗が再現できない (b) 運が悪いと同じ壊れ方を繰り返す。
 * 2 回目は温度を下げたうえでこの seed に固定し、決定的で再現可能な 1 本にする。
 */
export const RETRY_SEED = 7

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
   * 現在の運用値(routes 側で設定)。リトライで倍化はしない(フラット予算):
   * - /chat:           640(JSON エンベロープ最大構成の実測見積 ≒ 530 トークン + 余裕)
   * - /chat/opening:   400(feedback / vocabulary が無いぶん小さい)
   * - /summarize:      300(plain text なので切断 = 短い要約)
   * - /extract-facts:  700
   * 切断された JSON は倍化リトライではなく routes 側の salvage で拾う。
   * デフォルトは未指定(モデルの判断、長くなりがち)
   */
  numPredict?: number
  model?: string
  /**
   * 最初のトークンが返るまでの許容時間 (ms)。0 で無効化。既定 60 秒。
   *
   * ⚠️ 現状 Ollama へのリクエストは `stream: false` のため、レスポンスは
   * 生成が完全に終わってから一括で返ってくる。つまり「最初のトークン」を
   * 観測する手段がなく、この予算は実質「呼び出し全体のデッドライン」として
   * 機能する。ストリーミング化後は文字どおり最初のトークンまでの予算になる。
   */
  firstTokenTimeoutMs?: number
  /**
   * トークン間の無音(ストール)を許容する時間 (ms)。0 で無効化。既定 15 秒。
   *
   * ⚠️ 現状の非ストリーミング経路では **発火しない**。トークンの到着を
   * 観測できないため、判定材料が存在しないからである。
   * Tier2 の後続ステージで `stream: true` + SSE に移行した時点で
   * 「最後のチャンク受信から stallTimeoutMs 経過したら abort」として有効になり、
   * その時 firstTokenTimeoutMs は最初のチャンクまでにのみ適用される。
   * 先に型と既定値だけ通しておくことで、後続ステージは routes を触らずに済む。
   */
  stallTimeoutMs?: number
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
  const firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS

  // 非ストリーミング(stream:false)ではレスポンスが一括で返るため、観測できる
  // 時間は「リクエスト送出 → 全部入りのレスポンス」の 1 区間しかない。
  // よって実効デッドラインは firstTokenTimeoutMs のみ。stallTimeoutMs は
  // ストリーミング化(後続ステージ)でチャンク間タイマーとして有効になる。
  const deadlineMs = firstTokenTimeoutMs

  const ctrl = new AbortController()
  const timeoutId = deadlineMs > 0 ? setTimeout(() => ctrl.abort(), deadlineMs) : null

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
      throw new OllamaError(
        'TIMEOUT',
        `Ollama 呼び出しがタイムアウトしました(${deadlineMs}ms)`,
        // どちらの予算で落ちたのかを後から切り分けられるよう両方残す
        // (現状は必ず firstTokenTimeoutMs 側)。
        { cause: e, firstTokenTimeoutMs, stallTimeoutMs },
      )
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

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

export type OllamaErrorCode = 'NOT_RUNNING' | 'MODEL_NOT_FOUND' | 'TIMEOUT' | 'ABORTED' | 'UNKNOWN'

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
 *
 * ⚠️ ここは **安全側(長い方)を既定にする**。現在の呼び出し元はすべて
 * firstTokenTimeoutMs を明示しているので既定値は実効しないが、
 * 予算を書き忘れた新しい呼び出しが暗黙に厳しい方へ倒れると、
 * コールドロードだけで落ちる経路が静かに増える。短くしたい経路は
 * 呼び出し側で明示する(例: ストリーミング経路の 60 秒)。
 */
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 90_000

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
   * - `chatWithOllama`(`stream: false`)では最初のトークンを観測できないため、
   *   実質「呼び出し全体のデッドライン」として機能する。
   * - `startOllamaChatStream`(`stream: true`)では文字どおり
   *   「リクエスト送出 → 最初の content チャンク」までの予算になる。
   */
  firstTokenTimeoutMs?: number
  /**
   * トークン間の無音(ストール)を許容する時間 (ms)。0 で無効化。既定 15 秒。
   *
   * ⚠️ 非ストリーミング経路(`chatWithOllama`)では **発火しない**。
   * トークンの到着を観測できないため、判定材料が存在しないからである。
   * `startOllamaChatStream` では「最後のチャンク受信から stallTimeoutMs 経過したら
   * abort」として有効になり、その時 firstTokenTimeoutMs は最初のチャンクまでにのみ
   * 適用される。
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
  /**
   * 自前のデッドラインで abort したのか、外部(UI キャンセル)で abort されたのか。
   * この区別が無いと「ユーザーが会話を終えただけ」が TIMEOUT として記録され、
   * ルートは 503 + 「タイムアウトしました」をユーザーに見せてしまう。
   */
  let externalAbort = false
  const timeoutId = deadlineMs > 0 ? setTimeout(() => ctrl.abort(), deadlineMs) : null

  // 外部signalがある場合はそれにもチェーン
  const onExternalAbort = () => {
    externalAbort = true
    ctrl.abort()
  }
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort()
    else options.signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  /**
   * 1 つの signal は 1 ターン分のすべての呼び出し(会話 → 翻訳 → enrich)で
   * 使い回されるので、終わったリスナーは必ず外す(付けっぱなしは漏れになる)。
   */
  function cleanup(): void {
    if (timeoutId !== null) clearTimeout(timeoutId)
    options.signal?.removeEventListener('abort', onExternalAbort)
  }

  function abortError(e: unknown): OllamaError {
    if (externalAbort) {
      return new OllamaError('ABORTED', 'リクエストが中断されました', e)
    }
    return new OllamaError(
      'TIMEOUT',
      `Ollama 呼び出しがタイムアウトしました(${deadlineMs}ms)`,
      // どちらの予算で落ちたのかを後から切り分けられるよう両方残す
      // (現状は必ず firstTokenTimeoutMs 側)。
      { cause: e, firstTokenTimeoutMs, stallTimeoutMs },
    )
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
    cleanup()
    if ((e as Error).name === 'AbortError') throw abortError(e)
    throw new OllamaError(
      'NOT_RUNNING',
      `Ollamaに接続できませんでした(${OLLAMA_BASE_URL})。'ollama serve' で起動してください。`,
      e,
    )
  }

  if (!response.ok) {
    cleanup()
    const text = await response.text().catch(() => '')
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

  // ⚠️ 本文の読み取りが終わるまで予算と外部 signal を生かしておく。
  // stream:false の Ollama はヘッダーだけ先に返すことがあり、そこで
  // タイマーを止めてしまうと「生成を待っている間だけ中断できない」穴になる。
  try {
    return (await response.json()) as OllamaChatResponse
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw abortError(e)
    throw new OllamaError('UNKNOWN', `Ollama レスポンスの読み取りに失敗: ${String(e)}`, e)
  } finally {
    cleanup()
  }
}

/**
 * ストリーミング版の Ollama チャット。
 *
 * 非ストリーミング版と役割を分けてある理由:
 *  - **ヘッダーを送る前に失敗を確定させたい**。`startOllamaChatStream()` は
 *    「fetch が ok で解決した」ところまでを await して返す。呼び出し側はその後で
 *    はじめて SSE ヘッダーを送れるので、Ollama 未起動 / モデル無しは本物の 503 に
 *    できる(ヘッダーを送った後ではステータスは固定されてしまう)。
 *  - 最初のチャンクまで = firstTokenTimeoutMs、チャンク間 = stallTimeoutMs と、
 *    2 つの予算を分けて適用できる。
 *
 * 返り値の `chunks()` は content デルタだけを yield する。
 */
export interface OllamaChatStream {
  /** 実際に使われたモデル名(allowlist 解決後)。 */
  model: string
  /** content デルタを到着順に yield する。1 回だけ消費できる。 */
  chunks(): AsyncGenerator<string, void, undefined>
  /** 途中で読むのをやめる(ソケットを閉じて Ollama の生成を止める)。 */
  abort(): void
}

type OllamaStreamLine = {
  message?: { role?: string; content?: string }
  done?: boolean
  error?: string
}

export async function startOllamaChatStream(
  messages: OllamaChatMessage[],
  options: ChatWithOllamaOptions = {},
): Promise<OllamaChatStream> {
  const jsonFormat = options.jsonFormat ?? true
  const temperature = options.temperature ?? 0.7
  const topP = options.topP ?? 0.9
  const topK = options.topK ?? 40
  const repeatPenalty = options.repeatPenalty ?? 1.1
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31)
  const model = resolveLlmModel(options.model)
  const firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS

  const ctrl = new AbortController()
  /** 自前のタイマーで abort したのか、外部(UI キャンセル)で abort されたのかの区別。 */
  let timedOutBy: 'first-token' | 'stall' | null = null
  let externalAbort = false

  let timer: ReturnType<typeof setTimeout> | null = null
  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  function armTimer(ms: number, reason: 'first-token' | 'stall'): void {
    clearTimer()
    if (ms <= 0) return
    timer = setTimeout(() => {
      timedOutBy = reason
      ctrl.abort()
    }, ms)
  }

  const onExternalAbort = () => {
    externalAbort = true
    ctrl.abort()
  }
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort()
    else options.signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  function detachExternal(): void {
    options.signal?.removeEventListener('abort', onExternalAbort)
  }

  function abortError(e: unknown): OllamaError {
    if (externalAbort) {
      return new OllamaError('ABORTED', 'リクエストが中断されました', e)
    }
    return new OllamaError(
      'TIMEOUT',
      timedOutBy === 'stall'
        ? `Ollama の生成が停止しました(${stallTimeoutMs}ms 無応答)`
        : `Ollama 呼び出しがタイムアウトしました(${firstTokenTimeoutMs}ms)`,
      { cause: e, firstTokenTimeoutMs, stallTimeoutMs, timedOutBy },
    )
  }

  // 最初のチャンクまでの予算は fetch(= モデルのコールドロードを含む)から数え始める。
  armTimer(firstTokenTimeoutMs, 'first-token')

  let response: Response
  try {
    const body: OllamaChatRequest = {
      model,
      messages,
      stream: true,
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
    clearTimer()
    detachExternal()
    if ((e as Error).name === 'AbortError') throw abortError(e)
    throw new OllamaError(
      'NOT_RUNNING',
      `Ollamaに接続できませんでした(${OLLAMA_BASE_URL})。'ollama serve' で起動してください。`,
      e,
    )
  }

  if (!response.ok) {
    clearTimer()
    detachExternal()
    const text = await response.text().catch(() => '')
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

  if (!response.body) {
    clearTimer()
    detachExternal()
    throw new OllamaError('UNKNOWN', 'Ollama がストリーム本体を返しませんでした')
  }
  // reader はここで取得しておく(generator の中で narrowing を持ち回らないため)。
  // chunks() を一度も消費しなかった場合でも abort() が cancel してソケットを閉じる。
  const reader = response.body.getReader()

  async function* chunks(): AsyncGenerator<string, void, undefined> {
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let obj: OllamaStreamLine
          try {
            obj = JSON.parse(trimmed) as OllamaStreamLine
          } catch {
            // 壊れた 1 行は捨てる(Ollama は 1 行 1 JSON なので後続は独立して読める)。
            console.warn('[ollama:stream] 解釈できない行を無視:', trimmed.slice(0, 120))
            continue
          }
          if (obj.error) {
            throw new OllamaError('UNKNOWN', `Ollama APIエラー: ${obj.error}`, obj.error)
          }
          const content = obj.message?.content
          if (content) {
            // チャンクが届くたびにストール予算を張り直す。
            // (最初のチャンクでは first-token 予算をストール予算に差し替えている)
            armTimer(stallTimeoutMs, 'stall')
            yield content
          }
          if (obj.done) return
        }
      }
    } catch (e) {
      if (e instanceof OllamaError) throw e
      if ((e as Error).name === 'AbortError') throw abortError(e)
      throw new OllamaError('UNKNOWN', `Ollama ストリームの読み取りに失敗: ${String(e)}`, e)
    } finally {
      clearTimer()
      detachExternal()
      // ⚠️ ここが肝: signal を abort するだけでは Ollama の生成が止まらないことがある。
      // 読み取り側を cancel してソケットを閉じ、サーバー側に書き込み失敗を伝える。
      try {
        await reader.cancel()
      } catch {
        // 既に壊れている場合は無視
      }
      ctrl.abort()
    }
  }

  return {
    model,
    chunks,
    abort(): void {
      externalAbort = true
      clearTimer()
      detachExternal()
      ctrl.abort()
      void reader.cancel().catch(() => undefined)
    },
  }
}

export const ollamaConfig = {
  baseUrl: OLLAMA_BASE_URL,
  model: OLLAMA_MODEL,
}

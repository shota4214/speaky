import type { Level, Mode, PersonalityPreset, VocabItem } from '../db/types'
import { NO_FEATURES, parseHealthFeatures, type BackendFeatures } from '../utils/backend-features'
import {
  finalizeChatStream,
  initialChatStreamState,
  reduceChatStreamEvent,
  type ChatEnrichment,
  type ChatStreamEffect,
  type ChatStreamState,
} from '../utils/chat-stream-reducer'

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
  /** AI の性格プリセット。未指定なら backend 側で 'friendly' にフォールバック。 */
  personality?: PersonalityPreset
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
  // text フィールドは file より前に append する(multer の挙動に合わせる)
  if (options.model) form.append('model', options.model)
  form.append('audio', blob, options.filename ?? 'recording.webm')
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

/**
 * 会話開始時に AI から最初に話しかけてもらうエンドポイント。
 * userText を送らず、context だけで AI が挨拶 + 話題切り出しを生成する。
 */
export async function chatOpening(
  context: ChatRequestContext = {},
  options: { signal?: AbortSignal } = {},
): Promise<ChatReply> {
  const res = await fetch('/api/chat/opening', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context }),
    signal: options.signal,
  })
  return asJson<ChatReply>(res)
}

// ----- Backend capability probe -----

/**
 * 機能プローブのセッションキャッシュ。
 *
 * **成功した結果だけ**キャッシュする。失敗(バックエンドがまだ listen していない等)を
 * 恒久的にキャッシュすると、一度のタイミング事故でアプリを終了するまで
 * ストリーミングが死ぬ。失敗時は次の会話開始でもう一度だけ聞きに行く。
 */
let _featuresCache: BackendFeatures | null = null
let _featuresInFlight: Promise<BackendFeatures> | null = null

const FEATURE_PROBE_TIMEOUT_MS = 3000

/**
 * バックエンドの機能を検出する。**会話画面のマウント時に呼ぶこと**。
 * アプリ起動時に呼ぶと Electron の起動と backend の listen が競合して
 * 「まだ起きていない backend」を掴み、機能なしと誤判定する。
 *
 * 失敗・タイムアウト・壊れた応答はすべて「機能なし」(= 非ストリーミング経路)。
 */
export async function probeBackendFeatures(force = false): Promise<BackendFeatures> {
  if (_featuresCache && !force) return _featuresCache
  if (_featuresInFlight && !force) return _featuresInFlight

  const run = (async (): Promise<BackendFeatures> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FEATURE_PROBE_TIMEOUT_MS)
    try {
      const res = await fetch('/api/health', { signal: ctrl.signal })
      if (!res.ok) return NO_FEATURES
      const parsed = parseHealthFeatures((await res.json()) as unknown)
      if (parsed.features.length > 0) _featuresCache = parsed
      return parsed
    } catch {
      return NO_FEATURES
    } finally {
      clearTimeout(timer)
      _featuresInFlight = null
    }
  })()

  _featuresInFlight = run
  return run
}

/** テスト・設定リセット用。 */
export function resetBackendFeaturesCache(): void {
  _featuresCache = null
  _featuresInFlight = null
}

// ----- Chat streaming (SSE) -----

export interface ChatStreamDone {
  text: string
  /** 翻訳ターンだけ done に同梱される日本語訳。通常ターンは null(enrich で来る)。 */
  replyJa: string | null
}

export interface ChatStreamHandle {
  /**
   * **英文が確定した時点**で解決する(enrich は待たない)。
   * 失敗・中断で英文が確定しなかった場合は null。
   */
  done: Promise<ChatStreamDone | null>
  /** ストリームが閉じるまで(enrich を含む)。reject しない。 */
  finished: Promise<ChatStreamState>
}

export interface ChatStreamOptions {
  signal?: AbortSignal
  /** meta/delta/done/enrich/error をリデューサが解釈した結果が順に流れてくる。 */
  onEffect?: (effect: ChatStreamEffect) => void
}

/**
 * SSE として消費してよいレスポンスかを確かめる。
 *
 * ⚠️ parseSSE は `data:` 行しか読まないので、**JSON 本文を渡すと 0 件で正常終了する**。
 * つまり「静かに空の返答になる」。Content-Type まで検証してからでないと消費しない。
 */
async function assertEventStream(res: Response): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let message = `HTTP ${res.status}`
    let code: string | undefined
    try {
      const data = JSON.parse(text) as { error?: string; code?: string }
      message = data.error ?? message
      code = data.code
    } catch {
      message = text || message
    }
    throw new ApiError(res.status, message, code)
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    throw new ApiError(res.status, `Unexpected content-type for stream: ${contentType || '(none)'}`)
  }
}

/**
 * ストリームの締め切り(クライアント側)。
 *
 * backend の予算(first-token 60〜90 秒 / ストール 15 秒)は **backend が生きていれば**
 * 効く。効かないのは「ソケットが半開きのまま死んだ」場合 — スリープ復帰が典型で、
 * TCP は切れたことに気づかず read が永遠に返らない。そのときターンは
 * 「done も error も来ない」まま止まり、UI は生成中・マイクは閉じたままになる。
 *
 * 予算は 2 段階に分ける。**ヘッダーが返るまでは backend が何も書けない** ためで、
 * 具体的には
 *   - 会話 / 挨拶: Ollama の fetch が解決するまで(= 最大 90 秒の first-token 予算)
 *   - japanese_help / mixed: 翻訳を丸ごと生成してから SSE を開く(最大 2 回 × 60 秒)
 * という区間があり、ここを 45 秒で切ると **正常な生成を殺す**。
 * ヘッダーが返った後は backend が keepalive コメントを 10 秒間隔で流すので、
 * 無通信が 45 秒続いたら回線が死んでいると判断してよい(keepalive 4 回ぶんの空振り)。
 *
 * 判定は SSE イベントではなく **ソケットの受信** で行う。keepalive コメントは
 * parseSSE がイベントとして出さないため、イベント基準では正常な待ちを殺してしまう。
 */
const STREAM_HEADER_TIMEOUT_MS = 180_000
const STREAM_IDLE_TIMEOUT_MS = 45_000

async function openChatStream(
  url: string,
  body: unknown,
  options: ChatStreamOptions,
): Promise<ChatStreamHandle> {
  // 呼び出し側の signal に加えて、こちらからも中断できるようにする
  // (無通信タイムアウト時に reader を起こすため)。
  const ctrl = new AbortController()
  const abortFromCaller = (): void => ctrl.abort(options.signal?.reason)
  if (options.signal?.aborted) ctrl.abort(options.signal.reason)
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true })

  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimedOut = false
  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }
  function armTimer(ms: number): void {
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      console.warn(`[chat-stream] ${ms}ms 無通信のため打ち切り`)
      ctrl.abort(new Error('stream idle timeout'))
    }, ms)
  }
  /** 受信のたびに巻き直す(ヘッダー後の無通信監視)。 */
  function armIdleTimer(): void {
    armTimer(STREAM_IDLE_TIMEOUT_MS)
  }

  function cleanup(): void {
    clearIdleTimer()
    options.signal?.removeEventListener('abort', abortFromCaller)
  }

  let res: Response
  try {
    // ヘッダーが返るまでは backend が何も書けない区間。長めの予算で見る。
    armTimer(STREAM_HEADER_TIMEOUT_MS)
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (e) {
    cleanup()
    throw e
  }
  // ここで投げる = まだ 1 文字も読み上げていない。呼び出し側は非ストリーミングに落とせる。
  try {
    await assertEventStream(res)
  } catch (e) {
    cleanup()
    throw e
  }
  // ヘッダーが返った = ここから先は keepalive が流れる。短い締め切りに切り替える。
  armIdleTimer()

  let settleDone: (value: ChatStreamDone | null) => void = () => undefined
  const done = new Promise<ChatStreamDone | null>((resolve) => {
    settleDone = resolve
  })
  let doneSettled = false
  function settleOnce(value: ChatStreamDone | null): void {
    if (doneSettled) return
    doneSettled = true
    settleDone(value)
  }

  const finished = (async (): Promise<ChatStreamState> => {
    let state = initialChatStreamState()
    const apply = (effects: ChatStreamEffect[]): void => {
      for (const effect of effects) {
        try {
          options.onEffect?.(effect)
        } catch (e) {
          console.warn('[chat-stream] effect handler failed:', e)
        }
        if (effect.type === 'done') {
          settleOnce({ text: effect.text, replyJa: effect.replyJa })
        } else if (effect.type === 'error') {
          settleOnce(null)
        }
      }
    }

    try {
      // onActivity = 受信のたび。無通信タイマーはここで巻き直す
      // (keepalive コメントはイベントにならないが、受信としては数える)。
      for await (const event of parseSSE(res, armIdleTimer)) {
        const result = reduceChatStreamEvent(state, event)
        state = result.state
        apply(result.effects)
      }
    } catch (e) {
      // 中断(会話終了)は失敗として見せない。それ以外は「途中で切れた」扱い。
      if (!options.signal?.aborted) {
        console.warn('[chat-stream] stream read failed:', e)
      }
    } finally {
      cleanup()
    }

    if (options.signal?.aborted) {
      settleOnce(null)
      return state
    }

    // 無通信で打ち切った = 回線が死んでいる。TIMEOUT として畳む。
    // TRUNCATED にすると呼び出し側が「変な出力をした」と解釈して
    // **締め切りの無い非ストリーミング経路** でやり直し、また固まってしまう。
    if (idleTimedOut) {
      const timedOut = reduceChatStreamEvent(state, {
        type: 'error',
        code: 'TIMEOUT',
        error: '応答が途切れました。通信が切れている可能性があります。',
      })
      state = timedOut.state
      apply(timedOut.effects)
      settleOnce(null)
      return state
    }

    const final = finalizeChatStream(state)
    state = final.state
    apply(final.effects)
    settleOnce(null)
    return state
  })()

  return { done, finished }
}

/** 会話ターンのストリーミング。features に 'chat-stream' がある場合だけ呼ぶこと。 */
export async function chatStream(
  userText: string,
  context: ChatRequestContext = {},
  options: ChatStreamOptions = {},
): Promise<ChatStreamHandle> {
  return openChatStream('/api/chat/stream', { userText, context }, options)
}

/** 会話開始の挨拶のストリーミング。features に 'chat-opening-stream' がある場合だけ。 */
export async function chatOpeningStream(
  context: ChatRequestContext = {},
  options: ChatStreamOptions = {},
): Promise<ChatStreamHandle> {
  return openChatStream('/api/chat/opening/stream', { context }, options)
}

/**
 * 1 メッセージぶんの enrich(日本語訳 / 添削 / 単語)をやり直す。
 * ストリームが enrich を届けられなかったときの再試行用。
 */
export async function chatEnrich(
  replyEn: string,
  userText: string | null,
  context: ChatRequestContext = {},
  options: { signal?: AbortSignal } = {},
): Promise<ChatEnrichment> {
  const res = await fetch('/api/chat/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyEn, userText, context }),
    signal: options.signal,
  })
  return asJson<ChatEnrichment>(res)
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

/**
 * SSE の `data:` 行だけを読んで JSON として yield する。
 *
 * ⚠️ **`data:` 以外の行(`event:` / コメント `:`)は完全に無視する**。
 * そのため会話ストリームは名前付きイベントを使わず、type を JSON の中に入れた
 * data-only 形式にしてある(このパーサをそのまま使い回すため)。
 *
 * ⚠️ もう 1 つの落とし穴: **JSON 本文を渡すと 0 件で正常終了する**。
 * 呼び出し側は必ず `res.ok` と Content-Type が text/event-stream であることを
 * 先に確かめること。そうしないと「空の返答が静かに成功する」ことになる。
 */
export async function* parseSSE(
  response: Response,
  /** 受信(イベントにならない keepalive コメントを含む)のたびに呼ばれる。 */
  onActivity?: () => void,
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error('No response body for SSE')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      onActivity?.()
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

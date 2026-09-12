import { Router, type Request, type Response } from 'express'
import {
  buildOpeningUserPrompt,
  buildSystemPrompt,
  type Mode,
} from '../services/conversation-prompt.js'
import {
  isFeedback,
  isValidEnglishFeedback,
  isVocabItem,
  salvageChatReply,
  type Feedback,
  type VocabItem,
} from '../services/chat-reply.js'
import { endAborted, isAbortedError, watchClientAbort } from '../services/client-abort.js'
import {
  containsJsonScaffoldPattern,
  extractJsonObjectSlice,
  findScaffoldOpener,
  looksLikeJsonScaffold,
  matchJsonStringField,
  proseBeforeScaffold,
} from '../services/json-salvage.js'
import {
  chatWithOllama,
  OllamaError,
  resolveLlmModel,
  startOllamaChatStream,
  type OllamaChatMessage,
} from '../services/ollama.js'
import { setupSSE, sseComment, sseSend } from '../services/sse.js'
import { translateEnglishToJapanese, translateToNaturalEnglish } from '../services/translation.js'
import { MAX_HISTORY_TURNS, type ChatContext } from './chat.js'

/**
 * 会話のストリーミング経路。
 *
 * ここが Tier2 Stage2 の本体で、目的はただ 1 つ
 * 「**英文の最初の一文が出来た時点で喋り始める**」こと。
 * そのために非ストリーミング経路と決定的に違う点が 3 つある:
 *
 *  1) **プレーンテキスト生成**(`format:'json'` を送らない)。
 *     JSON を書かせながら「reply_en の中身だけ」を逐次読み上げることはできない。
 *  2) **日本語訳 / 添削 / 単語は後追い**(`enrich` イベント)。
 *     `done` は英文が出来た瞬間に出し、マイクは enrich を待たない。
 *  3) **ヘッダーは Ollama の fetch が ok で解決してから送る**。
 *     ヘッダーを送った後はステータスを変えられないので、Ollama 未起動 /
 *     モデル無しを本物の 503 で返せるのはこの順序を守っている間だけ。
 *
 * 非ストリーミング経路(`POST /api/chat` / `POST /api/chat/opening`)は
 * **フォールバックとして一切変更していない**。新しいフロントは古いバックエンド
 * (= features を返さない)と組み合わさる可能性があり、そのとき唯一頼れるのが
 * 旧経路だからである。
 */

/**
 * ストリーミング経路の first-token 予算。
 *
 * 非ストリーミング経路(routes/chat.ts の CHAT_FIRST_TOKEN_TIMEOUT_MS)が 90 秒
 * なのは「一括返却では first-token と生成完了が区別できず、640 トークンの
 * 生成時間まで含めて待つ必要がある」ため。ストリーミングではその 2 つが分離し、
 * 生成が動き出しているかどうかは stall 予算(15 秒)が見てくれるので、
 * ここは 60 秒まで下げられる。8GB 機のコールドロード(20〜40 秒)には十分。
 */
const STREAM_FIRST_TOKEN_TIMEOUT_MS = 60_000

/**
 * opening だけは 90 秒のまま。セッション最初の LLM 呼び出しで、
 * ここだけはモデルのコールドロードを確実に踏むため(非ストリーミング側と同じ理由)。
 */
const OPENING_STREAM_FIRST_TOKEN_TIMEOUT_MS = 90_000

/**
 * プレーンテキスト経路の生成上限。JSON エンベロープ(日本語訳・添削・単語)が
 * 無くなるので、非ストリーミングの 640 から大きく下げられる。
 * 英語の返答は advanced でもせいぜい 4〜5 文 = 100 トークン前後。
 */
const STREAM_NUM_PREDICT = 320

/**
 * enrich(日本語訳 + 添削 + 単語)の生成上限。
 *
 * enrich は **次のターンと同じ 1 枠を奪い合う**(NUM_PARALLEL=1 / 1 モデル)。
 * 次ターンが始まればクライアントが切るので最長でも「ユーザーが話し終えるまで」だが、
 * その間 Ollama を占有するぶんは短いほどよい。
 * 内訳の見積り: 日本語訳 150〜200 / 添削 90 / 単語 2 件 80 / 記号 30。
 * 480 → 360 に下げ、単語も 3 件 → 2 件にした。JSON のキー順は reply_ja が先頭なので、
 * 予算を使い切って切断されても日本語訳は parseEnrichment の salvage で必ず残る
 * (落ちるのは添削・単語だけ)。
 */
const ENRICH_NUM_PREDICT = 360
const ENRICH_FIRST_TOKEN_TIMEOUT_MS = 60_000

/** 最初のトークンを待つ間に流す keepalive コメントの間隔。 */
const KEEPALIVE_INTERVAL_MS = 10_000

/**
 * 「モデルがうっかり JSON を吐き始めた」かを判定するために覗く先頭の文字数。
 *
 * フロント側のアキュムレータ(SentenceAccumulator)は最初の 1 セグメントを
 * 30 文字貯まるまで出さない設計になっている。ここも同じ 30 文字を見てから
 * 判断することで、**1 文字も読み上げる前に** 救済判定を終えられる。
 */
const SCAFFOLD_PROBE_CHARS = 30

/**
 * プレーンテキストを期待したのに JSON / コードフェンスで返ってきた出力から
 * 英文を救い出す。Stage 0 の salvage を先に試し、ダメならフェンスだけ剥がし、
 * それでもダメなら「JSON の手前に書かれた自然文」を拾う。
 */
export function salvagePlainReply(raw: string): string | null {
  const salvaged = salvageChatReply(raw, 'normal')
  if (salvaged?.reply_en?.trim()) return salvaged.reply_en.trim()

  // ```json ... ``` のフェンスだけを剥がして、中身が JSON でなければ採用する。
  const unfenced = raw
    .replace(/^\s*```[a-zA-Z]*\s*/, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  if (unfenced && !looksLikeJsonScaffold(unfenced)) return unfenced
  return proseBeforeScaffold(raw)
}

export interface EnrichmentResult {
  replyJa: string
  feedback: Feedback | null
  vocabulary: VocabItem[]
}

const ENRICH_SYSTEM_PROMPT = `You support a Japanese learner of English. You are given (a) what the learner said and (b) the English reply their AI conversation partner just gave. You do NOT continue the conversation. You only annotate it.

Respond ONLY with valid JSON. No markdown, no code fences, no extra text.
{
  "reply_ja": "string - natural Japanese translation of the AI reply",
  "feedback": null OR { "user_said": "...", "corrected": "...", "explanation": "..." },
  "vocabulary": [] OR up to 2 items: { "word": "...", "meaning": "...", "example": "..." }
}

# Rules
- reply_ja is always required. Translate the AI reply into natural, conversational Japanese.
- feedback: only if the learner made a real English mistake. Otherwise null. "user_said" and "corrected" must be English; "explanation" must be in Japanese.
- vocabulary: only 1-2 genuinely useful words/phrases from the AI reply, with Japanese meanings. Skip trivial words. Empty array is fine.
- Never invent a mistake the learner did not make.`

/** enrich の JSON を検証して取り出す(壊れていたら拾える範囲だけ拾う)。 */
export function parseEnrichment(content: string): EnrichmentResult | null {
  const tryParse = (text: string): EnrichmentResult | null => {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const replyJa = typeof parsed.reply_ja === 'string' ? parsed.reply_ja : ''
      let feedback = isFeedback(parsed.feedback) ? parsed.feedback : null
      if (feedback && !isValidEnglishFeedback(feedback)) {
        console.warn('[chat:enrich] dropping feedback with Japanese in corrected/user_said')
        feedback = null
      }
      const vocabulary: VocabItem[] = Array.isArray(parsed.vocabulary)
        ? parsed.vocabulary
            .filter(isVocabItem)
            .slice(0, 3)
            .map((v) => ({ word: v.word, meaning: v.meaning, example: v.example ?? null }))
        : []
      return { replyJa, feedback, vocabulary }
    } catch {
      return null
    }
  }

  const direct = tryParse(content)
  if (direct) return direct

  const slice = extractJsonObjectSlice(content)
  if (slice) {
    const fromSlice = tryParse(slice)
    if (fromSlice) return fromSlice
  }

  // 切断された JSON からは日本語訳だけ拾う(添削 / 単語は後半に出るので信用しない)。
  const replyJa = matchJsonStringField(content, 'reply_ja')
  if (replyJa?.trim()) {
    return { replyJa: replyJa.trim(), feedback: null, vocabulary: [] }
  }
  return null
}

interface EnrichInput {
  replyEn: string
  userText?: string | null
  context: ChatContext
  signal?: AbortSignal
}

/**
 * 英文が確定した後に、日本語訳 / 添削 / 単語をまとめて生成する。
 *
 * 「日本語訳を必ず表示」は製品上の約束なので、enrich の JSON が壊れても
 * 最後に en→ja 翻訳で必ず日本語訳を埋める(非ストリーミング経路と同じ保証)。
 */
export async function buildEnrichment(input: EnrichInput): Promise<EnrichmentResult> {
  const { replyEn, userText, context, signal } = input

  // opening(ユーザー発話が無い)は添削も単語も出さない契約なので、
  // 日本語訳だけを取る。LLM 呼び出しが 1 回で済むぶん速い。
  if (!userText?.trim()) {
    const replyJa = await translateEnglishToJapanese(replyEn, { model: context.model, signal })
    return { replyJa, feedback: null, vocabulary: [] }
  }

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: ENRICH_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Learner said:\n${userText}\n\nAI reply to annotate:\n${replyEn}`,
    },
  ]

  let parsed: EnrichmentResult | null = null
  try {
    const res = await chatWithOllama(messages, {
      model: context.model,
      firstTokenTimeoutMs: ENRICH_FIRST_TOKEN_TIMEOUT_MS,
      numPredict: ENRICH_NUM_PREDICT,
      temperature: 0.3,
      topP: 0.9,
      jsonFormat: true,
      signal,
    })
    parsed = parseEnrichment(res.message?.content ?? '')
  } catch (e) {
    if (e instanceof OllamaError && e.code === 'ABORTED') throw e
    console.warn('[chat:enrich] generation failed:', e)
  }

  const result: EnrichmentResult = parsed ?? { replyJa: '', feedback: null, vocabulary: [] }
  if (!result.replyJa.trim()) {
    result.replyJa = await translateEnglishToJapanese(replyEn, { model: context.model, signal })
  }
  return result
}

/** 既にソケットが閉じている場合に書き込まないためのガード。 */
function canWrite(res: Response): boolean {
  return !res.writableEnded && !res.destroyed
}

function safeSend(res: Response, obj: unknown): void {
  if (canWrite(res)) sseSend(res, obj)
}

/** OllamaError を非ストリーミング経路と同じ形の JSON エラーで返す(ヘッダー未送信時のみ)。 */
function sendOllamaErrorJson(res: Response, e: unknown, tag: string): Response {
  if (e instanceof OllamaError) {
    if (e.code === 'NOT_RUNNING' || e.code === 'MODEL_NOT_FOUND' || e.code === 'TIMEOUT') {
      return res.status(503).json({ error: e.message, code: e.code })
    }
    if (e.code === 'ABORTED') {
      // クライアントが切ったので返す相手がいない。ステータスだけ付けて終わる。
      return endAborted(res)
    }
  }
  console.error(`${tag} unexpected error:`, e)
  return res.status(500).json({ error: (e as Error).message })
}

export const chatStreamRouter = Router()

/**
 * 会話ターンのストリーミング。イベントは data-only SSE で、
 * type による判別子を JSON の中に持つ(既存の parseSSE をそのまま使えるため)。
 *
 *   data: {"type":"meta","mode":"normal","model":"llama3.2:3b","speakDeltas":true}
 *   data: {"type":"delta","text":" I went"}
 *   data: {"type":"done","text":"<英文全体>"}
 *   data: {"type":"enrich","replyJa":"...","feedback":{...}|null,"vocabulary":[...]}
 *   data: {"type":"error","code":"TIMEOUT","error":"..."}
 */
chatStreamRouter.post('/chat/stream', async (req: Request, res: Response) => {
  const { userText, context = {} } = (req.body ?? {}) as {
    userText?: string
    context?: ChatContext
  }

  if (typeof userText !== 'string' || userText.trim().length === 0) {
    return res.status(400).json({ error: 'userText is required (non-empty string)' })
  }

  const mode: Mode = context.mode ?? 'normal'
  const { signal, dispose } = watchClientAbort(res)

  try {
    // 日本語 / 英日混在は「デルタを喋らない」。
    // 既存の翻訳経路は完成した出力に前置き剥がしの後処理をかける設計で、
    // これは逐次には適用できない(途中で切ると "Sure, here's the translation"
    // をそのまま読み上げてしまう)。mode はクライアント側で生成前に決まるので、
    // この分岐は LLM を呼ぶ前に確定している。
    if (mode === 'japanese_help' || mode === 'mixed') {
      return await streamTranslationTurn(res, userText, context, mode, signal)
    }
    return await streamConversationTurn(res, {
      context,
      userText,
      signal,
      firstTokenTimeoutMs: STREAM_FIRST_TOKEN_TIMEOUT_MS,
      tag: '[chat:stream]',
    })
  } finally {
    dispose()
  }
})

/** 会話開始の挨拶のストリーミング。userText を取らない以外は /chat/stream と同じ。 */
chatStreamRouter.post('/chat/opening/stream', async (req: Request, res: Response) => {
  const { context = {} } = (req.body ?? {}) as { context?: ChatContext }
  const { signal, dispose } = watchClientAbort(res)
  try {
    return await streamConversationTurn(res, {
      context,
      userText: null,
      signal,
      firstTokenTimeoutMs: OPENING_STREAM_FIRST_TOKEN_TIMEOUT_MS,
      tag: '[chat/opening:stream]',
    })
  } finally {
    dispose()
  }
})

/**
 * 単一メッセージの enrich をやり直すための非ストリーミング endpoint。
 * ストリームが enrich を届けられなかった(失敗 / 中断)ときに UI から再試行する。
 */
chatStreamRouter.post('/chat/enrich', async (req: Request, res: Response) => {
  const {
    replyEn,
    userText,
    context = {},
  } = (req.body ?? {}) as {
    replyEn?: string
    userText?: string | null
    context?: ChatContext
  }
  if (typeof replyEn !== 'string' || replyEn.trim().length === 0) {
    return res.status(400).json({ error: 'replyEn is required (non-empty string)' })
  }
  const { signal, dispose } = watchClientAbort(res)
  try {
    const enrichment = await buildEnrichment({
      replyEn,
      userText: typeof userText === 'string' ? userText : null,
      context,
      signal,
    })
    return res.json(enrichment)
  } catch (e) {
    return sendOllamaErrorJson(res, e, '[chat:enrich]')
  } finally {
    dispose()
  }
})

/** japanese_help / mixed: 完成した翻訳を meta + done だけで返す(enrich 無し)。 */
async function streamTranslationTurn(
  res: Response,
  userText: string,
  context: ChatContext,
  mode: Mode,
  signal: AbortSignal,
): Promise<Response | void> {
  let translated: string
  try {
    translated = await translateToNaturalEnglish(userText, {
      model: context.model,
      level: context.level,
      signal,
    })
  } catch (e) {
    return sendOllamaErrorJson(res, e, '[chat:stream:translate]')
  }
  if (!translated) {
    console.warn('[chat:stream:translate] empty translation result')
    return res.status(502).json({ error: 'Translation produced empty output.' })
  }
  if (signal.aborted) return res.end()

  setupSSE(res)
  safeSend(res, {
    type: 'meta',
    mode,
    model: resolveLlmModel(context.model),
    speakDeltas: false,
  })
  safeSend(res, {
    type: 'done',
    text: translated,
    // 翻訳モードの日本語訳は LLM ではなくサーバー側の定型文。
    // enrich を走らせない代わりにここで一緒に渡す(非ストリーミング経路と同じ文面)。
    replyJa: `「${translated}」と言えますよ。声に出して言ってみて!`,
  })
  return res.end()
}

interface ConversationStreamInput {
  context: ChatContext
  /** null なら opening(挨拶)ターン。 */
  userText: string | null
  signal: AbortSignal
  firstTokenTimeoutMs: number
  tag: string
}

async function streamConversationTurn(
  res: Response,
  input: ConversationStreamInput,
): Promise<Response | void> {
  const { context, userText, signal, firstTokenTimeoutMs, tag } = input

  const systemPrompt = buildSystemPrompt({
    aiName: context.aiName,
    level: context.level,
    topic: context.topic,
    topicDescription: context.topicDescription,
    mode: 'normal',
    vocabFocus: context.vocabFocus,
    userProfile: context.userProfile,
    lastConversationSummary: context.lastConversationSummary,
    personality: context.personality,
    // ここが非ストリーミング経路との唯一のプロンプト差分。
    outputFormat: 'text',
  })

  const messages: OllamaChatMessage[] = [{ role: 'system', content: systemPrompt }]
  if (userText === null) {
    messages.push({
      role: 'user',
      content: buildOpeningUserPrompt({
        aiName: context.aiName,
        topic: context.topic,
        userProfile: context.userProfile,
        lastConversationSummary: context.lastConversationSummary,
        personality: context.personality,
        outputFormat: 'text',
      }),
    })
  } else {
    const history = (context.conversationHistory ?? []).slice(-MAX_HISTORY_TURNS * 2)
    for (const h of history) {
      messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text })
    }
    messages.push({ role: 'user', content: userText })
  }

  // ⚠️ ヘッダーはここではまだ送らない。fetch が ok で解決するまで待つことで、
  // Ollama 未起動 / モデル無しを本物の 503 として返せる。
  let stream
  try {
    stream = await startOllamaChatStream(messages, {
      model: context.model,
      jsonFormat: false,
      numPredict: STREAM_NUM_PREDICT,
      firstTokenTimeoutMs,
      temperature: 0.85,
      topP: 0.92,
      repeatPenalty: 1.15,
      signal,
    })
  } catch (e) {
    return sendOllamaErrorJson(res, e, tag)
  }

  setupSSE(res)
  safeSend(res, { type: 'meta', mode: 'normal', model: stream.model, speakDeltas: true })

  // 無通信になる区間では keepalive コメントを流す。dev プロキシ対策であると同時に、
  // **クライアントの無通信タイムアウト(STREAM_IDLE_TIMEOUT_MS)に巻き込まれない**
  // ための命綱でもある。無通信になるのは 3 区間:
  //   1) 最初のトークンまで
  //   2) JSON を抑止している間(delta を 1 つも送らないまま生成が続く)
  //   3) done の後の enrich 生成中
  // parseSSE は `data:` 行しか読まないのでクライアントには観測されない。
  let keepalive: ReturnType<typeof setInterval> | null = null
  function startKeepalive(): void {
    if (keepalive !== null) return
    keepalive = setInterval(() => {
      if (canWrite(res)) sseComment(res)
    }, KEEPALIVE_INTERVAL_MS)
  }
  function stopKeepalive(): void {
    if (keepalive !== null) {
      clearInterval(keepalive)
      keepalive = null
    }
  }
  startKeepalive()

  let full = ''
  /** delta として送出済みの文字数(full の先頭からの長さ)。 */
  let sent = 0
  let probed = false
  let suppressed = false
  let streamError: OllamaError | null = null

  try {
    for await (const chunk of stream.chunks()) {
      full += chunk
      if (!probed) {
        if (full.length < SCAFFOLD_PROBE_CHARS) continue
        probed = true
        if (looksLikeJsonScaffold(full.slice(0, SCAFFOLD_PROBE_CHARS))) {
          // JSON を書き始めている。1 文字も読み上げさせず、終了後に救済する。
          // ここから done まで delta を 1 つも送らないので keepalive を再開する。
          console.warn(`${tag} model emitted JSON scaffolding; suppressing deltas`)
          suppressed = true
          startKeepalive()
          continue
        }
      }
      if (suppressed) continue

      // 途中から JSON に化ける出力(前置きの自然文 → JSON)を捕まえる。
      // `{` を見た時点でいったん止める。送ってしまってから `"reply_en":` が
      // 完成しても、その `{` はもうクライアントの読み上げキューに入っている。
      const opener = findScaffoldOpener(full, sent)
      if (opener !== -1) {
        const tail = full.slice(opener)
        if (containsJsonScaffoldPattern(tail)) {
          console.warn(`${tag} model switched to JSON mid-reply; suppressing further deltas`)
          suppressed = true
          startKeepalive()
          continue
        }
        if (tail.length < SCAFFOLD_PROBE_CHARS) {
          // まだ判断がつかない。疑わしい文字の **手前まで** を送る。
          const head = full.slice(sent, opener)
          if (head) {
            // delta を送る = 通信があるので keepalive は不要。
            stopKeepalive()
            safeSend(res, { type: 'delta', text: head })
            sent = opener
          }
          continue
        }
        // 30 文字見ても JSON にならなかった = ただの記号。普通に送る。
      }

      const pending = full.slice(sent)
      if (!pending) continue
      sent = full.length
      stopKeepalive()
      safeSend(res, { type: 'delta', text: pending })
    }
  } catch (e) {
    streamError = e instanceof OllamaError ? e : new OllamaError('UNKNOWN', (e as Error).message, e)
  } finally {
    stopKeepalive()
  }

  if (signal.aborted) {
    // ユーザーが会話を終えた。書き込む相手がいないのでそのまま閉じる。
    return res.end()
  }

  if (streamError) {
    safeSend(res, { type: 'error', code: streamError.code, error: streamError.message })
    return res.end()
  }

  let finalText = full.trim()
  if (suppressed || looksLikeJsonScaffold(finalText)) {
    const salvaged = salvagePlainReply(finalText)
    if (!salvaged) {
      console.warn(`${tag} could not salvage reply from:`, finalText.slice(0, 200))
      safeSend(res, {
        type: 'error',
        code: 'MALFORMED',
        error: 'LLM が読み上げ可能な英文を返しませんでした。',
      })
      return res.end()
    }
    finalText = salvaged
  }

  if (!finalText) {
    safeSend(res, { type: 'error', code: 'EMPTY', error: 'LLM が空の返答を返しました。' })
    return res.end()
  }

  safeSend(res, { type: 'done', text: finalText })

  // ここから先は「マイクが待っていない」時間。失敗してもターンは成立しているので
  // エラーイベントにはしない(フロントは日本語訳の再取得ボタンを出す)。
  // enrich の生成中もソケットは無通信になるので keepalive を流す
  // (クライアント側の無通信タイムアウトに巻き込まれないため)。
  startKeepalive()
  try {
    const enrichment = await buildEnrichment({
      replyEn: finalText,
      userText,
      context,
      signal,
    })
    if (!signal.aborted) {
      // 日本語訳が空の enrich は **送らない**。送るとクライアントは
      // 「準備中」を解除してしまい、訳も無い・エラーも無い・再取得ボタンも無い
      // 行になる(DB の replyJa も null のまま)。届かなかったことにして
      // フロントに「取得できませんでした + 再取得」を出させる。
      if (enrichment.replyJa.trim()) {
        safeSend(res, {
          type: 'enrich',
          replyJa: enrichment.replyJa,
          feedback: enrichment.feedback,
          vocabulary: enrichment.vocabulary,
        })
      } else {
        console.warn(`${tag} enrichment had no Japanese translation; not sending enrich event`)
      }
    }
  } catch (e) {
    // 中断は失敗ではない(ユーザーが会話を終えただけ)。ログを汚さない。
    if (!isAbortedError(e)) {
      console.warn(`${tag} enrichment failed (stream ends without enrich):`, e)
    }
  } finally {
    stopKeepalive()
  }

  return res.end()
}

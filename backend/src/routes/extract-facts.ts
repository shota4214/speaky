import { Router, type Request, type Response } from 'express'
import {
  chatWithOllama,
  OllamaError,
  RETRY_SEED,
  type ChatWithOllamaOptions,
  type OllamaChatMessage,
} from '../services/ollama.js'
import {
  extractJsonObjectSlice,
  matchJsonStringField,
  matchJsonStringArrayField,
} from '../services/json-salvage.js'
import { endAborted, isAbortedError, watchClientAbort } from '../services/client-abort.js'
import { OLLAMA_BUDGET_MS } from '../shared/request-budget.js'

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

/**
 * 生成トークン上限。
 *
 * 1 回目の 700 の根拠: newFacts は日本語の短文(20〜30 字 ≒ 30〜45 トークン)で、
 * 1 セッションから実際に取れる新規事実はせいぜい 5〜8 件。
 * 8 件 × 45 + updatedName + JSON 記号 ≒ 420 トークンで、700 は十分な上限。
 *
 * ⚠️ ここだけは **2 回目で予算を増やす**。他の経路(会話・opening)は
 * 「切断された返答も返答として使える」のでフラット予算 + salvage で足りるが、
 * 事実抽出の失敗モードは「配列の途中で切れた」= まさに予算不足であり、
 * 同じ予算で引き直しても同じところで切れる。しかも取りこぼした事実は
 * 次のセッションでは「既知の事実」として除外されるわけでもなく、
 * 単に永久に失われる。ここだけは遅くなる方を選ぶ。
 */
const EXTRACT_FACTS_NUM_PREDICT = 700
const EXTRACT_FACTS_RETRY_NUM_PREDICT = 1400

/**
 * 2 回まで。2 回目は温度をさらに下げ、seed を固定し、予算を広げる。
 * ⚠️ **本数は shared/request-budget.ts の OLLAMA_ATTEMPTS.extractFacts と一致させること**
 * (クライアント締め切りが「本数 × first-token 予算」から計算される)。
 */
export const EXTRACT_FACTS_ATTEMPTS: Pick<
  ChatWithOllamaOptions,
  'temperature' | 'topP' | 'seed' | 'numPredict'
>[] = [
  { temperature: 0.2, topP: 0.8, numPredict: EXTRACT_FACTS_NUM_PREDICT },
  { temperature: 0.1, topP: 0.7, seed: RETRY_SEED, numPredict: EXTRACT_FACTS_RETRY_NUM_PREDICT },
]

/** 1 件の fact として受け入れる最大長(暴走出力よけ)。 */
const MAX_FACT_LENGTH = 200

function normalizeExtractFactsResult(parsed: ExtractFactsResult): ExtractFactsResult {
  const newFacts = Array.isArray(parsed.newFacts)
    ? parsed.newFacts.filter(
        (f): f is string => typeof f === 'string' && f.length > 0 && f.length <= MAX_FACT_LENGTH,
      )
    : []
  const updatedName =
    typeof parsed.updatedName === 'string' && parsed.updatedName.length > 0
      ? parsed.updatedName
      : null
  return { newFacts, updatedName }
}

/**
 * 厳密 parse に失敗した出力から使える結果を救出する。
 *  1) コードフェンス / 前置きを剥がして parse し直す
 *  2) 途中で切れた JSON から newFacts の完結した要素と updatedName を拾う
 * 何も拾えなければ null を返し、そのときだけリトライする。
 *
 * ⚠️ **配列が閉じていない救済は成功として扱わない**。
 * 「9 件出そうとして 8 件目の途中で切れた」出力から 8 件を返して 200 を返すと、
 * フロントはそれを完全な抽出結果としてプロフィールに書き込み、9 件目は
 * 誰にも気付かれずに永久に失われる。会話の 1 文が切れるのとは違い、
 * 事実の欠落は取り返しがつかないので、**完結が確認できたリストだけ**を受け取り、
 * それ以外は予算を増やした 2 回目へ回す。
 */
export function salvageExtractFacts(raw: string): ExtractFactsResult | null {
  if (!raw) return null

  const slice = extractJsonObjectSlice(raw)
  if (slice) {
    try {
      return normalizeExtractFactsResult(JSON.parse(slice) as ExtractFactsResult)
    } catch {
      // 次の段へ
    }
  }

  const facts = matchJsonStringArrayField(raw, 'newFacts')
  const updatedName = matchJsonStringField(raw, 'updatedName')

  // 配列が `]` まで来ていない = 何件取りこぼしたか分からない。救済しない。
  if (facts && !facts.closed) {
    console.warn(
      `[extract-facts] newFacts が閉じていない(${facts.items.length} 件まで確認)。` +
        `切断とみなして救済せずリトライする。`,
    )
    return null
  }

  const items = facts?.items ?? []
  // newFacts が 1 件も拾えず名前も無いなら救済できたとは言えない。リトライさせる。
  // (正常な「収穫ゼロ」は厳密 parse が成功するのでここには来ない)
  if (items.length === 0 && !updatedName) return null

  return normalizeExtractFactsResult({
    newFacts: items,
    updatedName: updatedName ?? null,
  })
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

  // 事実抽出は「会話を終わる」直後に要約と続けて走る。ユーザーが待たずに
  // 離れたら止める(残すと NUM_PARALLEL=1 の Ollama を占有し続ける)。
  const { signal, dispose } = watchClientAbort(res)
  try {
    return await runExtraction(res, messages, model, signal)
  } finally {
    dispose()
  }
})

async function runExtraction(
  res: Response,
  messages: OllamaChatMessage[],
  model: string | undefined,
  signal: AbortSignal,
): Promise<Response | void> {
  let lastRaw = ''
  let lastParseError: unknown = null

  for (let attempt = 0; attempt < EXTRACT_FACTS_ATTEMPTS.length; attempt++) {
    if (signal.aborted) return endAborted(res)
    const sampling = EXTRACT_FACTS_ATTEMPTS[attempt]!
    try {
      const ollamaRes = await chatWithOllama(messages, {
        jsonFormat: true,
        model,
        firstTokenTimeoutMs: OLLAMA_BUDGET_MS.extractFacts,
        signal,
        ...sampling,
      })
      lastRaw = ollamaRes.message?.content ?? ''
      try {
        return res.json(normalizeExtractFactsResult(JSON.parse(lastRaw) as ExtractFactsResult))
      } catch (parseErr) {
        lastParseError = parseErr
        // リトライの前に salvage を試す(フェンス包み / 完結した切断は拾える)。
        // 配列が閉じていない出力はここで null が返り、予算を増やした次の attempt へ回る。
        const salvaged = salvageExtractFacts(lastRaw)
        if (salvaged) {
          console.warn(
            `[extract-facts] salvaged ${salvaged.newFacts.length} fact(s) from malformed JSON ` +
              `(attempt ${attempt + 1}/${EXTRACT_FACTS_ATTEMPTS.length}).`,
          )
          return res.json(salvaged)
        }
        console.warn(
          `[extract-facts] JSON parse + salvage failed (attempt ${attempt + 1}/${EXTRACT_FACTS_ATTEMPTS.length}, ` +
            `numPredict=${sampling.numPredict}, temperature=${sampling.temperature}). raw=`,
          lastRaw.slice(0, 200),
        )
      }
    } catch (e) {
      if (isAbortedError(e)) return endAborted(res)
      if (e instanceof OllamaError) {
        if (e.code === 'NOT_RUNNING' || e.code === 'MODEL_NOT_FOUND' || e.code === 'TIMEOUT') {
          return res.status(503).json({ error: e.message, code: e.code })
        }
      }
      console.error('[extract-facts] error:', e)
      return res.status(500).json({ error: (e as Error).message })
    }
  }

  // 全リトライ失敗。502 を返してフロント側の catch でログ可能にする
  // (フロントは現状 try/catch で握って学習スキップするが、エラーは記録される)。
  // ここで中途半端な救済結果を返さないことが重要:「8/9 件を成功として保存」より
  // 「今回は学習できなかった」の方が、あとから取り返しがつく。
  console.error(
    '[extract-facts] all attempts failed to parse JSON. lastRaw=',
    lastRaw.slice(0, 400),
    'lastError:',
    lastParseError,
  )
  return res.status(502).json({
    error: 'Failed to parse extract-facts JSON response after retries',
    rawContent: lastRaw,
  })
}

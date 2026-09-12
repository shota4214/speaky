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
 * 生成トークン上限。**リトライで倍化しない**(フラット予算)。
 * 旧実装は 700 → 1400 と倍化していたが、倍化は「失敗ターンほど遅い」を作るだけで、
 * 切断された JSON は下の salvage で拾えばよい。
 *
 * 700 の根拠: newFacts は日本語の短文(20〜30 字 ≒ 30〜45 トークン)で、
 * 1 セッションから実際に取れる新規事実はせいぜい 5〜8 件。
 * 8 件 × 45 + updatedName + JSON 記号 ≒ 420 トークンで、700 は十分な上限。
 */
const EXTRACT_FACTS_NUM_PREDICT = 700

/** 2 回まで。2 回目は温度をさらに下げ、seed を固定して決定的にする。 */
const EXTRACT_FACTS_ATTEMPTS: Pick<ChatWithOllamaOptions, 'temperature' | 'topP' | 'seed'>[] = [
  { temperature: 0.2, topP: 0.8 },
  { temperature: 0.1, topP: 0.7, seed: RETRY_SEED },
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
 */
function salvageExtractFacts(raw: string): ExtractFactsResult | null {
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
  // newFacts が 1 件も拾えず名前も無いなら救済できたとは言えない。リトライさせる。
  // (正常な「収穫ゼロ」は厳密 parse が成功するのでここには来ない)
  if ((!facts || facts.length === 0) && !updatedName) return null

  return normalizeExtractFactsResult({
    newFacts: facts ?? [],
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

  let lastRaw = ''
  let lastParseError: unknown = null

  for (let attempt = 0; attempt < EXTRACT_FACTS_ATTEMPTS.length; attempt++) {
    const sampling = EXTRACT_FACTS_ATTEMPTS[attempt]!
    try {
      const ollamaRes = await chatWithOllama(messages, {
        jsonFormat: true,
        model,
        firstTokenTimeoutMs: 60_000,
        numPredict: EXTRACT_FACTS_NUM_PREDICT,
        ...sampling,
      })
      lastRaw = ollamaRes.message?.content ?? ''
      try {
        return res.json(normalizeExtractFactsResult(JSON.parse(lastRaw) as ExtractFactsResult))
      } catch (parseErr) {
        lastParseError = parseErr
        // リトライの前に salvage を試す(切断 / フェンス包みは拾える)
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
            `numPredict=${EXTRACT_FACTS_NUM_PREDICT}, temperature=${sampling.temperature}). raw=`,
          lastRaw.slice(0, 200),
        )
      }
    } catch (e) {
      if (e instanceof OllamaError) {
        if (e.code === 'NOT_RUNNING' || e.code === 'MODEL_NOT_FOUND' || e.code === 'TIMEOUT') {
          return res.status(503).json({ error: e.message, code: e.code })
        }
      }
      console.error('[extract-facts] error:', e)
      return res.status(500).json({ error: (e as Error).message })
    }
  }

  // 全リトライ失敗。500 を返してフロント側の catch でログ可能にする
  // (フロントは現状 try/catch で握って学習スキップするが、エラーは記録される)
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
})

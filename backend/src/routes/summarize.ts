import { Router, type Request, type Response } from 'express'
import { endAborted, isAbortedError, watchClientAbort } from '../services/client-abort.js'
import { chatWithOllama, OllamaError, type OllamaChatMessage } from '../services/ollama.js'
import { OLLAMA_BUDGET_MS } from '../shared/request-budget.js'

interface TranscriptItem {
  role: 'user' | 'ai'
  text: string
}

interface SummarizeRequestBody {
  transcript?: TranscriptItem[]
  topic?: string
  model?: string
}

const SUMMARY_SYSTEM_PROMPT = `You are an assistant who summarizes English conversation practice sessions.
Given the transcript between an English-learning user (Japanese speaker) and an AI tutor, write a SHORT summary in Japanese (1-2 sentences, max 120 characters) that captures the main topics discussed and any notable moments. Output plain text only — no JSON, no markdown, no preamble.`

export const summarizeRouter = Router()

summarizeRouter.post('/summarize', async (req: Request, res: Response) => {
  const { transcript, topic, model } = (req.body ?? {}) as SummarizeRequestBody

  if (!Array.isArray(transcript) || transcript.length === 0) {
    return res.status(400).json({
      error: 'transcript is required (non-empty array of {role, text})',
    })
  }

  const dialogText = transcript
    .map((t) => `${t.role === 'user' ? 'User' : 'AI'}: ${t.text}`)
    .join('\n')

  const topicLine = topic ? `Topic: ${topic}\n\n` : ''

  const userPrompt = `${topicLine}Transcript:\n${dialogText}\n\nSummarize the above in Japanese (1-2 sentences).`

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ]

  // 要約は「会話を終わる」を押した直後に走る。ユーザーが結果を待たずに
  // 画面を離れたら生成も止める(NUM_PARALLEL=1 なので、残すと次の操作が詰まる)。
  const { signal, dispose } = watchClientAbort(res)
  try {
    const ollamaRes = await chatWithOllama(messages, {
      jsonFormat: false,
      model,
      // 予算は shared/request-budget.ts が出典(クライアント締め切りがここから導かれる)。
      firstTokenTimeoutMs: OLLAMA_BUDGET_MS.summarize,
      // 要約は安定性重視: 低 temperature
      temperature: 0.3,
      topP: 0.85,
      // 1-2 文 + 安全マージン。plain text なので length 切断されても短いサマリーになるだけ。
      numPredict: 300,
      signal,
    })
    const raw = ollamaRes.message?.content ?? ''
    const summary = raw.trim().slice(0, 240) // safety cap
    return res.json({ summary })
  } catch (e) {
    if (isAbortedError(e)) return endAborted(res)
    if (e instanceof OllamaError) {
      if (e.code === 'NOT_RUNNING' || e.code === 'MODEL_NOT_FOUND' || e.code === 'TIMEOUT') {
        return res.status(503).json({ error: e.message, code: e.code })
      }
    }
    console.error('[summarize] error:', e)
    return res.status(500).json({ error: (e as Error).message })
  } finally {
    dispose()
  }
})

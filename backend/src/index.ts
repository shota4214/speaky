import express from 'express'
import cors from 'cors'
import { chatRouter } from './routes/chat'
import { extractFactsRouter } from './routes/extract-facts'
import { summarizeRouter } from './routes/summarize'
import { transcribeRouter } from './routes/transcribe'
import { ollamaConfig } from './services/ollama'

const app = express()
const PORT = process.env.PORT ?? 3001

app.use(cors())
app.use(express.json({ limit: '10mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Ollama health check (used by Onboarding flow)
app.get('/api/health/ollama', async (_req, res) => {
  try {
    const response = await fetch(`${ollamaConfig.baseUrl}/api/tags`)
    if (!response.ok) {
      return res
        .status(503)
        .json({ ok: false, error: `Ollama returned ${response.status}` })
    }
    const data = (await response.json()) as { models?: { name: string }[] }
    const models = data.models?.map((m) => m.name) ?? []
    const hasDefaultModel = models.includes(ollamaConfig.model)
    return res.json({
      ok: true,
      baseUrl: ollamaConfig.baseUrl,
      models,
      defaultModel: ollamaConfig.model,
      hasDefaultModel,
    })
  } catch (e) {
    return res.status(503).json({
      ok: false,
      error:
        (e as Error).message ||
        `Ollamaに接続できませんでした(${ollamaConfig.baseUrl})`,
    })
  }
})

app.use('/api', chatRouter)
app.use('/api', summarizeRouter)
app.use('/api', extractFactsRouter)
app.use('/api', transcribeRouter)

app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`)
  console.log(
    `[backend] ollama -> ${ollamaConfig.baseUrl} (model: ${ollamaConfig.model})`,
  )
})

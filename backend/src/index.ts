import express from 'express'
import cors from 'cors'
import { chatRouter } from './routes/chat.js'
import { extractFactsRouter } from './routes/extract-facts.js'
import { modelsRouter } from './routes/models.js'
import { summarizeRouter } from './routes/summarize.js'
import { transcribeRouter } from './routes/transcribe.js'
import { getAdminToken } from './services/admin-token.js'
import { ollamaConfig } from './services/ollama.js'

const app = express()
const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '127.0.0.1'

// CORS: localhost のフロントエンドだけを許可。外部ページからの
// 管理API呼び出し(モデル削除/大容量DL)を CORS preflight で塞ぐ。
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  // 本番ビルドを `vite preview` などで開く場合の標準ポート
  'http://localhost:4173',
  'http://127.0.0.1:4173',
])

app.use(
  cors({
    origin(origin, cb) {
      // SSR/同一オリジン/CLI(originなし)は許可
      if (!origin) return cb(null, true)
      if (ALLOWED_ORIGINS.has(origin)) return cb(null, true)
      return cb(new Error(`Origin not allowed by CORS: ${origin}`))
    },
    credentials: false,
  }),
)
app.use(express.json({ limit: '10mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// 管理 API 用のトークンを同一オリジンの frontend に渡す。
// CORS allowlist により cross-origin からのアクセスは preflight で阻止される。
app.get('/api/auth/admin-token', (_req, res) => {
  res.json({ token: getAdminToken() })
})

// Ollama health check (used by Onboarding flow)
app.get('/api/health/ollama', async (_req, res) => {
  try {
    const response = await fetch(`${ollamaConfig.baseUrl}/api/tags`)
    if (!response.ok) {
      return res.status(503).json({ ok: false, error: `Ollama returned ${response.status}` })
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
      error: (e as Error).message || `Ollamaに接続できませんでした(${ollamaConfig.baseUrl})`,
    })
  }
})

app.use('/api', chatRouter)
app.use('/api', summarizeRouter)
app.use('/api', extractFactsRouter)
app.use('/api', transcribeRouter)
app.use('/api', modelsRouter)

// 127.0.0.1 にバインドして LAN 露出を防ぐ。
// LAN内の別端末からアクセスしたい場合は HOST=0.0.0.0 を設定。
app.listen(PORT, HOST, () => {
  console.log(`[backend] listening on http://${HOST}:${PORT}`)
  console.log(`[backend] ollama -> ${ollamaConfig.baseUrl} (model: ${ollamaConfig.model})`)
})

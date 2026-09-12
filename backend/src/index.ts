import express from 'express'
import cors from 'cors'
import { existsSync } from 'node:fs'
import { totalmem } from 'node:os'
import path from 'node:path'
import { chatRouter } from './routes/chat.js'
import { chatStreamRouter } from './routes/chat-stream.js'
import { extractFactsRouter } from './routes/extract-facts.js'
import { modelsRouter } from './routes/models.js'
import { summarizeRouter } from './routes/summarize.js'
import { transcribeRouter } from './routes/transcribe.js'
import { getAdminToken } from './services/admin-token.js'
import { ollamaConfig } from './services/ollama.js'

const app = express()
const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '127.0.0.1'

// frontend dist を同じ Express で serve するモード(Electron パッケージ用)。
// SPEAKY_FRONTEND_PATH が設定されかつ実在する場合だけ有効になる。
const FRONTEND_DIST = process.env.SPEAKY_FRONTEND_PATH
const SERVE_FRONTEND = !!FRONTEND_DIST && existsSync(FRONTEND_DIST)

// CORS allowlist:
// - 通常の dev は Vite dev server (5173) と vite preview (4173)
// - SERVE_FRONTEND モード(Electronパッケージ等)では同じ backend origin も許可。
//   Chromium は同一 origin の fetch でも Origin ヘッダを付けることがあるため、
//   allowlist に入れていないと CORS preflight で弾かれる。
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
])
if (SERVE_FRONTEND) {
  ALLOWED_ORIGINS.add(`http://${HOST}:${PORT}`)
  // HOST が `0.0.0.0` 等のケースに備えて localhost / 127.0.0.1 両方を入れる
  ALLOWED_ORIGINS.add(`http://localhost:${PORT}`)
  ALLOWED_ORIGINS.add(`http://127.0.0.1:${PORT}`)
}

app.use(
  cors({
    origin(origin, cb) {
      // SSR/同一オリジン直 fetch/CLI(originなし)は許可
      if (!origin) return cb(null, true)
      if (ALLOWED_ORIGINS.has(origin)) return cb(null, true)
      return cb(new Error(`Origin not allowed by CORS: ${origin}`))
    },
    credentials: false,
  }),
)
app.use(express.json({ limit: '10mb' }))

/**
 * バックエンドが持っている機能の宣言。
 *
 * Electron パッケージは frontend を app bundle から、backend を userData から
 * 読み込み、backend の同期は version gate で走る。つまり
 * **frontend だけが新しい** 状態が普通に起こりうる(前リリースでこの非対称が
 * 実際に事故になった)。そのためフロントは「機能があること」を **肯定的に**
 * 確認してからしか新経路を使ってはいけない。
 * 古いバックエンドはこのキー自体を返さないので、その場合は
 * 「ストリーミング無し」と解釈される。
 */
const API_FEATURES = [
  'chat-stream',
  'chat-opening-stream',
  'chat-enrich',
  // 会話プロファイル(standard / small)。フロントはこれがあるときだけ
  // context.modelProfile を送り、UI に「軽量モード」を表示する。
  'model-profile',
] as const
const API_VERSION = 3

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    apiVersion: API_VERSION,
    features: API_FEATURES,
    /**
     * この Mac の搭載メモリ(バイト)。
     *
     * ブラウザ側には積んでいる RAM を知る手段が無い(`deviceMemory` は
     * Chromium でも最大 8 を返す丸め値で、Electron では当てにならない)。
     * backend は Node なので 1 行で正確に取れる。
     * オンボーディングが「このマシンは 8GB なので軽いモデルを薦めます」と
     * 言えるかどうかがこの 1 行に懸かっている。
     */
    totalMemoryBytes: totalmem(),
  })
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
app.use('/api', chatStreamRouter)
app.use('/api', summarizeRouter)
app.use('/api', extractFactsRouter)
app.use('/api', transcribeRouter)
app.use('/api', modelsRouter)

// Electron パッケージ用: 同じ Express で frontend dist を serve し、
// SPA fallback で全ルート(/history, /settings 等)を index.html に解決する。
// API ルートの後に登録することで /api/* が優先される。
if (SERVE_FRONTEND && FRONTEND_DIST) {
  console.log(`[backend] serving frontend from ${FRONTEND_DIST}`)
  app.use(express.static(FRONTEND_DIST))
  // SPA fallback: 静的ファイルが無いパスは index.html に
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    if (req.method !== 'GET') return next()
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'))
  })
}

// 127.0.0.1 にバインドして LAN 露出を防ぐ。
// LAN内の別端末からアクセスしたい場合は HOST=0.0.0.0 を設定。
app.listen(PORT, HOST, () => {
  console.log(`[backend] listening on http://${HOST}:${PORT}`)
  console.log(`[backend] ollama -> ${ollamaConfig.baseUrl} (model: ${ollamaConfig.model})`)
})

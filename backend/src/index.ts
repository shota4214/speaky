import express from 'express'
import cors from 'cors'
import { chatRouter } from './routes/chat'
import { summarizeRouter } from './routes/summarize'
import { transcribeRouter } from './routes/transcribe'
import { ollamaConfig } from './services/ollama'

const app = express()
const PORT = process.env.PORT ?? 3001

app.use(cors())
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use('/api', chatRouter)
app.use('/api', summarizeRouter)
app.use('/api', transcribeRouter)

app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`)
  console.log(`[backend] ollama -> ${ollamaConfig.baseUrl} (model: ${ollamaConfig.model})`)
})
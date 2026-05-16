import { Router, type Request, type Response } from 'express'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { adminAuth } from '../services/admin-token.js'
import { ollamaConfig } from '../services/ollama.js'

interface OllamaTag {
  name: string
  size: number
  modified_at: string
}

interface OllamaTagsResponse {
  models?: OllamaTag[]
}

function findWhisperModelsDir(): string {
  const candidates = [
    path.resolve(
      process.cwd(),
      '..',
      'node_modules',
      'nodejs-whisper',
      'cpp',
      'whisper.cpp',
      'models',
    ),
    path.resolve(process.cwd(), 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp', 'models'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]!
}

function findWhisperCppDir(): string {
  const candidates = [
    path.resolve(process.cwd(), '..', 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp'),
    path.resolve(process.cwd(), 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]!
}

function setupSSE(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  ;(res as Response & { flushHeaders?: () => void }).flushHeaders?.()
}

function sseSend(res: Response, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

export const modelsRouter = Router()

// ----- List installed models -----

modelsRouter.get('/models/ollama', async (_req, res) => {
  try {
    const response = await fetch(`${ollamaConfig.baseUrl}/api/tags`)
    if (!response.ok) {
      return res.status(503).json({ error: `Ollama returned ${response.status}` })
    }
    const data = (await response.json()) as OllamaTagsResponse
    const models = (data.models ?? []).map((m) => ({
      name: m.name,
      sizeBytes: m.size,
      sizeMB: Math.round(m.size / 1024 / 1024),
      modifiedAt: m.modified_at,
    }))
    return res.json({
      models,
      defaultModel: ollamaConfig.model,
    })
  } catch (e) {
    return res.status(503).json({ error: (e as Error).message })
  }
})

modelsRouter.delete('/models/ollama/:name', adminAuth, async (req: Request, res: Response) => {
  const name = decodeURIComponent(req.params.name)
  if (!name || name.includes('..') || name.includes('/')) {
    return res.status(400).json({ error: 'Invalid model name' })
  }
  if (name === ollamaConfig.model) {
    return res.status(400).json({
      error: `現在のデフォルトモデル(${name})は削除できません。先に別のモデルに切り替えてから削除してください。`,
    })
  }
  try {
    const response = await fetch(`${ollamaConfig.baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!response.ok) {
      const text = await response.text()
      return res.status(response.status).json({ error: text })
    }
    return res.json({ ok: true })
  } catch (e) {
    return res.status(503).json({ error: (e as Error).message })
  }
})

modelsRouter.get('/models/whisper', async (_req, res) => {
  const dir = findWhisperModelsDir()
  try {
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      return res.json({ models: [], dir })
    }
    const models = []
    for (const name of entries) {
      if (!name.startsWith('ggml-') || !name.endsWith('.bin')) continue
      const fullPath = path.join(dir, name)
      try {
        const stat = await fs.stat(fullPath)
        models.push({
          name,
          sizeBytes: stat.size,
          sizeMB: Math.round(stat.size / 1024 / 1024),
          modifiedAt: stat.mtime.toISOString(),
        })
      } catch {
        // skip
      }
    }
    return res.json({ models, dir })
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message })
  }
})

modelsRouter.delete('/models/whisper/:filename', adminAuth, async (req: Request, res: Response) => {
  const filename = decodeURIComponent(req.params.filename)
  if (
    !filename.startsWith('ggml-') ||
    !filename.endsWith('.bin') ||
    filename.includes('/') ||
    filename.includes('..')
  ) {
    return res.status(400).json({ error: 'Invalid filename' })
  }
  const dir = findWhisperModelsDir()
  const fullPath = path.join(dir, filename)
  try {
    await fs.unlink(fullPath)
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message })
  }
})

// ----- Ollama pull (SSE) -----

modelsRouter.post('/models/ollama/pull', adminAuth, async (req: Request, res: Response) => {
  const { name } = (req.body ?? {}) as { name?: string }
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' })
  }

  setupSSE(res)

  try {
    const response = await fetch(`${ollamaConfig.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
    })

    if (!response.ok || !response.body) {
      sseSend(res, { error: `Pull failed: HTTP ${response.status}` })
      return res.end()
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line) as unknown
          sseSend(res, obj)
        } catch {
          // ignore parse errors
        }
      }
    }
    return res.end()
  } catch (e) {
    sseSend(res, { error: (e as Error).message })
    return res.end()
  }
})

// ----- Whisper download (SSE, direct from Hugging Face) -----

// nodejs-whisper の MODELS_LIST に含まれ、かつ Hugging Face で実在する
// `ggml-${name}.bin` を持つ名前のみ許可。`large` は HF で 404 になるため除外。
const WHISPER_PRESETS = new Set([
  'tiny',
  'tiny.en',
  'base',
  'base.en',
  'small',
  'small.en',
  'medium',
  'medium.en',
  'large-v1',
  'large-v3-turbo',
])

modelsRouter.post('/models/whisper/download', adminAuth, async (req: Request, res: Response) => {
  const { name } = (req.body ?? {}) as { name?: string }
  if (!name || !WHISPER_PRESETS.has(name)) {
    return res.status(400).json({ error: 'invalid name' })
  }

  setupSSE(res)

  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`
  const dir = findWhisperModelsDir()
  const targetPath = path.join(dir, `ggml-${name}.bin`)
  // 途中で失敗した時に壊れた .bin を残さないように、まず .tmp に書き出す。
  const tempPath = `${targetPath}.tmp`

  async function cleanupTmp() {
    try {
      await fs.unlink(tempPath)
    } catch {
      // ignore
    }
  }

  try {
    await fs.mkdir(dir, { recursive: true })
    await cleanupTmp() // 前回失敗の残骸があれば消す

    const response = await fetch(url)
    if (!response.ok || !response.body) {
      sseSend(res, { error: `HTTP ${response.status}` })
      return res.end()
    }

    const total = Number(response.headers.get('content-length') ?? 0)
    let downloaded = 0
    let lastReport = 0

    sseSend(res, { status: 'starting', total })

    const fileStream = createWriteStream(tempPath)
    const reader = response.body.getReader()

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        // back-pressure を尊重
        if (!fileStream.write(value)) {
          await new Promise<void>((resolve) => fileStream.once('drain', () => resolve()))
        }
        downloaded += value.byteLength
        const now = Date.now()
        if (now - lastReport > 300) {
          sseSend(res, {
            status: 'downloading',
            completed: downloaded,
            total,
          })
          lastReport = now
        }
      }
    } catch (e) {
      fileStream.destroy()
      await cleanupTmp()
      throw e
    }

    fileStream.end()
    await new Promise<void>((resolve, reject) => {
      fileStream.on('finish', () => resolve())
      fileStream.on('error', reject)
    })

    // Content-Length と実ダウンロード量が食い違ったら破損とみなす
    if (total > 0 && downloaded !== total) {
      await cleanupTmp()
      sseSend(res, {
        error: `Download size mismatch: expected ${total} bytes, got ${downloaded}`,
      })
      return res.end()
    }

    // atomic rename(同一FS内のrenameは原則アトミック)
    await fs.rename(tempPath, targetPath)

    sseSend(res, { status: 'success', completed: downloaded, total })
    return res.end()
  } catch (e) {
    await cleanupTmp()
    sseSend(res, { error: (e as Error).message })
    return res.end()
  }
})

// ----- Whisper.cpp build (SSE) -----

modelsRouter.get('/setup/whisper-cpp-status', async (_req, res) => {
  const dir = findWhisperCppDir()
  const cliPath = path.join(dir, 'build', 'bin', 'whisper-cli')
  res.json({
    built: existsSync(cliPath),
    dir,
  })
})

modelsRouter.post('/setup/build-whisper-cpp', adminAuth, async (_req: Request, res: Response) => {
  setupSSE(res)
  const dir = findWhisperCppDir()
  if (!existsSync(dir)) {
    sseSend(res, {
      error: `whisper.cpp directory not found: ${dir}. Run 'npm install' from the project root first.`,
    })
    return res.end()
  }

  function runCmd(cmd: string, args: string[], step: string): Promise<void> {
    return new Promise((resolve, reject) => {
      sseSend(res, {
        step,
        status: 'started',
        command: `${cmd} ${args.join(' ')}`,
      })
      const proc = spawn(cmd, args, { cwd: dir })

      proc.stdout.on('data', (chunk: Buffer) => {
        sseSend(res, { step, stdout: chunk.toString() })
      })
      proc.stderr.on('data', (chunk: Buffer) => {
        sseSend(res, { step, stderr: chunk.toString() })
      })
      proc.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err.message.includes('ENOENT')) {
          reject(
            new Error(
              `${cmd} が見つかりません。Homebrewでインストールしてください: brew install cmake`,
            ),
          )
        } else {
          reject(err)
        }
      })
      proc.on('close', (code) => {
        if (code === 0) {
          sseSend(res, { step, status: 'done' })
          resolve()
        } else {
          reject(new Error(`${step} failed with exit code ${code}`))
        }
      })
    })
  }

  try {
    await runCmd('cmake', ['-B', 'build'], 'configure')
    await runCmd('cmake', ['--build', 'build', '-j', '--config', 'Release'], 'build')
    sseSend(res, { status: 'success' })
    return res.end()
  } catch (e) {
    sseSend(res, { error: (e as Error).message })
    return res.end()
  }
})

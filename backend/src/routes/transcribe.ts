import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import { nodewhisper } from 'nodejs-whisper'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const upload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.audio'
      cb(null, `speaky-${randomUUID()}${ext}`)
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
})

type Language = 'en' | 'ja' | 'mixed' | 'unknown'

function detectLanguage(text: string): Language {
  const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text)
  const hasEnglish = /[A-Za-z]/.test(text)
  if (hasJapanese && hasEnglish) return 'mixed'
  if (hasJapanese) return 'ja'
  if (hasEnglish) return 'en'
  return 'unknown'
}

function extractText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .split('\n')
    .map((line) => {
      const m = line.match(
        /^\[\d{2}:\d{2}:\d{2}\.\d+\s*-->\s*\d{2}:\d{2}:\d{2}\.\d+\]\s*(.*)$/,
      )
      return m ? m[1]!.trim() : ''
    })
    .filter((line) => line.length > 0)
    .join(' ')
    .trim()
}

export const transcribeRouter = Router()

transcribeRouter.post(
  '/transcribe',
  upload.single('audio'),
  async (req: Request, res: Response) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: 'audio file required (multipart field name: "audio")' })
    }

    const filePath = req.file.path
    const startedAt = Date.now()

    try {
      const result = await nodewhisper(filePath, {
        modelName: 'medium',
        autoDownloadModelName: 'medium',
        removeWavFileAfterTranscription: true,
        whisperOptions: {
          language: 'auto',
          outputInJson: false,
          outputInText: false,
          outputInVtt: false,
          outputInSrt: false,
          translateToEnglish: false,
          wordTimestamps: false,
        } as never, // language は新しめのオプションで型定義に追従していない可能性あり
      })

      const text = extractText(result)
      const language = detectLanguage(text)
      const durationMs = Date.now() - startedAt

      console.log(
        `[transcribe] ${durationMs}ms lang=${language} text="${text.slice(0, 80)}"`,
      )

      return res.json({ text, language, durationMs })
    } catch (e) {
      console.error('[transcribe] error:', e)
      return res.status(500).json({ error: (e as Error).message })
    } finally {
      const cleanup = [
        filePath,
        `${filePath}.json`,
        `${filePath}.txt`,
        `${filePath}.srt`,
        `${filePath}.vtt`,
        `${filePath}.wav`,
      ]
      for (const p of cleanup) {
        try {
          await fs.unlink(p)
        } catch {
          // ignore cleanup errors
        }
      }
    }
  },
)
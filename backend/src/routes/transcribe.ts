import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import { nodewhisper } from 'nodejs-whisper'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'

const execFileAsync = promisify(execFile)

// nodejs-whisper の同期 shelljs.exec が Electron の GUI 起動コンテキストで
// 不安定なため(undefined を返して "Cannot read properties of undefined (reading 'code')"
// になる)、事前に WAV 変換しておいて nodejs-whisper の ffmpeg 呼び出しパスをバイパスする。
// 同梱した ffmpeg-static の絶対パスを直接 spawn する。
//
// ffmpeg-static は backend/vendor/node_modules/ にしか存在せず static import では
// resolve できないため、ランタイムで cwd 起点の候補パスを順に存在チェックする。
let cachedFfmpegPath: string | null | undefined
function resolveFfmpegPath(): string | null {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath
  // 1) 明示的な env で上書き(Electron から伝達可能)
  const fromEnv = process.env.SPEAKY_FFMPEG_PATH
  if (fromEnv && existsSync(fromEnv)) {
    cachedFfmpegPath = fromEnv
    return cachedFfmpegPath
  }
  // 2) ffmpeg-static の慣例パスを順に探索:
  //    - packaged: cwd = backend-runtime/        → node_modules/ffmpeg-static/ffmpeg
  //    - dev (tsx watch): cwd = backend/         → vendor/node_modules/ffmpeg-static/ffmpeg
  //    - その他(将来 cwd が変わった時の保険として親階層も見る)
  const candidates = [
    path.resolve(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'),
    path.resolve(process.cwd(), 'vendor', 'node_modules', 'ffmpeg-static', 'ffmpeg'),
    path.resolve(process.cwd(), '..', 'vendor', 'node_modules', 'ffmpeg-static', 'ffmpeg'),
    path.resolve(process.cwd(), '..', 'node_modules', 'ffmpeg-static', 'ffmpeg'),
    path.resolve(process.cwd(), '..', '..', 'node_modules', 'ffmpeg-static', 'ffmpeg'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedFfmpegPath = c
      return cachedFfmpegPath
    }
  }
  cachedFfmpegPath = null
  return cachedFfmpegPath
}

async function convertAudioToWav(inputPath: string): Promise<string> {
  const ffmpeg = resolveFfmpegPath()
  if (!ffmpeg) {
    throw new Error('ffmpeg binary not found (ffmpeg-static / SPEAKY_FFMPEG_PATH)')
  }
  const outputPath = `${inputPath}.wav`
  // 16kHz / mono / PCM s16le は whisper.cpp が期待するフォーマット
  await execFileAsync(ffmpeg, [
    '-nostats',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    outputPath,
  ])
  return outputPath
}

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
// nodejs-whisper の MODELS_LIST(constants.js)に含まれ、かつ Hugging Face
// 側で `ggml-${name}.bin` が実在するモデルのみを許可する。
// - `large-v3` は nodejs-whisper の MODELS_LIST に無く拒否される
// - `large` は nodejs-whisper には載っているが ggml-large.bin が HF で 404
type WhisperModelName =
  | 'tiny'
  | 'tiny.en'
  | 'base'
  | 'base.en'
  | 'small'
  | 'small.en'
  | 'medium'
  | 'medium.en'
  | 'large-v1'
  | 'large-v3-turbo'

const ALLOWED_WHISPER_MODELS = new Set<WhisperModelName>([
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

function pickDefaultWhisperModel(): WhisperModelName {
  const envModel = process.env.WHISPER_MODEL
  if (envModel && ALLOWED_WHISPER_MODELS.has(envModel as WhisperModelName)) {
    return envModel as WhisperModelName
  }
  return 'medium'
}

const DEFAULT_WHISPER_MODEL: WhisperModelName = pickDefaultWhisperModel()

function resolveWhisperModel(requested?: string): WhisperModelName {
  if (requested && ALLOWED_WHISPER_MODELS.has(requested as WhisperModelName)) {
    return requested as WhisperModelName
  }
  return DEFAULT_WHISPER_MODEL
}

function detectLanguage(text: string): Language {
  const hasJapanese = /[぀-ゟ゠-ヿ一-龯]/.test(text)
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
      const m = line.match(/^\[\d{2}:\d{2}:\d{2}\.\d+\s*-->\s*\d{2}:\d{2}:\d{2}\.\d+\]\s*(.*)$/)
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
      return res.status(400).json({
        error: 'audio file required (multipart field name: "audio")',
      })
    }

    const filePath = req.file.path
    const startedAt = Date.now()

    // multipart の追加フィールド `model` で Whisper モデルを指定可能。
    // allowlist 検証で安全化(任意のファイル名を受け付けない)。
    const requestedModel = typeof req.body?.model === 'string' ? req.body.model : undefined
    const modelName = resolveWhisperModel(requestedModel)

    // 念のため最終ガード(本来は resolveWhisperModel が常に文字列を返す)
    if (!modelName) {
      return res.status(500).json({ error: 'Internal: failed to resolve whisper model name' })
    }

    console.log(`[transcribe] start: requested=${requestedModel ?? '(none)'} resolved=${modelName}`)

    let wavPath: string | null = null
    try {
      // 事前 WAV 変換(nodejs-whisper の壊れた sync shelljs.exec をバイパス)。
      // 既に .wav なら nodejs-whisper が isValidWavHeader で素通しするので、
      // ffmpeg を介さず元ファイルを渡しても良いが、不正な .wav ヘッダだけ守るため
      // 拡張子に関わらず変換する。
      wavPath = await convertAudioToWav(filePath)
      const result = await nodewhisper(wavPath, {
        modelName,
        autoDownloadModelName: modelName,
        removeWavFileAfterTranscription: false,
        whisperOptions: {
          language: 'auto',
          outputInJson: false,
          outputInText: false,
          outputInVtt: false,
          outputInSrt: false,
          translateToEnglish: false,
          wordTimestamps: false,
        } as never,
      })

      const text = extractText(result)
      const language = detectLanguage(text)
      const durationMs = Date.now() - startedAt

      console.log(
        `[transcribe] model=${modelName} ${durationMs}ms lang=${language} text="${text.slice(0, 80)}"`,
      )

      return res.json({ text, language, durationMs, model: modelName })
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
      if (wavPath && !cleanup.includes(wavPath)) cleanup.push(wavPath)
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

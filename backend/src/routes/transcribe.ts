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
import {
  listInstalledWhisperModelNames,
  whisperModelExists,
  whisperModelPath,
} from '../services/whisper-paths.js'
import { endAborted, isClientAbort, watchClientAbort } from '../services/client-abort.js'
import { TRANSCRIBE_BUDGET_MS } from '../shared/request-budget.js'

const execFileAsync = promisify(execFile)

/**
 * 転写が予算内に終わらなかったことを表すエラー。
 * ルートはこれを 504 + code:'TIMEOUT' に変換する。
 */
class TranscribeTimeoutError extends Error {
  constructor(label: string, budgetMs: number) {
    super(`音声認識が時間内に終わりませんでした(${label} / ${budgetMs}ms)`)
    this.name = 'TranscribeTimeoutError'
  }
}

/**
 * 1 リクエスト分の残り時間を持つ予算。
 *
 * ⚠️ **これが v1.1.0 まで唯一存在しなかった締め切り**だった。
 * 転写は毎ターン必ず通る経路なのに、クライアント側にもサーバー側にも
 * 時間の上限が無く、whisper の子プロセスが詰まる(メモリ逼迫)か
 * ソケットが半開きになる(スリープ復帰)と、会話ループは
 * 「認識中」のままマイクを閉じて永久に戻ってこなかった。
 *
 * ⚠️ **whisper の子プロセス自体は kill できない**。nodejs-whisper は
 * `shelljs.exec(..., {async:true}, cb)` の戻り値(ChildProcess)を
 * 外に出さないので、こちらから握れるハンドルが無い。
 * よってここで打ち切れるのは「待つのをやめる」ところまでで、
 * 走っている whisper-cli は自然に終わるまで残る(音声は最長でも
 * 1 ターン分なので、詰まっていなければ数十秒で終わる)。
 * それでもリクエストが必ず畳まれることが重要 — ループが復帰できる。
 * 子プロセスまで確実に殺すには nodejs-whisper を経由せず whisper-cli を
 * 自前で spawn する必要があり、それは実機検証込みの別作業にしてある。
 */
class Deadline {
  private readonly expiresAt: number
  constructor(budgetMs: number) {
    this.expiresAt = Date.now() + budgetMs
  }
  remainingMs(): number {
    return this.expiresAt - Date.now()
  }
  /** `promise` を残り時間で打ち切る。中断シグナルが立っていても即座に諦める。 */
  async race<T>(promise: Promise<T>, label: string, signal: AbortSignal): Promise<T> {
    const remaining = this.remainingMs()
    // 負け側になった promise が後から reject しても unhandledRejection にしない。
    // 打ち切り後に finally が wav ファイルを消すので、走り続けている whisper は
    // ほぼ確実に失敗する = ここが無いとプロセスが落ちる。
    promise.catch(() => undefined)
    if (remaining <= 0) throw new TranscribeTimeoutError(label, TRANSCRIBE_BUDGET_MS)
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            console.warn(
              `[transcribe] ${label} が予算(${TRANSCRIBE_BUDGET_MS}ms)を超えたので打ち切り`,
            )
            reject(new TranscribeTimeoutError(label, TRANSCRIBE_BUDGET_MS))
          }, remaining)
          onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
}

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

// 同梱しているモデル(= DMG に必ず入っている既定モデル)。
// medium(1.53GB)は 8GB Mac で毎リクエスト RAM に載せると swap するため small に変更した。
// small は多言語モデル。日本語入力を扱うので `.en` 系は選ばないこと。
export const BUNDLED_WHISPER_MODEL: WhisperModelName = 'small'

function pickDefaultWhisperModel(): WhisperModelName {
  const envModel = process.env.WHISPER_MODEL
  if (envModel && ALLOWED_WHISPER_MODELS.has(envModel as WhisperModelName)) {
    return envModel as WhisperModelName
  }
  return BUNDLED_WHISPER_MODEL
}

const DEFAULT_WHISPER_MODEL: WhisperModelName = pickDefaultWhisperModel()

function resolveWhisperModel(requested?: string): WhisperModelName {
  if (requested && ALLOWED_WHISPER_MODELS.has(requested as WhisperModelName)) {
    return requested as WhisperModelName
  }
  return DEFAULT_WHISPER_MODEL
}

/**
 * フォールバック先に選んでよい多言語モデルを「小さい順」に並べたもの。
 *
 * - `.en` 系は絶対に入れないこと。日本語音声入力(japanese_help / mixed 経路)が
 *   英語専用モデルでは壊れる。フォールバックは品質劣化であってはならない。
 * - 低スペック機向けブランチなので、大きい方ではなく**小さい方**を優先する
 *   (rescue が RAM を食い潰して次の問題を作らないように)。
 */
const MULTILINGUAL_FALLBACK_ORDER: WhisperModelName[] = [
  'tiny',
  'base',
  'small',
  'medium',
  'large-v3-turbo',
  'large-v1',
]

/**
 * 実行直前にモデル実体(ggml-*.bin)がディスクにあるかを確認する。
 *
 * 旧版では `medium` が localStorage に残っているユーザーがいるが、DMG に同梱するのは
 * `small` になったため、そのまま whisper を叩くとモデルが無い。nodejs-whisper に
 * autoDownloadModelName を渡していた頃はここで DL + ビルドが走って固まっていた。
 *
 * フォールバック順: リクエスト値 → 同梱デフォルト → インストール済みの多言語モデル
 * (小さい順) → null(呼び出し側で 503)。
 * 3 段目が無いと「設定は small だがディスクには medium しか無い」ユーザーが、
 * 使えるモデルが同じディレクトリにあるのに毎ターン 503 になっていた。
 * どの段でもネットは叩かない(オフライン動作の前提を守る)。明示 DL は
 * POST /api/models/whisper/download のみ。
 */
function ensureWhisperModel(requested: WhisperModelName): WhisperModelName | null {
  if (whisperModelExists(requested)) return requested

  console.warn(
    `[transcribe] model file not found for "${requested}" (${whisperModelPath(requested)}); ` +
      `looking for a usable fallback`,
  )
  if (requested !== BUNDLED_WHISPER_MODEL && whisperModelExists(BUNDLED_WHISPER_MODEL)) {
    console.warn(`[transcribe] falling back to bundled model "${BUNDLED_WHISPER_MODEL}"`)
    return BUNDLED_WHISPER_MODEL
  }

  // 同梱モデルも無い(ユーザーが消した / 旧 userData のまま等)。
  // models ディレクトリを走査して、使える多言語モデルがあればそれを使う。
  const installed = new Set(listInstalledWhisperModelNames())
  const alternative = MULTILINGUAL_FALLBACK_ORDER.find(
    (m) => m !== requested && ALLOWED_WHISPER_MODELS.has(m) && installed.has(m),
  )
  if (alternative) {
    console.warn(
      `[transcribe] falling back to installed multilingual model "${alternative}" ` +
        `(installed: ${[...installed].join(', ') || '(none)'})`,
    )
    return alternative
  }

  console.error(
    `[transcribe] no usable whisper model on disk (installed: ${[...installed].join(', ') || '(none)'})`,
  )
  return null
}

function detectLanguage(text: string): Language {
  const hasJapanese = /[぀-ゟ゠-ヿ一-龯]/.test(text)
  const hasEnglish = /[A-Za-z]/.test(text)
  if (hasJapanese && hasEnglish) return 'mixed'
  if (hasJapanese) return 'ja'
  if (hasEnglish) return 'en'
  return 'unknown'
}

// ハングル(韓国語)文字。日本語音声を Whisper が韓国語と誤判定すると出る。
// アプリの対象は日本語・英語のみなので、ハングルが混入していれば誤認識とみなす。
// - Hangul Syllables: U+AC00–U+D7AF
// - Hangul Jamo: U+1100–U+11FF
// - Hangul Compatibility Jamo: U+3130–U+318F
const KOREAN_REGEX = /[가-힯ᄀ-ᇿ㄰-㆏]/

function hasKorean(text: string): boolean {
  return KOREAN_REGEX.test(text)
}

async function runWhisper(
  wavPath: string,
  modelName: WhisperModelName,
  language: 'auto' | 'ja' | 'en',
): Promise<string> {
  // autoDownloadModelName は意図的に渡さない。
  // 渡すと nodejs-whisper がモデル欠落時に HTTP リクエストの中で
  // HuggingFace からの DL + cmake ビルドを始めてしまい、リクエストが
  // 数分〜無限に固まる(autoDownloadModel.js 参照)。
  // モデルの有無は ensureWhisperModel() が事前に検証し、無ければ同梱モデルに
  // フォールバックする。明示的な DL は POST /api/models/whisper/download が担当。
  const result = await nodewhisper(wavPath, {
    modelName,
    removeWavFileAfterTranscription: false,
    whisperOptions: {
      language,
      outputInJson: false,
      outputInText: false,
      outputInVtt: false,
      outputInSrt: false,
      translateToEnglish: false,
      wordTimestamps: false,
    } as never,
  })
  return extractText(result)
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
    const resolvedModel = resolveWhisperModel(requestedModel)

    // 念のため最終ガード(本来は resolveWhisperModel が常に文字列を返す)
    if (!resolvedModel) {
      return res.status(500).json({ error: 'Internal: failed to resolve whisper model name' })
    }

    // モデル実体が無ければ同梱モデルにフォールバック(リクエスト内 DL/ビルドはしない)
    const modelName = ensureWhisperModel(resolvedModel)
    if (!modelName) {
      await fs.unlink(filePath).catch(() => {})
      return res.status(503).json({
        error:
          `音声認識モデルが見つかりません(要求: ${resolvedModel} / 同梱: ${BUNDLED_WHISPER_MODEL})。` +
          `使用できるモデルが 1 つもインストールされていません。` +
          `設定画面の「インストール済みモデル」から取得してください。`,
      })
    }

    console.log(
      `[transcribe] start: requested=${requestedModel ?? '(none)'} resolved=${resolvedModel} using=${modelName}`,
    )

    // 会話を終えた / クライアントが締め切りで諦めた瞬間に、こちらも待つのをやめる。
    // (whisper の子プロセス自体は Deadline のコメント通り握れないので残るが、
    //  リクエストは必ず畳まれ、Express のハンドラが宙に浮かない)
    const { signal, dispose } = watchClientAbort(res)
    // 予算はリクエスト全体に 1 本。ffmpeg + 最大 3 パスの合計をここで見る。
    const deadline = new Deadline(TRANSCRIBE_BUDGET_MS)

    let wavPath: string | null = null
    try {
      // 事前 WAV 変換(nodejs-whisper の壊れた sync shelljs.exec をバイパス)。
      // 既に .wav なら nodejs-whisper が isValidWavHeader で素通しするので、
      // ffmpeg を介さず元ファイルを渡しても良いが、不正な .wav ヘッダだけ守るため
      // 拡張子に関わらず変換する。
      wavPath = await deadline.race(convertAudioToWav(filePath), 'ffmpeg', signal)

      // 1パス目: 言語自動判定。日本語と韓国語は音素が近く、短い発話や雑音時に
      // ハングルとして返ってくることがある。アプリは日英のみ扱うので、その場合は
      // 言語を強制した再認識で救済する。
      let text = await deadline.race(
        runWhisper(wavPath, modelName, 'auto'),
        'whisper(auto)',
        signal,
      )
      let usedLanguage: 'auto' | 'ja' | 'en' = 'auto'

      if (hasKorean(text)) {
        console.warn(
          `[transcribe] Korean chars in auto pass; retrying with language=ja. text="${text.slice(0, 80)}"`,
        )
        const jaText = await deadline.race(
          runWhisper(wavPath, modelName, 'ja'),
          'whisper(ja)',
          signal,
        )
        if (!hasKorean(jaText) && jaText.trim().length > 0) {
          text = jaText
          usedLanguage = 'ja'
        } else {
          console.warn(
            `[transcribe] ja pass still bad; retrying with language=en. ja="${jaText.slice(0, 80)}"`,
          )
          const enText = await deadline.race(
            runWhisper(wavPath, modelName, 'en'),
            'whisper(en)',
            signal,
          )
          if (!hasKorean(enText) && enText.trim().length > 0) {
            text = enText
            usedLanguage = 'en'
          } else {
            console.warn(
              `[transcribe] all passes produced Korean / empty; dropping result. en="${enText.slice(0, 80)}"`,
            )
            text = ''
          }
        }
      }

      const language = detectLanguage(text)
      const durationMs = Date.now() - startedAt

      console.log(
        `[transcribe] model=${modelName} ${durationMs}ms lang=${language} forced=${usedLanguage} text="${text.slice(0, 80)}"`,
      )

      return res.json({ text, language, durationMs, model: modelName })
    } catch (e) {
      // 会話を終えただけ / クライアントが切っただけ。エラーとして書き込まない。
      if (isClientAbort(e, signal)) return endAborted(res)
      if (e instanceof TranscribeTimeoutError) {
        console.error('[transcribe] deadline exceeded:', e.message)
        // 504 + TIMEOUT。フロントはこれを「通信が切れたかもしれない」として
        // ユーザーに見せ、連続失敗の上限に当たれば録音を止める(復帰可能な形)。
        return res.status(504).json({
          error:
            '音声の認識が時間内に終わりませんでした。' +
            'Mac の空きメモリが少ない可能性があります。もう一度話しかけてみてください。',
          code: 'TIMEOUT',
        })
      }
      console.error('[transcribe] error:', e)
      return res.status(500).json({ error: (e as Error).message })
    } finally {
      dispose()
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

import type { Gender, Level, PersonalityPreset } from '../db/types'

const STORAGE_KEY = 'speaky:settings'

// nodejs-whisper の MODELS_LIST に含まれ、かつ Hugging Face で実在する
// `ggml-${name}.bin` を持つ名前のみ許可する。
// - `large-v3` は nodejs-whisper の MODELS_LIST に無いため拒否される
// - `large`(無印)は HF 上に ggml-large.bin が無く 404 になるため除外
export type WhisperModel =
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

export const VALID_WHISPER_MODELS = new Set<WhisperModel>([
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

/**
 * バックエンドが会話に使える LLM の allowlist(backend/src/services/ollama.ts の
 * ALLOWED_LLM_MODELS とミラー)。allowlist 外を指定すると backend が default に
 * フォールバックするため、設定画面の選択肢はこの集合に絞る。
 * ※ backend と手動同期が必要。片方だけ変更しないこと。
 */
export const ALLOWED_LLM_MODELS = new Set<string>([
  'llama3.2:3b',
  'llama3.1:8b',
  'gemma2:9b',
  'gemma2:2b',
  'qwen2.5:7b',
  'qwen2.5:14b',
])

export type DarkModePref = 'system' | 'light' | 'dark'

/**
 * TTS rate / pitch の許容範囲(UI のスライダー範囲と一致させる)。
 * 範囲外の値が localStorage に保存されていた場合は clamp する。
 */
export const TTS_RATE_MIN = 0.5
export const TTS_RATE_MAX = 1.5
export const TTS_PITCH_MIN = 0.7
export const TTS_PITCH_MAX = 1.4

export interface AppSettings {
  aiCharacter: {
    name: string
    gender: Gender
    /**
     * Web Speech API の voice.name(例: "Samantha", "Daniel")。
     * null の場合は gender ベースのフォールバック(下位互換)を使う。
     */
    voiceName: string | null
    /** AI の性格プリセット。デフォルト 'friendly' は従来挙動を踏襲。 */
    personality: PersonalityPreset
  }
  silenceDurationMs: number
  llmModel: string
  whisperModel: WhisperModel
  darkMode: DarkModePref
  ttsRateConnectedToLevel: boolean
  /**
   * ttsRateConnectedToLevel=false のときに使うユーザー指定の話速。
   * 連動時は無視され、speakRateForLevel() の結果が使われる。
   */
  ttsRate: number
  /** TTS の声の高さ。常にユーザー指定値を使う(連動オプション無し)。 */
  ttsPitch: number
  /** AI 返答に日本語訳を表示するか。true(表示)がデフォルト。 */
  showJapanese: boolean
  lastCleanupAt: number | null
  defaultLevel: Level
}

/** 無音自動送信の間隔(ミリ秒)の許容範囲。UI のスライダー範囲と一致させる。 */
export const SILENCE_MS_MIN = 1000
export const SILENCE_MS_MAX = 15000

export const DEFAULT_SETTINGS: AppSettings = {
  aiCharacter: {
    name: 'Emma',
    gender: 'female',
    voiceName: null,
    personality: 'friendly',
  },
  // 5秒: 話し終わってから送信されるまでの猶予。設定画面で 1-15 秒に調整可能。
  silenceDurationMs: 5000,
  llmModel: 'llama3.2:3b',
  // small(多言語・約488MB): 8GB Mac でも現実的な速度/RAM。日本語入力を扱うので `.en` は不可。
  whisperModel: 'small',
  darkMode: 'system',
  ttsRateConnectedToLevel: true,
  ttsRate: 1.0,
  ttsPitch: 1.0,
  showJapanese: true,
  lastCleanupAt: null,
  defaultLevel: 'intermediate',
}

const VALID_PERSONALITIES = new Set<PersonalityPreset>([
  'friendly',
  'teacher',
  'cool',
  'kohai',
  'colleague',
])

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

function isStorageAvailable(): boolean {
  return typeof globalThis.localStorage !== 'undefined'
}

export function loadSettings(): AppSettings {
  if (!isStorageAvailable()) return { ...DEFAULT_SETTINGS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    const merged: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      aiCharacter: {
        ...DEFAULT_SETTINGS.aiCharacter,
        ...(parsed.aiCharacter ?? {}),
      },
    }
    // 過去バージョンで保存されたサポート外の whisperModel(例: `large-v3`)を
    // 検出してデフォルトに戻す。そうしないと nodejs-whisper が拒否する。
    if (!VALID_WHISPER_MODELS.has(merged.whisperModel)) {
      console.warn(
        `[settings] Unsupported whisperModel "${merged.whisperModel}" detected; falling back to "${DEFAULT_SETTINGS.whisperModel}"`,
      )
      merged.whisperModel = DEFAULT_SETTINGS.whisperModel
    }
    // 旧バージョンに無かったフィールドのマイグレーション。
    // voiceName / personality は aiCharacter の中で欠落しているケースを補完する。
    if (typeof merged.aiCharacter.voiceName === 'undefined') {
      merged.aiCharacter.voiceName = null
    }
    if (!VALID_PERSONALITIES.has(merged.aiCharacter.personality)) {
      merged.aiCharacter.personality = DEFAULT_SETTINGS.aiCharacter.personality
    }
    // ttsRate / ttsPitch は範囲外のときデフォルトに戻す(clamp で防御)
    merged.ttsRate = clamp(
      typeof merged.ttsRate === 'number' ? merged.ttsRate : DEFAULT_SETTINGS.ttsRate,
      TTS_RATE_MIN,
      TTS_RATE_MAX,
    )
    merged.ttsPitch = clamp(
      typeof merged.ttsPitch === 'number' ? merged.ttsPitch : DEFAULT_SETTINGS.ttsPitch,
      TTS_PITCH_MIN,
      TTS_PITCH_MAX,
    )
    // showJapanese は旧バージョンに無いので欠落時はデフォルト(表示)に
    if (typeof merged.showJapanese !== 'boolean') {
      merged.showJapanese = DEFAULT_SETTINGS.showJapanese
    }
    // silenceDurationMs を許容範囲に clamp
    merged.silenceDurationMs = clamp(
      typeof merged.silenceDurationMs === 'number'
        ? merged.silenceDurationMs
        : DEFAULT_SETTINGS.silenceDurationMs,
      SILENCE_MS_MIN,
      SILENCE_MS_MAX,
    )
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: AppSettings): void {
  if (!isStorageAvailable()) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // localStorage may be full or unavailable
  }
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    aiCharacter: {
      ...current.aiCharacter,
      ...(patch.aiCharacter ?? {}),
    },
  }
  saveSettings(next)
  return next
}

export function resetSettings(): AppSettings {
  if (isStorageAvailable()) {
    localStorage.removeItem(STORAGE_KEY)
  }
  return { ...DEFAULT_SETTINGS }
}

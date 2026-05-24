import type { Gender, Level } from '../db/types'

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

const VALID_WHISPER_MODELS = new Set<WhisperModel>([
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

export type DarkModePref = 'system' | 'light' | 'dark'

export interface AppSettings {
  aiCharacter: {
    name: string
    gender: Gender
  }
  silenceDurationMs: number
  llmModel: string
  whisperModel: WhisperModel
  darkMode: DarkModePref
  ttsRateConnectedToLevel: boolean
  lastCleanupAt: number | null
  defaultLevel: Level
}

export const DEFAULT_SETTINGS: AppSettings = {
  aiCharacter: { name: 'Emma', gender: 'female' },
  // 1.5秒: 体感のラリー速度と誤切れのバランス点。設定画面で 1-5 秒に調整可能。
  silenceDurationMs: 1500,
  llmModel: 'llama3.2:3b',
  whisperModel: 'medium',
  darkMode: 'system',
  ttsRateConnectedToLevel: true,
  lastCleanupAt: null,
  defaultLevel: 'intermediate',
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

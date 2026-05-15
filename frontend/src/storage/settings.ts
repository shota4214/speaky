import type { Gender, Level } from '../db/types'

const STORAGE_KEY = 'speaky:settings'

export type WhisperModel = 'small' | 'medium' | 'large-v3'
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
  silenceDurationMs: 2000,
  llmModel: 'gemma2:9b',
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
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      aiCharacter: {
        ...DEFAULT_SETTINGS.aiCharacter,
        ...(parsed.aiCharacter ?? {}),
      },
    }
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

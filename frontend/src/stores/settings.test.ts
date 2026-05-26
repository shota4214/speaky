import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../storage/settings'
import { useSettingsStore } from './settings'

describe('useSettingsStore', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('loads DEFAULT_SETTINGS on first init', () => {
    const s = useSettingsStore()
    expect(s.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('update merges patch and persists to localStorage', async () => {
    const s = useSettingsStore()
    s.update({ silenceDurationMs: 3000 })
    expect(s.settings.silenceDurationMs).toBe(3000)
    // wait a tick for watch to fire
    await Promise.resolve()
    const raw = localStorage.getItem('speaky:settings')
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!).silenceDurationMs).toBe(3000)
  })

  it('update preserves nested aiCharacter fields', () => {
    const s = useSettingsStore()
    s.update({ aiCharacter: { name: 'Mike' } })
    expect(s.settings.aiCharacter.name).toBe('Mike')
    expect(s.settings.aiCharacter.gender).toBe(DEFAULT_SETTINGS.aiCharacter.gender)
    expect(s.settings.aiCharacter.voiceName).toBe(DEFAULT_SETTINGS.aiCharacter.voiceName)
    expect(s.settings.aiCharacter.personality).toBe(DEFAULT_SETTINGS.aiCharacter.personality)
  })

  it('reset restores DEFAULT_SETTINGS and clears storage', () => {
    const s = useSettingsStore()
    s.update({ silenceDurationMs: 4000 })
    s.reset()
    expect(s.settings).toEqual(DEFAULT_SETTINGS)
    expect(localStorage.getItem('speaky:settings')).toBeNull()
  })

  it('new store instance picks up persisted settings', async () => {
    const s1 = useSettingsStore()
    s1.update({ silenceDurationMs: 2500 })
    await Promise.resolve()

    // Reset Pinia to simulate page reload
    setActivePinia(createPinia())
    const s2 = useSettingsStore()
    expect(s2.settings.silenceDurationMs).toBe(2500)
  })

  // 旧バージョン(voiceName / personality / ttsRate / ttsPitch を持たない)
  // から読み込んだ場合にデフォルト値が補完されることを確認する。
  it('migrates legacy settings missing new fields', () => {
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({
        aiCharacter: { name: 'OldEmma', gender: 'female' },
        silenceDurationMs: 1500,
        llmModel: 'llama3.2:3b',
        whisperModel: 'medium',
        darkMode: 'system',
        ttsRateConnectedToLevel: true,
        lastCleanupAt: null,
        defaultLevel: 'intermediate',
      }),
    )
    const s = useSettingsStore()
    expect(s.settings.aiCharacter.name).toBe('OldEmma')
    expect(s.settings.aiCharacter.voiceName).toBeNull()
    expect(s.settings.aiCharacter.personality).toBe('friendly')
    expect(s.settings.ttsRate).toBe(DEFAULT_SETTINGS.ttsRate)
    expect(s.settings.ttsPitch).toBe(DEFAULT_SETTINGS.ttsPitch)
  })

  // 範囲外の ttsRate / ttsPitch が保存されていた場合に clamp されることを確認する。
  it('clamps out-of-range ttsRate / ttsPitch on load', () => {
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        ttsRate: 5.0, // out of range
        ttsPitch: 0.1, // out of range
      }),
    )
    const s = useSettingsStore()
    expect(s.settings.ttsRate).toBe(1.5) // TTS_RATE_MAX
    expect(s.settings.ttsPitch).toBe(0.7) // TTS_PITCH_MIN
  })

  it('persists personality changes', async () => {
    const s = useSettingsStore()
    s.update({ aiCharacter: { personality: 'teacher' } })
    expect(s.settings.aiCharacter.personality).toBe('teacher')
    await Promise.resolve()
    const raw = localStorage.getItem('speaky:settings')
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!).aiCharacter.personality).toBe('teacher')
  })
})

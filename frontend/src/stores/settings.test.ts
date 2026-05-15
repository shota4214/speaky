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
    s.update({ aiCharacter: { name: 'Mike' } as { name: string; gender: 'male' | 'female' } })
    expect(s.settings.aiCharacter.name).toBe('Mike')
    expect(s.settings.aiCharacter.gender).toBe(DEFAULT_SETTINGS.aiCharacter.gender)
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
})

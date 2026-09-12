import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, loadSettings, SETTINGS_SCHEMA_VERSION } from '../storage/settings'
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

  // スキーマ v1(schemaVersion 欠落)で旧デフォルトの 5000 が保存されている場合、
  // 新デフォルト(1500)へ一度だけ移行されることを確認する。
  it('migrates legacy default silenceDurationMs (5000) to the new default', () => {
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        silenceDurationMs: 5000,
        schemaVersion: undefined,
      }),
    )
    const s = useSettingsStore()
    expect(s.settings.silenceDurationMs).toBe(DEFAULT_SETTINGS.silenceDurationMs)
    expect(s.settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
  })

  // 自分で 5000 以外に変更していた値は移行対象外(尊重する)。
  it('keeps a user-customized silenceDurationMs during schema migration', () => {
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        silenceDurationMs: 8000,
        schemaVersion: undefined,
      }),
    )
    const s = useSettingsStore()
    expect(s.settings.silenceDurationMs).toBe(8000)
  })

  // スキーマ v1 の旧デフォルト whisperModel 'medium'(もう同梱されない)を
  // 新デフォルト 'small' へ移行することを確認する。
  it('migrates legacy default whisperModel (medium) to the new default', () => {
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        whisperModel: 'medium',
        schemaVersion: undefined,
      }),
    )
    const s = useSettingsStore()
    expect(s.settings.whisperModel).toBe(DEFAULT_SETTINGS.whisperModel)
  })

  // 移行済み(schemaVersion=2)なら、たまたま 5000 でも書き換えない。
  it('does not re-apply the migration once schemaVersion is current', () => {
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        silenceDurationMs: 5000,
        schemaVersion: SETTINGS_SCHEMA_VERSION,
      }),
    )
    const s = useSettingsStore()
    expect(s.settings.silenceDurationMs).toBe(5000)
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

// スキーマ移行は「一度きり」であることが契約なので、移行が走った時点で
// localStorage に書き戻されていること（= 次回起動では走らないこと）を検証する。
// ストアは値が変わったときにしか保存しないため、in-memory の状態だけを見ていると
// この抜けを検出できない。
describe('loadSettings schema migration persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  function persisted(): Record<string, unknown> {
    const raw = localStorage.getItem('speaky:settings')
    expect(raw).toBeTruthy()
    return JSON.parse(raw!) as Record<string, unknown>
  }

  it('persists the migrated result immediately (schemaVersion is written back)', () => {
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        silenceDurationMs: 5000,
        whisperModel: 'medium',
        schemaVersion: undefined,
      }),
    )

    const loaded = loadSettings()
    expect(loaded.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)

    const stored = persisted()
    expect(stored.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(stored.silenceDurationMs).toBe(DEFAULT_SETTINGS.silenceDurationMs)
    expect(stored.whisperModel).toBe(DEFAULT_SETTINGS.whisperModel)
  })

  it('a second load sees the migrated value and does not migrate again', () => {
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({ ...DEFAULT_SETTINGS, silenceDurationMs: 5000, schemaVersion: undefined }),
    )
    loadSettings()

    // 移行後にユーザーが 5000 へ戻したケース: 2 回目の load で書き換えられてはいけない
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({ ...persisted(), silenceDurationMs: 5000 }),
    )
    expect(loadSettings().silenceDurationMs).toBe(5000)
    expect(persisted().silenceDurationMs).toBe(5000)
  })

  it('does not write to storage when the stored schema is already current', () => {
    // ttsRate は範囲外なので in-memory では clamp されるが、保存はされない
    const stored = { ...DEFAULT_SETTINGS, silenceDurationMs: 5000, ttsRate: 5.0 }
    localStorage.setItem('speaky:settings', JSON.stringify(stored))

    const loaded = loadSettings()
    expect(loaded.ttsRate).toBe(1.5) // TTS_RATE_MAX に clamp
    expect(persisted()).toEqual(stored) // storage は素通り
  })

  it('streaming は既定で有効、保存済み設定に無ければ既定で補完する', () => {
    // v1.1.0 までの保存内容(streaming キーが存在しない)
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, silenceDurationMs: 2000 }),
    )
    const loaded = loadSettings()
    expect(loaded.streaming).toBe(true)
    // スキーマ版は上げない(値の形は変わっていない)
    expect(loaded.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
  })

  it('streaming を OFF にすると保存され、読み直しても OFF のまま(キルスイッチ)', async () => {
    const s = useSettingsStore()
    s.update({ streaming: false })
    await Promise.resolve()
    expect(loadSettings().streaming).toBe(false)
  })
})

/**
 * スキーマ v2 → v3(modelProfile の新設)。
 *
 * キーが増えただけなら版を上げる必要は無い(merge が欠落を埋める)。
 * 上げているのは 1 点だけのため: **既に `gemma2:2b` を選んでいる人**は
 * 新設の 'auto' だと small プロファイルへ落ちて挙動が変わるので、
 * その人にだけ 'standard' を書き込んで据え置く。
 * これは冪等でない移行なので、「一度きり」が本当に守られているかも見る。
 */
describe('設定スキーマ v3(会話プロファイル)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  function persisted(): Record<string, unknown> {
    const raw = localStorage.getItem('speaky:settings')
    expect(raw).toBeTruthy()
    return JSON.parse(raw!) as Record<string, unknown>
  }

  it('新規ユーザーの既定は auto', () => {
    expect(DEFAULT_SETTINGS.modelProfile).toBe('auto')
    expect(loadSettings().modelProfile).toBe('auto')
  })

  it('v2 で 2B を使っていた人は standard に固定される(挙動を変えない)', () => {
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({ ...DEFAULT_SETTINGS, llmModel: 'gemma2:2b', schemaVersion: 2 }),
    )
    const loaded = loadSettings()
    expect(loaded.modelProfile).toBe('standard')
    expect(loaded.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    // 移行はその場で永続化される(次回起動では走らない)
    expect(persisted().modelProfile).toBe('standard')
    expect(persisted().schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
  })

  it('v2 で 3B 以上を使っていた人は auto のまま(自動判定で standard になる)', () => {
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({ ...DEFAULT_SETTINGS, llmModel: 'llama3.2:3b', schemaVersion: 2 }),
    )
    expect(loadSettings().modelProfile).toBe('auto')
  })

  it('schemaVersion 欠落(v1)からでも 1 回で v3 まで移行する', () => {
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        llmModel: 'gemma2:2b',
        silenceDurationMs: 5000,
        whisperModel: 'medium',
        schemaVersion: undefined,
      }),
    )
    const loaded = loadSettings()
    // v1→v2 と v2→v3 の両方が適用される
    expect(loaded.silenceDurationMs).toBe(DEFAULT_SETTINGS.silenceDurationMs)
    expect(loaded.whisperModel).toBe(DEFAULT_SETTINGS.whisperModel)
    expect(loaded.modelProfile).toBe('standard')
    expect(loaded.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
  })

  // ここが「版を上げた理由」そのもの。移行は冪等でないので、
  // 2 回目の load で再実行されるとユーザーの選び直しを踏み潰す。
  it('2 回目の load では再実行されない(ユーザーが auto へ戻した設定を守る)', () => {
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({ ...DEFAULT_SETTINGS, llmModel: 'gemma2:2b', schemaVersion: 2 }),
    )
    expect(loadSettings().modelProfile).toBe('standard')

    // 移行後にユーザーが自分で 'auto' を選んだ
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({ ...persisted(), modelProfile: 'auto' }),
    )
    expect(loadSettings().modelProfile).toBe('auto')
    expect(persisted().modelProfile).toBe('auto')
  })

  it('壊れた modelProfile は既定へ戻す', () => {
    localStorage.setItem(
      'speaky:settings',
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        modelProfile: 'tiny',
        schemaVersion: SETTINGS_SCHEMA_VERSION,
      }),
    )
    expect(loadSettings().modelProfile).toBe(DEFAULT_SETTINGS.modelProfile)
  })

  it('v3 済みの設定は素通しする(書き戻さない)', () => {
    const stored = {
      ...DEFAULT_SETTINGS,
      llmModel: 'gemma2:2b',
      modelProfile: 'small',
      schemaVersion: SETTINGS_SCHEMA_VERSION,
    }
    localStorage.setItem('speaky:settings', JSON.stringify(stored))
    expect(loadSettings().modelProfile).toBe('small')
    expect(persisted()).toEqual(stored)
  })
})

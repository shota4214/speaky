import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/index'
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, type AppSettings } from '../storage/settings'
import { importAllData, type BackupV1 } from './data-portability'

/** schemaVersion を持たない v1 時代のバックアップを組み立てる。 */
function legacyBackup(): BackupV1 {
  const settings: Record<string, unknown> = {
    ...DEFAULT_SETTINGS,
    silenceDurationMs: 5000,
    whisperModel: 'medium',
  }
  delete settings.schemaVersion
  return {
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    data: {
      conversations: [],
      messages: [],
      vocabulary: [],
      customTopics: [],
      userProfile: null,
      settings: settings as unknown as AppSettings,
      selectedTheme: null,
    },
  }
}

describe('importAllData settings convergence', () => {
  beforeEach(async () => {
    localStorage.clear()
    if (db.isOpen()) db.close()
    await db.delete()
    await db.open()
  })

  // replace インポートはバックアップの設定をそのまま書き戻すため、古いバックアップを
  // 入れると schemaVersion が巻き戻る。インポート直後に最新スキーマへ収束すること。
  it('normalizes an imported v1 backup to the current schema version', async () => {
    await importAllData(legacyBackup(), 'replace')

    const stored = JSON.parse(localStorage.getItem('speaky:settings')!) as Record<string, unknown>
    expect(stored.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(stored.silenceDurationMs).toBe(DEFAULT_SETTINGS.silenceDurationMs)
    expect(stored.whisperModel).toBe(DEFAULT_SETTINGS.whisperModel)
  })

  // スキーマ版は最新でも中身が壊れている(手で編集した等)バックアップも正規化する。
  it('sanitizes an imported backup that has a current schemaVersion but invalid values', async () => {
    const backup = legacyBackup()
    backup.data.settings = {
      ...DEFAULT_SETTINGS,
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      whisperModel: 'large-v3',
      ttsRate: 5.0,
    } as unknown as AppSettings

    await importAllData(backup, 'replace')

    const stored = JSON.parse(localStorage.getItem('speaky:settings')!) as Record<string, unknown>
    expect(stored.whisperModel).toBe(DEFAULT_SETTINGS.whisperModel)
    expect(stored.ttsRate).toBe(1.5) // TTS_RATE_MAX に clamp
  })

  // merge モードは設定に触らない(既存の挙動)。
  it('leaves settings untouched in merge mode', async () => {
    await importAllData(legacyBackup(), 'merge')
    expect(localStorage.getItem('speaky:settings')).toBeNull()
  })
})

import { db } from '../db/index'
import type { Conversation, CustomTopic, Message, UserProfile, Vocabulary } from '../db/types'
import { loadSettings, saveSettings, type AppSettings } from '../storage/settings'

export const BACKUP_VERSION = 1

export interface BackupV1 {
  version: 1
  exportedAt: string
  data: {
    conversations: Conversation[]
    messages: Message[]
    vocabulary: Vocabulary[]
    userProfile: UserProfile | null
    customTopics: CustomTopic[]
    settings: AppSettings
    selectedTheme: string | null
  }
}

export async function exportAllData(): Promise<BackupV1> {
  const [conversations, messages, vocabulary, customTopics, profile] = await Promise.all([
    db.conversations.toArray(),
    db.messages.toArray(),
    db.vocabulary.toArray(),
    db.customTopics.toArray(),
    db.userProfile.get('main'),
  ])
  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      conversations,
      messages,
      vocabulary,
      customTopics,
      userProfile: profile ?? null,
      settings: loadSettings(),
      selectedTheme: localStorage.getItem('speaky:theme'),
    },
  }
}

export function downloadBackup(backup: BackupV1): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const dateStr = backup.exportedAt.slice(0, 10)
  a.download = `speaky-backup-${dateStr}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function reviveDate(value: unknown): Date {
  if (value instanceof Date) return value
  return new Date(value as string)
}

export async function importAllData(
  backup: BackupV1,
  mode: 'merge' | 'replace',
): Promise<{ imported: number }> {
  if (backup.version !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version: ${backup.version}`)
  }
  let imported = 0

  if (mode === 'replace') {
    await db.transaction(
      'rw',
      [db.conversations, db.messages, db.vocabulary, db.customTopics, db.userProfile],
      async () => {
        await db.conversations.clear()
        await db.messages.clear()
        await db.vocabulary.clear()
        await db.customTopics.clear()
        await db.userProfile.clear()
      },
    )
  }

  await db.transaction(
    'rw',
    [db.conversations, db.messages, db.vocabulary, db.customTopics, db.userProfile],
    async () => {
      for (const c of backup.data.conversations) {
        if (mode === 'merge' && (await db.conversations.get(c.id))) continue
        await db.conversations.put({
          ...c,
          startedAt: reviveDate(c.startedAt),
          endedAt: c.endedAt ? reviveDate(c.endedAt) : null,
          expiresAt: reviveDate(c.expiresAt),
        })
        imported++
      }
      for (const m of backup.data.messages) {
        if (mode === 'merge' && (await db.messages.get(m.id))) continue
        await db.messages.put({
          ...m,
          timestamp: reviveDate(m.timestamp),
        })
        imported++
      }
      for (const v of backup.data.vocabulary) {
        if (mode === 'merge' && (await db.vocabulary.get(v.id))) continue
        await db.vocabulary.put({
          ...v,
          savedAt: reviveDate(v.savedAt),
        })
        imported++
      }
      for (const t of backup.data.customTopics) {
        if (mode === 'merge' && (await db.customTopics.get(t.id))) continue
        await db.customTopics.put({
          ...t,
          createdAt: reviveDate(t.createdAt),
        })
        imported++
      }
      if (backup.data.userProfile) {
        const profile: UserProfile = {
          ...backup.data.userProfile,
          facts: backup.data.userProfile.facts.map((f) => ({
            ...f,
            learnedAt: reviveDate(f.learnedAt),
          })),
        }
        await db.userProfile.put(profile)
        imported++
      }
    },
  )

  if (mode === 'replace' && backup.data.settings) {
    saveSettings(backup.data.settings)
  }
  if (backup.data.selectedTheme) {
    localStorage.setItem('speaky:theme', backup.data.selectedTheme)
  }

  return { imported }
}

export async function deleteAllData(): Promise<void> {
  await db.transaction(
    'rw',
    [db.conversations, db.messages, db.vocabulary, db.customTopics, db.userProfile],
    async () => {
      await db.conversations.clear()
      await db.messages.clear()
      await db.vocabulary.clear()
      await db.customTopics.clear()
      await db.userProfile.clear()
    },
  )
  localStorage.removeItem('speaky:settings')
  localStorage.removeItem('speaky:selectedVocab')
  localStorage.removeItem('speaky:theme')
  localStorage.removeItem('speaky:onboarded')
}

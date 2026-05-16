import { db } from '../index'
import type { Conversation } from '../types'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export type CreateConversationInput = Omit<Conversation, 'id' | 'expiresAt'> & {
  id?: string
  expiresAt?: Date
}

export const conversationsRepo = {
  async create(input: CreateConversationInput): Promise<Conversation> {
    const id = input.id ?? crypto.randomUUID()
    const expiresAt = input.expiresAt ?? new Date(input.startedAt.getTime() + THIRTY_DAYS_MS)
    // Vue reactive Proxy 等が混入しても IndexedDB が拒否しないよう
    // 各フィールドを明示的にプレーン値で構築する
    const conv: Conversation = {
      id,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      topic: input.topic,
      level: input.level,
      aiCharacter: {
        name: input.aiCharacter.name,
        gender: input.aiCharacter.gender,
      },
      summary: input.summary,
      expiresAt,
    }
    await db.conversations.add(conv)
    return conv
  },

  async get(id: string): Promise<Conversation | undefined> {
    return db.conversations.get(id)
  },

  async list(options: { since?: Date; limit?: number } = {}): Promise<Conversation[]> {
    let collection = db.conversations.orderBy('startedAt').reverse()
    if (options.since) {
      const sinceTime = options.since.getTime()
      collection = collection.filter((c) => c.startedAt.getTime() >= sinceTime)
    }
    if (options.limit !== undefined) {
      collection = collection.limit(options.limit)
    }
    return collection.toArray()
  },

  async update(id: string, patch: Partial<Conversation>): Promise<void> {
    // Dexie 4 の Table.update() がパッチ内部の検査で稀に
    // 'Cannot convert undefined or null to object' を投げるため、
    // 確実な get + put パターンで実装する
    const existing = await db.conversations.get(id)
    if (!existing) return
    const merged: Conversation = {
      ...existing,
      ...patch,
      aiCharacter: patch.aiCharacter
        ? {
            name: patch.aiCharacter.name,
            gender: patch.aiCharacter.gender,
          }
        : existing.aiCharacter,
    }
    await db.conversations.put(merged)
  },

  async delete(id: string): Promise<void> {
    await db.transaction('rw', db.conversations, db.messages, async () => {
      await db.messages.where('conversationId').equals(id).delete()
      await db.conversations.delete(id)
    })
  },

  async cleanupExpired(now: Date = new Date()): Promise<number> {
    const expired = await db.conversations.where('expiresAt').below(now).toArray()
    const ids = expired.map((c) => c.id)
    if (ids.length === 0) return 0
    await db.transaction('rw', db.conversations, db.messages, async () => {
      await db.messages.where('conversationId').anyOf(ids).delete()
      await db.conversations.bulkDelete(ids)
    })
    return ids.length
  },
}

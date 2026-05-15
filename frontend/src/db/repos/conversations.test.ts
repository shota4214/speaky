import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../index'
import {
  conversationsRepo,
  type CreateConversationInput,
} from './conversations'
import { messagesRepo } from './messages'

function makeInput(
  overrides: Partial<CreateConversationInput> = {},
): CreateConversationInput {
  return {
    startedAt: new Date('2026-05-15T10:00:00Z'),
    endedAt: null,
    topic: 'daily',
    level: 'intermediate',
    aiCharacter: { name: 'Emma', gender: 'female' },
    summary: null,
    ...overrides,
  }
}

describe('conversationsRepo', () => {
  beforeEach(async () => {
    if (db.isOpen()) db.close()
    await db.delete()
    await db.open()
  })

  it('creates and retrieves a conversation', async () => {
    const conv = await conversationsRepo.create(makeInput())
    expect(conv.id).toBeTruthy()
    expect(conv.expiresAt.getTime()).toBeGreaterThan(conv.startedAt.getTime())
    const fetched = await conversationsRepo.get(conv.id)
    expect(fetched?.topic).toBe('daily')
  })

  it('lists conversations newest-first', async () => {
    await conversationsRepo.create(
      makeInput({
        startedAt: new Date('2026-05-14T10:00:00Z'),
        topic: 'daily',
      }),
    )
    await conversationsRepo.create(
      makeInput({
        startedAt: new Date('2026-05-15T10:00:00Z'),
        topic: 'business',
      }),
    )
    const list = await conversationsRepo.list()
    expect(list.map((c) => c.topic)).toEqual(['business', 'daily'])
  })

  it('expiresAt is 30 days after startedAt by default', async () => {
    const startedAt = new Date('2026-05-15T10:00:00Z')
    const conv = await conversationsRepo.create(makeInput({ startedAt }))
    const days =
      (conv.expiresAt.getTime() - startedAt.getTime()) /
      (1000 * 60 * 60 * 24)
    expect(days).toBeCloseTo(30, 1)
  })

  it('list respects since filter', async () => {
    await conversationsRepo.create(
      makeInput({ startedAt: new Date('2026-01-01T00:00:00Z'), topic: 'old' }),
    )
    await conversationsRepo.create(
      makeInput({
        startedAt: new Date('2026-05-15T10:00:00Z'),
        topic: 'recent',
      }),
    )
    const list = await conversationsRepo.list({
      since: new Date('2026-05-01T00:00:00Z'),
    })
    expect(list.map((c) => c.topic)).toEqual(['recent'])
  })

  it('cleanupExpired removes expired and cascades messages', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const longAgo = new Date('2025-01-01T00:00:00Z')

    const recent = await conversationsRepo.create(
      makeInput({ startedAt: yesterday, topic: 'recent' }),
    )
    const old = await conversationsRepo.create(
      makeInput({ startedAt: longAgo, topic: 'old' }),
    )

    await messagesRepo.create({
      conversationId: old.id,
      timestamp: longAgo,
      role: 'user',
      userText: 'goodbye',
      inputLanguage: 'en',
      replyEn: null,
      replyJa: null,
      feedback: null,
      vocabulary: null,
      mode: null,
    })

    const removed = await conversationsRepo.cleanupExpired()
    expect(removed).toBe(1)

    const remaining = await conversationsRepo.list()
    expect(remaining.map((c) => c.id)).toEqual([recent.id])

    const orphanMessages = await messagesRepo.listByConversation(old.id)
    expect(orphanMessages).toHaveLength(0)
  })

  it('delete cascades messages', async () => {
    const conv = await conversationsRepo.create(makeInput())
    await messagesRepo.create({
      conversationId: conv.id,
      timestamp: new Date(),
      role: 'user',
      userText: 'hello',
      inputLanguage: 'en',
      replyEn: null,
      replyJa: null,
      feedback: null,
      vocabulary: null,
      mode: null,
    })
    await conversationsRepo.delete(conv.id)

    expect(await conversationsRepo.get(conv.id)).toBeUndefined()
    expect(await messagesRepo.listByConversation(conv.id)).toHaveLength(0)
  })

  it('update modifies fields', async () => {
    const conv = await conversationsRepo.create(makeInput())
    await conversationsRepo.update(conv.id, {
      summary: 'A short summary',
      endedAt: new Date('2026-05-15T10:30:00Z'),
    })
    const updated = await conversationsRepo.get(conv.id)
    expect(updated?.summary).toBe('A short summary')
    expect(updated?.endedAt).toBeInstanceOf(Date)
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../index'
import { messagesRepo } from './messages'

describe('messagesRepo', () => {
  beforeEach(async () => {
    if (db.isOpen()) db.close()
    await db.delete()
    await db.open()
  })

  it('creates a user message', async () => {
    const m = await messagesRepo.create({
      conversationId: 'conv-1',
      timestamp: new Date(),
      role: 'user',
      userText: 'Hello',
      inputLanguage: 'en',
      replyEn: null,
      replyJa: null,
      feedback: null,
      vocabulary: null,
      mode: null,
    })
    expect(m.id).toBeTruthy()
    expect(m.userText).toBe('Hello')
  })

  it('lists messages by conversation ordered by timestamp', async () => {
    const convId = 'conv-2'
    await messagesRepo.create({
      conversationId: convId,
      timestamp: new Date('2026-05-15T10:02:00Z'),
      role: 'ai',
      userText: null,
      inputLanguage: null,
      replyEn: 'Hi there!',
      replyJa: 'やあ!',
      feedback: null,
      vocabulary: null,
      mode: 'normal',
    })
    await messagesRepo.create({
      conversationId: convId,
      timestamp: new Date('2026-05-15T10:00:00Z'),
      role: 'user',
      userText: 'Hello',
      inputLanguage: 'en',
      replyEn: null,
      replyJa: null,
      feedback: null,
      vocabulary: null,
      mode: null,
    })
    const list = await messagesRepo.listByConversation(convId)
    expect(list).toHaveLength(2)
    expect(list[0]!.role).toBe('user')
    expect(list[1]!.role).toBe('ai')
  })

  it('filters by conversationId', async () => {
    await messagesRepo.create({
      conversationId: 'conv-A',
      timestamp: new Date(),
      role: 'user',
      userText: 'A',
      inputLanguage: 'en',
      replyEn: null,
      replyJa: null,
      feedback: null,
      vocabulary: null,
      mode: null,
    })
    await messagesRepo.create({
      conversationId: 'conv-B',
      timestamp: new Date(),
      role: 'user',
      userText: 'B',
      inputLanguage: 'en',
      replyEn: null,
      replyJa: null,
      feedback: null,
      vocabulary: null,
      mode: null,
    })
    const a = await messagesRepo.listByConversation('conv-A')
    expect(a.map((m) => m.userText)).toEqual(['A'])
  })

  it('deleteByConversation removes only that conversation messages', async () => {
    await messagesRepo.create({
      conversationId: 'conv-3',
      timestamp: new Date(),
      role: 'user',
      userText: 'x',
      inputLanguage: 'en',
      replyEn: null,
      replyJa: null,
      feedback: null,
      vocabulary: null,
      mode: null,
    })
    await messagesRepo.create({
      conversationId: 'conv-4',
      timestamp: new Date(),
      role: 'user',
      userText: 'y',
      inputLanguage: 'en',
      replyEn: null,
      replyJa: null,
      feedback: null,
      vocabulary: null,
      mode: null,
    })
    const removed = await messagesRepo.deleteByConversation('conv-3')
    expect(removed).toBe(1)
    expect(await messagesRepo.listByConversation('conv-3')).toHaveLength(0)
    expect(await messagesRepo.listByConversation('conv-4')).toHaveLength(1)
  })

  it('updates an existing message (enrich の後追い反映)', async () => {
    const created = await messagesRepo.create({
      conversationId: 'conv-5',
      timestamp: new Date(),
      role: 'ai',
      userText: null,
      inputLanguage: null,
      replyEn: 'Oh nice, where did you go?',
      replyJa: null,
      feedback: null,
      vocabulary: [],
      mode: 'normal',
    })

    const updated = await messagesRepo.update(created.id, {
      replyJa: 'いいね、どこに行ったの?',
      feedback: { userSaid: 'I go', corrected: 'I went', explanation: '過去形に' },
      vocabulary: [{ word: 'hiking', meaning: 'ハイキング', example: null }],
    })

    expect(updated?.replyJa).toBe('いいね、どこに行ったの?')
    expect(updated?.feedback?.corrected).toBe('I went')
    expect(updated?.vocabulary).toHaveLength(1)
    // 英文と id は保たれる
    expect(updated?.replyEn).toBe('Oh nice, where did you go?')
    expect(updated?.id).toBe(created.id)

    const persisted = await messagesRepo.listByConversation('conv-5')
    expect(persisted[0]?.replyJa).toBe('いいね、どこに行ったの?')
  })

  it('update returns undefined for a missing id (中断したターンの id を渡しても壊れない)', async () => {
    expect(await messagesRepo.update('does-not-exist', { replyJa: 'x' })).toBeUndefined()
  })
})

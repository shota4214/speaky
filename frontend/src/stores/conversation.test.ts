import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Message } from '../db/types'
import { useConversationStore } from './conversation'

function makeAiMessage(id: string, replyEn: string): Message {
  return {
    id,
    conversationId: 'conv-1',
    timestamp: new Date(),
    role: 'ai',
    userText: null,
    inputLanguage: null,
    replyEn,
    replyJa: 'jp',
    feedback: null,
    vocabulary: null,
    mode: 'normal',
  }
}

function makeUserMessage(id: string, userText: string): Message {
  return {
    id,
    conversationId: 'conv-1',
    timestamp: new Date(),
    role: 'user',
    userText,
    inputLanguage: 'en',
    replyEn: null,
    replyJa: null,
    feedback: null,
    vocabulary: null,
    mode: null,
  }
}

describe('useConversationStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts in idle state', () => {
    const s = useConversationStore()
    expect(s.id).toBeNull()
    expect(s.mode).toBe('idle')
    expect(s.isActive).toBe(false)
    expect(s.messages).toEqual([])
    expect(s.turnCount).toBe(0)
  })

  it('start() transitions to recording with given metadata', () => {
    const s = useConversationStore()
    s.start({
      id: 'conv-1',
      level: 'advanced',
      topic: 'business',
      vocabFocusIds: ['v1', 'v2'],
    })
    expect(s.id).toBe('conv-1')
    expect(s.level).toBe('advanced')
    expect(s.topic).toBe('business')
    expect(s.mode).toBe('recording')
    expect(s.isActive).toBe(true)
    expect(s.vocabFocusIds).toEqual(['v1', 'v2'])
  })

  it('setMode transitions through valid states', () => {
    const s = useConversationStore()
    s.start({ id: 'c', level: 'intermediate', topic: 'daily' })
    s.setMode('processing')
    expect(s.mode).toBe('processing')
    s.setMode('thinking')
    expect(s.mode).toBe('thinking')
    s.setMode('aiSpeaking')
    expect(s.mode).toBe('aiSpeaking')
  })

  it('appendMessage adds to log and increments turnCount on ai role', () => {
    const s = useConversationStore()
    s.start({ id: 'c', level: 'intermediate', topic: 'daily' })
    s.appendMessage(makeUserMessage('m1', 'Hi'))
    expect(s.turnCount).toBe(0)
    s.appendMessage(makeAiMessage('m2', 'Hello!'))
    expect(s.turnCount).toBe(1)
    expect(s.messages).toHaveLength(2)
  })

  it('pause/resume only affect isPaused', () => {
    const s = useConversationStore()
    s.start({ id: 'c', level: 'intermediate', topic: 'daily' })
    s.pause()
    expect(s.isPaused).toBe(true)
    s.resume()
    expect(s.isPaused).toBe(false)
  })

  it('pause is ignored when idle', () => {
    const s = useConversationStore()
    s.pause()
    expect(s.isPaused).toBe(false)
  })

  it('end resets to idle state and clears messages', () => {
    const s = useConversationStore()
    s.start({ id: 'c', level: 'intermediate', topic: 'daily' })
    s.appendMessage(makeUserMessage('m1', 'Hi'))
    s.end()
    expect(s.id).toBeNull()
    expect(s.mode).toBe('idle')
    expect(s.messages).toEqual([])
    expect(s.vocabFocusIds).toEqual([])
  })

  it('setVocabFocus replaces the focus list', () => {
    const s = useConversationStore()
    s.setVocabFocus(['a', 'b', 'c'])
    expect(s.vocabFocusIds).toEqual(['a', 'b', 'c'])
    s.setVocabFocus([])
    expect(s.vocabFocusIds).toEqual([])
  })

  it('updateMessage replaces the array element (配列ごと差し替える)', () => {
    const s = useConversationStore()
    s.start({ id: 'conv-1', level: 'intermediate', topic: 'daily' })
    s.appendMessage(makeAiMessage('m1', 'first'))
    s.appendMessage(makeAiMessage('m2', 'second'))
    const before = s.messages

    s.updateMessage({ ...makeAiMessage('m2', 'second'), replyJa: '日本語訳' })

    expect(s.messages[1]?.replyJa).toBe('日本語訳')
    // 参照が変わる = Vue が再描画できる(その場書き換えだと変わらない)
    expect(s.messages).not.toBe(before)
    expect(s.messages).toHaveLength(2)
  })

  it('updateMessage ignores unknown ids', () => {
    const s = useConversationStore()
    s.start({ id: 'conv-1', level: 'intermediate', topic: 'daily' })
    s.appendMessage(makeAiMessage('m1', 'first'))
    s.updateMessage(makeAiMessage('ghost', 'nope'))
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]?.replyEn).toBe('first')
  })
})

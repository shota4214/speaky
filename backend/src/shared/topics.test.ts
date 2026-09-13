import { describe, expect, it } from 'vitest'
import { BUILT_IN_TOPICS, topicPromptLabel } from './topics.js'

describe('topicPromptLabel', () => {
  it('組み込みトピックはすべてキーと違う英語の説明を持つ', () => {
    expect(BUILT_IN_TOPICS.map((t) => t.key)).toEqual([
      'daily',
      'business',
      'travel',
      'shopping',
      'restaurant',
      'hobby',
      'news',
    ])
    for (const t of BUILT_IN_TOPICS) {
      expect(topicPromptLabel(t.key)).toBe(t.promptLabel)
      expect(t.promptLabel).toMatch(/^[a-z ]+$/)
    }
    expect(topicPromptLabel('daily')).toBe('daily life')
  })

  it('カスタムトピック(ユーザーが言葉で書いたもの)は素通しする', () => {
    expect(topicPromptLabel('My dog Pochi')).toBe('My dog Pochi')
    expect(topicPromptLabel('casual chat')).toBe('casual chat')
  })
})

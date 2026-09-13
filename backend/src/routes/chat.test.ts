import { describe, expect, it } from 'vitest'
import { finalizeReply, historyToMessages } from './chat.js'
import { MODEL_PROFILES } from '../services/model-profile.js'
import type { ChatReply } from '../services/chat-reply.js'

describe('historyToMessages', () => {
  it('末尾が今回の発話なら落とす(buildHistory は保存後に組むので含んでいる)', () => {
    const history = [
      { role: 'ai' as const, text: 'What do you do in the morning?' },
      { role: 'user' as const, text: 'I drink coffee.' },
    ]
    expect(historyToMessages(history, ' I drink coffee. ', 4)).toEqual([
      { role: 'assistant', content: 'What do you do in the morning?' },
    ])
  })

  it('今回の発話を含まない履歴(新しいフロント)はそのまま', () => {
    const history = [
      { role: 'user' as const, text: 'Yes.' },
      { role: 'ai' as const, text: 'Great!' },
    ]
    expect(historyToMessages(history, 'Yes.', 4)).toHaveLength(2)
  })

  it('往復数の上限で古い方から切る', () => {
    const history = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? ('ai' as const) : ('user' as const),
      text: `m${i}`,
    }))
    const msgs = historyToMessages(history, 'now', 2)
    expect(msgs.map((m) => m.content)).toEqual(['m8', 'm9', 'm10', 'm11'])
  })

  it('履歴が無ければ空', () => {
    expect(historyToMessages(undefined, 'hi', 4)).toEqual([])
  })
})

function reply(overrides: Partial<ChatReply>): ChatReply {
  return {
    reply_en: 'Curry is so good! Did you make it spicy?',
    reply_ja: 'カレーはおいしいね！辛くしたの？',
    feedback: null,
    vocabulary: [],
    mode: 'normal',
    ...overrides,
  }
}

describe('finalizeReply', () => {
  it('small: 3 文以上なら 2 文に切り、モデルの訳は捨てる(削る前の英文の訳なので)', () => {
    const r = finalizeReply(
      reply({ reply_en: 'Curry is so good! Did you make it spicy? I like mild curry myself.' }),
      MODEL_PROFILES.small,
    )
    expect(r?.reply_en).toBe('Curry is so good! Did you make it spicy?')
    expect(r?.reply_ja).toBe('')
  })

  it('standard: 長さは切らない', () => {
    const text = 'Curry is so good! Did you make it spicy? I like mild curry myself.'
    expect(finalizeReply(reply({ reply_en: text }), MODEL_PROFILES.standard)?.reply_en).toBe(text)
  })

  it('small: 非ラテン文字の文を落とす。全部落ちたら null(次の attempt へ)', () => {
    expect(
      finalizeReply(
        reply({ reply_en: 'Nice! 寿司が好き。 What do you like?' }),
        MODEL_PROFILES.small,
      )?.reply_en,
    ).toBe('Nice! What do you like?')
    expect(finalizeReply(reply({ reply_en: '寿司が好きです。' }), MODEL_PROFILES.small)).toBeNull()
  })

  it('訳として使えない reply_ja は空にする(en→ja 補完に回る)', () => {
    for (const profile of [MODEL_PROFILES.small, MODEL_PROFILES.standard]) {
      expect(finalizeReply(reply({ reply_ja: "kon'nichiwa" }), profile)?.reply_ja).toBe('')
      expect(finalizeReply(reply({}), profile)?.reply_ja).toBe('カレーはおいしいね！辛くしたの？')
    }
  })

  it('モデルが JSON に書いた mode は使わず、このターンのモードにする', () => {
    expect(finalizeReply(reply({ mode: 'mixed' }), MODEL_PROFILES.small, 'normal')?.mode).toBe(
      'normal',
    )
  })

  it('孤立サロゲートを落とす', () => {
    const r = finalizeReply(
      reply({ reply_en: 'Hello there\ud83d, friend.' }),
      MODEL_PROFILES.standard,
    )
    expect(r?.reply_en).toBe('Hello there, friend.')
  })
})

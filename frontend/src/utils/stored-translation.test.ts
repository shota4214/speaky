import { describe, expect, it } from 'vitest'
import { storedJapaneseTranslation } from './stored-translation'

describe('storedJapaneseTranslation', () => {
  const en = 'Nice to meet you, Shota! How long have you lived in Tokyo?'

  it('通常の行: 検証を通る訳はそのまま出す', () => {
    expect(
      storedJapaneseTranslation({
        mode: 'normal',
        replyEn: en,
        replyJa: 'はじめまして、翔太さん！東京にはどれくらい住んでるの？',
      }),
    ).toBe('はじめまして、翔太さん！東京にはどれくらい住んでるの？')
  })

  it('通常の行: v1.2.0 が保存したローマ字の訳は「無い」扱い(再取得ボタンを出す)', () => {
    expect(
      storedJapaneseTranslation({
        mode: 'normal',
        replyEn: en,
        replyJa: 'Konnichiwa, watashi wa Tokyo ni ikimasu desu.',
      }),
    ).toBe('')
  })

  it('mode が無い古い行も通常の行として検証する', () => {
    expect(storedJapaneseTranslation({ mode: null, replyEn: en, replyJa: 'Hello there!' })).toBe('')
  })

  it('訳が無い / 空の行は空文字', () => {
    expect(storedJapaneseTranslation({ mode: 'normal', replyEn: en, replyJa: null })).toBe('')
    expect(storedJapaneseTranslation({ mode: 'normal', replyEn: en, replyJa: '' })).toBe('')
  })

  it('日本語入力の行: 案内文は検証せず、従来どおりそのまま出す', () => {
    const guide = '「I have a meeting tomorrow.」と言えますよ。言ってみて！'
    for (const mode of ['japanese_help', 'mixed'] as const) {
      expect(
        storedJapaneseTranslation({ mode, replyEn: 'I have a meeting tomorrow.', replyJa: guide }),
      ).toBe(guide)
    }
  })
})

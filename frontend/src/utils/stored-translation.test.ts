import { describe, expect, it } from 'vitest'
import type { Message } from '../db/types'
import {
  HIDDEN_STORED_TRANSLATION_VERDICTS,
  storedJapaneseTranslation,
  withEffectiveAiModes,
} from './stored-translation'

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

describe('storedJapaneseTranslation(隠すのは v1.2.0 の症状だけ)', () => {
  it('隠す判定は empty / disallowed-char / no-kana / kana-share の 4 つ', () => {
    expect([...HIDDEN_STORED_TRANSLATION_VERDICTS].sort()).toEqual(
      ['disallowed-char', 'empty', 'kana-share', 'no-kana'].sort(),
    )
  })

  it.each([
    ['no-kana(ローマ字)', 'Hi! How are you?', 'Konnichiwa, genki desu ka?'],
    ['no-kana(英語)', 'Hi! How are you?', 'I am fine, thank you.'],
    ['disallowed-char(他の文字体系)', 'Oh nice, where did you go?', 'ごれ„浹 どこ？'],
    [
      'kana-share(中国語寄り)',
      'Tokyo station square in Shinjuku ward',
      '東京都新宿区西新宿駅前広場の',
    ],
    ['empty(絵文字だけ)', 'Hi!', '😊'],
  ])('%s は隠す(再取得ボタンを出す)', (_label, replyEn, replyJa) => {
    expect(storedJapaneseTranslation({ mode: 'normal', replyEn, replyJa })).toBe('')
  })

  it.each([
    [
      'latin-heavy(英文に無い固有名詞をラテン文字で書いた訳)',
      'What did you watch last night?',
      'Stranger Things を見たの？',
    ],
    ['too-long', 'Hi!', 'こんにちは、元気ですか？今日は何をしていましたか？'],
    ['json-remnant', 'Hello!', 'こんにちは”},{'],
    ['multi-paragraph', 'Nice!', 'いいね！\n\nそれで'],
  ])('%s は保存済みの行では隠さない(消したら戻らない)', (_label, replyEn, replyJa) => {
    expect(storedJapaneseTranslation({ mode: 'normal', replyEn, replyJa })).toBe(replyJa)
  })
})

describe('withEffectiveAiModes(履歴の AI の行の mode を直前のユーザーの行から導く)', () => {
  function row(role: Message['role'], mode: Message['mode'], id: string): Message {
    return {
      id,
      conversationId: 'c1',
      timestamp: new Date(0),
      role,
      userText: role === 'user' ? 'text' : null,
      inputLanguage: null,
      replyEn: role === 'ai' ? 'Hello!' : null,
      replyJa: null,
      feedback: null,
      vocabulary: role === 'ai' ? [] : null,
      mode,
    }
  }

  it('モデルが mixed と書いた英語のターンは normal に戻す', () => {
    const out = withEffectiveAiModes([
      row('ai', 'normal', 'opening'),
      row('user', 'normal', 'u1'),
      row('ai', 'mixed', 'a1'),
    ])
    expect(out.map((m) => m.mode)).toEqual(['normal', 'normal', 'normal'])
  })

  it('日本語入力のターンはユーザーの行の mode(japanese_help / mixed)になる', () => {
    const out = withEffectiveAiModes([
      row('user', 'japanese_help', 'u1'),
      row('ai', 'normal', 'a1'),
      row('user', 'mixed', 'u2'),
      row('ai', 'japanese_help', 'a2'),
    ])
    expect(out.map((m) => m.mode)).toEqual(['japanese_help', 'japanese_help', 'mixed', 'mixed'])
  })

  it('直前にユーザーの行が無い AI の行(最初のあいさつ)は normal', () => {
    expect(withEffectiveAiModes([row('ai', 'mixed', 'opening')])[0]!.mode).toBe('normal')
  })

  it('mode の無い古いユーザーの行なら AI の行も mode 無し(= 通常の行として検証)', () => {
    const out = withEffectiveAiModes([row('user', null, 'u1'), row('ai', 'mixed', 'a1')])
    expect(out[1]!.mode).toBeNull()
  })

  it('変える必要のない行は同じオブジェクトのまま、元の配列も書き換えない', () => {
    const input = [row('user', 'normal', 'u1'), row('ai', 'normal', 'a1'), row('ai', 'mixed', 'a2')]
    const out = withEffectiveAiModes(input)
    expect(out[1]).toBe(input[1])
    expect(out[2]).not.toBe(input[2])
    expect(input[2]!.mode).toBe('mixed')
  })

  it('導いた mode で訳を判定する: mixed と書かれた英語のターンのローマ字は隠れる', () => {
    const ai = { ...row('ai', 'mixed', 'a1'), replyJa: 'Konnichiwa, genki desu ka?' }
    expect(storedJapaneseTranslation(ai)).toBe(ai.replyJa)
    const [, effective] = withEffectiveAiModes([row('user', 'normal', 'u1'), ai])
    expect(storedJapaneseTranslation(effective!)).toBe('')
  })
})

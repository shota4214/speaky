import { describe, expect, it } from 'vitest'
import { isContractPlaceholder, parseChatReply, salvageChatReply } from './chat-reply.js'

/**
 * 返答の救済ルール。ここで一番大事なのは「切れた英文を返さない」こと:
 * 救済した文はそのまま読み上げられるので、途中で切れた文を採用すると
 * AI が文の途中で黙る(しかも会話履歴にもその半端な文が残る)。
 */
describe('salvageChatReply', () => {
  it('コードフェンス包みは feedback / vocabulary まで完全に復元する', () => {
    const raw = [
      '```json',
      JSON.stringify({
        reply_en: 'That sounds fun!',
        reply_ja: '楽しそうですね!',
        feedback: {
          user_said: 'I go yesterday',
          corrected: 'I went yesterday',
          explanation: '過去形です',
        },
        vocabulary: [{ word: 'fun', meaning: '楽しい' }],
        mode: 'normal',
      }),
      '```',
    ].join('\n')

    const salvaged = salvageChatReply(raw, 'normal')
    expect(salvaged?.reply_en).toBe('That sounds fun!')
    expect(salvaged?.feedback?.corrected).toBe('I went yesterday')
    expect(salvaged?.vocabulary).toHaveLength(1)
  })

  it('切断された JSON からは完結した reply_en だけを拾う(feedback / vocabulary は捨てる)', () => {
    const raw = '{"reply_en":"I love that too!","reply_ja":"私も大好きです!","feedback":{"user_sa'
    const salvaged = salvageChatReply(raw, 'normal')
    expect(salvaged).toEqual({
      reply_en: 'I love that too!',
      reply_ja: '私も大好きです!',
      feedback: null,
      vocabulary: [],
      mode: 'normal',
    })
  })

  it('文の途中で切れた返答は救済しない', () => {
    const raw = '{"reply_en":"I was just thinking about how'
    expect(salvageChatReply(raw, 'normal')).toBeNull()
  })

  it('日本語訳だけが切れていれば英文だけ返す(呼び出し側が en→ja で補完する)', () => {
    const raw = '{"reply_en":"Nice to meet you.","reply_ja":"はじめま'
    const salvaged = salvageChatReply(raw, 'normal')
    expect(salvaged?.reply_en).toBe('Nice to meet you.')
    expect(salvaged?.reply_ja).toBe('')
  })

  it('ラテン文字を含まない / 極端に短い出力は返答として採らない', () => {
    expect(salvageChatReply('{"reply_en":"。"}', 'normal')).toBeNull()
    expect(salvageChatReply('{"reply_en":"a"}', 'normal')).toBeNull()
  })

  it('空入力は null', () => {
    expect(salvageChatReply('', 'normal')).toBeNull()
  })
})

describe('parseChatReply', () => {
  it('reply_ja が欠けていても parse 失敗にしない(空文字に正規化)', () => {
    const parsed = parseChatReply('{"reply_en":"Sure!","mode":"normal"}', 'normal')
    expect(parsed?.reply_en).toBe('Sure!')
    expect(parsed?.reply_ja).toBe('')
  })

  it('英語入力なのに日本語の添削が返ってきたら捨てる(小型モデルの幻覚)', () => {
    const parsed = parseChatReply(
      JSON.stringify({
        reply_en: 'Got it.',
        reply_ja: 'わかりました。',
        feedback: {
          user_said: '私の名前は',
          corrected: '私の名前はShotaです',
          explanation: '説明',
        },
      }),
      'normal',
    )
    expect(parsed?.feedback).toBeNull()
  })

  it('reply_en が無ければ null', () => {
    expect(parseChatReply('{"reply_ja":"訳だけ"}', 'normal')).toBeNull()
  })
})

describe('parseChatReply のキーの空白と例示文言', () => {
  it('キーの前後の空白を無視して読む(llama3.2:1b の " reply_ja")', () => {
    const raw =
      '{"reply_en":"Nice to meet you!", " reply_ja":"はじめまして！", "feedback":null,"vocabulary":[], "mode":"normal"}'
    expect(parseChatReply(raw, 'normal')?.reply_ja).toBe('はじめまして！')
  })

  it('空白なしの正規のキーがあればそちらを優先する', () => {
    const raw = '{"reply_en":"Hi!","reply_ja":"やあ！"," reply_ja":"ちがう"}'
    expect(parseChatReply(raw, 'normal')?.reply_ja).toBe('やあ！')
  })

  it('契約の例示文言をそのまま返したら失敗扱い(次の attempt へ)', () => {
    const raw =
      '{"reply_en":"Your 1-2 sentence English reply","reply_ja":"映画を観ることが趣味です。","feedback":null,"vocabulary":[],"mode":"normal"}'
    expect(parseChatReply(raw, 'normal')).toBeNull()
    expect(salvageChatReply(raw, 'normal')).toBeNull()
    // 切断された JSON からの救済でも拾わない
    expect(
      salvageChatReply('{"reply_en":"your 1-2 sentence English reply","reply_ja":"', 'normal'),
    ).toBeNull()
  })

  it('配列など、オブジェクト以外の JSON は null', () => {
    expect(parseChatReply('["reply_en"]', 'normal')).toBeNull()
  })
})

describe('isContractPlaceholder', () => {
  it.each([
    'your 1-2 sentence English reply',
    'Your 1-2 sentence English reply.',
    // 実モデル評価で llama3.2:1b が実際に書いた変形
    'Your 1 sentence English reply',
    'string - your English response',
  ])('例示文言: %s', (text) => {
    expect(isContractPlaceholder(text)).toBe(true)
  })
  it.each(['Your English is really good!', 'I like your reply.'])('普通の返答: %s', (text) => {
    expect(isContractPlaceholder(text)).toBe(false)
  })
})

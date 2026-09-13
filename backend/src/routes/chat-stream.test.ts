import { afterEach, describe, expect, it, vi } from 'vitest'
import { findScaffoldOpener, looksLikeJsonScaffold } from '../services/json-salvage.js'
import { sanitizeJapaneseTranslation } from '../services/translation.js'
import { MODEL_PROFILES } from '../services/model-profile.js'
import { buildEnrichment, parseEnrichment, salvagePlainReply } from './chat-stream.js'

/**
 * ストリーミング経路の「JSON を読み上げさせない」防波堤のテスト。
 *
 * 先頭 30 文字が `{` で始まるかだけを見ていた頃は、
 *   Of course! Here is my reply.\n\n{"reply_en": "..."}
 * のような出力(小型モデルが実際にやる)が素通りして、JSON がそのまま
 * 読み上げ・保存され、次のプロンプトにも入っていた。
 * ここは **フロント(utils/chat-stream-reducer.ts)と同じ判定** を保つこと。
 */
describe('looksLikeJsonScaffold', () => {
  const scaffolding = [
    '{"reply_en": "hi"}',
    '  \n```json',
    '[{"word": "x"}]',
    'Of course! Here is my reply.\n\n{"reply_en": "hi there"}',
    'Here you go:\n```json\n{}\n```',
    'the key "reply_ja": comes later in the object',
  ]
  it.each(scaffolding)('JSON 足場として検出する: %s', (text) => {
    expect(looksLikeJsonScaffold(text)).toBe(true)
  })

  const legitimate = [
    'Oh nice, where did you go?',
    '"Really?" he said. That is a common reaction.',
    'He said "hello": that is a normal greeting in English.',
    'In math class we write {1, 2, 3} for a set of numbers.',
    'My meeting is at 9:00, so I said "sure" and went.',
    'You can say: I went hiking last weekend. That sounds natural!',
  ]
  it.each(legitimate)('普通の返答は誤検出しない: %s', (text) => {
    expect(looksLikeJsonScaffold(text)).toBe(false)
  })
})

describe('findScaffoldOpener', () => {
  it('from 以降の最初の疑わしい文字を返す', () => {
    expect(findScaffoldOpener('hello {world', 0)).toBe(6)
    expect(findScaffoldOpener('hello {world', 7)).toBe(-1)
    expect(findScaffoldOpener('a ```b', 0)).toBe(2)
  })
  it('無ければ -1', () => {
    expect(findScaffoldOpener('just a normal sentence.', 0)).toBe(-1)
  })
})

describe('salvagePlainReply', () => {
  it('JSON で返ってきた出力から reply_en を取り出す', () => {
    expect(salvagePlainReply('{"reply_en": "Hello there", "reply_ja": "やあ"}')).toBe('Hello there')
  })

  it('前置き → JSON の出力でも reply_en を優先する', () => {
    const raw = 'Of course! Here it is.\n\n{"reply_en": "Hello there", "reply_ja": "やあ"}'
    expect(salvagePlainReply(raw)).toBe('Hello there')
  })

  it('reply_en の無い JSON なら、その手前に書かれた自然文を拾う', () => {
    const raw = 'Sure, that sounds fun!\n\n{"note": "unused"}'
    expect(salvagePlainReply(raw)).toBe('Sure, that sounds fun!')
  })

  it('コードフェンスだけなら剥がして中身を返す', () => {
    expect(salvagePlainReply('```\nThat sounds like fun!\n```')).toBe('That sounds like fun!')
  })

  it('拾えるものが無ければ null', () => {
    expect(salvagePlainReply('{"unexpected": "shape"}')).toBeNull()
  })
})

describe('parseEnrichment', () => {
  it('正常な JSON を取り込む(モデルが書いた添削は読まない)', () => {
    const result = parseEnrichment(
      JSON.stringify({
        reply_ja: 'いいね、どこに行ったの?',
        feedback: { user_said: 'I go hiking', corrected: 'I went hiking', explanation: '過去形に' },
        vocabulary: [{ word: 'hiking', meaning: 'ハイキング', example: 'I went hiking.' }],
      }),
    )
    expect(result?.replyJa).toBe('いいね、どこに行ったの?')
    // 添削は grammar-check(検証 + 固定テンプレート)だけが作る。
    expect(result?.feedback).toBeNull()
    expect(result?.vocabulary).toHaveLength(1)
  })

  it('意味が日本語でない単語カードは落とす', () => {
    const result = parseEnrichment(
      JSON.stringify({
        reply_ja: 'いいね、どこに行ったの?',
        vocabulary: [
          { word: 'hiking', meaning: 'ハイキング' },
          { word: 'trail', meaning: 'a path through the countryside' },
          { word: 'summit', meaning: 'chōjō' },
        ],
      }),
    )
    expect(result?.vocabulary.map((v) => v.word)).toEqual(['hiking'])
  })

  it('予算切れで切断された JSON からは日本語訳だけを拾う', () => {
    // ENRICH_NUM_PREDICT を下げた結果として現実に起こる形。
    // reply_ja は JSON の先頭キーなので、切れても残る。
    const truncated = '{"reply_ja": "いいね、楽しそう!", "feedback": {"user_said": "I go hik'
    const result = parseEnrichment(truncated)
    expect(result?.replyJa).toBe('いいね、楽しそう!')
    expect(result?.feedback).toBeNull()
    expect(result?.vocabulary).toEqual([])
  })

  it('日本語訳が取れなければ null(呼び出し側が en→ja 翻訳で埋める)', () => {
    expect(parseEnrichment('total garbage')).toBeNull()
  })
})

describe('sanitizeJapaneseTranslation', () => {
  it('普通の日本語訳はそのまま通す', () => {
    expect(sanitizeJapaneseTranslation('いいね、どこに行ったの?')).toBe('いいね、どこに行ったの?')
  })
  it('JSON で返ってきたら中の reply_ja を拾う', () => {
    expect(sanitizeJapaneseTranslation('{"reply_ja": "いいね!", "feedback": null}')).toBe('いいね!')
  })
  it('拾えない JSON は捨てる(画面に JSON を出さない)', () => {
    expect(sanitizeJapaneseTranslation('{"unexpected": "shape"}')).toBe('')
  })
})

describe('buildEnrichment(空行のある reply_ja)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reply_en に空行があっても、空行のある reply_ja は捨てて 1 段落にした英文で訳し直す', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sent: { messages: { content: string }[] }[] = []
    const replies = [
      JSON.stringify({
        reply_ja: 'カレーはおいしいね！\n\n辛くしたの？',
        feedback: null,
        vocabulary: [],
      }),
      'カレーはおいしいね！辛くしたの？',
    ]
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as { messages: { content: string }[] })
      const content = replies[Math.min(sent.length - 1, replies.length - 1)]
      return new Response(JSON.stringify({ message: { role: 'assistant', content }, done: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const result = await buildEnrichment({
      replyEn: 'Curry is so good!\n\nDid you make it spicy?',
      userText: 'I made curry.',
      context: {},
      profile: MODEL_PROFILES.standard,
    })
    expect(result.replyJa).toBe('カレーはおいしいね！辛くしたの？')
    expect(sent).toHaveLength(2)
    expect(sent[1]!.messages.at(-1)!.content).toBe(
      '<en>Curry is so good! Did you make it spicy?</en>',
    )
  })
})

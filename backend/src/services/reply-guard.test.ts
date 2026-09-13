import { describe, expect, it } from 'vitest'
import { filterReplySentences, ReplySentenceGate } from './reply-guard.js'

const SMALL = { maxSentences: 2, dropNonLatin: true }

describe('filterReplySentences(2 文で打ち切り)', () => {
  it('3 文目以降を落とす', () => {
    const r = filterReplySentences(
      'That sounds like a busy morning. Do you like the train? I take the bus every day.',
      SMALL,
    )
    expect(r.text).toBe('That sounds like a busy morning. Do you like the train?')
    expect(r.changed).toBe(true)
  })

  it('2 文以内なら変えない', () => {
    const text = 'Curry is so good! Did you make it spicy?'
    expect(filterReplySentences(text, SMALL)).toEqual({ text, changed: false, droppedNonLatin: 0 })
  })

  it('略語と小数は文末に数えない', () => {
    const text = 'I met Dr. Smith at 3.30 p.m. yesterday, e.g. near the station. Was it fun?'
    expect(filterReplySentences(`${text} I think so.`, SMALL).text).toBe(text)
  })

  it('短い感嘆(Hello!)も 1 文と数える', () => {
    expect(
      filterReplySentences('Hello! How are you today? Do you have plans this weekend?', SMALL).text,
    ).toBe('Hello! How are you today?')
    expect(filterReplySentences('Was it fun? I think so. Tell me more.', SMALL).text).toBe(
      'Was it fun? I think so.',
    )
  })

  it('英字を含まない断片(絵文字だけ・記号だけ)は数えない', () => {
    expect(filterReplySentences('Nice! 😊. Where did you go?', SMALL).text).toBe(
      'Nice! 😊. Where did you go?',
    )
  })

  it('maxSentences が null なら長さはそのまま', () => {
    const text = 'One sentence here. Two sentences here. Three sentences here.'
    expect(filterReplySentences(text, { maxSentences: null, dropNonLatin: true }).text).toBe(text)
  })
})

describe('filterReplySentences(非ラテン文字体系を含む文を落とす)', () => {
  it('日本語を含む文だけを落とし、前後の英文は残す', () => {
    const r = filterReplySentences('That is great news. 寿司が好きです。 What did you eat?', SMALL)
    expect(r.text).toBe('That is great news. What did you eat?')
    expect(r.droppedNonLatin).toBe(1)
  })

  it('ハングル / キリル文字の混ざった文も落とす', () => {
    expect(filterReplySentences('Привет, my friend! How was your day today?', SMALL).text).toBe(
      'How was your day today?',
    )
    expect(filterReplySentences('Nice to meet you, 안녕! Where do you live now?', SMALL).text).toBe(
      'Where do you live now?',
    )
  })

  it('アクセント付きの名前・通貨記号・ダッシュは落とさない', () => {
    const text = 'José paid €5 for a café au lait — nice! Do you like coffee?'
    expect(filterReplySentences(text, SMALL)).toEqual({ text, changed: false, droppedNonLatin: 0 })
  })

  it('全部落ちたら空文字', () => {
    expect(filterReplySentences('こんにちは！元気ですか？', SMALL).text).toBe('')
  })
})

describe('ReplySentenceGate(ストリーミング)', () => {
  /** 1 文字ずつ流して、送出された delta と最終テキストを集める。 */
  function streamByChar(text: string) {
    const gate = new ReplySentenceGate(SMALL)
    let full = ''
    let sent = ''
    let stoppedAt = -1
    for (const ch of text) {
      full += ch
      sent += gate.advance(full)
      if (gate.isCapped) {
        stoppedAt = full.length
        break
      }
    }
    if (!gate.isCapped) sent += gate.advance(full, full.length, true)
    return { gate, sent, stoppedAt }
  }

  it('確定した文だけを送り、送った内容と最終テキストが一致する', () => {
    const text = 'That sounds fun. Where did you go last weekend'
    const { gate, sent } = streamByChar(text)
    expect(sent.trim()).toBe(gate.text)
    expect(gate.text).toBe(text)
  })

  it('2 文目の文末(の直後の空白)で止まる = それ以降を生成させない', () => {
    const text = 'Oh, you went shopping today. What vegetables did you buy? I love carrots.'
    const { gate, sent, stoppedAt } = streamByChar(text)
    expect(gate.isCapped).toBe(true)
    expect(gate.text).toBe('Oh, you went shopping today. What vegetables did you buy?')
    expect(sent.trim()).toBe(gate.text)
    // "buy?" の直後の空白を見た時点で止まっている(3 文目を 1 文字も読んでいない)
    expect(stoppedAt).toBe(text.indexOf('buy?') + 'buy? '.length)
  })

  it('非ラテン文字を含む文は 1 文字も送らない', () => {
    const { gate, sent } = streamByChar(
      'Nice to meet you! I like 東京 a lot. How about you, Shota?',
    )
    expect(sent).not.toMatch(/東京|I like/)
    expect(gate.text).toBe('Nice to meet you! How about you, Shota?')
  })

  it('一括投入と 1 文字ずつの結果が一致する', () => {
    const text = 'Hmm, 3.14 is pi. Dr. Lee said so. And then? 日本語。 The end'
    const batch = filterReplySentences(text, SMALL).text
    expect(streamByChar(text).gate.text).toBe(batch)
  })
})

import { describe, expect, it } from 'vitest'
import { SentenceAccumulator, splitIntoSpeechSegments } from './sentence-stream'

/** 1 文字ずつ push → flush した結果。 */
function feedByChar(text: string, options = {}): string[] {
  const acc = new SentenceAccumulator(options)
  const out: string[] = []
  for (const ch of text) out.push(...acc.push(ch))
  out.push(...acc.flush())
  return out
}

/** size 文字ずつ push → flush した結果。 */
function feedByChunks(text: string, size: number, options = {}): string[] {
  const acc = new SentenceAccumulator(options)
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(...acc.push(text.slice(i, i + size)))
  out.push(...acc.flush())
  return out
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

const SAMPLES = [
  'Dr. Smith arrived early today. We talked for a while.',
  'The price is 3.14 dollars right now. Shall we buy it?',
  'She said "Wow, that is great!" and smiled. Then we left.',
  'J. R. R. Tolkien wrote this book. It took him years.',
  'Hi. Hello there everyone in this room. Goodbye now my friends.',
  'Do you like it? I really do! It is wonderful, e.g. the color.',
  'Wait... okay, I understand your point now. Let us continue.',
  'I work at Acme Inc. in Tokyo, and I commute by train every day.',
  'そうなんだ。それはよかったね。また今度話そう。',
  `${'word '.repeat(60)}`,
  'a',
  '',
  '   ',
  'No punctuation at all here just a long-ish run of words to speak',
]

describe('SentenceAccumulator', () => {
  it('略語のあとでは切らない', () => {
    expect(
      splitIntoSpeechSegments('Dr. Smith arrived early today. We talked for a while.'),
    ).toEqual(['Dr. Smith arrived early today.', 'We talked for a while.'])
    expect(
      splitIntoSpeechSegments('I work at Acme Inc. in Tokyo, and I commute by train every day.'),
    ).toEqual(['I work at Acme Inc. in Tokyo, and I commute by train every day.'])
  })

  it('小数点では切らない', () => {
    expect(
      splitIntoSpeechSegments('The price is 3.14 dollars right now. Shall we buy it?'),
    ).toEqual(['The price is 3.14 dollars right now.', 'Shall we buy it?'])
  })

  it('閉じ引用符は直前の文に含める', () => {
    expect(
      splitIntoSpeechSegments('She said "Wow, that is great!" and smiled. Then we left.'),
    ).toEqual(['She said "Wow, that is great!"', 'and smiled. Then we left.'])
  })

  it('1 文字のイニシャルでは切らない', () => {
    expect(splitIntoSpeechSegments('J. R. R. Tolkien wrote this book. It took him years.')).toEqual(
      ['J. R. R. Tolkien wrote this book.', 'It took him years.'],
    )
  })

  it('短すぎるセグメントは次の文に合流させる', () => {
    expect(
      splitIntoSpeechSegments('Hi. Hello there everyone in this room. Goodbye now my friends.'),
    ).toEqual(['Hi. Hello there everyone in this room.', 'Goodbye now my friends.'])
  })

  it('上限を超えたら直前の空白で強制的に切る', () => {
    const text = 'word '.repeat(60).trim() // 299 文字、句読点なし
    const segments = splitIntoSpeechSegments(text)
    expect(segments.length).toBeGreaterThan(1)
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(180)
    // 単語を割らない = 復元できる
    expect(normalize(segments.join(' '))).toBe(normalize(text))
  })

  it('最初の 1 セグメントは 30 文字貯まるまで出さない', () => {
    const text = 'Hello there my friend. How are you doing today? Fine.'
    const acc = new SentenceAccumulator()
    const emittedAt: number[] = []
    for (let i = 0; i < text.length; i++) {
      const out = acc.push(text[i]!)
      if (out.length > 0) emittedAt.push(i + 1)
    }
    // 最初の文は 22 文字目で確定しているが、30 文字目まで保留される
    expect(emittedAt[0]).toBe(30)
  })

  it('ストリームが終わっていれば 30 文字未満でも flush で出す', () => {
    const acc = new SentenceAccumulator()
    expect(acc.push('Hi. Ok.')).toEqual([])
    expect(acc.flush()).toEqual(['Hi. Ok.'])
  })

  it('flush は残りを絶対に捨てない', () => {
    for (const text of SAMPLES) {
      const segments = splitIntoSpeechSegments(text)
      expect(normalize(segments.join(' '))).toBe(normalize(text))
    }
  })

  it('flush 後の pending は空', () => {
    const acc = new SentenceAccumulator()
    acc.push('Hello there, this is a fairly long sentence without a terminator')
    expect(acc.pending()).not.toBe('')
    acc.flush()
    expect(acc.pending()).toBe('')
    expect(acc.flush()).toEqual([])
  })

  it('チャンクの切れ目に関係なく同じセグメントになる', () => {
    for (const text of SAMPLES) {
      const whole = splitIntoSpeechSegments(text)
      expect(feedByChar(text)).toEqual(whole)
      for (const size of [2, 3, 5, 7, 13, 37, 200]) {
        expect(feedByChunks(text, size)).toEqual(whole)
      }
    }
  })

  it('チャンク不変性はランダムな分割でも保たれる', () => {
    // LLM のトークン境界を模した擬似ランダム分割 (シード固定で再現可能)
    let seed = 12345
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return (seed % n) + 1
    }
    const text = SAMPLES.join(' ') + ' ' + 'x'.repeat(200) + ' end of the whole thing.'
    const whole = splitIntoSpeechSegments(text)
    for (let trial = 0; trial < 20; trial++) {
      const acc = new SentenceAccumulator()
      const out: string[] = []
      let i = 0
      while (i < text.length) {
        const n = rand(9)
        out.push(...acc.push(text.slice(i, i + n)))
        i += n
      }
      out.push(...acc.flush())
      expect(out).toEqual(whole)
    }
  })

  it('reset で再利用できる', () => {
    const acc = new SentenceAccumulator()
    acc.push('Hello there everything is fine here. And more text follows.')
    acc.reset()
    expect(acc.pending()).toBe('')
    expect(acc.push('Short one.')).toEqual([])
    expect(acc.flush()).toEqual(['Short one.'])
  })
})

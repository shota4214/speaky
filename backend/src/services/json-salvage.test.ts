import { describe, expect, it } from 'vitest'
import {
  decodeJsonStringLiteral,
  extractJsonObjectSlice,
  matchJsonStringArrayField,
  matchJsonStringField,
} from './json-salvage.js'

/**
 * salvage のルールを固定するテスト。
 *
 * ここは「壊れた出力から何を拾い、何を拾わないか」という判断そのもので、
 * 拾いすぎれば途中で切れた英文をそのまま読み上げたり、欠けた事実リストを
 * 完全な結果として保存したりする。純粋関数として切り出してあるのは
 * この境界をテストで固定するためなので、境界ケースを明示的に並べる。
 */
describe('extractJsonObjectSlice', () => {
  it('コードフェンスと前置きを剥がして {...} を切り出す', () => {
    const raw = 'Here is the JSON:\n```json\n{"reply_en":"Hi there"}\n```'
    expect(extractJsonObjectSlice(raw)).toBe('{"reply_en":"Hi there"}')
  })

  it('剥がす余地が無ければ null(同じ文字列を再 parse させない)', () => {
    expect(extractJsonObjectSlice('{"a":1}')).toBeNull()
    // 前後の空白だけの違いも「余地なし」と扱う
    expect(extractJsonObjectSlice('  {"a":1}  ')).toBeNull()
  })

  it('{ や } が無い / 閉じていない出力では null', () => {
    expect(extractJsonObjectSlice('no json at all')).toBeNull()
    expect(extractJsonObjectSlice('{"reply_en":"truncated here')).toBeNull()
  })
})

describe('decodeJsonStringLiteral', () => {
  it('エスケープを JSON の規則どおりに戻す', () => {
    expect(decodeJsonStringLiteral('line1\\nline2')).toBe('line1\nline2')
    expect(decodeJsonStringLiteral('He said \\"hi\\"')).toBe('He said "hi"')
    expect(decodeJsonStringLiteral('\\u3053\\u3093\\u306b\\u3061\\u306f')).toBe('こんにちは')
    expect(decodeJsonStringLiteral('back\\\\slash')).toBe('back\\slash')
  })

  it('壊れたエスケープは null', () => {
    expect(decodeJsonStringLiteral('bad \\q escape')).toBeNull()
    expect(decodeJsonStringLiteral('unterminated \\')).toBeNull()
  })
})

describe('matchJsonStringField', () => {
  it('閉じ引用符まで揃っている値を拾う', () => {
    const raw = '{"reply_en":"I went to Kyoto.","reply_ja":"京都に行きました。"'
    expect(matchJsonStringField(raw, 'reply_en')).toBe('I went to Kyoto.')
    expect(matchJsonStringField(raw, 'reply_ja')).toBe('京都に行きました。')
  })

  it('値の中の \\" に引きずられず、値全体を拾う', () => {
    const raw = '{"reply_en":"She said \\"hello\\" to me.","reply_ja":"'
    expect(matchJsonStringField(raw, 'reply_en')).toBe('She said "hello" to me.')
  })

  it('文の途中で切れた値は拾わない(切れた英文を読み上げさせないため)', () => {
    const raw = '{"reply_en":"I was walking down the street when'
    expect(matchJsonStringField(raw, 'reply_en')).toBeNull()
  })

  it('フィールドが無ければ null', () => {
    expect(matchJsonStringField('{"other":"x"}', 'reply_en')).toBeNull()
  })

  it('空文字の値は「拾えなかった」と同じ扱い(null)', () => {
    // 空の返答を救済成功として返すと、空のメッセージが会話に残ってしまう。
    expect(matchJsonStringField('{"reply_en":""}', 'reply_en')).toBeNull()
  })
})

describe('matchJsonStringArrayField', () => {
  it('閉じた配列は closed=true で全要素を返す', () => {
    const raw = '{"newFacts":["京都に住んでいる","犬を飼っている"],"updatedName":null}'
    expect(matchJsonStringArrayField(raw, 'newFacts')).toEqual({
      items: ['京都に住んでいる', '犬を飼っている'],
      closed: true,
    })
  })

  it('空配列も「完結している」として扱う', () => {
    expect(matchJsonStringArrayField('{"newFacts":[],"updatedName":null}', 'newFacts')).toEqual({
      items: [],
      closed: true,
    })
  })

  it('切断された配列は closed=false(完結した要素だけを返す)', () => {
    // 3 件目の途中で num_predict に当たったケース。
    const raw = '{"newFacts":["一件目","二件目","三件目のとちゅ'
    expect(matchJsonStringArrayField(raw, 'newFacts')).toEqual({
      items: ['一件目', '二件目'],
      closed: false,
    })
  })

  it('閉じ引用符はあるが配列が閉じていなければ closed=false', () => {
    const raw = '{"newFacts":["一件目","二件目"'
    expect(matchJsonStringArrayField(raw, 'newFacts')).toEqual({
      items: ['一件目', '二件目'],
      closed: false,
    })
  })

  it('要素の中の ] で配列を切らない', () => {
    const raw = '{"newFacts":["配列の終端 ] を含む事実","次の事実"],"updatedName":null}'
    expect(matchJsonStringArrayField(raw, 'newFacts')).toEqual({
      items: ['配列の終端 ] を含む事実', '次の事実'],
      closed: true,
    })
  })

  it('要素の中の \\" や \\\\ を正しく解釈する', () => {
    const raw = '{"newFacts":["\\"推し\\" がいる","バックスラッシュ \\\\ を含む"]}'
    expect(matchJsonStringArrayField(raw, 'newFacts')).toEqual({
      items: ['"推し" がいる', 'バックスラッシュ \\ を含む'],
      closed: true,
    })
  })

  it('ネストしたオブジェクト / 配列の中身は要素として拾わない', () => {
    const raw = '{"newFacts":["直の要素",{"word":"混ぜてはいけない"},["ネスト配列"]],"x":1}'
    expect(matchJsonStringArrayField(raw, 'newFacts')).toEqual({
      items: ['直の要素'],
      closed: true,
    })
  })

  it('後続フィールドの文字列を配列に混ぜない', () => {
    const raw = '{"newFacts":["一件目"],"updatedName":"ショウタ"}'
    expect(matchJsonStringArrayField(raw, 'newFacts')?.items).toEqual(['一件目'])
  })

  it('空白だけの要素は捨てる', () => {
    expect(matchJsonStringArrayField('{"newFacts":["  ","有効な事実"]}', 'newFacts')).toEqual({
      items: ['有効な事実'],
      closed: true,
    })
  })

  it('フィールド自体が無ければ null(= 救済不能)', () => {
    expect(matchJsonStringArrayField('{"other":[]}', 'newFacts')).toBeNull()
    // 配列ではなく文字列で返ってきた場合もフィールド不在と同じ扱い
    expect(matchJsonStringArrayField('{"newFacts":"not an array"}', 'newFacts')).toBeNull()
  })
})

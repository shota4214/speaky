import { describe, expect, it, vi } from 'vitest'
import { salvageExtractFacts } from './extract-facts.js'

/**
 * 事実抽出の救済ルール。
 *
 * 会話の 1 文を取りこぼすのとは違い、事実の取りこぼしは **永久に失われる**
 * (次の会話で同じことを言ってくれる保証はどこにも無い)。
 * よって「拾えた分だけ返して成功にする」は禁止で、配列が閉じたことを
 * 確認できたときだけ救済を成功にする ― というのがここで固定したい契約。
 */
describe('salvageExtractFacts', () => {
  it('コードフェンス包みは丸ごと復元する', () => {
    const raw = '```json\n{"newFacts":["京都に住んでいる"],"updatedName":"ショウタ"}\n```'
    expect(salvageExtractFacts(raw)).toEqual({
      newFacts: ['京都に住んでいる'],
      updatedName: 'ショウタ',
    })
  })

  it('配列が閉じていれば(閉じ括弧まで来ていれば)救済する', () => {
    // オブジェクトの `}` が無い = 厳密 parse は失敗するが、リストは完結している。
    const raw = '{"newFacts":["一件目","二件目"],"updatedName":null'
    expect(salvageExtractFacts(raw)).toEqual({
      newFacts: ['一件目', '二件目'],
      updatedName: null,
    })
  })

  it('配列が閉じていない(= 途中で切れた)出力は救済しない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 9 件出そうとして 8 件目の途中で num_predict に当たったケース。
    const facts = Array.from({ length: 8 }, (_, i) => `"事実${i + 1}"`).join(',')
    const raw = `{"newFacts":[${facts},"九件目のとちゅ`
    expect(salvageExtractFacts(raw)).toBeNull()
    warn.mockRestore()
  })

  it('要素に ] が含まれていても配列は閉じている扱いのまま救済できる', () => {
    const raw = '{"newFacts":["配列記号 ] が入った事実"],"updatedName":null}'
    expect(salvageExtractFacts(raw)?.newFacts).toEqual(['配列記号 ] が入った事実'])
  })

  it('拾えるものが何も無ければ null(= リトライさせる)', () => {
    expect(salvageExtractFacts('完全に JSON ではない出力')).toBeNull()
    expect(salvageExtractFacts('')).toBeNull()
  })

  it('名前だけでも拾えたら救済成功とする', () => {
    const raw = '{"newFacts":[],"updatedName":"ショウタ"'
    expect(salvageExtractFacts(raw)).toEqual({ newFacts: [], updatedName: 'ショウタ' })
  })

  it('長すぎる事実は捨てる(暴走出力よけ)', () => {
    const long = 'あ'.repeat(201)
    const raw = `{"newFacts":["短い事実","${long}"],"updatedName":null}`
    expect(salvageExtractFacts(raw)?.newFacts).toEqual(['短い事実'])
  })
})

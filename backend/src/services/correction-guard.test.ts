import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  classify,
  extractCorrection,
  guard,
  recheckCorrection,
  tokenize,
  wordDiff,
} from '../shared/correction-guard.js'
import { evaluateGrammarCheckOutput, grammarCheckSkipReason } from './grammar-check.js'

/**
 * 添削フィルタの移植が **研究時と同じ判定をする** ことを固定するテスト。
 *
 * fixtures/grammar-correction-research.json は、研究段階のプロトタイプ(filter.mjs)を
 * 140 件のラベル付き発話(誤り 62 / 正しい文 78)× 2 モデル(qwen2.5:1.5b / llama3.2:3b)の
 * 記録済み出力(V6 プロンプト・温度 0)に対して実行した結果。ここで 1 件でも
 * 食い違ったら、研究で測った数字(正しい文を書き換えた 0/78・直せた 49/62・
 * 間違った説明 0)はもうこのコードの数字ではない。
 */

interface FixtureItem {
  id: string
  set: 'dev' | 'held'
  err: boolean
  cat: string[]
  text: string
  fix: [string, string][]
  bad: [string, string][]
}
interface FixtureRow {
  id: string
  raw: string
  extracted: string
  verdict: string
  reasons: string[]
  categories: string[] | null
  explanation: string | null
}
interface Fixture {
  items: FixtureItem[]
  models: Record<string, FixtureRow[]>
}

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(
  readFileSync(resolve(here, 'fixtures', 'grammar-correction-research.json'), 'utf-8'),
) as Fixture
const itemById = new Map(fixture.items.map((i) => [i.id, i]))

/** 研究の score.mjs の judgeError をそのまま移したもの。 */
function judgeError(
  item: FixtureItem,
  text: string,
): 'fixed' | 'partial' | 'changed-error-kept' | 'other-rewrite' {
  const fix = item.fix.map(([s, f]) => new RegExp(s, f))
  const bad = item.bad.map(([s, f]) => new RegExp(s, f))
  const hits = fix.map((re, k) => re.test(text) && !bad[k]?.test(text))
  const n = hits.filter(Boolean).length
  if (n === fix.length && !bad.some((re) => re.test(text))) return 'fixed'
  if (n > 0) return 'partial'
  if (bad.some((re) => re.test(text))) return 'changed-error-kept'
  return 'other-rewrite'
}

describe('研究のフィクスチャ', () => {
  it('140 件(誤り 62 / 正しい文 78)と 2 モデルぶんの記録がある', () => {
    expect(fixture.items).toHaveLength(140)
    expect(fixture.items.filter((i) => i.err)).toHaveLength(62)
    expect(fixture.items.filter((i) => !i.err)).toHaveLength(78)
    expect(Object.keys(fixture.models).sort()).toEqual(['llama3.2:3b', 'qwen2.5:1.5b'])
    for (const rows of Object.values(fixture.models)) expect(rows).toHaveLength(140)
  })

  it('140 件はどれも LLM を呼ぶ前の足切り(長さ・文字)を通る(研究と同じ入力になる)', () => {
    for (const item of fixture.items) {
      const reason = grammarCheckSkipReason(item.text)
      // 研究のフィルタも 3 語未満は 'skip'。それ以外の足切りには当たらないこと。
      if (tokenize(item.text).length < 3) expect(reason).toBe('too-short')
      else expect(reason, item.text).toBeNull()
    }
  })
})

for (const [model, rows] of Object.entries(fixture.models)) {
  describe(`${model} の記録済み出力で研究時の判定を再現する`, () => {
    it.each(rows.map((r) => [r.id, r] as const))('%s', (_id, row) => {
      const item = itemById.get(row.id)!
      const ext = extractCorrection(row.raw, 'echo')
      const candidate = ext.sentinel ? '' : ext.text
      expect(candidate).toBe(row.extracted)

      const g = guard(item.text, candidate, { minWords: 3, maxOps: 3 })
      expect(g.verdict).toBe(row.verdict)
      expect(g.reasons).toEqual(row.reasons)

      if (g.verdict === 'accept') {
        const c = classify(item.text, candidate, g.ops)
        expect(c.categories).toEqual(row.categories)
        expect(c.explanation).toBe(row.explanation)
      } else {
        expect(row.categories).toBeNull()
      }

      // 本番の入口(evaluateGrammarCheckOutput)も同じ結論になる。
      const e = evaluateGrammarCheckOutput(item.text, row.raw)
      const shown = row.verdict === 'accept' && row.explanation !== null
      expect(e.feedback !== null).toBe(shown)
      if (e.feedback) {
        expect(e.feedback).toEqual({
          user_said: item.text,
          corrected: row.extracted,
          explanation: row.explanation,
        })
      }

      // 履歴画面の再検証(保存された発話と直した文だけから作り直す)も同じ結論・同じ説明になる。
      expect(recheckCorrection(item.text, row.extracted)).toEqual(e.feedback)
    })

    it('研究の数字: 正しい文の書き換え 0/78・直せた誤り 49/62・間違った説明 0', () => {
      let wronglyChanged = 0
      let fixed = 0
      let shownNotFix = 0
      let wrongCategory = 0
      for (const row of rows) {
        const item = itemById.get(row.id)!
        const e = evaluateGrammarCheckOutput(item.text, row.raw)
        if (!e.feedback) continue
        if (!item.err) {
          wronglyChanged += 1
          continue
        }
        if (judgeError(item, e.feedback.corrected) === 'fixed') fixed += 1
        else shownNotFix += 1
        const gold = [...new Set(item.cat)].sort()
        if (JSON.stringify([...new Set(e.categories)].sort()) !== JSON.stringify(gold))
          wrongCategory += 1
      }
      expect(wronglyChanged).toBe(0)
      expect(fixed).toBe(49)
      expect(shownNotFix).toBe(0)
      expect(wrongCategory).toBe(0)
    })
  })
}

describe('今はテンプレートが無いので隠している正しい直し(次に足すテンプレートの候補)', () => {
  // 研究で「直しは正しいが説明できないので表示しない」になったもの。
  // テンプレートを足したら、このテストを書き換えてから数字を測り直すこと。
  it.each([
    ['I play the tennis every Sunday.', 'I play tennis every Sunday.'],
    ['Does he likes baseball?', 'Does he like baseball?'],
    ['Why you are sad?', 'Why are you sad?'],
    ["I don't know where is the station.", "I don't know where the station is."],
  ])('%s -> %s は表示しない', (said, corrected) => {
    expect(evaluateGrammarCheckOutput(said, corrected).feedback).toBeNull()
  })

  it('My friend have two child. -> children はフィルタが内容語の差し替えとして捨てる', () => {
    const e = evaluateGrammarCheckOutput('My friend have two child.', 'My friend has two children.')
    expect(e.verdict).toBe('reject')
    expect(e.feedback).toBeNull()
  })
})

describe('フィルタの基本動作', () => {
  it('正しい文をそのまま繰り返したら何も表示しない', () => {
    const e = evaluateGrammarCheckOutput(
      'I usually take the train to work.',
      'I usually take the train to work.',
    )
    expect(e.verdict).toBe('nochange')
    expect(e.feedback).toBeNull()
  })

  it('句読点や大文字だけの違いは変更とみなさない', () => {
    expect(
      evaluateGrammarCheckOutput('i usually take the train', 'I usually take the train.').verdict,
    ).toBe('nochange')
  })

  it('内容語の差し替え(言い換え)は捨てる', () => {
    const e = evaluateGrammarCheckOutput('I like dogs very much.', 'I love dogs very much.')
    expect(e.verdict).toBe('reject')
    expect(e.feedback).toBeNull()
  })

  it('日本語などラテン文字以外が混ざった書き直しは捨てる', () => {
    expect(evaluateGrammarCheckOutput('My sister is nurse.', 'My sister is 看護師.').verdict).toBe(
      'reject',
    )
  })

  it('説明できる直しには固定の日本語テンプレートの説明が付く', () => {
    const e = evaluateGrammarCheckOutput('My sister is nurse.', 'My sister is a nurse.')
    expect(e.feedback).toEqual({
      user_said: 'My sister is nurse.',
      corrected: 'My sister is a nurse.',
      explanation: '数えられる名詞が 1 つのときは、「a nurse」のように前に「a」を付けます。',
    })
  })

  it('テンプレートの差し込み位置に語が無いときは説明せず、例外も投げない', () => {
    // 文頭の前置詞の差し替え: 「前の語」が存在しない。
    const A = tokenize('In school I study English.')
    const B = tokenize('At school I study English.')
    const { ops } = wordDiff(A, B)
    const c = classify('In school I study English.', 'At school I study English.', ops)
    expect(c.explanation).toBeNull()
    expect(c.categories).toContain('unknown')
  })
})

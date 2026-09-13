import { describe, expect, it } from 'vitest'
import { buildOpeningUserPrompt, buildSystemPrompt } from './conversation-prompt.js'
import { BUILT_IN_TOPICS } from '../shared/topics.js'

/**
 * small プロファイルの system prompt は **約 300 トークン以内** という設計上の
 * 約束がある。1B クラスは指示の総量に負けて「英語で 1〜2 文」を落とすので、
 * この上限は品質そのものである。トークナイザを持ち込みたくないので
 * 「4 文字 ≒ 1 トークン」の粗い見積りで縛る(英語主体なので実際はもう少し少ない)。
 */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const RICH = {
  aiName: 'Emma',
  level: 'intermediate' as const,
  topic: 'travel',
  personality: 'friendly' as const,
  vocabFocus: ['commute', 'errand'],
  // フロントが送ってくる上限(MAX_PROFILE_FACTS_IN_PROMPT)と同じ 20 件
  userProfile: Array.from({ length: 20 }, (_, i) => `Fact number ${i} about the user`),
  lastConversationSummary: 'We talked about weekend plans and hiking in Nara.',
}

describe('small プロファイルの system prompt', () => {
  it('もっとも太い入力でも約 300 トークン以内に収まる', () => {
    for (const outputFormat of ['json', 'text'] as const) {
      const prompt = buildSystemPrompt({ ...RICH, profile: 'small', outputFormat })
      expect(approxTokens(prompt), `${outputFormat}: ${prompt.length} chars`).toBeLessThanOrEqual(
        300,
      )
    }
  })

  it('standard の半分以下の長さになる', () => {
    const standard = buildSystemPrompt({ ...RICH, outputFormat: 'text' })
    const small = buildSystemPrompt({ ...RICH, profile: 'small', outputFormat: 'text' })
    expect(small.length).toBeLessThan(standard.length / 2)
  })

  it('会話スタイル(バリエーション)セクションを載せない', () => {
    const small = buildSystemPrompt({ ...RICH, profile: 'small', outputFormat: 'text' })
    expect(small).not.toContain('VARIETY IS CRITICAL')
    // standard 側には残っている(= 削除ではなく分岐であることを固定する)
    expect(buildSystemPrompt({ ...RICH, outputFormat: 'text' })).toContain('VARIETY IS CRITICAL')
  })

  it('該当レベルの説明だけを載せる(3 レベル分を並べない)', () => {
    const small = buildSystemPrompt({ ...RICH, level: 'beginner', profile: 'small' })
    expect(small).toContain('A1-A2')
    expect(small).not.toContain('B1-B2')
    expect(small).not.toContain('C1-C2')
  })

  it('「1〜2 文の英語で返す」を明示する', () => {
    const small = buildSystemPrompt({ ...RICH, profile: 'small', outputFormat: 'text' })
    expect(small).toMatch(/ONE or TWO short sentences/)
    expect(small).toContain('ENGLISH only')
  })

  it('text 出力では JSON を禁止する', () => {
    const small = buildSystemPrompt({ ...RICH, profile: 'small', outputFormat: 'text' })
    expect(small).toContain('No JSON')
    expect(small).toContain('plain text')
  })

  it('json 出力では feedback / vocabulary を空に固定する', () => {
    const small = buildSystemPrompt({ ...RICH, profile: 'small', outputFormat: 'json' })
    expect(small).toContain('"feedback":null')
    expect(small).toContain('"vocabulary":[]')
  })

  it('プロフィール事実は 6 件までしか載せない', () => {
    const small = buildSystemPrompt({ ...RICH, profile: 'small' })
    const listed = RICH.userProfile.filter((f) => small.includes(f))
    expect(listed).toHaveLength(6)
    // 新しい方(末尾)から採る
    expect(small).toContain('Fact number 19 about the user')
    expect(small).not.toContain('Fact number 0 about the user')
  })

  it('空のセクションは見出しごと省く', () => {
    const minimal = buildSystemPrompt({
      aiName: 'Emma',
      topic: 'travel',
      profile: 'small',
      outputFormat: 'text',
    })
    expect(minimal).not.toContain('About the user')
    expect(minimal).not.toContain('Last conversation')
    expect(minimal).not.toContain('Try to use these words')
  })
})

describe('標準プロファイルは従来どおり', () => {
  it('profile 未指定は standard と同じ結果', () => {
    expect(buildSystemPrompt({ ...RICH })).toBe(buildSystemPrompt({ ...RICH, profile: 'standard' }))
  })

  it('3 レベル分の説明と会話スタイルを載せたまま', () => {
    const standard = buildSystemPrompt({ ...RICH })
    expect(standard).toContain('A1-A2')
    expect(standard).toContain('B1-B2')
    expect(standard).toContain('C1-C2')
    expect(standard).toContain('VARIETY IS CRITICAL')
  })
})

describe('small プロファイルの opening プロンプト', () => {
  it('挨拶の例文を載せない(小型モデルはそのまま丸写しする)', () => {
    const small = buildOpeningUserPrompt({ ...RICH, profile: 'small' })
    expect(small).not.toContain('Hey! Quick question for you')
    expect(small).not.toContain('invent your own')
  })

  it('standard より大幅に短い', () => {
    const standard = buildOpeningUserPrompt({ ...RICH })
    const small = buildOpeningUserPrompt({ ...RICH, profile: 'small' })
    expect(small.length).toBeLessThan(standard.length / 2)
  })

  it('text 出力ではプレーンテキストを念押しする', () => {
    const small = buildOpeningUserPrompt({ ...RICH, profile: 'small', outputFormat: 'text' })
    expect(small).toContain('Plain English text only')
  })
})

describe('トピックのキーはプロンプトに入る前に英語の説明へ置き換える', () => {
  it.each(BUILT_IN_TOPICS)('$key → $promptLabel', ({ key, promptLabel }) => {
    for (const profile of ['small', 'standard'] as const) {
      for (const outputFormat of ['json', 'text'] as const) {
        const system = buildSystemPrompt({ topic: key, profile, outputFormat })
        const opening = buildOpeningUserPrompt({ topic: key, profile, outputFormat })
        expect(system).toContain(promptLabel)
        expect(opening).toContain(promptLabel)
      }
    }
  })

  it('small の挨拶で "daily" という単語そのものを尋ねさせない', () => {
    const opening = buildOpeningUserPrompt({
      topic: 'daily',
      profile: 'small',
      outputFormat: 'text',
    })
    expect(opening).toContain('"daily life"')
    expect(opening).not.toContain('"daily"')
  })

  it('カスタムトピックはそのまま渡す', () => {
    expect(buildSystemPrompt({ topic: 'K-pop idols', profile: 'small' })).toContain('K-pop idols')
  })
})

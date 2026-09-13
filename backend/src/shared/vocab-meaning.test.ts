import { describe, expect, it } from 'vitest'
import { isJapaneseVocabMeaning } from './text-guards.js'
import { sanitizeVocabulary } from '../services/chat-reply.js'

/**
 * 単語カードの意味の検証。標準プロファイルの実モデル評価で、llama3.2:3b の単語カードの
 * 意味が日本語だったのは 90 件中 26 件だけだった。日本語でない意味は **カードごと落とす**。
 */
describe('isJapaneseVocabMeaning', () => {
  it.each([
    '散歩',
    '天気',
    'ハイキング',
    '楽しみにする',
    '〜に興味がある',
    '週末(しゅうまつ)',
    '電車に乗り遅れる',
  ])('日本語の意味は通す: %s', (meaning) => {
    expect(isJapaneseVocabMeaning(meaning)).toBe(true)
  })

  it.each([
    ['英語の言い換え', 'to walk for pleasure'],
    ['ローマ字', 'sanpo'],
    ['英語が主体で括弧に日本語', 'a walk in the park (散歩)'],
    ['ハングル', '산책'],
    ['キリル文字', 'прогулка'],
    ['空', ''],
    ['空白だけ', '   '],
  ])('%s は落とす: %s', (_label, meaning) => {
    expect(isJapaneseVocabMeaning(meaning)).toBe(false)
  })
})

describe('sanitizeVocabulary', () => {
  it('意味が日本語でない項目だけを落とし、残りは形を整えて返す', () => {
    const items = sanitizeVocabulary([
      { word: 'hike', meaning: 'ハイキングする', example: 'I hike every weekend.' },
      { word: 'weather', meaning: 'the state of the atmosphere' },
      { word: 'relax', meaning: 'くつろぐ' },
      { word: 42, meaning: '数' },
    ])
    expect(items).toEqual([
      { word: 'hike', meaning: 'ハイキングする', example: 'I hike every weekend.' },
      { word: 'relax', meaning: 'くつろぐ', example: null },
    ])
  })

  it('見出し語が英語でない項目も落とす(実モデルの出力: 意味が中国語 / 崩れた日本語でも漢字があれば通ってしまうため)', () => {
    // llama3.2:3b の enrich で実際に出た形。
    const items = sanitizeVocabulary([
      { word: '我是', meaning: '欢张。' },
      { word: '日本', meaning: '欢缿例' },
      { word: 'こんちていまた', meaning: '日、だるですといなた' },
      { word: 'ride-sharing', meaning: 'タクシーサービス' },
      { word: '', meaning: '散歩' },
    ])
    expect(items.map((v) => v.word)).toEqual(['ride-sharing'])
  })

  it('配列でなければ空', () => {
    expect(sanitizeVocabulary('nope')).toEqual([])
  })
})

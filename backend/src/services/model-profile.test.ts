import { describe, expect, it } from 'vitest'
import { MODEL_PROFILES, resolveModelProfile } from './model-profile.js'

/**
 * プロファイルは「小型モデルを実用にする」ための束なので、
 * 値そのものより **standard が v1.1.0 から動いていないこと** と
 * **small が確かに切り詰まっていること** を固定する。
 * 値を触るときはここも一緒に動かす(= 意図せず変わったら落ちる)。
 */

describe('standard プロファイル(v1.1.0 の実効値を据え置く)', () => {
  const p = MODEL_PROFILES.standard

  it('履歴 10 往復 / num_ctx 4096', () => {
    expect(p.maxHistoryTurns).toBe(10)
    expect(p.numCtx).toBe(4096)
  })

  it('生成予算は v1.1.0 のまま', () => {
    expect(p.chatNumPredict).toBe(640)
    expect(p.openingNumPredict).toBe(400)
    expect(p.streamNumPredict).toBe(320)
    expect(p.enrichNumPredict).toBe(360)
  })

  it('サンプリングは v1.1.0 のまま', () => {
    expect(p.temperature).toBe(0.85)
    expect(p.topP).toBe(0.92)
    expect(p.repeatPenalty).toBe(1.15)
  })

  it('enrich は添削・単語まで作る', () => {
    expect(p.enrichment).toBe('full')
  })
})

describe('small プロファイル', () => {
  const small = MODEL_PROFILES.small
  const standard = MODEL_PROFILES.standard

  it('履歴は standard より短い', () => {
    expect(small.maxHistoryTurns).toBeLessThan(standard.maxHistoryTurns)
  })

  it('num_ctx は下げない(計測できる実機が無いうちは据え置く)', () => {
    // CLAUDE.md: 計測せずに num_ctx を下げないこと。
    // プロファイル駆動にはしたが、値は standard と同じまま出荷する。
    expect(small.numCtx).toBe(standard.numCtx)
  })

  it('生成予算はすべて standard 以下', () => {
    expect(small.chatNumPredict).toBeLessThan(standard.chatNumPredict)
    expect(small.openingNumPredict).toBeLessThan(standard.openingNumPredict)
    expect(small.streamNumPredict).toBeLessThan(standard.streamNumPredict)
    expect(small.enrichNumPredict).toBeLessThan(standard.enrichNumPredict)
  })

  it('温度は低く、繰り返しペナルティは高い', () => {
    expect(small.temperature).toBeLessThan(standard.temperature)
    expect(small.openingTemperature).toBeLessThan(standard.openingTemperature)
    expect(small.repeatPenalty).toBeGreaterThan(standard.repeatPenalty)
  })

  it('enrich は日本語訳だけ(誤添削・無意味な単語を出さない)', () => {
    expect(small.enrichment).toBe('translation-only')
  })

  it('プロンプトは small 版に切り替わる', () => {
    expect(small.promptVariant).toBe('small')
  })
})

describe('resolveModelProfile', () => {
  it('auto + 1B → small', () => {
    expect(resolveModelProfile('auto', 'llama3.2:1b').level).toBe('small')
  })

  it('auto + 1.5B → small', () => {
    expect(resolveModelProfile('auto', 'qwen2.5:1.5b').level).toBe('small')
  })

  it('auto + 2B → small(既存 gemma2:2b ユーザーの挙動が変わる境界)', () => {
    expect(resolveModelProfile('auto', 'gemma2:2b').level).toBe('small')
  })

  it('auto + 3B → standard(同梱モデルは従来どおり)', () => {
    expect(resolveModelProfile('auto', 'llama3.2:3b').level).toBe('standard')
  })

  it('量子化タグでも判定が変わらない', () => {
    expect(resolveModelProfile('auto', 'llama3.2:1b-instruct-q4_K_M').level).toBe('small')
    expect(resolveModelProfile('auto', 'gemma2:9b-instruct-fp16').level).toBe('standard')
  })

  it('明示指定は推定より強い', () => {
    expect(resolveModelProfile('standard', 'llama3.2:1b').level).toBe('standard')
    expect(resolveModelProfile('small', 'qwen2.5:14b').level).toBe('small')
  })

  it('未指定(古いフロント)は auto 相当', () => {
    expect(resolveModelProfile(undefined, 'llama3.2:1b').level).toBe('small')
    expect(resolveModelProfile(undefined, undefined).level).toBe('standard')
  })
})

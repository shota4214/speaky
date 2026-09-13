import { describe, expect, it } from 'vitest'
import {
  FEATURE_GRAMMAR_CHECK,
  FEATURE_MODEL_PROFILE,
  NO_FEATURES,
  type BackendFeatures,
} from './backend-features'
import {
  correctionsAvailable,
  lightModeBadgeTitle,
  lightModeOutputsLabel,
} from './correction-wording'

function withFeatures(features: string[]): BackendFeatures {
  return { apiVersion: 1, features, totalMemoryBytes: null }
}

describe('添削の文言は grammar-check の申告に揃える', () => {
  it('grammar-check を申告した backend: 日本語訳と添削が出ると書く', () => {
    const f = withFeatures([FEATURE_MODEL_PROFILE, FEATURE_GRAMMAR_CHECK])
    expect(correctionsAvailable(f)).toBe(true)
    expect(lightModeOutputsLabel(f)).toBe('日本語訳と添削')
    expect(lightModeBadgeTitle(f)).toBe(
      '小さいモデル向けの設定で動いています(返答は短め・日本語訳と添削は出ます・単語カードは出ません)',
    )
  })

  it('model-profile だけ申告した backend: 添削には触れず日本語訳だけを書く', () => {
    const f = withFeatures([FEATURE_MODEL_PROFILE])
    expect(correctionsAvailable(f)).toBe(false)
    expect(lightModeOutputsLabel(f)).toBe('日本語訳')
    expect(lightModeBadgeTitle(f)).not.toContain('添削')
    expect(lightModeBadgeTitle(f)).toContain('日本語訳は出ます')
  })

  it('まだ確認できていない / 機能を返さない backend も添削があるとは言わない', () => {
    expect(correctionsAvailable(NO_FEATURES)).toBe(false)
    expect(lightModeOutputsLabel(NO_FEATURES)).toBe('日本語訳')
  })
})

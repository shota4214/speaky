import { describe, expect, it } from 'vitest'
import {
  FEATURE_CHAT_ENRICH,
  FEATURE_CHAT_STREAM,
  hasFeature,
  NO_FEATURES,
  parseHealthFeatures,
} from './backend-features'

describe('parseHealthFeatures', () => {
  it('features と apiVersion を読み取る', () => {
    const parsed = parseHealthFeatures({
      status: 'ok',
      apiVersion: 2,
      features: ['chat-stream', 'chat-enrich'],
    })
    expect(parsed.apiVersion).toBe(2)
    expect(hasFeature(parsed, FEATURE_CHAT_STREAM)).toBe(true)
    expect(hasFeature(parsed, FEATURE_CHAT_ENRICH)).toBe(true)
  })

  it('features を返さない古いバックエンドは「機能なし」になる', () => {
    // v1.1.0 までの /api/health のレスポンス
    const parsed = parseHealthFeatures({ status: 'ok', timestamp: '2026-01-01T00:00:00.000Z' })
    expect(parsed).toEqual(NO_FEATURES)
    expect(hasFeature(parsed, FEATURE_CHAT_STREAM)).toBe(false)
  })

  it('壊れた応答は「機能なし」に倒す', () => {
    expect(parseHealthFeatures(null)).toEqual(NO_FEATURES)
    expect(parseHealthFeatures('ok')).toEqual(NO_FEATURES)
    expect(parseHealthFeatures({ features: 'chat-stream' })).toEqual(NO_FEATURES)
    expect(parseHealthFeatures({ features: {} })).toEqual(NO_FEATURES)
  })

  it('features の中の非文字列は捨てる', () => {
    const parsed = parseHealthFeatures({ features: ['chat-stream', 42, null, ''] })
    expect(parsed.features).toEqual(['chat-stream'])
  })

  it('apiVersion が無い / 不正でも features は活きる(0 として扱う)', () => {
    const parsed = parseHealthFeatures({ features: ['chat-stream'], apiVersion: 'two' })
    expect(parsed.apiVersion).toBe(0)
    expect(hasFeature(parsed, FEATURE_CHAT_STREAM)).toBe(true)
  })

  it('知らない機能名は false', () => {
    const parsed = parseHealthFeatures({ features: ['chat-stream'] })
    expect(hasFeature(parsed, 'something-else')).toBe(false)
  })
})

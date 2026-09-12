import { describe, expect, it } from 'vitest'
import {
  FEATURE_CHAT_ENRICH,
  FEATURE_CHAT_STREAM,
  formatMemoryGb,
  hasFeature,
  isLowMemoryMachine,
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

/**
 * 搭載メモリ。オンボーディングが「この Mac は 8GB なので軽いモデルを」と
 * 言い切れるかどうかがこの 1 個に懸かっている。
 * **分からないときは推測しない**(false / null を返す)のが肝。
 */
describe('搭載メモリ', () => {
  const GB = 1024 * 1024 * 1024

  it('totalMemoryBytes を読み取る', () => {
    const parsed = parseHealthFeatures({ features: ['chat-stream'], totalMemoryBytes: 8 * GB })
    expect(parsed.totalMemoryBytes).toBe(8 * GB)
  })

  it('古いバックエンド(キーなし)は null', () => {
    expect(parseHealthFeatures({ features: ['chat-stream'] }).totalMemoryBytes).toBeNull()
  })

  it('不正な値は null に倒す', () => {
    for (const bad of ['8GB', 0, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(
        parseHealthFeatures({ features: ['chat-stream'], totalMemoryBytes: bad }).totalMemoryBytes,
        String(bad),
      ).toBeNull()
    }
  })

  it('8GB 機は軽量モデル向きと判定する', () => {
    const parsed = parseHealthFeatures({ features: [], totalMemoryBytes: 8 * GB })
    expect(isLowMemoryMachine(parsed)).toBe(true)
    expect(formatMemoryGb(parsed)).toBe('8GB')
  })

  it('16GB / 24GB 機は軽量モデル向きではない', () => {
    for (const gb of [16, 24, 36]) {
      const parsed = parseHealthFeatures({ features: [], totalMemoryBytes: gb * GB })
      expect(isLowMemoryMachine(parsed), `${gb}GB`).toBe(false)
      expect(formatMemoryGb(parsed)).toBe(`${gb}GB`)
    }
  })

  it('メモリが分からないときは推測しない', () => {
    expect(isLowMemoryMachine(NO_FEATURES)).toBe(false)
    expect(formatMemoryGb(NO_FEATURES)).toBeNull()
  })
})

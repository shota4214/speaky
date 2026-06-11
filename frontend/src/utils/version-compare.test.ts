import { describe, expect, it } from 'vitest'
import { compareVersions, isNewerVersion } from './version-compare'

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('0.0.7', '0.0.7')).toBe(0)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('returns positive when first is newer (patch)', () => {
    expect(compareVersions('0.0.8', '0.0.7')).toBeGreaterThan(0)
  })

  it('returns negative when first is older (patch)', () => {
    expect(compareVersions('0.0.6', '0.0.7')).toBeLessThan(0)
  })

  it('respects major > minor > patch precedence', () => {
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.0.99')).toBeGreaterThan(0)
  })

  it('tolerates leading "v"', () => {
    expect(compareVersions('v0.0.8', '0.0.7')).toBeGreaterThan(0)
  })

  it('treats missing components as 0', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
  })

  it('treats junk as 0 rather than throwing', () => {
    expect(compareVersions('abc', '0.0.0')).toBe(0)
    expect(compareVersions('0.0.1', 'xyz')).toBeGreaterThan(0)
  })

  it('treats empty string as 0.0.0', () => {
    expect(compareVersions('', '0.0.0')).toBe(0)
    expect(compareVersions('', '0.0.1')).toBeLessThan(0)
  })

  it('compares numerically, not lexicographically (10 > 9)', () => {
    expect(compareVersions('0.0.10', '0.0.9')).toBeGreaterThan(0)
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
  })

  it('parses leading zeros as decimal (07 = 7)', () => {
    expect(compareVersions('0.0.07', '0.0.7')).toBe(0)
  })
})

describe('isNewerVersion', () => {
  it('returns true only when candidate is strictly newer', () => {
    expect(isNewerVersion('0.0.8', '0.0.7')).toBe(true)
    expect(isNewerVersion('0.0.7', '0.0.7')).toBe(false)
    expect(isNewerVersion('0.0.6', '0.0.7')).toBe(false)
  })
})

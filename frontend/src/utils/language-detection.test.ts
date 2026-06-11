import { describe, expect, it } from 'vitest'
import {
  detectInputMode,
  isTooShort,
  looksLikeHallucination,
  looksLikeWrongLanguage,
} from './language-detection'

describe('detectInputMode', () => {
  it('returns "normal" for English-only input', () => {
    expect(detectInputMode('How are you?')).toBe('normal')
  })

  it('returns "japanese_help" for Japanese-only input', () => {
    expect(detectInputMode('今日は良い天気ですね')).toBe('japanese_help')
  })

  it('returns "mixed" when both scripts are present', () => {
    expect(detectInputMode('I want to eat 寿司')).toBe('mixed')
  })
})

describe('isTooShort', () => {
  it('returns true for empty or whitespace-only', () => {
    expect(isTooShort('')).toBe(true)
    expect(isTooShort('   ')).toBe(true)
  })

  it('returns true for input shorter than the threshold', () => {
    expect(isTooShort('hi')).toBe(true)
  })

  it('returns false for input at or above the threshold', () => {
    expect(isTooShort('yes')).toBe(false)
    expect(isTooShort('hello')).toBe(false)
  })
})

describe('looksLikeHallucination', () => {
  it('flags common Whisper silence hallucinations', () => {
    expect(looksLikeHallucination('Thanks for watching!')).toBe(true)
    expect(looksLikeHallucination('Bye.')).toBe(true)
    expect(looksLikeHallucination('.')).toBe(true)
  })

  it('does not flag normal sentences', () => {
    expect(looksLikeHallucination('I went to the park yesterday.')).toBe(false)
    expect(looksLikeHallucination('今日は楽しかった')).toBe(false)
  })
})

describe('looksLikeWrongLanguage', () => {
  it('flags Hangul syllables (Korean misdetection by Whisper)', () => {
    expect(looksLikeWrongLanguage('안녕하세요')).toBe(true)
  })

  it('flags Korean even when mixed with target-language characters', () => {
    expect(looksLikeWrongLanguage('hello 안녕')).toBe(true)
    expect(looksLikeWrongLanguage('こんにちは 안녕')).toBe(true)
  })

  it('does not flag pure Japanese / English / mixed Japanese-English', () => {
    expect(looksLikeWrongLanguage('How are you?')).toBe(false)
    expect(looksLikeWrongLanguage('今日は良い天気ですね')).toBe(false)
    expect(looksLikeWrongLanguage('I want to eat 寿司')).toBe(false)
  })

  it('does not flag punctuation / numbers / symbols', () => {
    expect(looksLikeWrongLanguage('123 !? -- ...')).toBe(false)
  })
})

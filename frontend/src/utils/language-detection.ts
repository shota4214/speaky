import type { Mode } from '../db/types'

const JP_REGEX = /[぀-ゟ゠-ヿ一-龯]/
const EN_REGEX = /[A-Za-z]/

export function detectInputMode(text: string): Mode {
  const hasJa = JP_REGEX.test(text)
  const hasEn = EN_REGEX.test(text)
  if (hasJa && hasEn) return 'mixed'
  if (hasJa) return 'japanese_help'
  return 'normal'
}

/**
 * Whisper が無音/雑音時に幻覚で返す典型パターン。
 * これらを破棄しないと「Thanks for watching」が突然返答される。
 */
const HALLUCINATION_PATTERNS: RegExp[] = [
  /^thank(s| you)( for watching| for listening)?[!.]*$/i,
  /^thanks for watching[!.]*$/i,
  /^subscribe.*channel[!.]*$/i,
  /^bye[!.]*$/i,
  /^you[!.]*$/i,
  /^\.$/,
]

export function looksLikeHallucination(text: string): boolean {
  const trimmed = text.trim()
  return HALLUCINATION_PATTERNS.some((p) => p.test(trimmed))
}

export function isTooShort(text: string, minChars = 3): boolean {
  return text.trim().length < minChars
}

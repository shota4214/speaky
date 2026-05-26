export type Level = 'beginner' | 'intermediate' | 'advanced'
export type Gender = 'male' | 'female'
export type Mode = 'normal' | 'japanese_help' | 'mixed'
export type Role = 'user' | 'ai'
export type InputLanguage = 'en' | 'ja' | 'mixed'

/**
 * AI の性格プリセット。Settings から切り替えられる 5 種類。
 * - friendly: 親友のように暖かく(デフォルト/従来挙動)
 * - teacher: 丁寧な英語の先生
 * - cool: 落ち着いた皮肉屋
 * - kohai: テンション高めの後輩
 * - colleague: 礼儀正しい同僚
 */
export type PersonalityPreset = 'friendly' | 'teacher' | 'cool' | 'kohai' | 'colleague'

export interface AiCharacter {
  name: string
  gender: Gender
}

export interface Conversation {
  id: string
  startedAt: Date
  endedAt: Date | null
  topic: string
  level: Level
  aiCharacter: AiCharacter
  summary: string | null
  expiresAt: Date
}

export interface Feedback {
  userSaid: string
  corrected: string
  explanation: string
}

export interface VocabItem {
  word: string
  meaning: string
  example: string | null
}

export interface Message {
  id: string
  conversationId: string
  timestamp: Date
  role: Role
  userText: string | null
  inputLanguage: InputLanguage | null
  replyEn: string | null
  replyJa: string | null
  feedback: Feedback | null
  vocabulary: VocabItem[] | null
  mode: Mode | null
}

export interface Vocabulary {
  id: string
  word: string
  meaning: string
  example: string | null
  partOfSpeech: string | null
  savedAt: Date
}

export interface UserFact {
  id: string
  fact: string
  learnedAt: Date
  learnedFromConversationId: string | null
}

export interface UserProfile {
  id: 'main'
  name: string | null
  facts: UserFact[]
}

export interface CustomTopic {
  id: string
  name: string
  description: string
  createdAt: Date
}

import { db } from '../index'
import type { Message } from '../types'

export type CreateMessageInput = Omit<Message, 'id'> & { id?: string }

export const messagesRepo = {
  async create(input: CreateMessageInput): Promise<Message> {
    const id = input.id ?? crypto.randomUUID()
    // reactive Proxy 等を排除してプレーン値だけで構築
    const msg: Message = {
      id,
      conversationId: input.conversationId,
      timestamp: input.timestamp,
      role: input.role,
      userText: input.userText,
      inputLanguage: input.inputLanguage,
      replyEn: input.replyEn,
      replyJa: input.replyJa,
      feedback: input.feedback
        ? {
            userSaid: input.feedback.userSaid,
            corrected: input.feedback.corrected,
            explanation: input.feedback.explanation,
          }
        : null,
      vocabulary: input.vocabulary
        ? input.vocabulary.map((v) => ({
            word: v.word,
            meaning: v.meaning,
            example: v.example,
          }))
        : null,
      mode: input.mode,
    }
    await db.messages.add(msg)
    return msg
  },

  async listByConversation(conversationId: string): Promise<Message[]> {
    return db.messages.where('conversationId').equals(conversationId).sortBy('timestamp')
  },

  async deleteByConversation(conversationId: string): Promise<number> {
    return db.messages.where('conversationId').equals(conversationId).delete()
  },
}

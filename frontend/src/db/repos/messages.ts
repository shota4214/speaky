import { db } from '../index'
import type { Message } from '../types'

export type CreateMessageInput = Omit<Message, 'id'> & { id?: string }

export const messagesRepo = {
  async create(input: CreateMessageInput): Promise<Message> {
    const id = input.id ?? crypto.randomUUID()
    const msg: Message = { ...input, id }
    await db.messages.add(msg)
    return msg
  },

  async listByConversation(conversationId: string): Promise<Message[]> {
    return db.messages
      .where('conversationId')
      .equals(conversationId)
      .sortBy('timestamp')
  },

  async deleteByConversation(conversationId: string): Promise<number> {
    return db.messages.where('conversationId').equals(conversationId).delete()
  },
}

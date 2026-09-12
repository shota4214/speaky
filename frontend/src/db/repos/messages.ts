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

  /**
   * 既存メッセージを部分更新する(enrich の後追い反映用)。
   *
   * ⚠️ `Table.update()` は使わない。conversationsRepo.update と同じ理由で、
   * Dexie 4 の `Table.update()` はパッチ内部の検査で稀に
   * 'Cannot convert undefined or null to object' を投げるため、
   * 確実な get + put パターンで実装する。
   *
   * 保存するフィールドの形は create と同じ(reactive Proxy を混ぜない)。
   * **ストリーミング固有の状態は一切保存しない** — 保存形は現行リリースと同一に保つ。
   */
  async update(id: string, patch: Partial<Omit<Message, 'id'>>): Promise<Message | undefined> {
    const existing = await db.messages.get(id)
    if (!existing) return undefined

    /**
     * patch にキーが無い(= 触らない)と null(= 消す)を区別する。
     * `patch.x ?? existing.x` にすると null を渡しても既存値に戻ってしまい、
     * **フィールドを消せない**(誤った添削を消す、といった操作ができない)。
     */
    const has = (key: keyof Omit<Message, 'id'>): boolean =>
      key in patch && patch[key] !== undefined

    const merged: Message = {
      ...existing,
      ...patch,
      id: existing.id,
      feedback: has('feedback')
        ? patch.feedback
          ? {
              userSaid: patch.feedback.userSaid,
              corrected: patch.feedback.corrected,
              explanation: patch.feedback.explanation,
            }
          : null
        : existing.feedback,
      vocabulary: has('vocabulary')
        ? (patch.vocabulary?.map((v) => ({
            word: v.word,
            meaning: v.meaning,
            example: v.example,
          })) ?? null)
        : existing.vocabulary,
    }
    await db.messages.put(merged)
    return merged
  },

  async listByConversation(conversationId: string): Promise<Message[]> {
    return db.messages.where('conversationId').equals(conversationId).sortBy('timestamp')
  },

  async deleteByConversation(conversationId: string): Promise<number> {
    return db.messages.where('conversationId').equals(conversationId).delete()
  },
}

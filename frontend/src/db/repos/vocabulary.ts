import { db } from '../index'
import type { Vocabulary } from '../types'

export type CreateVocabularyInput = Omit<Vocabulary, 'id' | 'savedAt'> & {
  id?: string
  savedAt?: Date
}

export interface ListVocabularyOptions {
  search?: string
  orderBy?: 'savedAt' | 'word'
  direction?: 'asc' | 'desc'
}

export const vocabularyRepo = {
  async create(input: CreateVocabularyInput): Promise<Vocabulary> {
    const v: Vocabulary = {
      id: input.id ?? crypto.randomUUID(),
      word: input.word,
      meaning: input.meaning,
      example: input.example,
      partOfSpeech: input.partOfSpeech,
      savedAt: input.savedAt ?? new Date(),
    }
    await db.vocabulary.add(v)
    return v
  },

  async get(id: string): Promise<Vocabulary | undefined> {
    return db.vocabulary.get(id)
  },

  async list(options: ListVocabularyOptions = {}): Promise<Vocabulary[]> {
    const { search, orderBy = 'savedAt', direction = 'desc' } = options
    let collection = db.vocabulary.orderBy(orderBy)
    if (direction === 'desc') {
      collection = collection.reverse()
    }
    if (search) {
      const lower = search.toLowerCase()
      collection = collection.filter(
        (v) =>
          v.word.toLowerCase().includes(lower) ||
          v.meaning.toLowerCase().includes(lower),
      )
    }
    return collection.toArray()
  },

  async delete(id: string): Promise<void> {
    await db.vocabulary.delete(id)
  },

  async deleteMany(ids: string[]): Promise<void> {
    await db.vocabulary.bulkDelete(ids)
  },
}

import { db } from '../index'
import type { CustomTopic } from '../types'

export type CreateCustomTopicInput = Omit<CustomTopic, 'id' | 'createdAt'> & {
  id?: string
  createdAt?: Date
}

export const customTopicsRepo = {
  async create(input: CreateCustomTopicInput): Promise<CustomTopic> {
    const topic: CustomTopic = {
      id: input.id ?? crypto.randomUUID(),
      name: input.name,
      description: input.description,
      createdAt: input.createdAt ?? new Date(),
    }
    await db.customTopics.add(topic)
    return topic
  },

  async list(): Promise<CustomTopic[]> {
    return db.customTopics.orderBy('createdAt').reverse().toArray()
  },

  async get(id: string): Promise<CustomTopic | undefined> {
    return db.customTopics.get(id)
  },

  async delete(id: string): Promise<void> {
    await db.customTopics.delete(id)
  },
}

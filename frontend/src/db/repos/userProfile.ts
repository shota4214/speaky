import { db } from '../index'
import type { UserFact, UserProfile } from '../types'

const PROFILE_ID = 'main' as const

export const userProfileRepo = {
  async getOrCreate(): Promise<UserProfile> {
    const existing = await db.userProfile.get(PROFILE_ID)
    if (existing) return existing
    const fresh: UserProfile = { id: PROFILE_ID, name: null, facts: [] }
    await db.userProfile.put(fresh)
    return fresh
  },

  async update(patch: Partial<Omit<UserProfile, 'id'>>): Promise<UserProfile> {
    const current = await this.getOrCreate()
    const updated: UserProfile = {
      ...current,
      ...patch,
      id: PROFILE_ID,
    }
    await db.userProfile.put(updated)
    return updated
  },

  async addFact(
    input: Omit<UserFact, 'id' | 'learnedAt'> & {
      id?: string
      learnedAt?: Date
    },
  ): Promise<UserFact> {
    const current = await this.getOrCreate()
    const newFact: UserFact = {
      id: input.id ?? crypto.randomUUID(),
      fact: input.fact,
      learnedAt: input.learnedAt ?? new Date(),
      learnedFromConversationId: input.learnedFromConversationId,
    }
    await db.userProfile.put({
      ...current,
      facts: [...current.facts, newFact],
    })
    return newFact
  },

  async removeFact(factId: string): Promise<void> {
    const current = await this.getOrCreate()
    await db.userProfile.put({
      ...current,
      facts: current.facts.filter((f) => f.id !== factId),
    })
  },

  async updateFact(
    factId: string,
    patch: Partial<Pick<UserFact, 'fact'>>,
  ): Promise<void> {
    const current = await this.getOrCreate()
    await db.userProfile.put({
      ...current,
      facts: current.facts.map((f) =>
        f.id === factId ? { ...f, ...patch } : f,
      ),
    })
  },
}

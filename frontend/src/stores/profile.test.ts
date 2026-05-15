import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/index'
import { useProfileStore } from './profile'

describe('useProfileStore', () => {
  beforeEach(async () => {
    if (db.isOpen()) db.close()
    await db.delete()
    await db.open()
    setActivePinia(createPinia())
  })

  it('starts unloaded', () => {
    const s = useProfileStore()
    expect(s.isLoaded).toBe(false)
    expect(s.profile).toBeNull()
  })

  it('load() fetches or creates the main profile', async () => {
    const s = useProfileStore()
    await s.load()
    expect(s.isLoaded).toBe(true)
    expect(s.profile?.id).toBe('main')
    expect(s.name).toBeNull()
    expect(s.facts).toEqual([])
  })

  it('setName updates and persists', async () => {
    const s = useProfileStore()
    await s.load()
    await s.setName('Shota')
    expect(s.name).toBe('Shota')

    setActivePinia(createPinia())
    const s2 = useProfileStore()
    await s2.load()
    expect(s2.name).toBe('Shota')
  })

  it('addFact appends a fact', async () => {
    const s = useProfileStore()
    await s.load()
    await s.addFact({
      fact: 'Web開発者として働いている',
      learnedFromConversationId: 'conv-1',
    })
    expect(s.facts).toHaveLength(1)
    expect(s.facts[0]!.fact).toBe('Web開発者として働いている')
  })

  it('removeFact deletes a single fact by id', async () => {
    const s = useProfileStore()
    await s.load()
    await s.addFact({ fact: 'A', learnedFromConversationId: null })
    await s.addFact({ fact: 'B', learnedFromConversationId: null })
    const factA = s.facts.find((f) => f.fact === 'A')!
    await s.removeFact(factA.id)
    expect(s.facts.map((f) => f.fact)).toEqual(['B'])
  })

  it('updateFact edits content', async () => {
    const s = useProfileStore()
    await s.load()
    await s.addFact({ fact: 'コーヒー好き', learnedFromConversationId: null })
    const fact = s.facts[0]!
    await s.updateFact(fact.id, '紅茶好き')
    expect(s.facts[0]!.fact).toBe('紅茶好き')
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../index'
import { userProfileRepo } from './userProfile'

describe('userProfileRepo', () => {
  beforeEach(async () => {
    if (db.isOpen()) db.close()
    await db.delete()
    await db.open()
  })

  it('getOrCreate returns empty profile initially', async () => {
    const p = await userProfileRepo.getOrCreate()
    expect(p.id).toBe('main')
    expect(p.name).toBeNull()
    expect(p.facts).toEqual([])
  })

  it('getOrCreate returns same row on second call', async () => {
    const a = await userProfileRepo.getOrCreate()
    const b = await userProfileRepo.getOrCreate()
    expect(b.id).toBe(a.id)
  })

  it('update changes name', async () => {
    const updated = await userProfileRepo.update({ name: 'Shota' })
    expect(updated.name).toBe('Shota')
    const fetched = await userProfileRepo.getOrCreate()
    expect(fetched.name).toBe('Shota')
  })

  it('addFact appends with auto id and learnedAt', async () => {
    const fact = await userProfileRepo.addFact({
      fact: 'Web開発者として働いている',
      learnedFromConversationId: 'conv-1',
    })
    expect(fact.id).toBeTruthy()
    expect(fact.learnedAt).toBeInstanceOf(Date)

    const p = await userProfileRepo.getOrCreate()
    expect(p.facts).toHaveLength(1)
    expect(p.facts[0]!.fact).toBe('Web開発者として働いている')
  })

  it('removeFact removes a single fact', async () => {
    const a = await userProfileRepo.addFact({
      fact: 'コーヒーが好き',
      learnedFromConversationId: null,
    })
    await userProfileRepo.addFact({
      fact: '京都に住んでいる',
      learnedFromConversationId: null,
    })
    await userProfileRepo.removeFact(a.id)
    const p = await userProfileRepo.getOrCreate()
    expect(p.facts).toHaveLength(1)
    expect(p.facts[0]!.fact).toBe('京都に住んでいる')
  })

  it('updateFact edits content but keeps id and learnedAt', async () => {
    const fact = await userProfileRepo.addFact({
      fact: 'コーヒーが好き',
      learnedFromConversationId: null,
    })
    await userProfileRepo.updateFact(fact.id, { fact: '紅茶が好き' })
    const p = await userProfileRepo.getOrCreate()
    expect(p.facts[0]!.fact).toBe('紅茶が好き')
    expect(p.facts[0]!.id).toBe(fact.id)
  })
})

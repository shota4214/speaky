import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../index'
import { customTopicsRepo } from './customTopics'

describe('customTopicsRepo', () => {
  beforeEach(async () => {
    if (db.isOpen()) db.close()
    await db.delete()
    await db.open()
  })

  it('creates with auto id and createdAt', async () => {
    const t = await customTopicsRepo.create({
      name: '医療英語',
      description: '医療現場で使う表現',
    })
    expect(t.id).toBeTruthy()
    expect(t.createdAt).toBeInstanceOf(Date)
  })

  it('lists newest-first', async () => {
    await customTopicsRepo.create({
      name: '医療英語',
      description: '医療現場で使う表現',
      createdAt: new Date('2026-05-14T10:00:00Z'),
    })
    await customTopicsRepo.create({
      name: '法律英語',
      description: '契約書系',
      createdAt: new Date('2026-05-15T10:00:00Z'),
    })
    const list = await customTopicsRepo.list()
    expect(list.map((t) => t.name)).toEqual(['法律英語', '医療英語'])
  })

  it('deletes by id', async () => {
    const t = await customTopicsRepo.create({
      name: 'temp',
      description: '',
    })
    await customTopicsRepo.delete(t.id)
    expect(await customTopicsRepo.get(t.id)).toBeUndefined()
  })
})

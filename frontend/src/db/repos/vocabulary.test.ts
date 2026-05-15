import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../index'
import { vocabularyRepo } from './vocabulary'

describe('vocabularyRepo', () => {
  beforeEach(async () => {
    if (db.isOpen()) db.close()
    await db.delete()
    await db.open()
  })

  it('creates with auto id and savedAt', async () => {
    const v = await vocabularyRepo.create({
      word: 'appreciate',
      meaning: '感謝する',
      example: 'I really appreciate your help.',
      partOfSpeech: 'verb',
    })
    expect(v.id).toBeTruthy()
    expect(v.savedAt).toBeInstanceOf(Date)
  })

  it('lists newest-first by default', async () => {
    await vocabularyRepo.create({
      word: 'alpha',
      meaning: 'first',
      example: null,
      partOfSpeech: 'noun',
      savedAt: new Date('2026-05-14T10:00:00Z'),
    })
    await vocabularyRepo.create({
      word: 'beta',
      meaning: 'second',
      example: null,
      partOfSpeech: 'noun',
      savedAt: new Date('2026-05-15T10:00:00Z'),
    })
    const list = await vocabularyRepo.list()
    expect(list.map((v) => v.word)).toEqual(['beta', 'alpha'])
  })

  it('searches by word', async () => {
    await vocabularyRepo.create({
      word: 'appreciate',
      meaning: '感謝する',
      example: null,
      partOfSpeech: 'verb',
    })
    await vocabularyRepo.create({
      word: 'memorable',
      meaning: '思い出に残る',
      example: null,
      partOfSpeech: 'adjective',
    })
    const byWord = await vocabularyRepo.list({ search: 'appr' })
    expect(byWord.map((v) => v.word)).toEqual(['appreciate'])
  })

  it('searches by meaning', async () => {
    await vocabularyRepo.create({
      word: 'memorable',
      meaning: '思い出に残る',
      example: null,
      partOfSpeech: 'adjective',
    })
    const byMeaning = await vocabularyRepo.list({ search: '思い' })
    expect(byMeaning.map((v) => v.word)).toEqual(['memorable'])
  })

  it('sorts alphabetically when orderBy=word', async () => {
    await vocabularyRepo.create({
      word: 'beta',
      meaning: 'b',
      example: null,
      partOfSpeech: null,
    })
    await vocabularyRepo.create({
      word: 'alpha',
      meaning: 'a',
      example: null,
      partOfSpeech: null,
    })
    const asc = await vocabularyRepo.list({
      orderBy: 'word',
      direction: 'asc',
    })
    expect(asc.map((v) => v.word)).toEqual(['alpha', 'beta'])
  })

  it('deletes by id', async () => {
    const v = await vocabularyRepo.create({
      word: 'temp',
      meaning: '一時',
      example: null,
      partOfSpeech: null,
    })
    await vocabularyRepo.delete(v.id)
    expect(await vocabularyRepo.get(v.id)).toBeUndefined()
  })

  it('deleteMany removes multiple', async () => {
    const a = await vocabularyRepo.create({
      word: 'a',
      meaning: '1',
      example: null,
      partOfSpeech: null,
    })
    const b = await vocabularyRepo.create({
      word: 'b',
      meaning: '2',
      example: null,
      partOfSpeech: null,
    })
    const c = await vocabularyRepo.create({
      word: 'c',
      meaning: '3',
      example: null,
      partOfSpeech: null,
    })
    await vocabularyRepo.deleteMany([a.id, b.id])
    const remaining = await vocabularyRepo.list()
    expect(remaining.map((v) => v.id)).toEqual([c.id])
  })
})

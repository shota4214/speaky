import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useVocabularyStore } from './vocabulary'

describe('useVocabularyStore', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('starts empty', () => {
    const s = useVocabularyStore()
    expect(s.selectedIds).toEqual([])
    expect(s.count).toBe(0)
    expect(s.canAddMore).toBe(true)
  })

  it('toggle adds an id and returns true', () => {
    const s = useVocabularyStore()
    expect(s.toggle('v1')).toBe(true)
    expect(s.selectedIds).toEqual(['v1'])
    expect(s.isSelected('v1')).toBe(true)
  })

  it('toggle removes an existing id and returns false', () => {
    const s = useVocabularyStore()
    s.toggle('v1')
    expect(s.toggle('v1')).toBe(false)
    expect(s.selectedIds).toEqual([])
    expect(s.isSelected('v1')).toBe(false)
  })

  it('refuses to add more than MAX_SELECTED', () => {
    const s = useVocabularyStore()
    s.toggle('a')
    s.toggle('b')
    s.toggle('c')
    expect(s.count).toBe(3)
    expect(s.canAddMore).toBe(false)
    expect(s.toggle('d')).toBe(false)
    expect(s.selectedIds).toEqual(['a', 'b', 'c'])
  })

  it('clear empties the selection', () => {
    const s = useVocabularyStore()
    s.toggle('a')
    s.toggle('b')
    s.clear()
    expect(s.selectedIds).toEqual([])
  })

  it('persists across store re-init via localStorage', () => {
    const s1 = useVocabularyStore()
    s1.toggle('persist-1')
    s1.toggle('persist-2')

    setActivePinia(createPinia())
    const s2 = useVocabularyStore()
    expect(s2.selectedIds).toEqual(['persist-1', 'persist-2'])
  })
})

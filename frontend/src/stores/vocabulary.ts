import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

const MAX_SELECTED = 3
const STORAGE_KEY = 'speaky:selectedVocab'

function loadInitial(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : []
  } catch {
    return []
  }
}

export const useVocabularyStore = defineStore('vocabulary', () => {
  const selectedIds = ref<string[]>(loadInitial())

  const count = computed(() => selectedIds.value.length)
  const canAddMore = computed(() => selectedIds.value.length < MAX_SELECTED)

  function isSelected(id: string): boolean {
    return selectedIds.value.includes(id)
  }

  function toggle(id: string): boolean {
    if (selectedIds.value.includes(id)) {
      selectedIds.value = selectedIds.value.filter((x) => x !== id)
      persist()
      return false
    }
    if (selectedIds.value.length >= MAX_SELECTED) return false
    selectedIds.value = [...selectedIds.value, id]
    persist()
    return true
  }

  function clear() {
    selectedIds.value = []
    persist()
  }

  function persist() {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedIds.value))
    } catch {
      // ignore
    }
  }

  return {
    selectedIds,
    count,
    canAddMore,
    isSelected,
    toggle,
    clear,
    MAX_SELECTED,
  }
})

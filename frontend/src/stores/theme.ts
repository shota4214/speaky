import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type ThemeId = 'mint' | 'lavender' | 'peach'

export interface ThemeInfo {
  id: ThemeId
  name: string
  description: string
}

const STORAGE_KEY = 'speaky:theme'

const THEMES: ThemeInfo[] = [
  { id: 'mint', name: 'Mint Garden', description: '清涼感・健康的・清潔感' },
  { id: 'lavender', name: 'Lavender Dusk', description: '落ち着き・上品・夜の集中' },
  { id: 'peach', name: 'Peach Sunrise', description: '暖かみ・朝の活力・フレンドリー' },
]

function loadInitial(): ThemeId {
  if (typeof localStorage === 'undefined') return 'mint'
  const v = localStorage.getItem(STORAGE_KEY)
  if (v === 'mint' || v === 'lavender' || v === 'peach') return v
  return 'mint'
}

export const useThemeStore = defineStore('theme', () => {
  const current = ref<ThemeId>(loadInitial())
  const themes = ref<ThemeInfo[]>(THEMES)

  watch(
    current,
    (id) => {
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-theme', id)
      }
      try {
        localStorage.setItem(STORAGE_KEY, id)
      } catch {
        // localStorage not available
      }
    },
    { immediate: true },
  )

  function set(id: ThemeId) {
    current.value = id
  }

  return {
    current,
    themes,
    set,
  }
})
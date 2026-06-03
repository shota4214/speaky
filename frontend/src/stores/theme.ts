import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useSettingsStore } from './settings'
import type { DarkModePref } from '../storage/settings'

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

/** OS のダーク設定を購読するための MediaQueryList(存在すれば) */
function getDarkMediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null
  }
  return window.matchMedia('(prefers-color-scheme: dark)')
}

export const useThemeStore = defineStore('theme', () => {
  const current = ref<ThemeId>(loadInitial())
  const themes = ref<ThemeInfo[]>(THEMES)
  const settings = useSettingsStore()

  // data-theme 属性 + localStorage 永続化
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

  // ----- ダークモード適用ロジック -----
  // html.dark クラスを付け外しする。themes.css / tailwind(darkMode:'class')
  // の両方がこのクラスに追従する。
  function applyDarkClass(enabled: boolean) {
    if (typeof document === 'undefined') return
    document.documentElement.classList.toggle('dark', enabled)
  }

  const mql = getDarkMediaQuery()

  /** settings.darkMode の値に応じて html.dark を反映する */
  function applyDarkMode(pref: DarkModePref) {
    if (pref === 'light') {
      applyDarkClass(false)
    } else if (pref === 'dark') {
      applyDarkClass(true)
    } else {
      // 'system': OS 設定に従う
      applyDarkClass(mql?.matches ?? false)
    }
  }

  // OS 設定変更時のハンドラ。'system' のときだけ追従させる。
  function handleOsChange(e: MediaQueryListEvent) {
    if (settings.settings.darkMode === 'system') {
      applyDarkClass(e.matches)
    }
  }
  if (mql) {
    mql.addEventListener('change', handleOsChange)
  }

  // settings.darkMode が変わったら即反映(ドロップダウン操作・リロード復元の両方をカバー)
  watch(
    () => settings.settings.darkMode,
    (pref) => {
      applyDarkMode(pref)
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

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import {
  DEFAULT_SETTINGS,
  loadSettings,
  resetSettings as resetStorage,
  saveSettings,
  type AppSettings,
} from '../storage/settings'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>(loadSettings())

  watch(
    settings,
    (next) => {
      saveSettings(next)
    },
    { deep: true },
  )

  function update(patch: Partial<AppSettings>) {
    settings.value = {
      ...settings.value,
      ...patch,
      aiCharacter: {
        ...settings.value.aiCharacter,
        ...(patch.aiCharacter ?? {}),
      },
    }
  }

  function reset() {
    resetStorage()
    settings.value = { ...DEFAULT_SETTINGS }
  }

  return { settings, update, reset }
})

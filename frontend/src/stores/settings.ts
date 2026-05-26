import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import {
  DEFAULT_SETTINGS,
  loadSettings,
  resetSettings as resetStorage,
  saveSettings,
  type AppSettings,
} from '../storage/settings'

/**
 * update() に渡すパッチ型。
 * aiCharacter は深いネスト構造なので、内側だけ部分指定できるよう Partial にする。
 * (呼び出し側で voiceName / personality を毎回指定しなくて済むようにする)
 */
export type SettingsPatch = Partial<Omit<AppSettings, 'aiCharacter'>> & {
  aiCharacter?: Partial<AppSettings['aiCharacter']>
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>(loadSettings())

  watch(
    settings,
    (next) => {
      saveSettings(next)
    },
    { deep: true },
  )

  function update(patch: SettingsPatch) {
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

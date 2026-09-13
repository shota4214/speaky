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
    const next: AppSettings = {
      ...settings.value,
      ...patch,
      aiCharacter: {
        ...settings.value.aiCharacter,
        ...(patch.aiCharacter ?? {}),
      },
    }
    // モデルを明示的に選んだ(設定画面 / オンボーディング)なら、旧既定 LLM からの
    // 移行は終わりにする(utils/bundled-llm-migration.ts)。
    // - 'pending': 確認が後から終わって、選んだばかりのモデルを同梱モデルで上書きしないため
    // - 'notice' : 「同梱モデルに切り替えました」という通知が、別のモデルを選んだ後も
    //              出続けて嘘にならないため
    if (
      patch.llmModel !== undefined &&
      patch.bundledLlmMigration === undefined &&
      (next.bundledLlmMigration === 'pending' || next.bundledLlmMigration === 'notice')
    ) {
      next.bundledLlmMigration = 'idle'
    }
    settings.value = next
  }

  /** 同梱モデルへ切り替えた通知を閉じる(永続化され、二度と出ない)。 */
  function dismissBundledLlmNotice() {
    if (settings.value.bundledLlmMigration !== 'notice') return
    update({ bundledLlmMigration: 'idle' })
  }

  function reset() {
    resetStorage()
    settings.value = { ...DEFAULT_SETTINGS }
  }

  return { settings, update, reset, dismissBundledLlmNotice }
})

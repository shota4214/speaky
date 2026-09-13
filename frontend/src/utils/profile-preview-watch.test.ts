import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OllamaModelsResponse } from '../services/api'
import { BUNDLED_LLM_MODEL, LEGACY_DEFAULT_LLM_MODEL } from '../storage/settings'
import { useSettingsStore } from '../stores/settings'
import { runBundledLlmMigration } from './bundled-llm-migration'
import { watchProfilePreviewInputs } from './profile-preview-watch'

/**
 * 設定画面の「会話モード」バッジを問い合わせ直すきっかけ。
 * Settings.vue はこの関数をそのまま setup で呼んでいる(コンポーネントを
 * マウントする仕組みがテストに無いので、きっかけの部分だけをここで固定する)。
 */

function launchWithLegacyModel() {
  localStorage.setItem(
    'speaky:settings',
    JSON.stringify({
      llmModel: LEGACY_DEFAULT_LLM_MODEL,
      modelProfile: 'standard',
      schemaVersion: 3,
    }),
  )
  setActivePinia(createPinia())
  return useSettingsStore()
}

describe('watchProfilePreviewInputs', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('設定画面を開いている間に移行がモデルを切り替えたら、問い合わせ直す', async () => {
    const store = launchWithLegacyModel()
    const refresh = vi.fn()
    const stop = watchProfilePreviewInputs(store, refresh)

    const listing: OllamaModelsResponse = {
      models: [LEGACY_DEFAULT_LLM_MODEL, BUNDLED_LLM_MODEL].map((name) => ({
        name,
        sizeBytes: 1,
        sizeMB: 1,
        modifiedAt: '',
      })),
      defaultModel: BUNDLED_LLM_MODEL,
    }
    await expect(
      runBundledLlmMigration(store, { listOllamaModels: vi.fn().mockResolvedValue(listing) }),
    ).resolves.toBe('switched')
    await nextTick()

    // llmModel と modelProfile が同時に変わっても 1 回だけ
    expect(refresh).toHaveBeenCalledTimes(1)
    stop()
  })

  it('画面の操作でモデルや会話モードを変えても問い合わせ直す', async () => {
    const store = launchWithLegacyModel()
    const refresh = vi.fn()
    const stop = watchProfilePreviewInputs(store, refresh)

    store.update({ llmModel: 'gemma2:9b', modelProfile: 'auto' })
    await nextTick()
    expect(refresh).toHaveBeenCalledTimes(1)

    store.update({ modelProfile: 'small' })
    await nextTick()
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
  })

  // ストアは update() のたびに settings を丸ごと差し替える。無関係な変更で問い合わせない。
  it('モデル・会話モード以外の変更では問い合わせない', async () => {
    const store = launchWithLegacyModel()
    const refresh = vi.fn()
    const stop = watchProfilePreviewInputs(store, refresh)

    store.update({ silenceDurationMs: 3000 })
    store.update({ showJapanese: false })
    await nextTick()
    expect(refresh).not.toHaveBeenCalled()
    stop()
  })
})

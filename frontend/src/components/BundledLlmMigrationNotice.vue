<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSettingsStore } from '../stores/settings'
import { runBundledLlmMigration } from '../utils/bundled-llm-migration'
import { BUNDLED_LLM_NOTICE } from '../utils/bundled-llm-migration-notice'

/**
 * 旧既定 LLM → 同梱モデルの一度きりの移行を起動し、切り替えた場合だけ通知を出す。
 * 判定と状態遷移は utils/bundled-llm-migration.ts、文言は同ディレクトリの -notice.ts。
 * 通知は画面を塞がない(閉じるまで右上に残るだけで、操作はそのまま続けられる)。
 */

const settings = useSettingsStore()
const router = useRouter()

const visible = computed(() => settings.settings.bundledLlmMigration === 'notice')

/** 起動直後の IndexedDB 移行等とぶつからないよう少し遅らせる。失敗しても次回起動で再試行。 */
const MIGRATION_DELAY_MS = 1500
let timer: ReturnType<typeof setTimeout> | null = null

function isOnboarded(): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' && localStorage.getItem('speaky:onboarded') === 'true'
    )
  } catch {
    return false
  }
}

onMounted(() => {
  timer = setTimeout(() => {
    timer = null
    // オンボーディング中は何もしない(そこでモデルを選べば移行待ちは取り消される)。
    if (!isOnboarded()) return
    void runBundledLlmMigration(settings)
  }, MIGRATION_DELAY_MS)
})

onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer)
})

function dismiss() {
  settings.dismissBundledLlmNotice()
}

function openSettings() {
  settings.dismissBundledLlmNotice()
  void router.push('/settings')
}
</script>

<template>
  <Transition
    enter-active-class="transition duration-300 ease-out"
    enter-from-class="opacity-0 -translate-y-2"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition duration-200 ease-in"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 -translate-y-2"
  >
    <div
      v-if="visible"
      class="fixed right-4 top-4 z-40 max-w-sm rounded-2xl bg-surface p-4 shadow-glow-lg ring-1 ring-border"
      role="status"
      aria-live="polite"
    >
      <div class="flex items-start gap-3">
        <div class="text-2xl" aria-hidden="true">🔄</div>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold text-text">{{ BUNDLED_LLM_NOTICE.title }}</div>
          <p class="mt-1 text-xs text-text-muted">{{ BUNDLED_LLM_NOTICE.reason }}</p>
          <p class="mt-1 text-xs text-text">{{ BUNDLED_LLM_NOTICE.changes }}</p>
          <p class="mt-1 text-xs text-text-muted">{{ BUNDLED_LLM_NOTICE.howToRevert }}</p>
        </div>
      </div>

      <div class="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          class="rounded-full bg-primary-light/40 px-3 py-1.5 text-xs text-text hover:bg-primary-light/60"
          @click="openSettings"
        >
          {{ BUNDLED_LLM_NOTICE.openSettings }}
        </button>
        <button
          type="button"
          class="rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
          @click="dismiss"
        >
          {{ BUNDLED_LLM_NOTICE.dismiss }}
        </button>
      </div>
    </div>
  </Transition>
</template>

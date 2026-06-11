<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  checkForUpdate,
  getDismissedVersion,
  getSkippedVersion,
  isForceCheckRequested,
  setDismissedVersion,
  setSkippedVersion,
  type UpdateInfo,
} from '../services/update-checker'

const info = ref<UpdateInfo | null>(null)

let timer: ReturnType<typeof setTimeout> | null = null
const controller = new AbortController()

onMounted(() => {
  // 起動直後の重い処理(runtime sync, IndexedDB マイグレーション等)とぶつからないよう、
  // 軽く遅延させて裏で実行。失敗してもサイレントに何も出ない。
  timer = setTimeout(async () => {
    try {
      const result = await checkForUpdate({
        currentVersion: __APP_VERSION__,
        skippedVersion: getSkippedVersion(),
        dismissedVersion: getDismissedVersion(),
        signal: controller.signal,
        force: isForceCheckRequested(),
      })
      if (result) info.value = result
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        console.warn('[update] check failed:', e)
      }
    }
  }, 2000)
})

onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer)
  controller.abort()
})

function openDownload() {
  if (!info.value) return
  // Electron main の setWindowOpenHandler が外部リンクを既定ブラウザで開く。
  window.open(info.value.downloadUrl, '_blank', 'noopener')
}

function openReleaseNotes() {
  if (!info.value?.releaseNotesUrl) return
  window.open(info.value.releaseNotesUrl, '_blank', 'noopener')
}

function dismiss() {
  if (!info.value) return
  // 同セッション中の再表示を防ぐ。次回アプリ起動時にはまた通知される。
  setDismissedVersion(info.value.version)
  info.value = null
}

function skip() {
  if (!info.value) return
  setSkippedVersion(info.value.version)
  info.value = null
}
</script>

<template>
  <Transition
    enter-active-class="transition duration-300 ease-out"
    enter-from-class="opacity-0 translate-y-2"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition duration-200 ease-in"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 translate-y-2"
  >
    <div
      v-if="info"
      class="fixed bottom-4 right-4 z-40 max-w-sm rounded-2xl bg-surface p-4 shadow-glow-lg ring-1 ring-border"
      role="status"
      aria-live="polite"
    >
      <div class="flex items-start gap-3">
        <div class="text-2xl" aria-hidden="true">🎉</div>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold text-text">
            新バージョン {{ info.version }} が利用可能です
          </div>
          <p v-if="info.releasedAt" class="mt-0.5 text-[10px] text-text-muted">
            {{ info.releasedAt }} リリース
          </p>
          <p v-if="info.summary" class="mt-1 line-clamp-3 text-xs text-text-muted">
            {{ info.summary }}
          </p>
        </div>
      </div>

      <div class="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          class="rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
          @click="openDownload"
        >
          ダウンロード
        </button>
        <button
          v-if="info.releaseNotesUrl"
          type="button"
          class="rounded-full bg-primary-light/40 px-3 py-1.5 text-xs text-text hover:bg-primary-light/60"
          @click="openReleaseNotes"
        >
          リリースノート
        </button>
        <button
          type="button"
          class="rounded-full px-3 py-1.5 text-xs text-text-muted hover:text-text"
          @click="dismiss"
        >
          あとで
        </button>
        <button
          type="button"
          class="rounded-full px-3 py-1.5 text-xs text-text-muted hover:text-text"
          @click="skip"
        >
          このバージョンをスキップ
        </button>
      </div>
    </div>
  </Transition>
</template>

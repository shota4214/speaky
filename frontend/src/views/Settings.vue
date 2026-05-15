<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import { useSettingsStore } from '../stores/settings'
import { useThemeStore } from '../stores/theme'
import {
  deleteAllData,
  downloadBackup,
  exportAllData,
  importAllData,
  type BackupV1,
} from '../utils/data-portability'

const router = useRouter()
const settings = useSettingsStore()
const theme = useThemeStore()

const importMode = ref<'merge' | 'replace'>('merge')
const importing = ref(false)
const exporting = ref(false)
const deleting = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

function updateSilence(e: Event) {
  const value = Number((e.target as HTMLInputElement).value)
  settings.update({ silenceDurationMs: value })
}
function updateTtsRateLink(e: Event) {
  settings.update({
    ttsRateConnectedToLevel: (e.target as HTMLInputElement).checked,
  })
}
function updateWhisper(e: Event) {
  settings.update({
    whisperModel: (e.target as HTMLSelectElement).value as
      | 'small'
      | 'medium'
      | 'large-v3',
  })
}
function updateLlm(e: Event) {
  settings.update({ llmModel: (e.target as HTMLSelectElement).value })
}
function updateDarkMode(e: Event) {
  settings.update({
    darkMode: (e.target as HTMLSelectElement).value as
      | 'system'
      | 'light'
      | 'dark',
  })
}

async function handleExport() {
  exporting.value = true
  try {
    const backup = await exportAllData()
    downloadBackup(backup)
  } finally {
    exporting.value = false
  }
}

function handleImportClick() {
  fileInput.value?.click()
}

async function handleFileSelected(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  importing.value = true
  try {
    const text = await file.text()
    const backup = JSON.parse(text) as BackupV1
    const confirmMsg =
      importMode.value === 'replace'
        ? '⚠ 全データを削除してインポートします。よろしいですか?'
        : '既存データに追加でインポートします。よろしいですか?'
    if (!confirm(confirmMsg)) {
      target.value = ''
      return
    }
    const { imported } = await importAllData(backup, importMode.value)
    alert(`${imported} 件のデータをインポートしました。ページを再読み込みします。`)
    location.reload()
  } catch (err) {
    alert(`インポートに失敗しました: ${(err as Error).message}`)
  } finally {
    importing.value = false
    target.value = ''
  }
}

async function handleDeleteAll() {
  if (!confirm('全データを削除します。元に戻せません。よろしいですか?'))
    return
  if (
    !confirm(
      '本当によろしいですか?会話履歴・復習リスト・プロフィール全てが消えます。',
    )
  )
    return
  deleting.value = true
  try {
    await deleteAllData()
    settings.reset()
    alert('全データを削除しました。')
    await router.push('/')
    location.reload()
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-2xl px-6 py-8">
    <h1 class="text-3xl font-bold">設定</h1>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">🎤 音声</div>
      <div class="mt-4 space-y-4">
        <div>
          <label class="block text-sm">
            無音自動送信の間隔:
            <strong>{{
              (settings.settings.silenceDurationMs / 1000).toFixed(1)
            }}秒</strong>
          </label>
          <input
            :value="settings.settings.silenceDurationMs"
            type="range"
            min="1000"
            max="5000"
            step="100"
            class="mt-2 w-full accent-primary"
            @input="updateSilence"
          />
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            class="h-4 w-4 rounded accent-primary"
            :checked="settings.settings.ttsRateConnectedToLevel"
            @change="updateTtsRateLink"
          />
          AIの話速をレベルと連動させる
        </label>
      </div>
    </BaseCard>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">🧠 モデル</div>
      <div class="mt-4 space-y-3">
        <div>
          <label class="block text-sm">Whisper</label>
          <select
            :value="settings.settings.whisperModel"
            class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            @change="updateWhisper"
          >
            <option value="small">small (~500MB)</option>
            <option value="medium">medium (~1.5GB)</option>
            <option value="large-v3">large-v3 (~3GB)</option>
          </select>
          <p class="mt-1 text-xs text-text-muted">
            ※ 切り替えは backend 環境変数(OLLAMA_MODEL系)で行ってください
          </p>
        </div>
        <div>
          <label class="block text-sm">LLM</label>
          <select
            :value="settings.settings.llmModel"
            class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            @change="updateLlm"
          >
            <option value="llama3.2:3b">軽量 (Llama 3.2 3B)</option>
            <option value="gemma2:9b">推奨 (Gemma 2 9B)</option>
            <option value="qwen2.5:14b">高精度 (Qwen 2.5 14B)</option>
          </select>
          <p class="mt-1 text-xs text-text-muted">
            ※ 切り替え時は <code>ollama pull</code> で取得後、backend を再起動
          </p>
        </div>
      </div>
    </BaseCard>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">🎨 表示</div>
      <div class="mt-4 space-y-4">
        <div>
          <label class="block text-sm">ダークモード</label>
          <select
            :value="settings.settings.darkMode"
            class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            @change="updateDarkMode"
          >
            <option value="system">システム連動</option>
            <option value="light">ライト</option>
            <option value="dark">ダーク</option>
          </select>
          <p class="mt-1 text-xs text-text-muted">
            ※ 現状はシステム連動のみ実装。明示切替は Phase 3 残作業
          </p>
        </div>
        <div>
          <label class="block text-sm">テーマ</label>
          <div class="mt-2 flex flex-wrap gap-2">
            <BaseButton
              v-for="t in theme.themes"
              :key="t.id"
              :variant="theme.current === t.id ? 'primary' : 'secondary'"
              size="sm"
              @click="theme.set(t.id)"
            >
              {{ t.name }}
            </BaseButton>
          </div>
        </div>
      </div>
    </BaseCard>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">💾 データ</div>
      <div class="mt-4 space-y-3">
        <p class="text-sm text-text-muted">
          会話履歴の保存期間: 30日(変更不可)
        </p>
        <div class="flex flex-wrap gap-2">
          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="exporting"
            @click="handleExport"
          >
            {{ exporting ? 'エクスポート中...' : '📤 データをエクスポート' }}
          </BaseButton>
          <BaseButton
            variant="secondary"
            size="sm"
            :disabled="importing"
            @click="handleImportClick"
          >
            {{ importing ? 'インポート中...' : '📥 データをインポート' }}
          </BaseButton>
          <input
            ref="fileInput"
            type="file"
            accept="application/json"
            class="hidden"
            @change="handleFileSelected"
          />
        </div>
        <div class="text-xs">
          インポートモード:
          <label class="ml-2 inline-flex items-center gap-1">
            <input v-model="importMode" type="radio" value="merge" />
            マージ(既存に追加)
          </label>
          <label class="ml-2 inline-flex items-center gap-1">
            <input v-model="importMode" type="radio" value="replace" />
            全置換
          </label>
        </div>

        <div class="mt-4 border-t border-border pt-4">
          <BaseButton
            variant="danger"
            size="sm"
            :disabled="deleting"
            @click="handleDeleteAll"
          >
            ⚠ 全データを削除
          </BaseButton>
        </div>
      </div>
    </BaseCard>
  </div>
</template>

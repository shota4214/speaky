<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import {
  buildWhisperCpp,
  deleteOllamaModel,
  deleteWhisperModel,
  downloadWhisperModelStream,
  getWhisperCppStatus,
  listOllamaModels,
  listWhisperModels,
  pullOllamaModel,
  type InstalledModel,
} from '../services/api'
import type { WhisperModel } from '../storage/settings'
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

const ollamaModels = ref<InstalledModel[]>([])
const ollamaDefault = ref<string>('')
const ollamaLoadError = ref<string>('')
const whisperModels = ref<InstalledModel[]>([])
const whisperLoadError = ref<string>('')
const modelsLoading = ref(false)

const whisperCppBuilt = ref(false)

async function loadInstalledModels() {
  modelsLoading.value = true
  ollamaLoadError.value = ''
  whisperLoadError.value = ''
  try {
    const o = await listOllamaModels()
    ollamaModels.value = o.models
    ollamaDefault.value = o.defaultModel
  } catch (e) {
    ollamaLoadError.value = (e as Error).message
    ollamaModels.value = []
  }
  try {
    const w = await listWhisperModels()
    whisperModels.value = w.models
  } catch (e) {
    whisperLoadError.value = (e as Error).message
    whisperModels.value = []
  }
  try {
    const s = await getWhisperCppStatus()
    whisperCppBuilt.value = s.built
  } catch {
    whisperCppBuilt.value = false
  }
  modelsLoading.value = false
}

// LLM pull
const newLlmName = ref('llama3.2:3b')
const llmPulling = ref(false)
const llmPullProgress = ref(0)
const llmPullStatus = ref('')
const llmPullError = ref('')

const llmPresets = [
  { value: 'llama3.2:3b', label: 'Llama 3.2 3B (~2GB)' },
  { value: 'gemma2:9b', label: 'Gemma 2 9B (~5.5GB)' },
  { value: 'qwen2.5:14b', label: 'Qwen 2.5 14B (~9GB)' },
]

async function handlePullLlm() {
  if (llmPulling.value) return
  llmPulling.value = true
  llmPullProgress.value = 0
  llmPullStatus.value = 'starting...'
  llmPullError.value = ''
  try {
    await pullOllamaModel(newLlmName.value, (p) => {
      if (p.status) llmPullStatus.value = p.status
      if (p.total && p.completed) {
        llmPullProgress.value = Math.round((p.completed / p.total) * 100)
      }
    })
    llmPullStatus.value = 'done'
    await loadInstalledModels()
  } catch (e) {
    llmPullError.value = (e as Error).message
  } finally {
    llmPulling.value = false
  }
}

// Whisper download
const newWhisperName = ref('medium')
const whisperDownloading = ref(false)
const whisperProgress = ref(0)
const whisperStatus = ref('')
const whisperError = ref('')

const whisperPresets = [
  { value: 'tiny', label: 'tiny (~75MB)' },
  { value: 'base', label: 'base (~142MB)' },
  { value: 'small', label: 'small (~466MB)' },
  { value: 'medium', label: 'medium (~1.5GB)' },
  { value: 'large-v1', label: 'large-v1 (~2.9GB)' },
  { value: 'large-v3-turbo', label: 'large-v3-turbo (~1.5GB)' },
]

async function handleDownloadWhisper() {
  if (whisperDownloading.value) return
  whisperDownloading.value = true
  whisperProgress.value = 0
  whisperStatus.value = 'starting...'
  whisperError.value = ''
  try {
    await downloadWhisperModelStream(newWhisperName.value, (p) => {
      if (p.status) whisperStatus.value = p.status
      if (p.total && p.completed) {
        whisperProgress.value = Math.round((p.completed / p.total) * 100)
      }
    })
    whisperStatus.value = 'done'
    await loadInstalledModels()
  } catch (e) {
    whisperError.value = (e as Error).message
  } finally {
    whisperDownloading.value = false
  }
}

// Whisper.cpp build
const buildingWhisperCpp = ref(false)
const buildLog = ref<string>('')
const buildError = ref('')

async function handleBuildWhisperCpp() {
  if (buildingWhisperCpp.value) return
  if (!confirm('whisper.cpp をビルドします(cmake が必要、5〜10分かかります)。続行しますか?')) return
  buildingWhisperCpp.value = true
  buildLog.value = ''
  buildError.value = ''
  try {
    await buildWhisperCpp((p) => {
      if (p.command) buildLog.value += `\n$ ${p.command}\n`
      if (p.stdout) buildLog.value += p.stdout
      if (p.stderr) buildLog.value += p.stderr
      if (p.status === 'done') buildLog.value += `\n[${p.step} ✓]\n`
    })
    buildLog.value += '\n[ビルド完了 ✓]\n'
    await loadInstalledModels()
  } catch (e) {
    buildError.value = (e as Error).message
  } finally {
    buildingWhisperCpp.value = false
  }
}

async function handleDeleteOllama(name: string) {
  if (!confirm(`LLM モデル "${name}" を削除しますか?`)) return
  try {
    await deleteOllamaModel(name)
    await loadInstalledModels()
  } catch (e) {
    alert(`削除に失敗しました: ${(e as Error).message}`)
  }
}

async function handleDeleteWhisper(filename: string) {
  if (!confirm(`Whisper モデル "${filename}" を削除しますか?`)) return
  try {
    await deleteWhisperModel(filename)
    await loadInstalledModels()
  } catch (e) {
    alert(`削除に失敗しました: ${(e as Error).message}`)
  }
}

function formatSize(mb: number): string {
  if (mb < 1024) return `${mb} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

const totalSize = () => {
  const ollamaTotal = ollamaModels.value.reduce((a, m) => a + m.sizeMB, 0)
  const whisperTotal = whisperModels.value.reduce((a, m) => a + m.sizeMB, 0)
  return formatSize(ollamaTotal + whisperTotal)
}

onMounted(loadInstalledModels)

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
    whisperModel: (e.target as HTMLSelectElement).value as WhisperModel,
  })
}
function updateLlm(e: Event) {
  settings.update({ llmModel: (e.target as HTMLSelectElement).value })
}
function updateDarkMode(e: Event) {
  settings.update({
    darkMode: (e.target as HTMLSelectElement).value as 'system' | 'light' | 'dark',
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
  if (!confirm('全データを削除します。元に戻せません。よろしいですか?')) return
  if (!confirm('本当によろしいですか?会話履歴・復習リスト・プロフィール全てが消えます。')) return
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
            <strong>{{ (settings.settings.silenceDurationMs / 1000).toFixed(1) }}秒</strong>
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
            <option value="tiny">⚡⚡ tiny (~75MB / 超高速・精度低)</option>
            <option value="base">⚡ base (~142MB / 高速)</option>
            <option value="small">⚡ small (~466MB / 高速・実用精度)</option>
            <option value="medium">⚖ medium (~1.5GB / バランス・推奨)</option>
            <option value="large-v1">🎯 large-v1 (~2.9GB / 高精度・低速)</option>
            <option value="large-v3-turbo">🎯 large-v3-turbo (~1.5GB / 高精度・最新)</option>
          </select>
          <p class="mt-1 text-xs text-text-muted">
            英会話学習なら
            <strong class="text-text">small または medium</strong> がスピードと精度のバランス良。
            会話のラリーを優先したいなら small へ。
          </p>
        </div>
        <div>
          <label class="block text-sm">LLM</label>
          <select
            :value="settings.settings.llmModel"
            class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            @change="updateLlm"
          >
            <option value="llama3.2:3b">⚡ 軽量・高速 (Llama 3.2 3B / ~2GB)</option>
            <option value="gemma2:9b">⚖ バランス (Gemma 2 9B / ~5.5GB)</option>
            <option value="qwen2.5:14b">🎯 高精度・低速 (Qwen 2.5 14B / ~9GB)</option>
          </select>
          <p class="mt-1 text-xs text-text-muted">
            速度の目安(M4/M5):
            <strong class="text-text">Llama 3B ≈ 1-2秒</strong> /
            <strong class="text-text">Gemma 9B ≈ 3-5秒</strong> /
            <strong class="text-text">Qwen 14B ≈ 5-10秒</strong> per turn
          </p>
          <p class="mt-1 text-xs text-text-muted">
            ※ 未取得モデルは「インストール済みモデル」セクションの「+ 取得」ボタンで先に DL
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
      <div class="flex items-center justify-between">
        <div class="text-sm font-semibold">💽 インストール済みモデル</div>
        <button class="text-xs text-text-muted hover:text-text" @click="loadInstalledModels">
          🔄 更新
        </button>
      </div>
      <p class="mt-1 text-xs text-text-muted">
        ローカルにダウンロード済みの LLM と Whisper モデル。不要なものは削除して容量を空けられます。
      </p>

      <div v-if="modelsLoading" class="mt-4 text-sm text-text-muted">読み込み中...</div>

      <div v-else class="mt-4 space-y-5">
        <!-- LLM -->
        <div>
          <div class="mb-2 flex items-center justify-between">
            <div class="text-xs font-semibold uppercase tracking-wider text-text-muted">
              LLM (Ollama)
            </div>
            <span class="text-xs text-text-muted">
              <code>ollama pull &lt;name&gt;</code> で追加
            </span>
          </div>
          <div
            v-if="ollamaLoadError"
            class="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
          >
            {{ ollamaLoadError }}
          </div>
          <ul v-else-if="ollamaModels.length > 0" class="space-y-1.5">
            <li
              v-for="m in ollamaModels"
              :key="m.name"
              class="flex items-center justify-between rounded-lg bg-bg px-3 py-2 text-sm ring-1 ring-border"
            >
              <div class="flex items-center gap-2">
                <span class="font-mono">{{ m.name }}</span>
                <span
                  v-if="m.name === ollamaDefault"
                  class="rounded-full bg-primary px-2 py-0.5 text-[10px] text-white"
                >
                  使用中
                </span>
              </div>
              <div class="flex items-center gap-3 text-xs">
                <span class="text-text-muted">{{ formatSize(m.sizeMB) }}</span>
                <button
                  class="text-rose-500 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="m.name === ollamaDefault"
                  @click="handleDeleteOllama(m.name)"
                >
                  削除
                </button>
              </div>
            </li>
          </ul>
          <p v-else class="text-xs text-text-muted">インストール済みの LLM はありません</p>

          <!-- LLM 追加ダウンロードフォーム -->
          <div class="mt-3 rounded-lg border border-dashed border-border p-3">
            <div class="flex flex-wrap items-center gap-2">
              <select
                v-model="newLlmName"
                :disabled="llmPulling"
                class="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              >
                <option v-for="p in llmPresets" :key="p.value" :value="p.value">
                  {{ p.label }}
                </option>
              </select>
              <BaseButton size="sm" :disabled="llmPulling" @click="handlePullLlm">
                {{ llmPulling ? '取得中...' : '+ 取得' }}
              </BaseButton>
            </div>
            <div v-if="llmPulling || llmPullStatus" class="mt-2">
              <div class="flex justify-between text-[10px] text-text-muted">
                <span>{{ llmPullStatus }}</span>
                <span v-if="llmPullProgress > 0">{{ llmPullProgress }}%</span>
              </div>
              <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
                <div
                  class="h-full bg-primary transition-all"
                  :style="{ width: `${llmPullProgress}%` }"
                />
              </div>
            </div>
            <p v-if="llmPullError" class="mt-2 text-xs text-rose-500">
              {{ llmPullError }}
            </p>
          </div>
        </div>

        <!-- Whisper -->
        <div>
          <div class="mb-2 flex items-center justify-between">
            <div class="text-xs font-semibold uppercase tracking-wider text-text-muted">
              Whisper (nodejs-whisper)
            </div>
            <span class="text-xs text-text-muted">
              <code>npx nodejs-whisper download</code> で追加
            </span>
          </div>
          <div
            v-if="whisperLoadError"
            class="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
          >
            {{ whisperLoadError }}
          </div>
          <ul v-else-if="whisperModels.length > 0" class="space-y-1.5">
            <li
              v-for="m in whisperModels"
              :key="m.name"
              class="flex items-center justify-between rounded-lg bg-bg px-3 py-2 text-sm ring-1 ring-border"
            >
              <span class="font-mono">{{ m.name }}</span>
              <div class="flex items-center gap-3 text-xs">
                <span class="text-text-muted">{{ formatSize(m.sizeMB) }}</span>
                <button class="text-rose-500 hover:underline" @click="handleDeleteWhisper(m.name)">
                  削除
                </button>
              </div>
            </li>
          </ul>
          <p v-else class="text-xs text-text-muted">
            インストール済みの Whisper モデルはありません
          </p>

          <!-- Whisper 追加ダウンロードフォーム -->
          <div class="mt-3 rounded-lg border border-dashed border-border p-3">
            <div class="flex flex-wrap items-center gap-2">
              <select
                v-model="newWhisperName"
                :disabled="whisperDownloading || !whisperCppBuilt"
                class="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              >
                <option v-for="p in whisperPresets" :key="p.value" :value="p.value">
                  {{ p.label }}
                </option>
              </select>
              <BaseButton
                size="sm"
                :disabled="whisperDownloading || !whisperCppBuilt"
                @click="handleDownloadWhisper"
              >
                {{ whisperDownloading ? '取得中...' : '+ 取得' }}
              </BaseButton>
            </div>
            <p v-if="!whisperCppBuilt" class="mt-2 text-xs text-amber-600 dark:text-amber-400">
              ⚠ 先に whisper.cpp をビルドしてください(下のセクション)
            </p>
            <div v-if="whisperDownloading || whisperStatus" class="mt-2">
              <div class="flex justify-between text-[10px] text-text-muted">
                <span>{{ whisperStatus }}</span>
                <span v-if="whisperProgress > 0">{{ whisperProgress }}%</span>
              </div>
              <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
                <div
                  class="h-full bg-primary transition-all"
                  :style="{ width: `${whisperProgress}%` }"
                />
              </div>
            </div>
            <p v-if="whisperError" class="mt-2 text-xs text-rose-500">
              {{ whisperError }}
            </p>
          </div>
        </div>

        <!-- whisper.cpp ビルド -->
        <div>
          <div class="mb-2 flex items-center justify-between">
            <div class="text-xs font-semibold uppercase tracking-wider text-text-muted">
              whisper.cpp ビルド
            </div>
            <span
              class="rounded-full px-2 py-0.5 text-[10px]"
              :class="
                whisperCppBuilt
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                  : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
              "
            >
              {{ whisperCppBuilt ? '✓ ビルド済み' : '⚠ 未ビルド' }}
            </span>
          </div>
          <p v-if="!whisperCppBuilt" class="text-xs text-text-muted">
            Whisperモデルを使うには、whisper.cpp をビルドする必要があります(cmakeが必要)。
          </p>
          <BaseButton
            v-if="!whisperCppBuilt"
            class="mt-2"
            size="sm"
            variant="secondary"
            :disabled="buildingWhisperCpp"
            @click="handleBuildWhisperCpp"
          >
            {{ buildingWhisperCpp ? 'ビルド中...' : '🔨 whisper.cpp をビルド' }}
          </BaseButton>
          <BaseButton
            v-else
            class="mt-2"
            size="sm"
            variant="ghost"
            :disabled="buildingWhisperCpp"
            @click="handleBuildWhisperCpp"
          >
            {{ buildingWhisperCpp ? 'リビルド中...' : '🔨 再ビルド' }}
          </BaseButton>
          <pre
            v-if="buildLog"
            class="mt-2 max-h-48 overflow-y-auto rounded bg-bg p-2 font-mono text-[10px]"
            >{{ buildLog }}</pre
          >
          <p v-if="buildError" class="mt-2 text-xs text-rose-500">
            {{ buildError }}
          </p>
        </div>

        <div class="border-t border-border pt-3 text-xs text-text-muted">
          合計: <strong class="text-text">{{ totalSize() }}</strong>
        </div>
      </div>
    </BaseCard>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">💾 データ</div>
      <div class="mt-4 space-y-3">
        <p class="text-sm text-text-muted">会話履歴の保存期間: 30日(変更不可)</p>
        <div class="flex flex-wrap gap-2">
          <BaseButton variant="secondary" size="sm" :disabled="exporting" @click="handleExport">
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
          <BaseButton variant="danger" size="sm" :disabled="deleting" @click="handleDeleteAll">
            ⚠ 全データを削除
          </BaseButton>
        </div>
      </div>
    </BaseCard>
  </div>
</template>

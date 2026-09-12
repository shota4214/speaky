<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import {
  getDefaultVoicePreference,
  isConversationalEnglishVoice,
  useTextToSpeech,
} from '../composables/useTextToSpeech'
import type { PersonalityPreset } from '../db/types'
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
import { ALLOWED_LLM_MODELS, VALID_WHISPER_MODELS, type WhisperModel } from '../storage/settings'
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
const previewTts = useTextToSpeech()

// 音声選択: 利用可能な en-* voice を列挙する。
// Chromium/Safari ともに初回呼び出しで空配列を返すことがあるため、
// voiceschanged イベントで再取得する(useTextToSpeech.ensureVoicesLoaded と同様のパターン)。
const englishVoices = ref<SpeechSynthesisVoice[]>([])

function loadEnglishVoices() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  const all = window.speechSynthesis.getVoices()
  // 会話実用に耐える音声だけに絞る(ノベルティ/旧ロボ調を除外)。
  englishVoices.value = all
    .filter(isConversationalEnglishVoice)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function handleVoicesChanged() {
  loadEnglishVoices()
}

onMounted(() => {
  loadEnglishVoices()
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.addEventListener('voiceschanged', handleVoicesChanged)
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged)
  }
  // 試聴中だったら止める
  previewTts.cancel()
})

function updateVoiceName(e: Event) {
  const value = (e.target as HTMLSelectElement).value
  settings.update({
    aiCharacter: {
      ...settings.settings.aiCharacter,
      voiceName: value === '' ? null : value,
    },
  })
}

function updateTtsRate(e: Event) {
  settings.update({ ttsRate: Number((e.target as HTMLInputElement).value) })
}

function updateTtsPitch(e: Event) {
  settings.update({ ttsPitch: Number((e.target as HTMLInputElement).value) })
}

async function previewVoice() {
  // 連続再生防止: 既存パターン通り cancel して即発話
  previewTts.cancel()
  const opts = {
    rate: settings.settings.ttsRateConnectedToLevel ? 1.0 : settings.settings.ttsRate,
    pitch: settings.settings.ttsPitch,
    voiceName: settings.settings.aiCharacter.voiceName,
    voicePreference: getDefaultVoicePreference(settings.settings.aiCharacter.gender),
  }
  try {
    await previewTts.speak('Hello! This is how I sound now.', opts)
  } catch (e) {
    console.warn('[settings] preview TTS failed:', e)
  }
}

const personalityPresets: {
  value: PersonalityPreset
  label: string
  desc: string
  icon: string
}[] = [
  { value: 'friendly', label: 'friendly', desc: '親友のように暖かく(デフォルト)', icon: '😊' },
  {
    value: 'teacher',
    label: 'teacher',
    desc: '丁寧な先生 — 小さな成功を褒めて理由を簡潔に解説',
    icon: '👩‍🏫',
  },
  { value: 'cool', label: 'cool', desc: '落ち着いた皮肉屋 — 短くドライなユーモア', icon: '😎' },
  { value: 'kohai', label: 'kohai', desc: 'テンション高めの後輩 — リアクション大きめ', icon: '🐣' },
  { value: 'colleague', label: 'colleague', desc: '礼儀正しい同僚 — 大人同士の会話', icon: '💼' },
]

function updatePersonality(e: Event) {
  settings.update({
    aiCharacter: {
      ...settings.settings.aiCharacter,
      personality: (e.target as HTMLSelectElement).value as PersonalityPreset,
    },
  })
}

// AI キャラの名前。入力中はローカル状態、blur or Enter で settings に反映する。
const aiNameDraft = ref(settings.settings.aiCharacter.name)

function commitAiName() {
  const trimmed = aiNameDraft.value.trim()
  if (!trimmed) {
    // 空文字は許容しない。前の値に巻き戻す。
    aiNameDraft.value = settings.settings.aiCharacter.name
    return
  }
  if (trimmed === settings.settings.aiCharacter.name) return
  settings.update({
    aiCharacter: { ...settings.settings.aiCharacter, name: trimmed },
  })
}

function setAiGender(g: 'female' | 'male') {
  if (settings.settings.aiCharacter.gender === g) return
  settings.update({
    aiCharacter: { ...settings.settings.aiCharacter, gender: g },
  })
}

const importMode = ref<'merge' | 'replace'>('merge')
const importing = ref(false)
const exporting = ref(false)
const deleting = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const ollamaModels = ref<InstalledModel[]>([])
// backend のデフォルト LLM(OLLAMA_MODEL)。backend の delete endpoint は
// このモデルの削除を拒否するため、UI の削除可否判定にも使う。
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
  { value: 'llama3.2:3b', label: '⚡ Llama 3.2 3B — 軽量・高速(~2GB)' },
  { value: 'gemma2:9b', label: '⚖️ Gemma 2 9B — バランス・標準おすすめ(~5.5GB)' },
  { value: 'qwen2.5:14b', label: '💎 Qwen 2.5 14B — 高品質・低速(~9GB)' },
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
const newWhisperName = ref('small')
const whisperDownloading = ref(false)
const whisperProgress = ref(0)
const whisperStatus = ref('')
const whisperError = ref('')

const whisperPresets = [
  { value: 'tiny', label: '⚡⚡ tiny — 超高速・精度低(~75MB)' },
  { value: 'base', label: '⚡ base — 高速・精度ふつう(~142MB)' },
  { value: 'small', label: '⚡ small — 高速・実用精度・おすすめ(~466MB)' },
  { value: 'medium', label: '⚖️ medium — 高精度・重い(~1.5GB / 16GB以上向け)' },
  { value: 'large-v1', label: '🎯 large-v1 — 高精度・低速(~2.9GB)' },
  { value: 'large-v3-turbo', label: '🎯 large-v3-turbo — 高精度・最新(~1.5GB)' },
]

// インストール済みリストで「どれを選べばいいか」が分かるよう、
// モデル名から特徴(アイコン + 一言説明)を返す。前方一致で判定する。
function describeLlm(name: string): { icon: string; note: string } {
  const n = name.toLowerCase()
  if (n.startsWith('llama3.2:3b')) return { icon: '⚡', note: '軽量・高速 / 精度は控えめ' }
  if (n.startsWith('gemma2:9b')) return { icon: '⚖️', note: 'バランス型 / 標準おすすめ' }
  if (n.startsWith('qwen2.5:14b')) return { icon: '💎', note: '高品質 / 重め・低速' }
  if (n.includes(':1b') || n.includes(':0.5b'))
    return { icon: '⚡⚡', note: '超軽量 / 最速・精度低' }
  if (n.includes('14b') || n.includes('13b') || n.includes('32b') || n.includes('70b'))
    return { icon: '💎', note: '高品質 / 重め' }
  if (n.includes('7b') || n.includes('8b') || n.includes('9b'))
    return { icon: '⚖️', note: 'バランス型' }
  if (n.includes('1b') || n.includes('3b')) return { icon: '⚡', note: '軽量・高速' }
  return { icon: '🤖', note: 'LLM モデル' }
}

function describeWhisper(name: string): { icon: string; note: string } {
  // 例: "ggml-small.bin" → "small"
  const base = name
    .replace(/^ggml-/, '')
    .replace(/\.bin$/, '')
    .toLowerCase()
  if (base.startsWith('tiny')) return { icon: '⚡⚡', note: '超高速 / 精度低' }
  if (base.startsWith('base')) return { icon: '⚡', note: '高速 / 精度ふつう' }
  if (base.startsWith('small')) return { icon: '⚡', note: '高速・実用精度 / おすすめ' }
  if (base.startsWith('medium')) return { icon: '⚖️', note: '高精度 / 重め・16GB以上向け' }
  if (base.startsWith('large')) return { icon: '🎯', note: '高精度 / 低速・重め' }
  return { icon: '🎙', note: 'Whisper モデル' }
}

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
function updateShowJapanese(e: Event) {
  settings.update({ showJapanese: (e.target as HTMLInputElement).checked })
}
function updateStreaming(e: Event) {
  settings.update({ streaming: (e.target as HTMLInputElement).checked })
}

// アプリが実際に使う Whisper モデルのファイル名(例: small → ggml-small.bin)。
// インストール済み一覧の「使用中」バッジ・削除保護の判定に使う。
const activeWhisperFile = computed(() => `ggml-${settings.settings.whisperModel}.bin`)

// LLM の削除不可判定。backend が拒否する条件と揃える:
//  - settings.llmModel(アプリが今使うモデル)
//  - ollamaDefault(backend の OLLAMA_MODEL。backend が削除拒否する)
function isLlmDeleteDisabled(name: string): boolean {
  return name === settings.settings.llmModel || name === ollamaDefault.value
}

// 🧠 モデルセクションの選択肢は「インストール済みのもの」だけに絞る。
// 未取得モデルを選ばせると、会話開始時に存在しないモデルを使おうとして失敗するため。
// インストール済み AND backend allowlist 内のものだけを選択肢にする。
// allowlist 外(例: mistral, llama3.2:1b)を選ばせても backend が default に
// フォールバックして「選んだのに使われない」状態になるため。
const installedLlmOptions = computed(() =>
  ollamaModels.value
    .filter((m) => ALLOWED_LLM_MODELS.has(m.name))
    .map((m) => {
      const d = describeLlm(m.name)
      return { value: m.name, label: `${d.icon} ${m.name} — ${d.note}` }
    }),
)

// Whisper はインストール名が "ggml-small.bin"。設定値は短縮名 "small" なので変換する。
// transcribe 側の allowlist と同期した VALID_WHISPER_MODELS で絞る。
const installedWhisperOptions = computed(() =>
  whisperModels.value
    .map((m) => {
      const short = m.name.replace(/^ggml-/, '').replace(/\.bin$/, '')
      const d = describeWhisper(m.name)
      return { value: short, label: `${d.icon} ${short} — ${d.note}`, installed: true }
    })
    .filter((o) => VALID_WHISPER_MODELS.has(o.value as WhisperModel)),
)

/**
 * 実際に <select> へ流す選択肢。
 * 保存されている whisperModel がインストール済み一覧に無いと、ブラウザは先頭の
 * option を選択状態として描画してしまい、「画面の表示」と「保存値(実際に
 * backend へ送られる値)」が食い違う。現在値を必ず表現できるよう、未インストール
 * なら先頭に disabled の項目として差し込む。
 */
const whisperSelectOptions = computed(() => {
  const current = settings.settings.whisperModel
  const options = installedWhisperOptions.value
  if (options.some((o) => o.value === current)) return options
  return [{ value: current, label: `⚠️ ${current} — 未インストール`, installed: false }, ...options]
})
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
            max="15000"
            step="500"
            class="mt-2 w-full accent-primary"
            @input="updateSilence"
          />
          <div class="mt-1 flex justify-between text-[10px] text-text-muted">
            <span>1秒</span>
            <span>15秒</span>
          </div>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            class="h-4 w-4 rounded accent-primary"
            :checked="settings.settings.showJapanese"
            @change="updateShowJapanese"
          />
          AI返答に日本語訳を表示する
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            class="h-4 w-4 rounded accent-primary"
            :checked="settings.settings.ttsRateConnectedToLevel"
            @change="updateTtsRateLink"
          />
          AIの話速をレベルと連動させる
        </label>
        <div>
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              class="h-4 w-4 rounded accent-primary"
              :checked="settings.settings.streaming"
              @change="updateStreaming"
            />
            AIの返答を文ができた順に読み上げる(推奨)
          </label>
          <p class="ml-6 mt-1 text-[11px] text-text-muted">
            OFF にすると返答全体が出来上がってから読み上げます。読み上げがおかしいときの
            切り戻し用です。
          </p>
        </div>
        <div>
          <label class="block text-sm">
            話す速度:
            <strong>{{ settings.settings.ttsRate.toFixed(2) }}x</strong>
            <span v-if="settings.settings.ttsRateConnectedToLevel" class="text-text-muted">
              (レベル連動中は無効)
            </span>
          </label>
          <input
            :value="settings.settings.ttsRate"
            type="range"
            min="0.5"
            max="1.5"
            step="0.05"
            class="mt-2 w-full accent-primary"
            :disabled="settings.settings.ttsRateConnectedToLevel"
            @input="updateTtsRate"
          />
        </div>
        <div>
          <label class="block text-sm">
            声の高さ:
            <strong>{{ settings.settings.ttsPitch.toFixed(2) }}</strong>
          </label>
          <input
            :value="settings.settings.ttsPitch"
            type="range"
            min="0.7"
            max="1.4"
            step="0.05"
            class="mt-2 w-full accent-primary"
            @input="updateTtsPitch"
          />
        </div>
        <div>
          <BaseButton size="sm" variant="secondary" @click="previewVoice"> 🔊 試聴 </BaseButton>
          <span class="ml-2 text-xs text-text-muted">
            "Hello! This is how I sound now." を現在の設定で読み上げ
          </span>
        </div>
      </div>
    </BaseCard>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">🤖 AI キャラクター</div>
      <div class="mt-4 space-y-4">
        <div>
          <label class="block text-sm">名前</label>
          <input
            v-model="aiNameDraft"
            type="text"
            maxlength="30"
            class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            @blur="commitAiName"
            @keydown.enter="commitAiName"
          />
          <p class="mt-1 text-xs text-text-muted">
            AI が自己紹介で名乗る名前。フォーカスを外すか Enter で保存。
          </p>
        </div>
        <div>
          <label class="block text-sm">性別</label>
          <div class="mt-2 flex gap-2">
            <BaseButton
              :variant="settings.settings.aiCharacter.gender === 'female' ? 'primary' : 'secondary'"
              size="sm"
              @click="setAiGender('female')"
            >
              女性
            </BaseButton>
            <BaseButton
              :variant="settings.settings.aiCharacter.gender === 'male' ? 'primary' : 'secondary'"
              size="sm"
              @click="setAiGender('male')"
            >
              男性
            </BaseButton>
          </div>
          <p class="mt-1 text-xs text-text-muted">
            「音声」が「自動」のときの初期声と、会話プロンプトの代名詞に使われます。
          </p>
        </div>
        <div>
          <label class="block text-sm">音声(Voice)</label>
          <select
            :value="settings.settings.aiCharacter.voiceName ?? ''"
            class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            @change="updateVoiceName"
          >
            <option value="">自動(性別で自動選択)</option>
            <option v-for="v in englishVoices" :key="v.name" :value="v.name">
              {{ v.name }} ({{ v.lang }})
            </option>
          </select>
          <p class="mt-1 text-xs text-text-muted">
            macOS の英語音声から会話実用に耐えるものだけを表示しています。
          </p>
        </div>
        <div>
          <label class="block text-sm">性格プリセット</label>
          <select
            :value="settings.settings.aiCharacter.personality"
            class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            @change="updatePersonality"
          >
            <option v-for="p in personalityPresets" :key="p.value" :value="p.value">
              {{ p.icon }} {{ p.label }} — {{ p.desc }}
            </option>
          </select>
          <p class="mt-1 text-xs text-text-muted">
            会話 AI の話し方の傾向。次の会話から反映されます。
          </p>
        </div>
      </div>
    </BaseCard>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">🧠 モデル</div>
      <div class="mt-4 space-y-3">
        <div>
          <label class="block text-sm">Whisper</label>
          <select
            v-if="installedWhisperOptions.length > 0"
            :value="settings.settings.whisperModel"
            class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            @change="updateWhisper"
          >
            <option
              v-for="o in whisperSelectOptions"
              :key="o.value"
              :value="o.value"
              :disabled="!o.installed"
            >
              {{ o.label }}
            </option>
          </select>
          <p
            v-else
            class="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
          >
            インストール済みの Whisper
            モデルがありません。下の「インストール済みモデル」から取得してください。
          </p>
          <p class="mt-1 text-xs text-text-muted">
            選べるのはインストール済みのモデルだけです。英会話学習なら
            <strong class="text-text">small</strong>
            がおすすめ(同梱モデル)。メモリ 16GB 以上なら medium も選べます。
          </p>
        </div>
        <div>
          <label class="block text-sm">LLM</label>
          <select
            v-if="installedLlmOptions.length > 0"
            :value="settings.settings.llmModel"
            class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            @change="updateLlm"
          >
            <option v-for="o in installedLlmOptions" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
          <p
            v-else
            class="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
          >
            インストール済みの LLM
            がありません。下の「インストール済みモデル」から取得してください。
          </p>
          <p class="mt-1 text-xs text-text-muted">
            選べるのはインストール済みのモデルだけです。速度の目安(M4/M5):
            <strong class="text-text">Llama 3B ≈ 1-2秒</strong> /
            <strong class="text-text">Gemma 9B ≈ 3-5秒</strong> /
            <strong class="text-text">Qwen 14B ≈ 5-10秒</strong> per turn
          </p>
          <p class="mt-1 text-xs text-text-muted">
            ※ 未取得モデルは下の「インストール済みモデル」セクションの「+ 取得」ボタンで先に DL
          </p>
          <p
            class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
          >
            💡 精度重視なら <strong>Gemma 9B</strong> または <strong>Qwen 14B</strong> がおすすめ。
            <strong>Llama 3.2 3B</strong>
            は軽量・高速ですが、英文の添削や日本語→英語の翻訳が不正確になることがあり、誤った添削・誤訳が表示される場合があります。
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
            OS の設定に関わらずアプリの表示を固定できます(システム連動を選ぶと OS に追従)
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
              <div class="flex min-w-0 items-center gap-2">
                <span class="shrink-0">{{ describeLlm(m.name).icon }}</span>
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="font-mono">{{ m.name }}</span>
                    <span
                      v-if="m.name === settings.settings.llmModel"
                      class="rounded-full bg-primary px-2 py-0.5 text-[10px] text-white"
                    >
                      使用中
                    </span>
                  </div>
                  <div class="text-[10px] text-text-muted">{{ describeLlm(m.name).note }}</div>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-3 text-xs">
                <span class="text-text-muted">{{ formatSize(m.sizeMB) }}</span>
                <button
                  class="text-rose-500 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="isLlmDeleteDisabled(m.name)"
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
              <div class="flex min-w-0 items-center gap-2">
                <span class="shrink-0">{{ describeWhisper(m.name).icon }}</span>
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="font-mono">{{ m.name }}</span>
                    <span
                      v-if="m.name === activeWhisperFile"
                      class="rounded-full bg-primary px-2 py-0.5 text-[10px] text-white"
                    >
                      使用中
                    </span>
                  </div>
                  <div class="text-[10px] text-text-muted">{{ describeWhisper(m.name).note }}</div>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-3 text-xs">
                <span class="text-text-muted">{{ formatSize(m.sizeMB) }}</span>
                <button
                  class="text-rose-500 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="m.name === activeWhisperFile"
                  @click="handleDeleteWhisper(m.name)"
                >
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

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
  previewModelProfile,
  probeBackendFeatures,
  pullOllamaModel,
  type InstalledModel,
  type ModelProfilePreview,
} from '../services/api'
import {
  BUNDLED_LLM_MODEL,
  findCatalogEntry,
  isAllowedLlmModel,
  LLM_CATALOG,
  llmParameterBillions,
  RECOMMENDED_DOWNLOAD_LLM_MODEL,
  VALID_WHISPER_MODELS,
  type ModelProfilePref,
  type WhisperModel,
} from '../storage/settings'
import { FEATURE_MODEL_PROFILE_PREVIEW, hasFeature } from '../utils/backend-features'
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
// 取得フォームの初期値は「同梱の 1B から標準モードへ戻すのに要るモデル」。
// ここを固定文字列で書くと、同梱物を変えたときに真っ先に嘘になる。
const newLlmName = ref<string>(RECOMMENDED_DOWNLOAD_LLM_MODEL)
const llmPulling = ref(false)
const llmPullProgress = ref(0)
const llmPullStatus = ref('')
const llmPullError = ref('')

// 取得フォームの選択肢はカタログ(backend/src/shared/llm-models.ts)から作る。
// 一覧をここに手書きすると、また backend と食い違う。
const llmPresets = LLM_CATALOG.filter((e) => e.offerForDownload).map((e) => ({
  value: e.tag,
  label: `${e.icon} ${e.label} — ${e.note}(${e.sizeLabel})`,
}))

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
// モデル名から特徴(アイコン + 一言説明)を返す。
// まずカタログの完全一致、次にパラメータ数からの推定(量子化タグ対応)。
function describeLlm(name: string): { icon: string; note: string } {
  const entry = LLM_CATALOG.find((e) => e.tag === name)
  if (entry) return { icon: entry.icon, note: entry.note }

  // 自分で pull した量子化タグ(`llama3.2:3b-instruct-q4_K_M` 等)はここへ来る。
  const billions = llmParameterBillions(name)
  if (billions !== null) {
    if (billions <= 2) return { icon: '⚡⚡', note: '超軽量 / 最速・精度低(軽量モード対象)' }
    if (billions <= 3) return { icon: '⚡', note: '軽量・高速 / 精度は控えめ' }
    if (billions <= 9) return { icon: '⚖️', note: 'バランス型' }
    return { icon: '💎', note: '高品質 / 重め・低速' }
  }
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
onMounted(refreshProfilePreview)

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
// インストール済み AND backend が受け付けるものだけを選択肢にする。
// 受け付けない名前(例: mistral)を選ばせても backend が default にフォールバックして
// 「選んだのに使われない」状態になるため。
// 判定は backend と同一の関数(shared/llm-models.ts)。ファミリー一致なので、
// 自分で pull した量子化タグもここに出る(v1.1.0 までは消えていた)。
const installedLlmOptions = computed(() =>
  ollamaModels.value
    .filter((m) => isAllowedLlmModel(m.name))
    .map((m) => {
      const d = describeLlm(m.name)
      return { value: m.name, label: `${d.icon} ${m.name} — ${d.note}` }
    }),
)

// --- 会話プロファイル ---
//
// ⚠️ **ここはローカルの設定から推測してはいけない**(v1.1.0 の不具合)。
// 会話画面のバッジは backend が申告した値だけを信じているのに、この画面だけが
// `resolveProfileLevel()` をフロントで呼んで「軽量モードで動作中」と言い切っていた。
// Electron は frontend を app bundle から、backend を userData から読み、backend の
// 同期は app version の gate で走るので **frontend だけ新しい** 組み合わせが普通に起こる。
// その旧 backend は
//   - プロファイルを知らない(常に長いプロンプトで動く)
//   - allowlist が完全一致で `llama3.2:1b` を含まない → 黙って既定モデルへ差し替える
// ため、ユーザーは「選んだモデル」も「表示されたモード」も両方間違った画面を見ていた。
//
// なので **backend に聞く**(POST /api/model-profile/preview)。
// 聞けない backend(機能申告が無い / 応答しない)には何も言い切らない。
const profilePreview = ref<ModelProfilePreview | null>(null)
/** backend がプレビューに対応しているか。null = まだ確認できていない。 */
const profilePreviewSupported = ref<boolean | null>(null)

/**
 * 問い合わせの世代。モデルとモードを続けて変えると問い合わせが並走し、
 * 遅かった方が後から解決して**古い結果でバッジを上書きする**ことがある。
 * バッジは「backend が確認した内容」を名乗る以上、古い答えを出すのは
 * 推測を出すのと同じくらい悪い。最後の問い合わせだけを採用する。
 */
let previewGeneration = 0

async function refreshProfilePreview() {
  const generation = ++previewGeneration
  const model = settings.settings.llmModel
  const pref = settings.settings.modelProfile

  const features = await probeBackendFeatures()
  if (generation !== previewGeneration) return
  if (!hasFeature(features, FEATURE_MODEL_PROFILE_PREVIEW)) {
    profilePreviewSupported.value = false
    profilePreview.value = null
    return
  }
  try {
    const preview = await previewModelProfile(model, pref)
    if (generation !== previewGeneration) return
    profilePreview.value = preview
    profilePreviewSupported.value = true
  } catch {
    // 応答が無い = 確認できない。推測で埋めない。
    if (generation !== previewGeneration) return
    profilePreviewSupported.value = false
    profilePreview.value = null
  }
}

const profileOptions: { value: ModelProfilePref; label: string }[] = [
  { value: 'auto', label: '自動(モデルの大きさで決める / 推奨)' },
  { value: 'standard', label: '標準に固定(詳しい指示・添削あり)' },
  { value: 'small', label: '軽量に固定(短い指示・日本語訳のみ)' },
]

/**
 * バッジ。**backend が確認した内容だけ**を出す。
 * 確認できないときは「不明」と言う(嘘をつくより役に立つ)。
 */
const profileBadge = computed(() => {
  if (profilePreviewSupported.value === null) {
    return { label: '確認中...', tone: 'unknown' as const }
  }
  const preview = profilePreview.value
  if (!preview) {
    return { label: 'このバックエンドでは確認できません', tone: 'unknown' as const }
  }
  return preview.profile === 'small'
    ? { label: '軽量モードで動作します(backend 確認済み)', tone: 'small' as const }
    : { label: '標準モードで動作します(backend 確認済み)', tone: 'standard' as const }
})

/** backend が選択モデルを黙って差し替える状態。旧 backend + 新しいモデル名で起きる。 */
const modelSubstituted = computed(
  () => profilePreview.value !== null && !profilePreview.value.modelAccepted,
)

/** 添削・単語が出ない状態か(backend の申告)。 */
const enrichmentReduced = computed(() => profilePreview.value?.enrichment === 'translation-only')

function updateModelProfile(e: Event) {
  settings.update({ modelProfile: (e.target as HTMLSelectElement).value as ModelProfilePref })
  void refreshProfilePreview()
}

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
/**
 * LLM を選び直したら、会話モードの固定を **自動へ戻す**。
 *
 * 設定スキーマ v3 の移行は `gemma2:2b` を使っていた人に 'standard' を書き込んで
 * 挙動を据え置いた。移行の瞬間としては正しいが、その値は残り続けるので、
 * あとからその人が 1B へ乗り換えると **小さいモデルに長いプロンプト** という、
 * この一連の作業がまさに潰そうとしている組み合わせに静かに戻ってしまう。
 * モデルを変える瞬間は「前のモデルのための固定」を捨ててよい唯一の合図なので、
 * ここで 'auto' に戻す(下の説明文にもそう書いてある)。
 */
function updateLlm(e: Event) {
  const next = (e.target as HTMLSelectElement).value
  const patch: { llmModel: string; modelProfile?: ModelProfilePref } = { llmModel: next }
  if (settings.settings.modelProfile !== 'auto') patch.modelProfile = 'auto'
  settings.update(patch)
  void refreshProfilePreview()
}

/** 同梱モデル / 追加ダウンロードの案内に使う表示名。 */
const bundledLlmLabel = computed(() => {
  const entry = findCatalogEntry(BUNDLED_LLM_MODEL)
  return entry ? `${entry.label}(${entry.sizeLabel})` : BUNDLED_LLM_MODEL
})
const recommendedDownloadLabel = computed(() => {
  const entry = findCatalogEntry(RECOMMENDED_DOWNLOAD_LLM_MODEL)
  return entry ? `${entry.label}(${entry.sizeLabel})` : RECOMMENDED_DOWNLOAD_LLM_MODEL
})
/** 追加ダウンロードのモデルが既に入っているか(案内を出すかどうか)。 */
const recommendedDownloadInstalled = computed(() =>
  ollamaModels.value.some((m) => m.name === RECOMMENDED_DOWNLOAD_LLM_MODEL),
)
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
            <strong class="text-text">Llama 1B ≈ 1秒未満</strong> /
            <strong class="text-text">Llama 3B ≈ 1-2秒</strong> /
            <strong class="text-text">Gemma 9B ≈ 3-5秒</strong> /
            <strong class="text-text">Qwen 14B ≈ 5-10秒</strong> per turn
          </p>
          <p class="mt-1 text-xs text-text-muted">
            ※ 未取得モデルは下の「インストール済みモデル」セクションの「+ 取得」ボタンで先に DL
          </p>
          <p
            v-if="!recommendedDownloadInstalled"
            class="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:bg-sky-900/20 dark:text-sky-200"
          >
            💡 DMG に同梱しているのは <strong>{{ bundledLlmLabel }}</strong> だけです(ネット無しで
            すぐ会話できます)。これは小さいモデルなので
            <strong>軽量モード</strong>で動き、<strong>添削と単語カードは出ません</strong>。
            メモリに余裕がある Mac なら、下の「インストール済みモデル」で
            <strong>{{ recommendedDownloadLabel }}</strong>
            を取得すると<strong>標準モードに戻り、添削と単語カードが出るようになります</strong>。
          </p>
          <p
            class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
          >
            💡 精度重視なら <strong>Gemma 9B</strong> または <strong>Qwen 14B</strong> がおすすめ。
            <strong>Llama 3.2 3B</strong>
            は軽量・高速ですが、英文の添削や日本語→英語の翻訳が不正確になることがあり、誤った添削・誤訳が表示される場合があります。
            <strong>Llama 3.2 1B / Qwen 2.5 1.5B</strong>
            はさらに精度が落ちます(添削は出しません)。メモリ 8GB の Mac
            で「重くて会話にならない」ときの選択肢です。
          </p>
        </div>

        <!-- 会話プロファイル -->
        <div class="border-t border-border pt-3">
          <div class="flex items-center justify-between">
            <label class="block text-sm">会話モード</label>
            <span
              class="rounded-full px-2 py-0.5 text-[10px]"
              :class="{
                'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300':
                  profileBadge.tone === 'small',
                'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300':
                  profileBadge.tone === 'standard',
                'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300':
                  profileBadge.tone === 'unknown',
              }"
            >
              {{ profileBadge.label }}
            </span>
          </div>
          <select
            :value="settings.settings.modelProfile"
            class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            @change="updateModelProfile"
          >
            <option v-for="o in profileOptions" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
          <p class="mt-1 text-xs text-text-muted">
            小さいモデル(2B 以下)は長い指示を守れないため、<strong class="text-text"
              >軽量モード</strong
            >では AI への指示を短くし、会話履歴を減らし、返答を 1〜2
            文に制限します。添削と単語は出さず、日本語訳だけを作ります(小さいモデルの添削は誤りが多いため)。
          </p>
          <p class="mt-1 text-xs text-text-muted">
            「自動」はモデル名のパラメータ数で判定します(2B 以下 = 軽量)。 上のバッジは<strong
              class="text-text"
              >バックエンドに問い合わせた結果</strong
            >で、 会話画面のバッジ(実際に動いた値)と同じ出典です。
            <strong class="text-text">LLM を選び直すと、この設定は「自動」に戻ります</strong>
            (前のモデル向けの固定を、別のモデルに引きずらないため)。
          </p>
          <p
            v-if="profilePreviewSupported === false"
            class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
          >
            ⚠ このバックエンドは会話モードに対応していない(または応答しない)ため、
            <strong>実際にどのモードで動くか確認できません</strong>。
            対応していないバックエンドはこの設定を無視し、選んだモデルも受け付けずに
            自分の既定モデルへ差し替えることがあります。
            アプリを再起動しても直らない場合は、アプリを最新版に入れ直してください。
          </p>
          <p
            v-else-if="modelSubstituted"
            class="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-900/20 dark:text-rose-300"
          >
            ⚠ バックエンドは選択中のモデルを受け付けず、
            <code class="font-mono">{{ profilePreview?.model }}</code>
            に差し替えて動作します。アプリを最新版に入れ直してください。
          </p>
          <p
            v-else-if="enrichmentReduced"
            class="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:bg-sky-900/20 dark:text-sky-200"
          >
            ℹ️
            いまの組み合わせでは<strong>添削と単語カードは出ません</strong>(日本語訳は必ず出ます)。
            小さいモデルの添削は誤りが多く、間違った学習材料を出すより出さない方がよいためです。
            <strong>{{ recommendedDownloadLabel }}</strong> 以上のモデルを取得して選ぶと、
            標準モードに戻って添削と単語カードが出るようになります。
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

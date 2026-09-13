<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AiMascot from '../components/AiMascot.vue'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import {
  buildWhisperCpp,
  checkOllamaHealth,
  downloadWhisperModelStream,
  getWhisperCppStatus,
  listOllamaModels,
  listWhisperModels,
  probeBackendFeatures,
  pullOllamaModel,
} from '../services/api'
import type { PersonalityPreset } from '../db/types'
import { BUNDLED_LLM_MODEL, findCatalogEntry } from '../storage/settings'
import { useSettingsStore } from '../stores/settings'
import {
  formatMemoryGb,
  isLowMemoryMachine,
  NO_FEATURES,
  type BackendFeatures,
} from '../utils/backend-features'
import { buildOnboardingLlmOptions, chooseOnboardingLlm } from '../utils/onboarding-model'

const router = useRouter()
const settings = useSettingsStore()

type Step = 1 | 2 | 3 | 4 | 5 | 6

const step = ref<Step>(1)
const stepLabels: Record<Step, string> = {
  1: 'ようこそ',
  2: 'Ollama 確認',
  3: 'モデル選択',
  4: 'モデルダウンロード',
  5: 'AIキャラ設定',
  6: '完了',
}

// Step 2: Ollama は Electron が sidecar 起動するので、ここでは ready 待ちだけ行う。
// 10 秒以内に running になれば自動で次へ進む。失敗なら再試行 UI を出す。
const OLLAMA_POLL_INTERVAL_MS = 2_000
const OLLAMA_READY_TIMEOUT_MS = 10_000

const ollamaReady = ref(false)
const ollamaWaitFailed = ref(false)
let ollamaPollTimer: ReturnType<typeof setInterval> | null = null
let ollamaWaitDeadline = 0

function stopOllamaPolling() {
  if (ollamaPollTimer !== null) {
    clearInterval(ollamaPollTimer)
    ollamaPollTimer = null
  }
}

async function pollOllamaOnce() {
  const res = await checkOllamaHealth()
  if (res.ok) {
    ollamaReady.value = true
    stopOllamaPolling()
    // 600ms 待ってから次へ自動遷移(完了表示を一瞬視認できるように)
    setTimeout(() => {
      if (step.value === 2) next()
    }, 600)
    return
  }
  if (Date.now() >= ollamaWaitDeadline) {
    ollamaWaitFailed.value = true
    stopOllamaPolling()
  }
}

function startOllamaPolling() {
  stopOllamaPolling()
  ollamaReady.value = false
  ollamaWaitFailed.value = false
  ollamaWaitDeadline = Date.now() + OLLAMA_READY_TIMEOUT_MS
  void pollOllamaOnce()
  ollamaPollTimer = setInterval(() => {
    void pollOllamaOnce()
  }, OLLAMA_POLL_INTERVAL_MS)
}

watch(step, (s) => {
  if (s === 2) startOllamaPolling()
  else stopOllamaPolling()
  if (s === 4) refreshStep4Status()
})

/**
 * この Mac の搭載メモリ。**このステージで一番効く 1 行**。
 *
 * 8GB の Mac に 9B を選ばせると「重くて使えない」まま離脱するが、
 * ユーザーは自分が何を選ぶべきか判断する材料を持っていない
 * (「軽量」「標準」「高品質」だけでは、自分の機械がどれなのか分からない)。
 * backend が os.totalmem() を返すので、**このマシンは何 GB か**を言い切って
 * 既定の選択もそちらへ寄せる。メモリが取れないときは何も推測しない。
 */
const backendFeatures = ref<BackendFeatures>(NO_FEATURES)
const memoryLabel = computed(() => formatMemoryGb(backendFeatures.value))
const lowMemory = computed(() => isLowMemoryMachine(backendFeatures.value))

onMounted(async () => {
  if (step.value === 2) startOllamaPolling()
  if (step.value === 4) refreshStep4Status()

  backendFeatures.value = await probeBackendFeatures()
  // refreshInstalledLlms が中で applyAutoLlmSelection まで走らせる
  // (一覧が変われば選択もやり直す、が唯一の置き場所)。
  await refreshInstalledLlms()
})

onUnmounted(() => {
  stopOllamaPolling()
})

const llmModel = ref(settings.settings.llmModel)
/** ユーザーがこの画面で LLM を選び直したか(自動選択で上書きしないため)。 */
const userPickedLlm = ref(false)
const whisperModel = ref(settings.settings.whisperModel)
const aiName = ref(settings.settings.aiCharacter.name)
const aiGender = ref<'female' | 'male'>(settings.settings.aiCharacter.gender)
const aiPersonality = ref<PersonalityPreset>(settings.settings.aiCharacter.personality)

const personalityPresets: {
  value: PersonalityPreset
  label: string
  desc: string
  icon: string
}[] = [
  { value: 'friendly', label: 'friendly', desc: '親友のように暖かく(デフォルト)', icon: '😊' },
  { value: 'teacher', label: 'teacher', desc: '丁寧な先生 — 解説を交える', icon: '👩‍🏫' },
  { value: 'cool', label: 'cool', desc: '落ち着いた皮肉屋', icon: '😎' },
  { value: 'kohai', label: 'kohai', desc: 'テンション高めの後輩', icon: '🐣' },
  { value: 'colleague', label: 'colleague', desc: '礼儀正しい同僚', icon: '💼' },
]

// Step 4: download state
const llmPulled = ref(false)
const llmPulling = ref(false)
const llmPullProgress = ref(0)
const llmPullStatus = ref('')
const llmPullError = ref('')

const whisperCppBuilt = ref(false)
const buildingWhisperCpp = ref(false)
const buildError = ref('')
const buildLog = ref('')

const whisperDownloaded = ref(false)
const whisperDownloading = ref(false)
const whisperProgress = ref(0)
const whisperStatus = ref('')
const whisperError = ref('')

/**
 * インストール済みの LLM 一覧。**自動選択の前に必ず取る**。
 * 取れなければ空配列 = 「何も入っていない」と同じ扱いにして、
 * 同梱モデルを選ぶ(推測でユーザーを行き止まりに置かない)。
 */
const installedLlms = ref<string[]>([])

async function refreshInstalledLlms(): Promise<void> {
  try {
    const list = await listOllamaModels()
    installedLlms.value = list.models.map((m) => m.name)
  } catch {
    installedLlms.value = []
  }
  // ⚠️ **一覧を取り直したら自動選択もやり直す**。
  // 最初のプローブは Ollama がまだ応答しない段階で走ることがあり、そのときは
  // 「1 つも入っていない」= 同梱モデル + 「3B の取得を薦める」案内 で確定していた。
  // あとから一覧が埋まっても選択と案内は mount 時のまま固定で、3B を持っている
  // 16GB 機が最後まで 1B のまま & 不要な DL 案内を出し続けていた。
  applyAutoLlmSelection()
}

/**
 * この Mac に合わせて LLM を選択状態にする。
 *
 * ⚠️ **インストール済みの中からしか選ばない**(utils/onboarding-model.ts)。
 * v1.1.0 は 12GB 未満なら無条件に 1B を選んでいたが、同梱は 3B だけだったので
 * オフラインの 8GB 機では「選ばれたモデルを取得できず次へ進めない」
 * 行き止まりになっていた。ユーザーが自分で選び直していたら尊重する。
 */
function applyAutoLlmSelection(): void {
  // 自分で選び直した人の選択は絶対に動かさない。
  // DL 中も動かさない(いま引いているモデルの足元を変えないため)。
  if (userPickedLlm.value || llmPulling.value) return
  const selection = chooseOnboardingLlm({
    installed: installedLlms.value,
    lowMemory: lowMemory.value,
    memoryKnown: backendFeatures.value.totalMemoryBytes !== null,
  })
  // 案内は毎回更新する(3B が入った瞬間に消えるべき)。
  recommendedDownload.value = selection.recommendedDownload
  if (llmModel.value === selection.model) return
  llmModel.value = selection.model
  // 選択が動いたらステップ 4 の「取得済みか」も引き直す。
  llmPulled.value = installedLlms.value.includes(selection.model)
}

/**
 * メモリに余裕がある Mac に薦めたいが、まだ入っていないモデル(通常 3B)。
 * **案内するだけで選択は動かさない** — オフラインでも先へ進めることが優先。
 */
const recommendedDownload = ref<string | null>(null)

/**
 * 同梱モデルの表示名。説明文に型番を手書きすると、同梱物を変えたときに
 * 真っ先に嘘になる(v1.2.0 → 次のリリースで Llama 3.2 1B → Qwen 2.5 1.5B)。
 */
const bundledLlmName = computed(
  () => findCatalogEntry(BUNDLED_LLM_MODEL)?.label ?? BUNDLED_LLM_MODEL,
)

const recommendedDownloadLabel = computed(() => {
  const tag = recommendedDownload.value
  if (!tag) return null
  const entry = findCatalogEntry(tag)
  return entry ? `${entry.label}(${entry.sizeLabel})` : tag
})

/**
 * 選択肢はカタログから作る(設定画面の取得フォームと同じ出典)。
 * ただし **いま選ばれているモデルは必ず入れる** — カタログに無いモデルが
 * 選ばれることがある(この Mac に入っているのがそれだけ、という場合)。
 * 詳細は utils/onboarding-model.ts の注記。
 */
const llmOptions = computed(() =>
  buildOnboardingLlmOptions({ selected: llmModel.value, installed: installedLlms.value }),
)

/** 今選ばれているモデルがディスクにあるか(= このまま会話を始められるか)。 */
const selectedLlmInstalled = computed(
  () => llmPulled.value || installedLlms.value.includes(llmModel.value),
)

function onLlmPicked(): void {
  userPickedLlm.value = true
  // 選び直したら「取得済みか」を即座に引き直す(step 4 の「次へ」の判定に効く)。
  llmPulled.value = installedLlms.value.includes(llmModel.value)
}

async function refreshStep4Status() {
  await refreshInstalledLlms()
  llmPulled.value = installedLlms.value.includes(llmModel.value)
  try {
    const wList = await listWhisperModels()
    whisperDownloaded.value = wList.models.some((m) => m.name === `ggml-${whisperModel.value}.bin`)
  } catch {
    whisperDownloaded.value = false
  }
  try {
    const s = await getWhisperCppStatus()
    whisperCppBuilt.value = s.built
  } catch {
    whisperCppBuilt.value = false
  }
}

async function pullLlm() {
  llmPulling.value = true
  llmPullProgress.value = 0
  llmPullStatus.value = 'starting...'
  llmPullError.value = ''
  try {
    await pullOllamaModel(llmModel.value, (p) => {
      if (p.status) llmPullStatus.value = p.status
      if (p.total && p.completed) {
        llmPullProgress.value = Math.round((p.completed / p.total) * 100)
      }
    })
    llmPulled.value = true
    llmPullStatus.value = 'done'
    await refreshInstalledLlms()
  } catch (e) {
    llmPullError.value = (e as Error).message
  } finally {
    llmPulling.value = false
  }
}

async function buildWhisper() {
  buildingWhisperCpp.value = true
  buildError.value = ''
  buildLog.value = ''
  try {
    await buildWhisperCpp((p) => {
      if (p.command) buildLog.value += `\n$ ${p.command}\n`
      if (p.stdout) buildLog.value += p.stdout
      if (p.stderr) buildLog.value += p.stderr
      if (p.status === 'done') buildLog.value += `\n[${p.step} ✓]\n`
    })
    whisperCppBuilt.value = true
    buildLog.value += '\n[ビルド完了 ✓]\n'
  } catch (e) {
    buildError.value = (e as Error).message
  } finally {
    buildingWhisperCpp.value = false
  }
}

async function downloadWhisper() {
  whisperDownloading.value = true
  whisperProgress.value = 0
  whisperStatus.value = 'starting...'
  whisperError.value = ''
  try {
    await downloadWhisperModelStream(whisperModel.value, (p) => {
      if (p.status) whisperStatus.value = p.status
      if (p.total && p.completed) {
        whisperProgress.value = Math.round((p.completed / p.total) * 100)
      }
    })
    whisperDownloaded.value = true
    whisperStatus.value = 'done'
  } catch (e) {
    whisperError.value = (e as Error).message
  } finally {
    whisperDownloading.value = false
  }
}

function next() {
  if (step.value < 6) step.value = (step.value + 1) as Step
}
function prev() {
  if (step.value > 1) step.value = (step.value - 1) as Step
}

function complete() {
  settings.update({
    llmModel: llmModel.value,
    whisperModel: whisperModel.value,
    aiCharacter: {
      name: aiName.value.trim() || 'Emma',
      gender: aiGender.value,
      // 既存設定の voiceName は保持(未設定なら null)
      voiceName: settings.settings.aiCharacter.voiceName ?? null,
      personality: aiPersonality.value,
    },
  })
  localStorage.setItem('speaky:onboarded', 'true')
  router.push('/')
}
</script>

<template>
  <div class="min-h-screen text-text">
    <div class="mx-auto flex min-h-screen max-w-3xl flex-col px-6 py-10">
      <header class="mb-8">
        <div class="text-2xl font-bold text-primary">speaky</div>
        <div class="mt-1 text-xs text-text-muted">
          初回セットアップ — ステップ {{ step }} / 6 · {{ stepLabels[step] }}
        </div>
        <div class="mt-3 grid grid-cols-6 gap-1">
          <div
            v-for="i in 6"
            :key="i"
            class="h-1 rounded-full"
            :class="i <= step ? 'bg-primary' : 'bg-border'"
          />
        </div>
      </header>

      <BaseCard class="flex-1">
        <div v-if="step === 1" class="space-y-4">
          <div class="flex justify-center">
            <AiMascot :size="140" mood="happy" :gender="aiGender" />
          </div>
          <h2 class="text-center text-xl font-semibold">英会話練習アプリ speaky へようこそ</h2>
          <p>
            このアプリは <strong>完全ローカル動作</strong> の英会話練習アプリです。
            Whisper(音声認識)・Ollama(LLM)・Web Speech API(音声合成) を組み合わせ、外部API課金ゼロで
            AI と英会話練習ができます。
          </p>
          <ul class="list-disc space-y-1 pl-5 text-sm text-text-muted">
            <li>マイクから英語/日本語で話しかけると AI が応答します</li>
            <li>添削・単語学習・復習リスト機能つき</li>
            <li>会話履歴は30日間ローカルに保存</li>
            <li>外部にデータが送信されることはありません</li>
          </ul>
          <p class="text-sm text-text-muted">初回セットアップを始めましょう。</p>
        </div>

        <div v-else-if="step === 2" class="space-y-4">
          <h2 class="text-xl font-semibold">LLM ランタイムを準備しています</h2>
          <p class="text-sm text-text-muted">Ollama の起動を待っています...</p>

          <div
            v-if="ollamaReady"
            class="rounded-lg bg-emerald-50 px-3 py-2 text-sm dark:bg-emerald-900/20"
          >
            ✅ 準備が完了しました。まもなく次のステップへ進みます。
          </div>
          <div
            v-else-if="ollamaWaitFailed"
            class="rounded-lg bg-rose-50 px-3 py-2 text-sm dark:bg-rose-900/20"
          >
            ❌ Ollama の起動に失敗しました。アプリを再起動してください。
            <div class="mt-3">
              <BaseButton variant="secondary" size="sm" @click="startOllamaPolling">
                🔄 再試行
              </BaseButton>
            </div>
          </div>
          <div v-else class="flex items-center gap-2 text-sm text-text-muted">
            <span
              class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent"
            />
            起動中...
          </div>
        </div>

        <div v-else-if="step === 3" class="space-y-4">
          <h2 class="text-xl font-semibold">モデル選択</h2>
          <p class="text-sm text-text-muted">
            利用する LLM と Whisper のモデルを選びます。後から設定で変更可能です。
          </p>

          <!--
            このマシンのメモリ。「軽量 / 標準 / 高品質」だけでは、ユーザーは
            自分の Mac がどれに当たるのか判断できない。言い切る。
          -->
          <div
            v-if="lowMemory"
            class="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
          >
            💡 この Mac のメモリは <strong>{{ memoryLabel }}</strong> です。
            <strong>同梱の軽量モデル</strong>を選んであります(ダウンロード不要です)。
            大きいモデルを選ぶと 1 回の返答に 30 秒以上かかったり、途中で止まったりします。
          </div>
          <div v-else-if="memoryLabel" class="text-xs text-text-muted">
            この Mac のメモリ: <strong class="text-text">{{ memoryLabel }}</strong>
          </div>

          <!--
            メモリに余裕がある Mac への案内。**選択は動かさない**。
            ネットが無い環境でも「入っているモデル」で先へ進めることが最優先で、
            3B は入っていれば選ばれるし、入っていなければここで薦めるだけにする。
          -->
          <div
            v-if="recommendedDownloadLabel"
            class="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:bg-sky-900/20 dark:text-sky-200"
          >
            💡 この Mac はメモリに余裕があります(<strong>{{ memoryLabel }}</strong
            >)。同梱の軽量モデルでもすぐ会話できますが、
            <strong>{{ recommendedDownloadLabel }}</strong>
            をダウンロードすると<strong>標準モード</strong>になり、
            <strong>添削と単語カード</strong>が出るようになります。
            次のステップで取得できます(オフラインなら後から設定画面でも取得できます)。
          </div>

          <div>
            <label class="block text-sm font-medium">LLM</label>
            <select
              v-model="llmModel"
              class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              @change="onLlmPicked"
            >
              <option v-for="o in llmOptions" :key="o.value" :value="o.value">
                {{ o.label }}
              </option>
            </select>
            <p
              v-if="!selectedLlmInstalled"
              class="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
            >
              ⚠ このモデルはまだ入っていません。次のステップでダウンロードが必要です(要ネット接続)。
              オフラインのままなら「同梱」と書かれたモデルを選んでください。
            </p>
            <p class="mt-1 text-xs text-text-muted">
              2B 以下のモデルを選ぶと <strong class="text-text">軽量モード</strong> で動きます(AI
              への指示を短くし、返答を 1〜2 文に制限(最初の挨拶だけは 3 文まで)。<strong
                class="text-text"
                >添削と単語カードは出ず</strong
              >、日本語訳だけを作ります)。 同梱の {{ bundledLlmName }} もこれに当たります —
              小さいモデルの添削は誤りが多く、 間違った学習材料を出すより出さない方がよいためです。
              大きいモデルを入れれば自動で標準モードに戻り、設定画面で固定もできます。
            </p>
          </div>
          <div>
            <label class="block text-sm font-medium">Whisper</label>
            <select
              v-model="whisperModel"
              class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              <option value="tiny">⚡⚡ tiny (~75MB)</option>
              <option value="base">⚡ base (~142MB)</option>
              <option value="small">⚡ small (~466MB / 同梱・おすすめ)</option>
              <option value="medium">⚖️ medium (~1.5GB / 16GB以上向け)</option>
              <option value="large-v1">🎯 large-v1 (~2.9GB)</option>
              <option value="large-v3-turbo">🎯 large-v3-turbo (~1.5GB)</option>
            </select>
          </div>
        </div>

        <div v-else-if="step === 4" class="space-y-5">
          <h2 class="text-xl font-semibold">モデルダウンロード</h2>
          <p class="text-sm text-text-muted">
            選択したモデルをダウンロードします。Wi-Fi推奨、合計で 5〜30 分。
          </p>

          <!-- LLM Pull -->
          <div class="rounded-lg border border-border p-4">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-sm font-medium">
                  LLM: <code class="font-mono">{{ llmModel }}</code>
                </div>
                <div class="text-xs text-text-muted">
                  {{
                    selectedLlmInstalled
                      ? '取得済み(ダウンロード不要)'
                      : 'Ollama 経由でダウンロード(要ネット接続)'
                  }}
                </div>
              </div>
              <span
                v-if="selectedLlmInstalled"
                class="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
              >
                ✓ 取得済み
              </span>
            </div>
            <BaseButton
              v-if="!selectedLlmInstalled"
              class="mt-3"
              size="sm"
              :disabled="llmPulling"
              @click="pullLlm"
            >
              {{ llmPulling ? '取得中...' : '📥 LLM をダウンロード' }}
            </BaseButton>
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

          <!-- whisper.cpp build -->
          <div class="rounded-lg border border-border p-4">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-sm font-medium">whisper.cpp ビルド</div>
                <div class="text-xs text-text-muted">音声認識エンジン(通常は配布版に同梱済み)</div>
              </div>
              <span
                v-if="whisperCppBuilt"
                class="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
              >
                ✓ ビルド済み
              </span>
            </div>
            <BaseButton
              v-if="!whisperCppBuilt"
              class="mt-3"
              size="sm"
              :disabled="buildingWhisperCpp"
              @click="buildWhisper"
            >
              {{ buildingWhisperCpp ? 'ビルド中...' : '🔨 ビルドする' }}
            </BaseButton>
            <pre
              v-if="buildLog"
              class="mt-2 max-h-32 overflow-y-auto rounded bg-bg p-2 font-mono text-[10px]"
              >{{ buildLog }}</pre
            >
            <p v-if="buildError" class="mt-2 text-xs text-rose-500">
              {{ buildError }}
            </p>
          </div>

          <!-- Whisper download -->
          <div class="rounded-lg border border-border p-4">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-sm font-medium">
                  Whisper: <code class="font-mono">{{ whisperModel }}</code>
                </div>
                <div class="text-xs text-text-muted">音声認識モデルをダウンロード</div>
              </div>
              <span
                v-if="whisperDownloaded"
                class="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
              >
                ✓ 取得済み
              </span>
            </div>
            <BaseButton
              v-if="!whisperDownloaded"
              class="mt-3"
              size="sm"
              :disabled="whisperDownloading || !whisperCppBuilt"
              @click="downloadWhisper"
            >
              {{ whisperDownloading ? '取得中...' : '📥 Whisper をダウンロード' }}
            </BaseButton>
            <p v-if="!whisperCppBuilt" class="mt-2 text-xs text-amber-600 dark:text-amber-400">
              ⚠ 先に whisper.cpp をビルドしてください
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

          <p class="text-xs text-text-muted">すべて ✓ になったら「次へ」を押してください。</p>
        </div>

        <div v-else-if="step === 5" class="space-y-4">
          <h2 class="text-xl font-semibold">AIキャラクター設定</h2>
          <p class="text-sm text-text-muted">会話相手のAIに名前を付けます。</p>
          <div>
            <label class="block text-sm font-medium">名前</label>
            <input
              v-model="aiName"
              type="text"
              class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            />
            <div class="mt-2 text-xs text-text-muted">候補: Emma · Mike · Alex · Sarah · James</div>
          </div>
          <div>
            <div class="text-sm font-medium">性別 / 声</div>
            <div class="mt-2 flex gap-2">
              <BaseButton
                :variant="aiGender === 'female' ? 'primary' : 'secondary'"
                size="sm"
                @click="aiGender = 'female'"
              >
                女性 (Samantha)
              </BaseButton>
              <BaseButton
                :variant="aiGender === 'male' ? 'primary' : 'secondary'"
                size="sm"
                @click="aiGender = 'male'"
              >
                男性 (Daniel)
              </BaseButton>
            </div>
          </div>
          <div>
            <label class="block text-sm font-medium">性格(後から設定で変更できます)</label>
            <select
              v-model="aiPersonality"
              class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              <option v-for="p in personalityPresets" :key="p.value" :value="p.value">
                {{ p.icon }} {{ p.label }} — {{ p.desc }}
              </option>
            </select>
          </div>
        </div>

        <div v-else-if="step === 6" class="space-y-3">
          <h2 class="text-xl font-semibold">準備完了!</h2>
          <p class="text-sm">
            これで設定は完了です。「会話を始める」をクリックして最初の会話に進みましょう。
          </p>
          <p class="text-xs text-text-muted">これらの設定は後から「設定」画面で変更できます。</p>
        </div>
      </BaseCard>

      <footer class="mt-6 flex items-center justify-between">
        <BaseButton variant="ghost" :disabled="step === 1" @click="prev"> ← 戻る </BaseButton>
        <BaseButton
          v-if="step < 6"
          :disabled="
            (step === 2 && !ollamaReady) ||
            (step === 4 && (!selectedLlmInstalled || !whisperCppBuilt || !whisperDownloaded))
          "
          @click="next"
        >
          次へ →
        </BaseButton>
        <BaseButton v-else @click="complete">会話を始める</BaseButton>
      </footer>
    </div>
  </div>
</template>

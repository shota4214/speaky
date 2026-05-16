<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import {
  buildWhisperCpp,
  checkOllamaHealth,
  downloadWhisperModelStream,
  getWhisperCppStatus,
  listOllamaModels,
  listWhisperModels,
  pullOllamaModel,
} from '../services/api'
import { useSettingsStore } from '../stores/settings'

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

const ollamaStatus = ref<'unknown' | 'checking' | 'ok' | 'error'>('unknown')
const ollamaError = ref<string>('')
const hasDefaultModel = ref(false)
const availableModels = ref<string[]>([])

async function checkOllama() {
  ollamaStatus.value = 'checking'
  ollamaError.value = ''
  const res = await checkOllamaHealth()
  if (res.ok) {
    ollamaStatus.value = 'ok'
    hasDefaultModel.value = res.hasDefaultModel ?? false
    availableModels.value = res.models ?? []
  } else {
    ollamaStatus.value = 'error'
    ollamaError.value = res.error ?? 'Ollama not reachable'
  }
}

watch(step, (s) => {
  if (s === 2) checkOllama()
  if (s === 4) refreshStep4Status()
})

onMounted(() => {
  if (step.value === 2) checkOllama()
  if (step.value === 4) refreshStep4Status()
})

const llmModel = ref(settings.settings.llmModel)
const whisperModel = ref(settings.settings.whisperModel)
const aiName = ref(settings.settings.aiCharacter.name)
const aiGender = ref<'female' | 'male'>(settings.settings.aiCharacter.gender)

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

async function refreshStep4Status() {
  try {
    const llmList = await listOllamaModels()
    llmPulled.value = llmList.models.some((m) => m.name === llmModel.value)
  } catch {
    llmPulled.value = false
  }
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
    aiCharacter: { name: aiName.value.trim() || 'Emma', gender: aiGender.value },
  })
  localStorage.setItem('speaky:onboarded', 'true')
  router.push('/')
}
</script>

<template>
  <div class="min-h-screen bg-bg text-text">
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
          <h2 class="text-xl font-semibold">英会話練習アプリ speaky へようこそ</h2>
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
          <h2 class="text-xl font-semibold">Ollama の確認</h2>
          <p class="text-sm">Ollama がローカルで起動しているか確認します。</p>

          <div
            v-if="ollamaStatus === 'checking'"
            class="rounded-lg bg-amber-50 px-3 py-2 text-sm dark:bg-amber-900/20"
          >
            🔄 確認中...
          </div>
          <div
            v-else-if="ollamaStatus === 'ok'"
            class="rounded-lg bg-emerald-50 px-3 py-2 text-sm dark:bg-emerald-900/20"
          >
            ✅ Ollama に接続できました
            <div class="mt-2 text-xs text-text-muted">
              利用可能なモデル: {{ availableModels.join(', ') || '(なし)' }}
            </div>
            <div
              v-if="!hasDefaultModel"
              class="mt-2 rounded bg-amber-100 px-2 py-1 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
            >
              ⚠ デフォルトモデル(gemma2:9b)が未取得です。次のステップでダウンロードします。
            </div>
          </div>
          <div
            v-else-if="ollamaStatus === 'error'"
            class="rounded-lg bg-rose-50 px-3 py-2 text-sm dark:bg-rose-900/20"
          >
            ❌ Ollama に接続できませんでした
            <div class="mt-1 text-xs text-text-muted">{{ ollamaError }}</div>
            <div class="mt-3 space-y-1 text-xs">
              <div>インストール: <code>brew install ollama</code></div>
              <div>起動: <code>brew services start ollama</code></div>
              <div>または: <code>ollama serve</code>(フォアグラウンド)</div>
            </div>
          </div>

          <BaseButton variant="secondary" size="sm" @click="checkOllama">
            🔄 再チェック
          </BaseButton>
        </div>

        <div v-else-if="step === 3" class="space-y-4">
          <h2 class="text-xl font-semibold">モデル選択</h2>
          <p class="text-sm text-text-muted">
            利用する LLM と Whisper のモデルを選びます。後から設定で変更可能です。
          </p>
          <div>
            <label class="block text-sm font-medium">LLM</label>
            <select
              v-model="llmModel"
              class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              <option value="llama3.2:3b">軽量 (Llama 3.2 3B / ~2GB)</option>
              <option value="gemma2:9b">推奨 (Gemma 2 9B / ~5.5GB)</option>
              <option value="qwen2.5:14b">高精度 (Qwen 2.5 14B / ~9GB)</option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium">Whisper</label>
            <select
              v-model="whisperModel"
              class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              <option value="small">small (~500MB)</option>
              <option value="medium">medium (~1.5GB)</option>
              <option value="large-v3">large-v3 (~3GB)</option>
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
                <div class="text-xs text-text-muted">Ollama 経由でダウンロード</div>
              </div>
              <span
                v-if="llmPulled"
                class="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
              >
                ✓ 取得済み
              </span>
            </div>
            <BaseButton
              v-if="!llmPulled"
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
                <div class="text-xs text-text-muted">
                  音声認識エンジンを最初に1回だけビルド(cmake が必要)
                </div>
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
            (step === 2 && ollamaStatus !== 'ok') ||
            (step === 4 && (!llmPulled || !whisperCppBuilt || !whisperDownloaded))
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

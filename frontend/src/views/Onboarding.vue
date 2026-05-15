<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import { checkOllamaHealth } from '../services/api'
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
})

onMounted(() => {
  if (step.value === 2) checkOllama()
})

const llmModel = ref(settings.settings.llmModel)
const whisperModel = ref(settings.settings.whisperModel)
const aiName = ref(settings.settings.aiCharacter.name)
const aiGender = ref<'female' | 'male'>(settings.settings.aiCharacter.gender)

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
            Whisper(音声認識)・Ollama(LLM)・Web Speech API(音声合成)
            を組み合わせ、外部API課金ゼロで AI と英会話練習ができます。
          </p>
          <ul class="list-disc space-y-1 pl-5 text-sm text-text-muted">
            <li>マイクから英語/日本語で話しかけると AI が応答します</li>
            <li>添削・単語学習・復習リスト機能つき</li>
            <li>会話履歴は30日間ローカルに保存</li>
            <li>外部にデータが送信されることはありません</li>
          </ul>
          <p class="text-sm text-text-muted">
            初回セットアップを始めましょう。
          </p>
        </div>

        <div v-else-if="step === 2" class="space-y-4">
          <h2 class="text-xl font-semibold">Ollama の確認</h2>
          <p class="text-sm">
            Ollama がローカルで起動しているか確認します。
          </p>

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

        <div v-else-if="step === 4" class="space-y-4">
          <h2 class="text-xl font-semibold">モデルダウンロード</h2>
          <p class="text-sm text-text-muted">
            次のコマンドをターミナルで実行してください(初回のみ):
          </p>
          <div class="rounded-lg bg-bg p-3 font-mono text-xs">
            <div># LLM(数GB、Wi-Fi推奨)</div>
            <div>ollama pull {{ llmModel }}</div>
            <div class="mt-2"># Whisper モデル + whisper.cpp ビルド</div>
            <div>cd backend</div>
            <div>npx --yes nodejs-whisper download</div>
            <div>(プロンプトで {{ whisperModel }} と入力)</div>
          </div>
          <p class="text-xs text-text-muted">
            ダウンロード完了後、このページに戻って「次へ」を押してください。
          </p>
        </div>

        <div v-else-if="step === 5" class="space-y-4">
          <h2 class="text-xl font-semibold">AIキャラクター設定</h2>
          <p class="text-sm text-text-muted">
            会話相手のAIに名前を付けます。
          </p>
          <div>
            <label class="block text-sm font-medium">名前</label>
            <input
              v-model="aiName"
              type="text"
              class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            />
            <div class="mt-2 text-xs text-text-muted">
              候補: Emma · Mike · Alex · Sarah · James
            </div>
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
          <p class="text-xs text-text-muted">
            これらの設定は後から「設定」画面で変更できます。
          </p>
        </div>
      </BaseCard>

      <footer class="mt-6 flex items-center justify-between">
        <BaseButton variant="ghost" :disabled="step === 1" @click="prev">
          ← 戻る
        </BaseButton>
        <BaseButton
          v-if="step < 6"
          :disabled="step === 2 && ollamaStatus !== 'ok'"
          @click="next"
        >
          次へ →
        </BaseButton>
        <BaseButton v-else @click="complete">会話を始める</BaseButton>
      </footer>
    </div>
  </div>
</template>

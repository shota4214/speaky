<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAudioRecorder } from '../composables/useAudioRecorder'

const { state: recState, error: recError, audioLevel, start, stop, activeMimeType } =
  useAudioRecorder()

type TestState = 'idle' | 'recording' | 'transcribing' | 'done' | 'error'

const testState = ref<TestState>('idle')
const transcribedText = ref<string>('')
const detectedLanguage = ref<string>('')
const transcribeDurationMs = ref<number>(0)
const errorMessage = ref<string>('')

async function handleStart() {
  testState.value = 'recording'
  errorMessage.value = ''
  transcribedText.value = ''

  try {
    const blob = await start()

    testState.value = 'transcribing'
    const form = new FormData()
    const ext = activeMimeType().includes('mp4') ? 'mp4' : 'webm'
    form.append('audio', blob, `recording.${ext}`)

    const res = await fetch('/api/transcribe', { method: 'POST', body: form })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`HTTP ${res.status}: ${body}`)
    }

    const data = (await res.json()) as {
      text: string
      language: string
      durationMs: number
    }
    transcribedText.value = data.text
    detectedLanguage.value = data.language
    transcribeDurationMs.value = data.durationMs
    testState.value = 'done'
  } catch (e) {
    errorMessage.value = (e as Error).message
    testState.value = 'error'
  }
}

function handleStop() {
  stop()
}

const barCount = 32
const bars = computed(() => {
  const level = audioLevel.value
  const arr: number[] = []
  for (let i = 0; i < barCount; i++) {
    const t = i / (barCount - 1)
    const distance = Math.abs(t - 0.5) * 2
    const localFactor = Math.cos((distance * Math.PI) / 2)
    arr.push(Math.min(1, level * 12 * localFactor + 0.05))
  }
  return arr
})

const statusLabel = computed(() => {
  switch (testState.value) {
    case 'idle':
      return 'Ready'
    case 'recording':
      return 'Listening...'
    case 'transcribing':
      return 'Processing audio...'
    case 'done':
      return `Done (${transcribeDurationMs.value}ms)`
    case 'error':
      return 'Error'
    default:
      return ''
  }
})
</script>

<template>
  <main
    class="min-h-screen bg-gradient-to-br from-emerald-50 to-sky-50 dark:from-slate-900 dark:to-slate-800 p-8"
  >
    <div class="mx-auto max-w-3xl">
      <div class="flex items-center justify-between">
        <h1 class="text-3xl font-bold text-slate-900 dark:text-slate-100">
          Prototype: Audio Recording
        </h1>
        <router-link
          to="/"
          class="text-sm text-slate-600 dark:text-slate-400 hover:underline"
        >
          ← home
        </router-link>
      </div>
      <p class="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Task 1.4 — マイク録音 + 無音検出 + /api/transcribe 接続テスト
      </p>

      <div
        class="mt-8 rounded-2xl bg-white dark:bg-slate-900 p-8 shadow-xl ring-1 ring-slate-200 dark:ring-slate-700"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span
              class="h-2.5 w-2.5 rounded-full"
              :class="{
                'bg-slate-300 dark:bg-slate-600': testState === 'idle',
                'bg-red-500 animate-pulse': testState === 'recording',
                'bg-amber-500 animate-pulse': testState === 'transcribing',
                'bg-emerald-500': testState === 'done',
                'bg-rose-500': testState === 'error',
              }"
            />
            <span class="text-sm font-medium text-slate-700 dark:text-slate-300">{{
              statusLabel
            }}</span>
          </div>
          <span
            v-if="testState === 'done'"
            class="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-1 text-xs text-slate-600 dark:text-slate-400"
          >
            lang: {{ detectedLanguage }}
          </span>
        </div>

        <div class="mt-6 flex h-24 items-center justify-center gap-1">
          <span
            v-for="(h, i) in bars"
            :key="i"
            class="w-1.5 rounded-full transition-all duration-75"
            :class="
              testState === 'recording'
                ? 'bg-emerald-500'
                : 'bg-slate-300 dark:bg-slate-700'
            "
            :style="{ height: `${h * 100}%` }"
          />
        </div>

        <div class="mt-6 flex gap-3">
          <button
            v-if="testState !== 'recording'"
            class="flex-1 rounded-xl bg-emerald-500 hover:bg-emerald-600 px-6 py-3 text-white font-medium shadow-sm transition disabled:opacity-50"
            :disabled="testState === 'transcribing'"
            @click="handleStart"
          >
            <template v-if="testState === 'transcribing'">処理中...</template>
            <template v-else>🎤 録音開始(無音2秒で自動送信)</template>
          </button>
          <button
            v-else
            class="flex-1 rounded-xl bg-rose-500 hover:bg-rose-600 px-6 py-3 text-white font-medium shadow-sm transition"
            @click="handleStop"
          >
            ⏹ 録音停止
          </button>
        </div>

        <div
          v-if="testState === 'done'"
          class="mt-6 rounded-xl bg-slate-50 dark:bg-slate-800 p-4"
        >
          <div class="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Transcribed text
          </div>
          <div class="mt-1 text-slate-900 dark:text-slate-100">{{ transcribedText }}</div>
        </div>

        <div
          v-if="testState === 'error' || recError"
          class="mt-6 rounded-xl bg-rose-50 dark:bg-rose-950/30 p-4 text-sm text-rose-700 dark:text-rose-300"
        >
          {{ errorMessage || recError }}
        </div>
      </div>

      <div class="mt-6 text-xs text-slate-500 dark:text-slate-400">
        <p>使い方:</p>
        <ol class="mt-2 list-decimal list-inside space-y-1">
          <li>「録音開始」(初回はマイクの権限ダイアログ)</li>
          <li>マイクに向かって話す(波形が動く)</li>
          <li>2秒沈黙で自動停止 → /api/transcribe へ送信</li>
          <li>テキスト結果が表示される</li>
        </ol>
        <p class="mt-2">
          recorder state: <code class="font-mono">{{ recState }}</code> /
          mime: <code class="font-mono">{{ activeMimeType() || 'default' }}</code>
        </p>
      </div>
    </div>
  </main>
</template>
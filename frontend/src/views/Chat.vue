<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useAudioRecorder } from '../composables/useAudioRecorder'
import { useTextToSpeech } from '../composables/useTextToSpeech'

type LoopState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'stopped'
  | 'error'

interface UserMessage {
  id: string
  role: 'user'
  text: string
  language: string
  timestamp: Date
}

interface AiMessage {
  id: string
  role: 'ai'
  replyEn: string
  replyJa: string
  timestamp: Date
}

type ChatMessage = UserMessage | AiMessage

const audioRecorder = useAudioRecorder()
const tts = useTextToSpeech({ rate: 1.0 })

const loopState = ref<LoopState>('idle')
const stopRequested = ref(false)
const messages = ref<ChatMessage[]>([])
const errorMessage = ref<string>('')
const turnTimings = ref<{ transcribe: number; chat: number; speak: number }[]>([])
const logEndRef = ref<HTMLDivElement | null>(null)

watch(
  messages,
  async () => {
    await nextTick()
    logEndRef.value?.scrollIntoView({ behavior: 'smooth' })
  },
  { deep: true },
)

async function transcribe(
  blob: Blob,
): Promise<{ text: string; language: string; durationMs: number }> {
  const form = new FormData()
  const mime = audioRecorder.activeMimeType()
  const ext = mime.includes('mp4')
    ? 'mp4'
    : mime.includes('ogg')
      ? 'ogg'
      : 'webm'
  form.append('audio', blob, `recording.${ext}`)
  const res = await fetch('/api/transcribe', { method: 'POST', body: form })
  if (!res.ok) {
    throw new Error(`transcribe HTTP ${res.status}: ${await res.text()}`)
  }
  return await res.json()
}

async function chat(
  userText: string,
): Promise<{ reply_en: string; reply_ja: string }> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userText }),
  })
  if (!res.ok) throw new Error(`chat HTTP ${res.status}: ${await res.text()}`)
  return await res.json()
}

async function runLoop() {
  try {
    while (!stopRequested.value) {
      loopState.value = 'recording'
      const blob = await audioRecorder.start()
      if (stopRequested.value) break

      loopState.value = 'transcribing'
      const t0 = Date.now()
      const transcription = await transcribe(blob)
      const tDur = Date.now() - t0
      if (stopRequested.value) break

      if (!transcription.text.trim()) {
        continue
      }

      messages.value.push({
        id: crypto.randomUUID(),
        role: 'user',
        text: transcription.text,
        language: transcription.language,
        timestamp: new Date(),
      })

      loopState.value = 'thinking'
      const c0 = Date.now()
      const reply = await chat(transcription.text)
      const cDur = Date.now() - c0
      if (stopRequested.value) break

      messages.value.push({
        id: crypto.randomUUID(),
        role: 'ai',
        replyEn: reply.reply_en,
        replyJa: reply.reply_ja,
        timestamp: new Date(),
      })

      loopState.value = 'speaking'
      const s0 = Date.now()
      await tts.speak(reply.reply_en)
      const sDur = Date.now() - s0

      turnTimings.value.push({ transcribe: tDur, chat: cDur, speak: sDur })

      if (stopRequested.value) break
    }
  } catch (e) {
    errorMessage.value = (e as Error).message
    loopState.value = 'error'
    return
  }
  loopState.value = 'stopped'
}

const isActive = computed(() =>
  ['recording', 'transcribing', 'thinking', 'speaking'].includes(loopState.value),
)

function handleStart() {
  if (isActive.value) return
  stopRequested.value = false
  messages.value = []
  errorMessage.value = ''
  turnTimings.value = []
  runLoop()
}

function handleStop() {
  stopRequested.value = true
  audioRecorder.stop()
  tts.cancel()
}

function replayText(text: string) {
  tts.speak(text)
}

const statusLabel = computed(() => {
  switch (loopState.value) {
    case 'idle':
      return 'Ready'
    case 'recording':
      return '🎙 Listening...'
    case 'transcribing':
      return '📝 Transcribing...'
    case 'thinking':
      return '🤔 Thinking...'
    case 'speaking':
      return '🗣 Speaking...'
    case 'stopped':
      return 'Stopped'
    case 'error':
      return 'Error'
    default:
      return ''
  }
})

const barCount = 32
const bars = computed(() => {
  const level = audioRecorder.audioLevel.value
  const arr: number[] = []
  for (let i = 0; i < barCount; i++) {
    const t = i / (barCount - 1)
    const distance = Math.abs(t - 0.5) * 2
    const localFactor = Math.cos((distance * Math.PI) / 2)
    arr.push(Math.min(1, level * 12 * localFactor + 0.05))
  }
  return arr
})

function formatTime(d: Date): string {
  return d.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

const lastTurnTotal = computed(() => {
  const last = turnTimings.value[turnTimings.value.length - 1]
  if (!last) return 0
  return last.transcribe + last.chat + last.speak
})
</script>

<template>
  <main
    class="min-h-screen bg-gradient-to-br from-emerald-50 to-sky-50 dark:from-slate-900 dark:to-slate-800"
  >
    <div class="mx-auto max-w-4xl px-6 py-8">
      <div class="flex items-center justify-between">
        <h1 class="text-3xl font-bold text-slate-900 dark:text-slate-100">Chat</h1>
        <router-link
          to="/"
          class="text-sm text-slate-600 dark:text-slate-400 hover:underline"
          >← home</router-link
        >
      </div>
      <p class="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Task 1.5 — Whisper → Ollama → Web Speech API のフルループ
      </p>

      <!-- Conversation log -->
      <div
        class="mt-6 min-h-[400px] max-h-[600px] overflow-y-auto rounded-2xl bg-white dark:bg-slate-900 p-6 shadow-xl ring-1 ring-slate-200 dark:ring-slate-700"
      >
        <div
          v-if="messages.length === 0"
          class="flex h-80 flex-col items-center justify-center text-center text-slate-400 dark:text-slate-500"
        >
          <div class="text-6xl">🎤</div>
          <p class="mt-4 text-sm">「会話を始める」をクリックして話しかけてください</p>
        </div>
        <div v-else class="space-y-4">
          <div v-for="m in messages" :key="m.id">
            <div v-if="m.role === 'user'" class="flex justify-end">
              <div
                class="max-w-[75%] rounded-2xl rounded-br-md bg-emerald-500 px-4 py-3 text-white shadow-sm"
              >
                <div class="text-sm">{{ m.text }}</div>
                <div class="mt-1 text-[10px] text-emerald-100 opacity-80">
                  {{ formatTime(m.timestamp) }} · lang: {{ m.language }}
                </div>
              </div>
            </div>
            <div v-else class="flex justify-start">
              <div
                class="max-w-[75%] rounded-2xl rounded-bl-md bg-slate-100 dark:bg-slate-800 px-4 py-3 text-slate-900 dark:text-slate-100 shadow-sm"
              >
                <div class="text-sm">{{ m.replyEn }}</div>
                <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {{ m.replyJa }}
                </div>
                <button
                  class="mt-2 flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                  @click="replayText(m.replyEn)"
                >
                  🔊 もう一度聞く
                </button>
              </div>
            </div>
          </div>
          <div ref="logEndRef"></div>
        </div>
      </div>

      <!-- Mic state + controls -->
      <div
        class="mt-6 rounded-2xl bg-white dark:bg-slate-900 p-6 shadow-xl ring-1 ring-slate-200 dark:ring-slate-700"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span
              class="h-2.5 w-2.5 rounded-full"
              :class="{
                'bg-slate-300 dark:bg-slate-600':
                  loopState === 'idle' || loopState === 'stopped',
                'bg-red-500 animate-pulse': loopState === 'recording',
                'bg-amber-500 animate-pulse':
                  loopState === 'transcribing' || loopState === 'thinking',
                'bg-blue-500 animate-pulse': loopState === 'speaking',
                'bg-rose-500': loopState === 'error',
              }"
            />
            <span class="text-sm font-medium text-slate-700 dark:text-slate-300">{{
              statusLabel
            }}</span>
          </div>
          <span
            v-if="turnTimings.length > 0"
            class="text-xs text-slate-500 dark:text-slate-400"
          >
            {{ turnTimings.length }} turn{{ turnTimings.length === 1 ? '' : 's' }} ·
            last: {{ lastTurnTotal }}ms
          </span>
        </div>

        <div class="mt-4 flex h-20 items-center justify-center gap-1">
          <span
            v-for="(h, i) in bars"
            :key="i"
            class="w-1.5 rounded-full transition-all duration-75"
            :class="
              loopState === 'recording'
                ? 'bg-emerald-500'
                : 'bg-slate-300 dark:bg-slate-700'
            "
            :style="{ height: `${h * 100}%` }"
          />
        </div>

        <div class="mt-4 flex gap-3">
          <button
            v-if="!isActive"
            class="flex-1 rounded-xl bg-emerald-500 px-6 py-3 font-medium text-white shadow-sm transition hover:bg-emerald-600"
            @click="handleStart"
          >
            🎤 会話を始める
          </button>
          <button
            v-else
            class="flex-1 rounded-xl bg-rose-500 px-6 py-3 font-medium text-white shadow-sm transition hover:bg-rose-600"
            @click="handleStop"
          >
            ⏹ 会話を終わる
          </button>
        </div>

        <div
          v-if="errorMessage"
          class="mt-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 p-3 text-xs text-rose-700 dark:text-rose-300"
        >
          {{ errorMessage }}
        </div>
      </div>

      <div class="mt-4 text-xs text-slate-500 dark:text-slate-400">
        💡 一度だけ「会話を始める」 → 話す → 2秒沈黙でAI応答 → 自動で次のターン。終わるときは「会話を終わる」。
      </div>
    </div>
  </main>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeMount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import LevelBadge from '../components/LevelBadge.vue'
import TopicChip from '../components/TopicChip.vue'
import { useConversationLoop } from '../composables/useConversationLoop'
import { conversationsRepo } from '../db/repos/conversations'
import { vocabularyRepo } from '../db/repos/vocabulary'
import type { Message, VocabItem } from '../db/types'
import { useConversationStore } from '../stores/conversation'
import { useVocabularyStore } from '../stores/vocabulary'

const router = useRouter()
const conversation = useConversationStore()
const vocabStore = useVocabularyStore()
const loop = useConversationLoop()

const lastSummary = ref<string | null>(null)
const vocabFocusWords = ref<string[]>([])
const savedVocab = ref<Set<string>>(new Set())
const logEndRef = ref<HTMLDivElement | null>(null)
const showInactivityDialog = ref(false)

onBeforeMount(() => {
  if (!conversation.id) {
    router.replace('/')
  }
})

onMounted(async () => {
  if (!conversation.id) return

  // 別の最近の会話の要約を「前回の話」として渡す
  const recent = await conversationsRepo.list({ limit: 5 })
  const previous = recent.find((c) => c.id !== conversation.id && c.summary)
  lastSummary.value = previous?.summary ?? null

  // vocab focus
  if (conversation.vocabFocusIds.length > 0) {
    const items = await Promise.all(
      conversation.vocabFocusIds.map((id) => vocabularyRepo.get(id)),
    )
    vocabFocusWords.value = items
      .filter((v): v is NonNullable<typeof v> => v != null)
      .map((v) => v.word)
  }

  await loop.start({
    conversationId: conversation.id,
    vocabFocusWords: vocabFocusWords.value,
    lastConversationSummary: lastSummary.value,
  })
})

watch(
  () => conversation.messages.length,
  async () => {
    await nextTick()
    logEndRef.value?.scrollIntoView({ behavior: 'smooth' })
  },
)

// 3回連続沈黙で「会話続けますか?」ダイアログを表示
watch(
  () => loop.consecutiveSilent.value,
  (count, prev) => {
    if (count >= 3 && (prev ?? 0) < 3) {
      showInactivityDialog.value = true
    }
  },
)

function continueConversation() {
  showInactivityDialog.value = false
  loop.consecutiveSilent.value = 0
}

async function endFromDialog() {
  showInactivityDialog.value = false
  await handleEnd()
}

const isActive = computed(() =>
  [
    'recording',
    'processing',
    'thinking',
    'aiSpeaking',
    'awaitingPromptedSpeech',
  ].includes(conversation.mode),
)

const statusLabel = computed(() => {
  switch (conversation.mode) {
    case 'idle':
      return 'Ready'
    case 'recording':
      return '🎙 Listening...'
    case 'processing':
      return '📝 Transcribing...'
    case 'thinking':
      return '🤔 Thinking...'
    case 'aiSpeaking':
      return '🗣 Speaking...'
    case 'awaitingPromptedSpeech':
      return '👂 言ってみて...'
    default:
      return ''
  }
})

const statusDotClass = computed(() => ({
  'bg-text-muted/50': conversation.mode === 'idle',
  'bg-rose-500 animate-pulse': conversation.mode === 'recording',
  'bg-amber-500 animate-pulse':
    conversation.mode === 'processing' || conversation.mode === 'thinking',
  'bg-sky-500 animate-pulse': conversation.mode === 'aiSpeaking',
  'bg-violet-500 animate-pulse':
    conversation.mode === 'awaitingPromptedSpeech',
}))

const barCount = 32
const bars = computed(() => {
  const level = loop.recorder.audioLevel.value
  const arr: number[] = []
  for (let i = 0; i < barCount; i++) {
    const t = i / (barCount - 1)
    const distance = Math.abs(t - 0.5) * 2
    const localFactor = Math.cos((distance * Math.PI) / 2)
    arr.push(Math.min(1, level * 12 * localFactor + 0.05))
  }
  return arr
})

async function handleEnd() {
  loop.stop()
  const id = await loop.endAndPersist()
  conversation.end()
  vocabStore.clear()
  if (id) {
    await router.push({ path: '/chat/summary', query: { id } })
  } else {
    await router.push('/')
  }
}

async function saveVocabItem(message: Message, item: VocabItem) {
  await vocabularyRepo.create({
    word: item.word,
    meaning: item.meaning,
    example: item.example,
    partOfSpeech: null,
  })
  savedVocab.value = new Set([
    ...savedVocab.value,
    `${message.id}:${item.word}`,
  ])
}

async function saveAllFromMessage(message: Message) {
  if (!message.vocabulary) return
  for (const item of message.vocabulary) {
    if (savedVocab.value.has(`${message.id}:${item.word}`)) continue
    await saveVocabItem(message, item)
  }
}

function replayText(text: string) {
  loop.tts.speak(text)
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function isVocabSaved(message: Message, word: string): boolean {
  return savedVocab.value.has(`${message.id}:${word}`)
}
</script>

<template>
  <div class="flex h-screen flex-col bg-bg text-text">
    <header class="border-b border-border px-6 py-3">
      <div class="mx-auto flex max-w-4xl items-center justify-between">
        <div>
          <h1 class="text-lg font-semibold">会話中</h1>
          <div class="mt-1 flex items-center gap-2 text-xs">
            <LevelBadge :level="conversation.level" size="sm" />
            <TopicChip :label="conversation.topic" size="sm" />
            <span v-if="conversation.isPaused" class="text-amber-500">
              ⏸ 一時停止中
            </span>
          </div>
        </div>
        <BaseButton variant="danger" size="sm" @click="handleEnd">
          ⏹ 会話を終わる
        </BaseButton>
      </div>
    </header>

    <div class="flex-1 overflow-y-auto px-6 py-6">
      <div class="mx-auto max-w-3xl space-y-4">
        <div
          v-if="conversation.messages.length === 0"
          class="flex h-64 flex-col items-center justify-center text-center text-text-muted"
        >
          <div class="text-5xl">🎤</div>
          <p class="mt-3 text-sm">話しかけてください...</p>
        </div>

        <div v-for="m in conversation.messages" :key="m.id">
          <div v-if="m.role === 'user'" class="flex justify-end">
            <div
              class="max-w-[75%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-white shadow-sm"
            >
              <div class="text-sm">{{ m.userText }}</div>
              <div class="mt-1 text-[10px] opacity-80">
                {{ formatTime(m.timestamp) }} · lang:
                {{ m.inputLanguage ?? '—' }}
              </div>
            </div>
          </div>

          <div v-else class="flex flex-col items-start space-y-2">
            <div class="flex w-full justify-start">
              <div
                class="max-w-[75%] rounded-2xl rounded-bl-md bg-surface px-4 py-3 shadow-sm ring-1 ring-border"
              >
                <div class="text-sm">{{ m.replyEn }}</div>
                <div class="mt-1 text-xs text-text-muted">{{ m.replyJa }}</div>
                <div class="mt-2 flex items-center gap-2">
                  <button
                    class="text-[10px] text-text-muted hover:text-text"
                    @click="replayText(m.replyEn ?? '')"
                  >
                    🔊 もう一度聞く
                  </button>
                  <span
                    v-if="m.mode === 'japanese_help' || m.mode === 'mixed'"
                    class="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] text-violet-700 dark:bg-violet-900/30 dark:text-violet-300"
                  >
                    言ってみて
                  </span>
                </div>
              </div>
            </div>

            <div
              v-if="m.feedback"
              class="ml-2 max-w-[75%] rounded-xl bg-amber-50 px-3 py-2 text-xs ring-1 ring-amber-200 dark:bg-amber-900/20 dark:ring-amber-700/40"
            >
              <div class="font-semibold text-amber-700 dark:text-amber-300">
                ✏️ 添削
              </div>
              <div class="mt-1">
                <span class="text-rose-500 line-through">{{
                  m.feedback.userSaid
                }}</span>
                <span class="mx-1 text-text-muted">→</span>
                <strong class="text-emerald-600 dark:text-emerald-400">{{
                  m.feedback.corrected
                }}</strong>
              </div>
              <div class="mt-1 text-text-muted">
                {{ m.feedback.explanation }}
              </div>
            </div>

            <div
              v-if="m.vocabulary && m.vocabulary.length > 0"
              class="ml-2 max-w-[75%] rounded-xl bg-primary-light/40 px-3 py-2 text-xs"
            >
              <div class="flex items-center justify-between">
                <div class="font-semibold text-primary-dark">
                  📚 単語・フレーズ
                </div>
                <button
                  class="text-[10px] text-primary hover:underline"
                  @click="saveAllFromMessage(m)"
                >
                  ♡ 全部覚えたい
                </button>
              </div>
              <ul class="mt-2 space-y-1.5">
                <li
                  v-for="v in m.vocabulary"
                  :key="v.word"
                  class="flex items-start justify-between gap-2"
                >
                  <div>
                    <strong>{{ v.word }}</strong>
                    <span class="ml-2 text-text-muted">— {{ v.meaning }}</span>
                    <div
                      v-if="v.example"
                      class="text-[10px] italic text-text-muted"
                    >
                      "{{ v.example }}"
                    </div>
                  </div>
                  <button
                    class="shrink-0 text-[10px]"
                    :class="
                      isVocabSaved(m, v.word)
                        ? 'text-text-muted'
                        : 'text-primary hover:underline'
                    "
                    :disabled="isVocabSaved(m, v.word)"
                    @click="saveVocabItem(m, v)"
                  >
                    {{ isVocabSaved(m, v.word) ? '✓ 保存済み' : '♡ これ覚えたい' }}
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </div>
        <div ref="logEndRef"></div>
      </div>
    </div>

    <footer class="border-t border-border bg-surface px-6 py-4">
      <div class="mx-auto max-w-3xl">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="h-2.5 w-2.5 rounded-full" :class="statusDotClass" />
            <span class="text-sm font-medium">{{ statusLabel }}</span>
            <span
              v-if="loop.consecutiveSilent.value > 0"
              class="text-xs text-text-muted"
            >
              · {{ loop.consecutiveSilent.value }} silent
            </span>
            <span
              v-if="loop.promptedAttempts.value > 0"
              class="text-xs text-violet-500"
            >
              · 言ってみて {{ loop.promptedAttempts.value }}/3
            </span>
          </div>
          <span v-if="!isActive" class="text-xs text-text-muted">
            会話セッション終了済み
          </span>
        </div>
        <div class="mt-3 flex h-12 items-center justify-center gap-1">
          <span
            v-for="(h, i) in bars"
            :key="i"
            class="w-1 rounded-full transition-all duration-75"
            :class="
              conversation.mode === 'recording' ||
              conversation.mode === 'awaitingPromptedSpeech'
                ? 'bg-primary'
                : 'bg-border'
            "
            :style="{ height: `${h * 100}%` }"
          />
        </div>
        <div
          v-if="loop.errorMessage.value"
          class="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
        >
          {{ loop.errorMessage.value }}
        </div>
      </div>
    </footer>

    <!-- Inactivity dialog -->
    <div
      v-if="showInactivityDialog"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div
        class="mx-4 max-w-md rounded-2xl bg-surface p-6 shadow-xl ring-1 ring-border"
      >
        <h3 class="text-lg font-semibold">会話を続けますか?</h3>
        <p class="mt-2 text-sm text-text-muted">
          無音が続いています。会話を続けるか、終了するかを選んでください。
        </p>
        <div class="mt-6 flex gap-2">
          <BaseButton
            variant="secondary"
            class="flex-1"
            @click="endFromDialog"
          >
            会話を終わる
          </BaseButton>
          <BaseButton class="flex-1" @click="continueConversation">
            続ける
          </BaseButton>
        </div>
      </div>
    </div>
  </div>
</template>

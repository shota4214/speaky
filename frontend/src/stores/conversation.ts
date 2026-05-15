import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Level, Message } from '../db/types'

export type ConversationMode =
  | 'idle'
  | 'recording'
  | 'processing'
  | 'thinking'
  | 'aiSpeaking'
  | 'awaitingPromptedSpeech'

export interface StartConversationInput {
  id: string
  level: Level
  topic: string
  vocabFocusIds?: string[]
}

export const useConversationStore = defineStore('conversation', () => {
  const id = ref<string | null>(null)
  const level = ref<Level>('intermediate')
  const topic = ref<string>('daily')
  const messages = ref<Message[]>([])
  const isPaused = ref<boolean>(false)
  const mode = ref<ConversationMode>('idle')
  const vocabFocusIds = ref<string[]>([])

  const isActive = computed(() => mode.value !== 'idle')
  const turnCount = computed(
    () => messages.value.filter((m) => m.role === 'ai').length,
  )

  function start(input: StartConversationInput) {
    id.value = input.id
    level.value = input.level
    topic.value = input.topic
    messages.value = []
    isPaused.value = false
    mode.value = 'recording'
    vocabFocusIds.value = input.vocabFocusIds ?? []
  }

  function appendMessage(msg: Message) {
    messages.value = [...messages.value, msg]
  }

  function setMode(newMode: ConversationMode) {
    mode.value = newMode
  }

  function pause() {
    if (!isActive.value) return
    isPaused.value = true
  }

  function resume() {
    isPaused.value = false
  }

  function end() {
    id.value = null
    messages.value = []
    isPaused.value = false
    mode.value = 'idle'
    vocabFocusIds.value = []
  }

  function setVocabFocus(ids: string[]) {
    vocabFocusIds.value = ids
  }

  return {
    id,
    level,
    topic,
    messages,
    isPaused,
    mode,
    vocabFocusIds,
    isActive,
    turnCount,
    start,
    appendMessage,
    setMode,
    pause,
    resume,
    end,
    setVocabFocus,
  }
})

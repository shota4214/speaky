<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import BaseCard from '../components/BaseCard.vue'
import LevelBadge from '../components/LevelBadge.vue'
import TopicChip from '../components/TopicChip.vue'
import { useTextToSpeech } from '../composables/useTextToSpeech'
import { conversationsRepo } from '../db/repos/conversations'
import { messagesRepo } from '../db/repos/messages'
import type { Conversation, Message } from '../db/types'

const route = useRoute()
const tts = useTextToSpeech()

const conversation = ref<Conversation | null>(null)
const messages = ref<Message[]>([])
const loading = ref(true)

onMounted(async () => {
  const id = route.params.id as string
  conversation.value = (await conversationsRepo.get(id)) ?? null
  if (conversation.value) {
    messages.value = await messagesRepo.listByConversation(id)
  }
  loading.value = false
})

const durationMin = computed(() => {
  const c = conversation.value
  if (!c || !c.endedAt) return null
  const ms = c.endedAt.getTime() - c.startedAt.getTime()
  return Math.max(1, Math.round(ms / 60_000))
})

const turnCount = computed(() => messages.value.filter((m) => m.role === 'ai').length)

function formatTime(d: Date): string {
  return d.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function replay(text: string) {
  tts.speak(text)
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-8">
    <div class="flex items-center justify-between">
      <h1 class="text-3xl font-bold">会話の詳細</h1>
      <router-link to="/history" class="text-sm text-text-muted hover:underline">
        ← 履歴一覧
      </router-link>
    </div>

    <div v-if="loading" class="mt-6 text-text-muted">読み込み中...</div>

    <div v-else-if="!conversation" class="mt-6">
      <BaseCard>
        <p class="text-text-muted">会話が見つかりませんでした(30日経過で削除済みの可能性)</p>
      </BaseCard>
    </div>

    <template v-else>
      <BaseCard class="mt-6">
        <div class="flex flex-wrap items-center gap-3 text-sm">
          <TopicChip :label="conversation.topic" />
          <LevelBadge :level="conversation.level" size="sm" />
          <span v-if="durationMin" class="text-text-muted"> {{ durationMin }}分 </span>
          <span class="text-text-muted">{{ turnCount }} turns</span>
        </div>
        <p v-if="conversation.summary" class="mt-3 text-sm text-text-muted">
          📝 {{ conversation.summary }}
        </p>
      </BaseCard>

      <div class="mt-6 space-y-3">
        <div v-for="m in messages" :key="m.id">
          <div v-if="m.role === 'user'" class="flex justify-end">
            <div class="max-w-[75%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-white">
              <div class="text-sm">{{ m.userText }}</div>
              <div class="mt-1 text-[10px] opacity-80">
                {{ formatTime(m.timestamp) }}
              </div>
            </div>
          </div>
          <div v-else class="flex flex-col items-start space-y-2">
            <div class="flex w-full justify-start">
              <div
                class="max-w-[75%] rounded-2xl rounded-bl-md bg-surface px-4 py-3 shadow-sm ring-1 ring-border"
              >
                <div class="text-sm">{{ m.replyEn }}</div>
                <!--
                  日本語訳は後追い(enrich)で入るため、届かないまま保存された行が
                  ありうる。無条件に出すと空行だけが残るので、あるときだけ描画する。
                -->
                <div v-if="m.replyJa" class="mt-1 text-xs text-text-muted">{{ m.replyJa }}</div>
                <button
                  class="mt-2 text-[10px] text-text-muted hover:text-text"
                  @click="replay(m.replyEn ?? '')"
                >
                  🔊 再生
                </button>
              </div>
            </div>
            <div
              v-if="m.feedback"
              class="ml-2 max-w-[75%] rounded-xl bg-amber-50 px-3 py-2 text-xs ring-1 ring-amber-200 dark:bg-amber-900/20 dark:ring-amber-700/40"
            >
              <div class="font-semibold text-amber-700 dark:text-amber-300">✏️ 添削</div>
              <div class="mt-1">
                <span class="text-rose-500 line-through">{{ m.feedback.userSaid }}</span>
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
              <div class="font-semibold text-primary-dark">📚 単語・フレーズ</div>
              <ul class="mt-2 space-y-1.5">
                <li v-for="v in m.vocabulary" :key="v.word">
                  <strong>{{ v.word }}</strong>
                  <span class="ml-2 text-text-muted">— {{ v.meaning }}</span>
                  <div v-if="v.example" class="text-[10px] italic text-text-muted">
                    "{{ v.example }}"
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

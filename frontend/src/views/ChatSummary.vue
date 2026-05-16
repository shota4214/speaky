<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import LevelBadge from '../components/LevelBadge.vue'
import TopicChip from '../components/TopicChip.vue'
import { conversationsRepo } from '../db/repos/conversations'
import { messagesRepo } from '../db/repos/messages'
import type { Conversation, Level, Message, VocabItem } from '../db/types'

const route = useRoute()
const router = useRouter()

const conversation = ref<Conversation | null>(null)
const messages = ref<Message[]>([])
const loading = ref(true)

onMounted(async () => {
  const id = route.query.id as string | undefined
  if (!id) {
    loading.value = false
    return
  }
  const conv = await conversationsRepo.get(id)
  if (conv) {
    conversation.value = conv
    messages.value = await messagesRepo.listByConversation(id)
  }
  loading.value = false
})

const durationMin = computed(() => {
  const c = conversation.value
  if (!c || !c.endedAt) return 0
  const ms = c.endedAt.getTime() - c.startedAt.getTime()
  return Math.max(1, Math.round(ms / 60_000))
})

const turnCount = computed(() => messages.value.filter((m) => m.role === 'ai').length)

const allVocabulary = computed<VocabItem[]>(() => {
  const seen = new Set<string>()
  const out: VocabItem[] = []
  for (const m of messages.value) {
    if (m.vocabulary) {
      for (const v of m.vocabulary) {
        if (seen.has(v.word)) continue
        seen.add(v.word)
        out.push(v)
      }
    }
  }
  return out
})

const level = computed<Level>(() => conversation.value?.level ?? 'intermediate')
const topic = computed(() => conversation.value?.topic ?? '')

function restart() {
  // 設定を引き継いで /chat には飛べないため、Home に戻ってもう一度開始してもらう
  router.push('/')
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-8">
    <h1 class="text-3xl font-bold">お疲れさま!</h1>

    <div v-if="loading" class="mt-6 text-text-muted">読み込み中...</div>

    <div v-else-if="!conversation" class="mt-6">
      <BaseCard>
        <p class="text-sm text-text-muted">会話データが見つかりませんでした。</p>
      </BaseCard>
    </div>

    <template v-else>
      <BaseCard class="mt-6">
        <div class="text-sm font-semibold">今回の会話</div>
        <div class="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <span class="flex items-center gap-1.5">
            <span class="text-text-muted">トピック:</span>
            <TopicChip :label="topic" />
          </span>
          <span class="flex items-center gap-1.5">
            <span class="text-text-muted">レベル:</span>
            <LevelBadge :level="level" />
          </span>
        </div>
        <div class="mt-3 flex gap-6 text-sm text-text-muted">
          <span>
            時間:
            <strong class="text-text">{{ durationMin }}分</strong>
          </span>
          <span>
            ターン数:
            <strong class="text-text">{{ turnCount }}</strong>
          </span>
        </div>
        <div v-if="conversation.summary" class="mt-4 rounded-lg bg-bg p-3">
          <div class="text-xs font-semibold text-text-muted">📝 要約</div>
          <div class="mt-1 text-sm">{{ conversation.summary }}</div>
        </div>
      </BaseCard>

      <BaseCard class="mt-6">
        <div class="text-sm font-semibold">今回出た単語・フレーズ</div>
        <p class="mt-1 text-xs text-text-muted">
          ※ ここからは保存できません。保存は会話中の「♡ これ覚えたい」から。
        </p>
        <ul v-if="allVocabulary.length > 0" class="mt-4 space-y-2">
          <li
            v-for="v in allVocabulary"
            :key="v.word"
            class="rounded-lg bg-primary-light/40 px-3 py-2 text-sm"
          >
            <strong class="text-primary-dark">{{ v.word }}</strong>
            <span class="ml-2 text-text-muted">— {{ v.meaning }}</span>
            <div v-if="v.example" class="mt-1 text-xs italic text-text-muted">
              "{{ v.example }}"
            </div>
          </li>
        </ul>
        <p v-else class="mt-4 text-sm text-text-muted">
          今回は新しい単語・フレーズの紹介はありませんでした
        </p>
      </BaseCard>
    </template>

    <div class="mt-8 flex gap-3">
      <router-link to="/" class="flex-1">
        <BaseButton variant="secondary" class="w-full">ホームに戻る</BaseButton>
      </router-link>
      <BaseButton class="flex-1" @click="restart"> もう一度会話する </BaseButton>
    </div>
  </div>
</template>

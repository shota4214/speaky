<script setup lang="ts">
import { onMounted, ref } from 'vue'
import BaseCard from '../components/BaseCard.vue'
import LevelBadge from '../components/LevelBadge.vue'
import TopicChip from '../components/TopicChip.vue'
import { conversationsRepo } from '../db/repos/conversations'
import { messagesRepo } from '../db/repos/messages'
import type { Conversation } from '../db/types'

interface ConvWithMeta extends Conversation {
  turnCount: number
  preview: string
}

const items = ref<ConvWithMeta[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  const conversations = await conversationsRepo.list()
  const enriched = await Promise.all(
    conversations.map(async (c) => {
      const msgs = await messagesRepo.listByConversation(c.id)
      const turnCount = msgs.filter((m) => m.role === 'ai').length
      const firstUserMsg = msgs.find((m) => m.role === 'user')
      const preview = firstUserMsg?.userText ?? '(no messages)'
      return { ...c, turnCount, preview }
    }),
  )
  items.value = enriched
  loading.value = false
}

onMounted(load)

async function deleteItem(id: string) {
  if (!confirm('この会話を削除しますか?')) return
  await conversationsRepo.delete(id)
  await load()
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}
function formatTime(d: Date): string {
  return d.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  })
}
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-8">
    <h1 class="text-3xl font-bold">履歴</h1>
    <p class="mt-2 text-sm text-text-muted">過去の会話を振り返れます</p>

    <div v-if="loading" class="mt-6 text-text-muted">読み込み中...</div>

    <div v-else-if="items.length === 0" class="mt-6">
      <BaseCard>
        <p class="text-center text-text-muted">
          まだ会話がありません。<router-link to="/" class="text-primary hover:underline"
            >ホーム</router-link
          >から始めましょう。
        </p>
      </BaseCard>
    </div>

    <div v-else class="mt-6 space-y-3">
      <BaseCard v-for="item in items" :key="item.id">
        <div class="flex items-start justify-between">
          <router-link
            :to="`/history/${item.id}`"
            class="block flex-1 transition hover:opacity-80"
          >
            <div class="text-sm text-text-muted">
              {{ formatDate(item.startedAt) }} {{ formatTime(item.startedAt) }}
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <TopicChip :label="item.topic" />
              <LevelBadge :level="item.level" size="sm" />
              <span class="text-xs text-text-muted">
                {{ item.turnCount }} turns
              </span>
            </div>
            <p class="mt-3 line-clamp-1 text-sm text-text">
              "{{ item.preview }}"
            </p>
            <p
              v-if="item.summary"
              class="mt-1 line-clamp-1 text-xs text-text-muted"
            >
              📝 {{ item.summary }}
            </p>
          </router-link>
          <button
            type="button"
            class="ml-3 text-xs text-rose-500 hover:underline"
            @click="deleteItem(item.id)"
          >
            削除
          </button>
        </div>
      </BaseCard>
    </div>

    <p class="mt-6 text-xs text-text-muted">
      ※ 30日経過すると自動で削除されます
    </p>
  </div>
</template>

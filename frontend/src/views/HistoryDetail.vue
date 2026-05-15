<script setup lang="ts">
import { useRoute } from 'vue-router'
import BaseCard from '../components/BaseCard.vue'

const route = useRoute()
const conversationId = route.params.id as string

// Placeholder — Task 2.8 で messagesRepo.listByConversation で読む
const messages = [
  { role: 'ai' as const, en: 'Hi! How was your trip to Kyoto?', ja: 'やっほー!京都旅行どうだった?' },
  { role: 'user' as const, text: 'It was amazing! I went to Kyoto with my friends last weekend.' },
  { role: 'ai' as const, en: "That sounds wonderful! What did you see there?", ja: '素敵だね!何を見たの?' },
]
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-8">
    <div class="flex items-center justify-between">
      <h1 class="text-3xl font-bold">会話の詳細</h1>
      <router-link to="/history" class="text-sm text-text-muted hover:underline">
        ← 履歴一覧
      </router-link>
    </div>
    <p class="mt-2 text-xs text-text-muted">
      会話ID: <code class="font-mono">{{ conversationId }}</code>
    </p>

    <div class="mt-6 space-y-3">
      <BaseCard v-for="(m, i) in messages" :key="i" padding="md">
        <div v-if="m.role === 'user'" class="flex justify-end">
          <div class="max-w-[75%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-white">
            <div class="text-sm">{{ m.text }}</div>
          </div>
        </div>
        <div v-else class="flex justify-start">
          <div
            class="max-w-[75%] rounded-2xl rounded-bl-md bg-primary-light px-4 py-3 text-primary-dark"
          >
            <div class="text-sm">{{ m.en }}</div>
            <div class="mt-1 text-xs text-text-muted">{{ m.ja }}</div>
            <button class="mt-2 text-[10px] text-text-muted hover:text-text">
              🔊 再生
            </button>
          </div>
        </div>
      </BaseCard>
    </div>

    <p class="mt-6 text-xs text-text-muted">
      Phase 2 — Task 2.8 で完全実装 / Task 2.4 ではスケルトン
    </p>
  </div>
</template>

<script setup lang="ts">
import BaseCard from '../components/BaseCard.vue'
import LevelBadge from '../components/LevelBadge.vue'
import TopicChip from '../components/TopicChip.vue'

// Placeholder data — Task 2.8 で conversationsRepo.list() から取得
const items = [
  {
    id: 'demo-1',
    startedAt: '2026-05-14T19:23:00',
    topic: '旅行',
    level: 'intermediate' as const,
    turnCount: 8,
    preview: 'It was amazing! I went to Kyoto last weekend...',
  },
  {
    id: 'demo-2',
    startedAt: '2026-05-13T08:10:00',
    topic: 'ビジネス',
    level: 'advanced' as const,
    turnCount: 14,
    preview: 'I have a meeting with a client tomorrow morning...',
  },
]

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  })
}
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-8">
    <h1 class="text-3xl font-bold">履歴</h1>
    <p class="mt-2 text-sm text-text-muted">過去の会話を振り返れます</p>

    <div class="mt-6 space-y-3">
      <router-link
        v-for="item in items"
        :key="item.id"
        :to="`/history/${item.id}`"
        class="block transition hover:opacity-80"
      >
        <BaseCard>
          <div class="flex items-start justify-between">
            <div class="flex-1">
              <div class="text-sm text-text-muted">
                {{ formatDate(item.startedAt) }} {{ formatTime(item.startedAt) }}
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <TopicChip :label="item.topic" />
                <LevelBadge :level="item.level" size="sm" />
                <span class="text-xs text-text-muted">{{ item.turnCount }} turns</span>
              </div>
              <p class="mt-3 line-clamp-1 text-sm text-text">
                "{{ item.preview }}"
              </p>
            </div>
            <button
              type="button"
              class="ml-3 text-xs text-rose-500 hover:underline"
              @click.prevent
            >
              削除
            </button>
          </div>
        </BaseCard>
      </router-link>
    </div>

    <p class="mt-6 text-xs text-text-muted">
      ※ 30日経過すると自動で削除されます
    </p>
    <p class="mt-2 text-xs text-text-muted">
      Phase 2 — Task 2.8 で完全実装 / Task 2.4 ではスケルトン
    </p>
  </div>
</template>

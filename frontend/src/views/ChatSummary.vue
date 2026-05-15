<script setup lang="ts">
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import LevelBadge from '../components/LevelBadge.vue'
import TopicChip from '../components/TopicChip.vue'

// Placeholder data — Task 2.7 でストアから取得
const stats = {
  topic: '旅行',
  level: 'intermediate' as const,
  durationMin: 8,
  turnCount: 12,
}

const vocab = [
  { word: 'appreciate', meaning: '感謝する' },
  { word: 'memorable', meaning: '思い出に残る' },
  { word: 'vibrant', meaning: '活気のある' },
]
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-8">
    <h1 class="text-3xl font-bold">お疲れさま!</h1>
    <p class="mt-2 text-sm text-text-muted">今回の会話の振り返り</p>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">今回の会話</div>
      <div class="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <span class="flex items-center gap-1.5">
          <span class="text-text-muted">トピック:</span>
          <TopicChip :label="stats.topic" />
        </span>
        <span class="flex items-center gap-1.5">
          <span class="text-text-muted">レベル:</span>
          <LevelBadge :level="stats.level" />
        </span>
      </div>
      <div class="mt-3 flex gap-6 text-sm text-text-muted">
        <span>時間: <strong class="text-text">{{ stats.durationMin }}分</strong></span>
        <span>ターン数: <strong class="text-text">{{ stats.turnCount }}</strong></span>
      </div>
    </BaseCard>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">今回出た単語・フレーズ</div>
      <p class="mt-1 text-xs text-text-muted">
        ※ ここから保存はできません。保存は会話中の「これ覚えたい」ボタンから。
      </p>
      <ul class="mt-4 space-y-2">
        <li
          v-for="v in vocab"
          :key="v.word"
          class="rounded-lg bg-primary-light/40 px-3 py-2 text-sm"
        >
          <strong class="text-primary-dark">{{ v.word }}</strong>
          <span class="ml-2 text-text-muted">— {{ v.meaning }}</span>
        </li>
      </ul>
    </BaseCard>

    <div class="mt-8 flex gap-3">
      <router-link to="/" class="flex-1">
        <BaseButton variant="secondary" class="w-full">ホームに戻る</BaseButton>
      </router-link>
      <router-link to="/chat" class="flex-1">
        <BaseButton class="w-full">もう一度会話する</BaseButton>
      </router-link>
    </div>

    <p class="mt-6 text-center text-xs text-text-muted">
      Phase 2 — Task 2.7 で完全実装 / Task 2.4 ではスケルトン
    </p>
  </div>
</template>

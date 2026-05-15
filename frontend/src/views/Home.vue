<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import LevelBadge from '../components/LevelBadge.vue'
import TopicChip from '../components/TopicChip.vue'
import type { Level } from '../db/types'

const router = useRouter()

function startConversation() {
  // TODO Task 2.6: conversationsRepo.create + level/topic を ConversationStore に保存してから遷移
  router.push('/chat')
}

const aiName = 'Emma' // TODO Task 2.6: useSettingsStore.settings.aiCharacter.name

const level = ref<Level>('intermediate')

const defaultTopics = [
  { id: 'daily', name: '日常会話' },
  { id: 'business', name: 'ビジネス' },
  { id: 'travel', name: '旅行' },
  { id: 'shopping', name: 'ショッピング' },
  { id: 'restaurant', name: 'レストラン' },
  { id: 'hobby', name: '趣味' },
  { id: 'news', name: 'ニュース話題' },
]
const selectedTopic = ref<string>('daily')

const levels: Level[] = ['beginner', 'intermediate', 'advanced']
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-8">
    <h1 class="text-3xl font-bold">
      English Conversation with {{ aiName }}
    </h1>
    <p class="mt-2 text-sm text-text-muted">
      レベルとトピックを選んで会話を始めましょう
    </p>

    <BaseCard class="mt-8">
      <div class="text-sm font-semibold">今日のレベル</div>
      <div class="mt-3 flex flex-wrap gap-2">
        <button
          v-for="l in levels"
          :key="l"
          type="button"
          class="rounded-full focus:outline-none focus:ring-2 focus:ring-primary"
          @click="level = l"
        >
          <LevelBadge :level="l" :active="level === l" size="lg" />
        </button>
      </div>
    </BaseCard>

    <BaseCard class="mt-6">
      <div class="flex items-center justify-between">
        <div class="text-sm font-semibold">何を話す?</div>
        <button type="button" class="text-xs text-primary hover:underline">
          + カスタムトピック追加
        </button>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <button
          v-for="t in defaultTopics"
          :key="t.id"
          type="button"
          class="rounded-full focus:outline-none focus:ring-2 focus:ring-accent"
          @click="selectedTopic = t.id"
        >
          <TopicChip :label="t.name" :active="selectedTopic === t.id" />
        </button>
      </div>
    </BaseCard>

    <div class="mt-8 flex justify-center">
      <BaseButton size="lg" @click="startConversation">
        ▶ 会話を始める
      </BaseButton>
    </div>

    <p class="mt-6 text-center text-xs text-text-muted">
      Phase 2 — Task 2.4 スケルトン / 機能ワイヤリングは Task 2.5・2.6 で実装
    </p>
  </div>
</template>

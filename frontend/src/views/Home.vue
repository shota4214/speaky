<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AiMascot from '../components/AiMascot.vue'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import LevelBadge from '../components/LevelBadge.vue'
import TopicChip from '../components/TopicChip.vue'
import { conversationsRepo } from '../db/repos/conversations'
import type { Level } from '../db/types'
import { useConversationStore } from '../stores/conversation'
import { useSettingsStore } from '../stores/settings'
import { useVocabularyStore } from '../stores/vocabulary'

const router = useRouter()
const settings = useSettingsStore()
const conversation = useConversationStore()
const vocabStore = useVocabularyStore()

const aiName = computed(() => settings.settings.aiCharacter.name)
const aiGender = computed(() => settings.settings.aiCharacter.gender)

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

const starting = ref(false)

async function startConversation() {
  if (starting.value) return
  starting.value = true
  try {
    const newConv = await conversationsRepo.create({
      startedAt: new Date(),
      endedAt: null,
      topic: selectedTopic.value,
      level: level.value,
      aiCharacter: {
        name: settings.settings.aiCharacter.name,
        gender: settings.settings.aiCharacter.gender,
      },
      summary: null,
    })
    conversation.start({
      id: newConv.id,
      level: level.value,
      topic: selectedTopic.value,
      vocabFocusIds: [...vocabStore.selectedIds],
    })
    await router.push('/chat')
  } finally {
    starting.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-8">
    <div class="flex flex-col items-center text-center">
      <AiMascot :size="120" mood="happy" :gender="aiGender" />
      <h1 class="mt-4 text-3xl font-bold">{{ aiName }} とおしゃべりしよう</h1>
      <p class="mt-2 text-sm text-text-muted">レベルとトピックを選んで会話を始めましょう</p>
    </div>

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

    <div
      v-if="vocabStore.count > 0"
      class="mt-6 rounded-xl bg-accent/10 px-4 py-3 text-sm text-accent"
    >
      📚 復習リストから <strong>{{ vocabStore.count }}個の単語</strong>
      を会話で練習します
    </div>

    <div class="mt-8 flex justify-center">
      <BaseButton size="lg" :disabled="starting" @click="startConversation">
        {{ starting ? '準備中...' : '▶ 会話を始める' }}
      </BaseButton>
    </div>
  </div>
</template>

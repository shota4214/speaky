<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AiMascot from '../components/AiMascot.vue'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import LevelBadge from '../components/LevelBadge.vue'
import TopicChip from '../components/TopicChip.vue'
import { conversationsRepo } from '../db/repos/conversations'
import { customTopicsRepo } from '../db/repos/customTopics'
import type { CustomTopic, Level } from '../db/types'
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

interface TopicOption {
  /** 選択状態の一意キー(デフォルトは id、カスタムは uuid) */
  key: string
  /** 画面表示ラベル */
  label: string
  /** バックエンド(会話プロンプト)に渡すトピック文字列 */
  topicValue: string
  /** カスタムトピックなら削除可能 */
  custom: boolean
}

const defaultTopics: TopicOption[] = [
  { key: 'daily', label: '日常会話', topicValue: 'daily', custom: false },
  { key: 'business', label: 'ビジネス', topicValue: 'business', custom: false },
  { key: 'travel', label: '旅行', topicValue: 'travel', custom: false },
  { key: 'shopping', label: 'ショッピング', topicValue: 'shopping', custom: false },
  { key: 'restaurant', label: 'レストラン', topicValue: 'restaurant', custom: false },
  { key: 'hobby', label: '趣味', topicValue: 'hobby', custom: false },
  { key: 'news', label: 'ニュース話題', topicValue: 'news', custom: false },
]

const customTopics = ref<CustomTopic[]>([])
const allTopics = computed<TopicOption[]>(() => [
  ...defaultTopics,
  ...customTopics.value.map((t) => ({
    key: t.id,
    label: t.name,
    topicValue: t.name,
    custom: true,
  })),
])

const selectedTopicKey = ref<string>('daily')

// カスタムトピック追加フォーム
const showAddForm = ref(false)
const newTopicName = ref('')

async function loadCustomTopics() {
  try {
    customTopics.value = await customTopicsRepo.list()
  } catch (e) {
    console.warn('[home] failed to load custom topics:', e)
  }
}

onMounted(loadCustomTopics)

function toggleAddForm() {
  showAddForm.value = !showAddForm.value
  if (showAddForm.value) newTopicName.value = ''
}

async function addCustomTopic() {
  const name = newTopicName.value.trim()
  if (!name) return
  const created = await customTopicsRepo.create({ name, description: '' })
  await loadCustomTopics()
  // 追加したトピックを選択状態にする
  selectedTopicKey.value = created.id
  newTopicName.value = ''
  showAddForm.value = false
}

async function removeCustomTopic(id: string) {
  await customTopicsRepo.delete(id)
  // 削除したものが選択中ならデフォルトに戻す
  if (selectedTopicKey.value === id) selectedTopicKey.value = 'daily'
  await loadCustomTopics()
}

const levels: Level[] = ['beginner', 'intermediate', 'advanced']

const starting = ref(false)

async function startConversation() {
  if (starting.value) return
  starting.value = true
  try {
    const selected =
      allTopics.value.find((t) => t.key === selectedTopicKey.value) ?? defaultTopics[0]!
    const newConv = await conversationsRepo.create({
      startedAt: new Date(),
      endedAt: null,
      topic: selected.topicValue,
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
      topic: selected.topicValue,
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
        <button type="button" class="text-xs text-primary hover:underline" @click="toggleAddForm">
          {{ showAddForm ? '× 閉じる' : '+ カスタムトピック追加' }}
        </button>
      </div>

      <!-- カスタムトピック追加フォーム -->
      <div v-if="showAddForm" class="mt-3 flex items-center gap-2">
        <input
          v-model="newTopicName"
          type="text"
          maxlength="30"
          placeholder="例: 料理 / 映画 / 仕事の面接 …"
          class="flex-1 rounded-full border border-border bg-surface px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          @keydown.enter="addCustomTopic"
        />
        <BaseButton size="sm" :disabled="!newTopicName.trim()" @click="addCustomTopic">
          追加
        </BaseButton>
      </div>

      <div class="mt-4 flex flex-wrap gap-2">
        <!-- 選択ボタンと削除ボタンは「兄弟要素」に分離する。
             interactive control(button)の入れ子を避け、アクセシビリティと
             HTML 妥当性の両方を満たすため、ラッパは非インタラクティブな span。 -->
        <span v-for="t in allTopics" :key="t.key" class="inline-flex items-center">
          <button
            type="button"
            class="rounded-full focus:outline-none focus:ring-2 focus:ring-accent"
            @click="selectedTopicKey = t.key"
          >
            <TopicChip :label="t.label" :active="selectedTopicKey === t.key" />
          </button>
          <button
            v-if="t.custom"
            type="button"
            class="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-text-muted opacity-70 transition hover:bg-rose-500/15 hover:text-rose-500 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-rose-400"
            :aria-label="`「${t.label}」を削除`"
            @click="removeCustomTopic(t.key)"
          >
            ×
          </button>
        </span>
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

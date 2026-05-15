<script setup lang="ts">
import { ref } from 'vue'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import BaseInput from '../components/BaseInput.vue'

const search = ref('')
const sort = ref<'added' | 'alphabetical'>('added')

// Placeholder — Task 2.10 で vocabularyRepo.list() から取得
const items = [
  {
    id: 'v1',
    word: 'appreciate',
    partOfSpeech: '動詞',
    meaning: '感謝する',
    example: 'I really appreciate your help.',
    checked: false,
  },
  {
    id: 'v2',
    word: 'look forward to',
    partOfSpeech: 'フレーズ',
    meaning: '楽しみにする',
    example: null,
    checked: false,
  },
  {
    id: 'v3',
    word: 'memorable',
    partOfSpeech: '形容詞',
    meaning: '思い出に残る',
    example: 'It was a memorable trip.',
    checked: false,
  },
]

const selectedCount = ref(0)
function toggle(item: (typeof items)[number]) {
  if (item.checked) {
    item.checked = false
    selectedCount.value -= 1
  } else if (selectedCount.value < 3) {
    item.checked = true
    selectedCount.value += 1
  }
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-8">
    <div class="flex items-center justify-between">
      <h1 class="text-3xl font-bold">
        復習リスト
        <span class="ml-2 text-sm font-normal text-text-muted">
          ({{ items.length }}個)
        </span>
      </h1>
    </div>

    <div class="mt-6 flex flex-wrap items-center gap-3">
      <div class="flex-1 min-w-[240px]">
        <BaseInput v-model="search" placeholder="🔍 検索..." />
      </div>
      <select
        v-model="sort"
        class="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
      >
        <option value="added">並び順: 追加順</option>
        <option value="alphabetical">並び順: アルファベット</option>
      </select>
    </div>

    <div class="mt-6 space-y-3">
      <BaseCard v-for="item in items" :key="item.id" padding="md">
        <div class="flex items-start gap-3">
          <input
            type="checkbox"
            class="mt-1 h-4 w-4 rounded accent-primary"
            :checked="item.checked"
            :disabled="!item.checked && selectedCount >= 3"
            @change="toggle(item)"
          />
          <div class="flex-1">
            <div class="flex items-center gap-2">
              <strong class="text-base">{{ item.word }}</strong>
              <span class="text-xs text-text-muted">({{ item.partOfSpeech }})</span>
            </div>
            <div class="mt-1 text-sm text-text">{{ item.meaning }}</div>
            <div v-if="item.example" class="mt-1 text-xs italic text-text-muted">
              "{{ item.example }}"
            </div>
          </div>
          <button class="text-xs text-rose-500 hover:underline">削除</button>
        </div>
      </BaseCard>
    </div>

    <div class="sticky bottom-4 mt-8">
      <BaseCard>
        <div class="flex items-center justify-between">
          <div class="text-sm text-text-muted">
            選択中: <strong class="text-text">{{ selectedCount }}</strong> / 3
          </div>
          <BaseButton :disabled="selectedCount === 0">
            ▶ 選択した単語を使って会話する
          </BaseButton>
        </div>
      </BaseCard>
    </div>

    <p class="mt-6 text-center text-xs text-text-muted">
      Phase 2 — Task 2.10 で完全実装 / Task 2.4 ではスケルトン
    </p>
  </div>
</template>

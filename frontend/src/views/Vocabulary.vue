<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import BaseInput from '../components/BaseInput.vue'
import { vocabularyRepo } from '../db/repos/vocabulary'
import type { Vocabulary } from '../db/types'
import { useVocabularyStore } from '../stores/vocabulary'

const router = useRouter()
const vocabStore = useVocabularyStore()

const items = ref<Vocabulary[]>([])
const search = ref('')
const orderBy = ref<'savedAt' | 'word'>('savedAt')
const direction = ref<'asc' | 'desc'>('desc')

async function load() {
  items.value = await vocabularyRepo.list({
    search: search.value || undefined,
    orderBy: orderBy.value,
    direction: direction.value,
  })
}

onMounted(load)
watch([search, orderBy, direction], load)

function toggle(id: string) {
  vocabStore.toggle(id)
}

async function deleteItem(id: string) {
  if (!confirm('この単語を削除しますか?')) return
  await vocabularyRepo.delete(id)
  await load()
}

function goStart() {
  if (vocabStore.count === 0) return
  router.push('/')
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-8 pb-32">
    <h1 class="text-3xl font-bold">
      復習リスト
      <span class="ml-2 text-sm font-normal text-text-muted"> ({{ items.length }}個) </span>
    </h1>

    <div class="mt-6 flex flex-wrap items-center gap-3">
      <div class="flex-1 min-w-[240px]">
        <BaseInput v-model="search" placeholder="🔍 検索..." />
      </div>
      <select
        v-model="orderBy"
        class="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
      >
        <option value="savedAt">追加日時</option>
        <option value="word">アルファベット</option>
      </select>
      <select
        v-model="direction"
        class="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
      >
        <option value="desc">↓ 降順</option>
        <option value="asc">↑ 昇順</option>
      </select>
    </div>

    <div v-if="items.length === 0" class="mt-6">
      <BaseCard>
        <p class="text-center text-text-muted">
          {{
            search
              ? '検索条件に一致する単語がありません'
              : 'まだ単語がありません。会話中の「♡ これ覚えたい」で追加できます。'
          }}
        </p>
      </BaseCard>
    </div>

    <div v-else class="mt-6 space-y-3">
      <BaseCard v-for="item in items" :key="item.id" padding="md">
        <div class="flex items-start gap-3">
          <input
            type="checkbox"
            class="mt-1 h-4 w-4 rounded accent-primary"
            :checked="vocabStore.isSelected(item.id)"
            :disabled="!vocabStore.isSelected(item.id) && !vocabStore.canAddMore"
            @change="toggle(item.id)"
          />
          <div class="flex-1">
            <div class="flex items-center gap-2">
              <strong class="text-base">{{ item.word }}</strong>
              <span v-if="item.partOfSpeech" class="text-xs text-text-muted">
                ({{ item.partOfSpeech }})
              </span>
            </div>
            <div class="mt-1 text-sm text-text">{{ item.meaning }}</div>
            <div v-if="item.example" class="mt-1 text-xs italic text-text-muted">
              "{{ item.example }}"
            </div>
          </div>
          <button class="text-xs text-rose-500 hover:underline" @click="deleteItem(item.id)">
            削除
          </button>
        </div>
      </BaseCard>
    </div>

    <div v-if="items.length > 0" class="fixed bottom-4 left-60 right-4 z-10 mx-auto max-w-3xl px-2">
      <BaseCard>
        <div class="flex items-center justify-between gap-3">
          <div class="text-sm text-text-muted">
            選択中:
            <strong class="text-text">{{ vocabStore.count }}</strong> / 3
          </div>
          <div class="flex items-center gap-2">
            <button
              v-if="vocabStore.count > 0"
              class="text-sm text-text-muted hover:underline"
              @click="vocabStore.clear()"
            >
              クリア
            </button>
            <BaseButton :disabled="vocabStore.count === 0" @click="goStart">
              ▶ 選択した単語を使って会話する
            </BaseButton>
          </div>
        </div>
      </BaseCard>
    </div>
  </div>
</template>

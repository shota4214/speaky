<script setup lang="ts">
import { ref } from 'vue'
import BaseCard from '../components/BaseCard.vue'
import BaseInput from '../components/BaseInput.vue'

const userName = ref('Shota')

// Placeholder — Task 3.2 で profileStore から取得
const facts = ref([
  { id: 'f1', text: 'Web開発者として働いている' },
  { id: 'f2', text: '京都に旅行に行ったことがある' },
  { id: 'f3', text: 'コーヒーが好き' },
  { id: 'f4', text: '富士宮市に住んでいる' },
])

const aiName = ref('Emma')
const aiGender = ref<'female' | 'male'>('female')
</script>

<template>
  <div class="mx-auto max-w-2xl px-6 py-8">
    <h1 class="text-3xl font-bold">プロフィール</h1>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">あなたについて</div>
      <div class="mt-4">
        <BaseInput v-model="userName" label="名前" />
      </div>

      <div class="mt-6">
        <div class="text-sm font-semibold">AIが学習したあなたのこと</div>
        <p class="mt-1 text-xs text-text-muted">
          会話の中からAIが自然に学習した情報。不要なものは削除できます。
        </p>
        <ul class="mt-3 space-y-2">
          <li
            v-for="f in facts"
            :key="f.id"
            class="flex items-start justify-between rounded-lg bg-primary-light/40 px-3 py-2 text-sm"
          >
            <span>• {{ f.text }}</span>
            <button class="text-xs text-rose-500 hover:underline">削除</button>
          </li>
        </ul>
      </div>
    </BaseCard>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">AIキャラクター</div>
      <div class="mt-4 space-y-3">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm">名前</div>
            <div class="text-text-muted">{{ aiName }}</div>
          </div>
          <button class="text-xs text-primary hover:underline">変更</button>
        </div>
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm">性別 / 声</div>
            <div class="text-text-muted">
              {{ aiGender === 'female' ? '女性 (Samantha)' : '男性 (Daniel)' }}
            </div>
          </div>
          <button class="text-xs text-primary hover:underline">変更</button>
        </div>
      </div>
    </BaseCard>

    <p class="mt-6 text-center text-xs text-text-muted">
      Phase 3 — Task 3.2 で完全実装 / Task 2.4 ではスケルトン
    </p>
  </div>
</template>

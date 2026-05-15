<script setup lang="ts">
import { ref } from 'vue'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import { useThemeStore } from '../stores/theme'

const theme = useThemeStore()

const silenceDuration = ref(2.0)
const ttsRateConnectedToLevel = ref(true)
const whisperModel = ref('medium')
const llmModel = ref('gemma2:9b')
const darkMode = ref<'system' | 'light' | 'dark'>('system')
</script>

<template>
  <div class="mx-auto max-w-2xl px-6 py-8">
    <h1 class="text-3xl font-bold">設定</h1>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">🎤 音声</div>
      <div class="mt-4 space-y-4">
        <div>
          <label class="block text-sm">
            無音自動送信の間隔: <strong>{{ silenceDuration.toFixed(1) }}秒</strong>
          </label>
          <input
            v-model.number="silenceDuration"
            type="range"
            min="1"
            max="5"
            step="0.1"
            class="mt-2 w-full accent-primary"
          />
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input
            v-model="ttsRateConnectedToLevel"
            type="checkbox"
            class="h-4 w-4 rounded accent-primary"
          />
          AIの話速をレベルと連動させる
        </label>
      </div>
    </BaseCard>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">🧠 モデル</div>
      <div class="mt-4 space-y-3">
        <div>
          <label class="block text-sm">Whisper</label>
          <select
            v-model="whisperModel"
            class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          >
            <option value="small">small (~500MB)</option>
            <option value="medium">medium (~1.5GB)</option>
            <option value="large-v3">large-v3 (~3GB)</option>
          </select>
        </div>
        <div>
          <label class="block text-sm">LLM</label>
          <select
            v-model="llmModel"
            class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          >
            <option value="llama3.2:3b">軽量 (Llama 3.2 3B)</option>
            <option value="gemma2:9b">推奨 (Gemma 2 9B)</option>
            <option value="qwen2.5:14b">高精度 (Qwen 2.5 14B)</option>
          </select>
        </div>
      </div>
    </BaseCard>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">🎨 表示</div>
      <div class="mt-4 space-y-4">
        <div>
          <label class="block text-sm">ダークモード</label>
          <select
            v-model="darkMode"
            class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          >
            <option value="system">システム連動</option>
            <option value="light">ライト</option>
            <option value="dark">ダーク</option>
          </select>
        </div>
        <div>
          <label class="block text-sm">テーマ</label>
          <div class="mt-2 flex gap-2">
            <BaseButton
              v-for="t in theme.themes"
              :key="t.id"
              :variant="theme.current === t.id ? 'primary' : 'secondary'"
              size="sm"
              @click="theme.set(t.id)"
            >
              {{ t.name }}
            </BaseButton>
          </div>
        </div>
      </div>
    </BaseCard>

    <BaseCard class="mt-6">
      <div class="text-sm font-semibold">💾 データ</div>
      <div class="mt-4 space-y-3">
        <p class="text-sm text-text-muted">
          会話履歴の保存期間: 30日(変更不可)
        </p>
        <div class="flex flex-wrap gap-2">
          <BaseButton variant="secondary" size="sm">データをエクスポート</BaseButton>
          <BaseButton variant="secondary" size="sm">データをインポート</BaseButton>
          <BaseButton variant="danger" size="sm">全データを削除</BaseButton>
        </div>
      </div>
    </BaseCard>

    <p class="mt-6 text-center text-xs text-text-muted">
      Phase 3 — Task 3.3・3.4 で完全実装 / Task 2.4 ではスケルトン
    </p>
  </div>
</template>

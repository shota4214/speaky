<script setup lang="ts">
import { ref } from 'vue'
import { useThemeStore } from '../stores/theme'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import BaseInput from '../components/BaseInput.vue'
import LevelBadge from '../components/LevelBadge.vue'
import TopicChip from '../components/TopicChip.vue'

const theme = useThemeStore()
const nameInput = ref('Shota')
const errorInput = ref('invalid')
</script>

<template>
  <main class="min-h-screen bg-bg text-text">
    <div class="mx-auto max-w-5xl px-6 py-8">
      <div class="flex items-center justify-between">
        <h1 class="text-3xl font-bold">Components Preview</h1>
        <router-link to="/" class="text-sm text-text-muted hover:underline">← home</router-link>
      </div>
      <p class="mt-2 text-sm text-text-muted">Task 2.1 — テーマ切替とベースコンポーネント表示</p>

      <!-- Theme switcher -->
      <BaseCard class="mt-6">
        <div class="text-sm font-semibold">テーマ切替</div>
        <p class="mt-1 text-xs text-text-muted">
          現在: <code class="font-mono">{{ theme.current }}</code>
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <BaseButton
            v-for="t in theme.themes"
            :key="t.id"
            :variant="theme.current === t.id ? 'primary' : 'secondary'"
            @click="theme.set(t.id)"
          >
            {{ t.name }}
          </BaseButton>
        </div>
      </BaseCard>

      <!-- Buttons -->
      <BaseCard class="mt-6">
        <div class="text-sm font-semibold">BaseButton</div>
        <div class="mt-4 space-y-3">
          <div class="flex flex-wrap items-center gap-2">
            <BaseButton variant="primary">Primary</BaseButton>
            <BaseButton variant="secondary">Secondary</BaseButton>
            <BaseButton variant="ghost">Ghost</BaseButton>
            <BaseButton variant="danger">Danger</BaseButton>
            <BaseButton disabled>Disabled</BaseButton>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <BaseButton size="sm">Small</BaseButton>
            <BaseButton size="md">Medium</BaseButton>
            <BaseButton size="lg">Large</BaseButton>
          </div>
        </div>
      </BaseCard>

      <!-- Input -->
      <BaseCard class="mt-6">
        <div class="text-sm font-semibold">BaseInput</div>
        <div class="mt-4 grid gap-4 md:grid-cols-2">
          <BaseInput
            v-model="nameInput"
            label="ニックネーム"
            placeholder="Shota"
            hint="AIが呼びかけるときに使う"
          />
          <BaseInput v-model="errorInput" label="エラー例" error="この値は無効です" />
        </div>
      </BaseCard>

      <!-- Level Badge -->
      <BaseCard class="mt-6">
        <div class="text-sm font-semibold">LevelBadge</div>
        <div class="mt-4 space-y-3">
          <div class="flex flex-wrap items-center gap-2">
            <LevelBadge level="beginner" />
            <LevelBadge level="intermediate" />
            <LevelBadge level="advanced" />
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <LevelBadge level="beginner" active />
            <LevelBadge level="intermediate" active />
            <LevelBadge level="advanced" active />
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <LevelBadge level="beginner" size="sm" />
            <LevelBadge level="intermediate" size="md" />
            <LevelBadge level="advanced" size="lg" />
          </div>
        </div>
      </BaseCard>

      <!-- Topic Chip -->
      <BaseCard class="mt-6">
        <div class="text-sm font-semibold">TopicChip</div>
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <TopicChip label="日常会話" />
          <TopicChip label="ビジネス" />
          <TopicChip label="旅行" active />
          <TopicChip label="趣味" removable @remove="() => {}" />
        </div>
      </BaseCard>

      <!-- Typography -->
      <BaseCard class="mt-6">
        <div class="text-sm font-semibold">Typography</div>
        <div class="mt-4 space-y-2">
          <h1 class="text-4xl font-bold">Heading 1 — text-4xl</h1>
          <h2 class="text-3xl font-bold">Heading 2 — text-3xl</h2>
          <h3 class="text-2xl font-semibold">Heading 3 — text-2xl</h3>
          <h4 class="text-xl font-semibold">Heading 4 — text-xl</h4>
          <p class="text-base">Body — text-base. The quick brown fox jumps over the lazy dog.</p>
          <p class="text-sm text-text-muted">Small muted — text-sm text-text-muted</p>
          <p class="text-xs text-text-muted">Caption — text-xs text-text-muted</p>
        </div>
      </BaseCard>

      <!-- Color Tokens -->
      <BaseCard class="mt-6">
        <div class="text-sm font-semibold">Color Tokens</div>
        <div class="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div class="rounded-lg bg-primary p-3 text-xs text-white">bg-primary</div>
          <div class="rounded-lg bg-primary-light p-3 text-xs text-primary-dark">
            bg-primary-light
          </div>
          <div class="rounded-lg bg-primary-dark p-3 text-xs text-white">bg-primary-dark</div>
          <div class="rounded-lg bg-accent p-3 text-xs text-white">bg-accent</div>
          <div class="rounded-lg bg-bg p-3 text-xs text-text ring-1 ring-border">bg-bg</div>
          <div class="rounded-lg bg-surface p-3 text-xs text-text ring-1 ring-border">
            bg-surface
          </div>
          <div class="rounded-lg p-3 text-xs text-text ring-1 ring-border">text-text</div>
          <div class="rounded-lg p-3 text-xs text-text-muted ring-1 ring-border">
            text-text-muted
          </div>
        </div>
      </BaseCard>
    </div>
  </main>
</template>

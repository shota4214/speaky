<script setup lang="ts">
import { RouterLink } from 'vue-router'

interface NavItem {
  to: string
  icon: string
  label: string
}

const mainItems: NavItem[] = [
  { to: '/', icon: '🏠', label: 'ホーム' },
  { to: '/history', icon: '📚', label: '履歴' },
  { to: '/vocabulary', icon: '⭐', label: '復習リスト' },
  { to: '/profile', icon: '👤', label: 'プロフィール' },
  { to: '/settings', icon: '⚙️', label: '設定' },
]

const devItems: NavItem[] = [
  { to: '/chat', icon: '💬', label: '会話 (Phase 1)' },
  { to: '/prototype', icon: '🎤', label: '録音テスト' },
  { to: '/components-preview', icon: '🎨', label: 'デザインシステム' },
]
</script>

<template>
  <aside class="flex w-60 shrink-0 flex-col border-r border-border bg-surface px-4 py-6">
    <RouterLink to="/" class="mb-8 text-2xl font-bold text-primary hover:opacity-80">
      speaky
    </RouterLink>

    <nav class="flex flex-col gap-1">
      <RouterLink
        v-for="item in mainItems"
        :key="item.to"
        :to="item.to"
        class="flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-text transition hover:bg-primary-light/60"
        active-class="bg-primary-light text-primary-dark"
      >
        <span aria-hidden="true">{{ item.icon }}</span>
        <span>{{ item.label }}</span>
      </RouterLink>
    </nav>

    <div class="mt-auto pt-6">
      <div class="mb-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        Dev tools
      </div>
      <nav class="flex flex-col gap-1">
        <RouterLink
          v-for="item in devItems"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 rounded-xl px-3 py-2 text-xs text-text-muted transition hover:bg-primary-light/40 hover:text-text"
          active-class="bg-primary-light/60 text-text"
        >
          <span aria-hidden="true">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>
    </div>
  </aside>
</template>

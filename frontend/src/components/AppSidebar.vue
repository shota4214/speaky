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

// vite.config.ts の define で root package.json から注入される。
const appVersion = __APP_VERSION__
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

    <div class="mt-auto pt-4 text-center text-xs text-text-muted">Speaky v{{ appVersion }}</div>
  </aside>
</template>

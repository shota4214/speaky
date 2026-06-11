<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppShell from './components/AppShell.vue'
import UpdateNotification from './components/UpdateNotification.vue'
import { conversationsRepo } from './db/repos/conversations'
import { useSettingsStore } from './stores/settings'

const route = useRoute()
const router = useRouter()
const isMinimal = computed(() => route.meta?.layout === 'minimal')

const settings = useSettingsStore()
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const ONBOARDED_KEY = 'speaky:onboarded'

onMounted(async () => {
  // 未オンボーディングなら /onboarding にリダイレクト
  const onboarded =
    typeof localStorage !== 'undefined' && localStorage.getItem(ONBOARDED_KEY) === 'true'
  if (!onboarded && route.path !== '/onboarding') {
    await router.replace('/onboarding')
    return
  }

  // 30日経過した会話の自動削除(24時間に1回まで)
  const last = settings.settings.lastCleanupAt
  const now = Date.now()
  if (last !== null && now - last < ONE_DAY_MS) return
  try {
    const removed = await conversationsRepo.cleanupExpired()
    if (removed > 0) {
      console.log(`[cleanup] removed ${removed} expired conversation(s)`)
    }
    settings.update({ lastCleanupAt: now })
  } catch (e) {
    console.warn('[cleanup] failed:', e)
  }
})
</script>

<template>
  <AppShell v-if="!isMinimal">
    <router-view />
  </AppShell>
  <router-view v-else />
  <UpdateNotification v-if="!isMinimal" />
</template>

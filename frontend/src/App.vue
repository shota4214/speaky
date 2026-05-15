<script setup lang="ts">
import { onMounted, ref } from 'vue'

type HealthState = 'checking' | 'ok' | 'error'

const state = ref<HealthState>('checking')
const message = ref<string>('checking backend...')

onMounted(async () => {
  try {
    const res = await fetch('/api/health')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { status: string; timestamp: string }
    state.value = data.status === 'ok' ? 'ok' : 'error'
    message.value = `${data.status} (${data.timestamp})`
  } catch (e) {
    state.value = 'error'
    message.value = (e as Error).message
  }
})
</script>

<template>
  <main class="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-50 to-sky-50 dark:from-slate-900 dark:to-slate-800">
    <div class="rounded-2xl bg-white dark:bg-slate-900 p-10 shadow-xl ring-1 ring-slate-200 dark:ring-slate-700">
      <h1 class="text-4xl font-bold text-slate-900 dark:text-slate-100">speaky</h1>
      <p class="mt-2 text-slate-600 dark:text-slate-400">ローカル英会話学習アプリ</p>

      <div class="mt-8 flex items-center gap-3">
        <span class="text-sm text-slate-500 dark:text-slate-400">backend:</span>
        <span
          class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium"
          :class="{
            'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300': state === 'checking',
            'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300': state === 'ok',
            'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300': state === 'error',
          }"
        >
          <span
            class="h-1.5 w-1.5 rounded-full"
            :class="{
              'bg-slate-400 animate-pulse': state === 'checking',
              'bg-emerald-500': state === 'ok',
              'bg-rose-500': state === 'error',
            }"
          />
          {{ message }}
        </span>
      </div>

      <p class="mt-6 text-xs text-slate-400 dark:text-slate-500">Phase 1 / Task 1.1 — scaffold</p>
    </div>
  </main>
</template>
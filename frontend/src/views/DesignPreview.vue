<script setup lang="ts">
type Palette = {
  id: 'mint' | 'lavender' | 'peach'
  name: string
  description: string
  primary: string
  primaryLight: string
  primaryDark: string
  accent: string
  background: string
  card: string
  textPrimary: string
  textMuted: string
}

const palettes: Palette[] = [
  {
    id: 'mint',
    name: 'A. Mint Garden',
    description: '清涼感・健康的・清潔感。学習アプリの王道。',
    primary: '#10b981',
    primaryLight: '#d1fae5',
    primaryDark: '#047857',
    accent: '#0ea5e9',
    background: '#f0fdf4',
    card: '#ffffff',
    textPrimary: '#1f2937',
    textMuted: '#6b7280',
  },
  {
    id: 'lavender',
    name: 'B. Lavender Dusk',
    description: '落ち着き・上品・夜のじっくり学習向き。',
    primary: '#a78bfa',
    primaryLight: '#ede9fe',
    primaryDark: '#7c3aed',
    accent: '#f472b6',
    background: '#faf5ff',
    card: '#ffffff',
    textPrimary: '#1f2937',
    textMuted: '#6b7280',
  },
  {
    id: 'peach',
    name: 'C. Peach Sunrise',
    description: '暖かみ・朝の活力・フレンドリー。',
    primary: '#fb923c',
    primaryLight: '#ffedd5',
    primaryDark: '#ea580c',
    accent: '#f472b6',
    background: '#fffbf5',
    card: '#ffffff',
    textPrimary: '#1f2937',
    textMuted: '#6b7280',
  },
]
</script>

<template>
  <main
    class="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 p-6"
  >
    <div class="mx-auto max-w-7xl">
      <div class="flex items-center justify-between">
        <h1 class="text-3xl font-bold text-slate-900 dark:text-slate-100">
          Design Preview — 3 Palettes
        </h1>
        <router-link
          to="/"
          class="text-sm text-slate-600 dark:text-slate-400 hover:underline"
        >
          ← home
        </router-link>
      </div>
      <p class="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Task 2.1 — どのカラーパレットを採用するか比較用
      </p>

      <div class="mt-8 grid gap-6 lg:grid-cols-3">
        <div
          v-for="p in palettes"
          :key="p.id"
          class="rounded-2xl p-6 shadow-md"
          :style="{ backgroundColor: p.background }"
        >
          <div class="mb-1 text-xl font-bold" :style="{ color: p.textPrimary }">
            {{ p.name }}
          </div>
          <div class="text-sm" :style="{ color: p.textMuted }">
            {{ p.description }}
          </div>

          <div class="mt-5 grid grid-cols-4 gap-2">
            <div class="text-center">
              <div
                class="h-12 w-full rounded-lg"
                :style="{ backgroundColor: p.primary }"
              />
              <div class="mt-1 text-[10px]" :style="{ color: p.textMuted }">
                primary
              </div>
            </div>
            <div class="text-center">
              <div
                class="h-12 w-full rounded-lg"
                :style="{ backgroundColor: p.primaryLight }"
              />
              <div class="mt-1 text-[10px]" :style="{ color: p.textMuted }">
                light
              </div>
            </div>
            <div class="text-center">
              <div
                class="h-12 w-full rounded-lg"
                :style="{ backgroundColor: p.primaryDark }"
              />
              <div class="mt-1 text-[10px]" :style="{ color: p.textMuted }">
                dark
              </div>
            </div>
            <div class="text-center">
              <div
                class="h-12 w-full rounded-lg"
                :style="{ backgroundColor: p.accent }"
              />
              <div class="mt-1 text-[10px]" :style="{ color: p.textMuted }">
                accent
              </div>
            </div>
          </div>

          <div
            class="mt-5 rounded-xl p-4"
            :style="{ backgroundColor: p.card }"
          >
            <div
              class="text-xs uppercase tracking-wide font-semibold"
              :style="{ color: p.textMuted }"
            >
              Sample message
            </div>
            <div class="mt-2 text-sm" :style="{ color: p.textPrimary }">
              Hi! How was your weekend in Kyoto?
            </div>
            <div class="mt-1 text-xs" :style="{ color: p.textMuted }">
              やっほー!京都の週末どうだった?
            </div>

            <div class="mt-4 flex flex-wrap gap-2">
              <button
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-white"
                :style="{ backgroundColor: p.primary }"
              >
                会話を始める
              </button>
              <button
                class="rounded-lg px-3 py-1.5 text-sm font-medium"
                :style="{
                  backgroundColor: p.primaryLight,
                  color: p.primaryDark,
                }"
              >
                Secondary
              </button>
            </div>

            <div class="mt-3 flex flex-wrap gap-2">
              <span
                class="rounded-full px-2.5 py-1 text-xs font-medium text-white"
                :style="{ backgroundColor: p.primary }"
              >
                初心者
              </span>
              <span
                class="rounded-full px-2.5 py-1 text-xs font-medium"
                :style="{
                  backgroundColor: p.primaryLight,
                  color: p.primaryDark,
                }"
              >
                中級
              </span>
              <span
                class="rounded-full px-2.5 py-1 text-xs font-medium"
                :style="{ backgroundColor: p.accent + '20', color: p.accent }"
              >
                #日常会話
              </span>
            </div>
          </div>

          <div
            class="mt-4 text-[10px] font-mono"
            :style="{ color: p.textMuted }"
          >
            {{ p.primary }} / {{ p.accent }}
          </div>
        </div>
      </div>

      <div
        class="mt-8 rounded-xl bg-slate-100 dark:bg-slate-800 p-4 text-sm text-slate-600 dark:text-slate-400"
      >
        💡 3つを比べたら「A / B / C」のどれを採用するか教えてください。Tailwind config に反映してベースコンポーネントを実装します。
      </div>
    </div>
  </main>
</template>
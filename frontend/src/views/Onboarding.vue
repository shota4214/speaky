<script setup lang="ts">
import { ref } from 'vue'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'

type Step = 1 | 2 | 3 | 4 | 5 | 6

const step = ref<Step>(1)
const stepLabels: Record<Step, string> = {
  1: 'ようこそ',
  2: 'Ollama 確認',
  3: 'モデル選択',
  4: 'モデルダウンロード',
  5: 'AIキャラ設定',
  6: '完了',
}

function next() {
  if (step.value < 6) step.value = (step.value + 1) as Step
}
function prev() {
  if (step.value > 1) step.value = (step.value - 1) as Step
}
</script>

<template>
  <div class="min-h-screen bg-bg text-text">
    <div class="mx-auto flex min-h-screen max-w-3xl flex-col px-6 py-10">
      <header class="mb-8">
        <div class="text-2xl font-bold text-primary">speaky</div>
        <div class="mt-1 text-xs text-text-muted">
          初回セットアップ — ステップ {{ step }} / 6
        </div>
        <div class="mt-3 grid grid-cols-6 gap-1">
          <div
            v-for="i in 6"
            :key="i"
            class="h-1 rounded-full"
            :class="i <= step ? 'bg-primary' : 'bg-border'"
          />
        </div>
      </header>

      <BaseCard class="flex-1">
        <div class="text-sm font-semibold">{{ stepLabels[step] }}</div>

        <div v-if="step === 1" class="mt-6 space-y-4">
          <p>
            このアプリは英会話を学ぶための <strong>ローカル完結型</strong>
            アプリです。Whisper / Ollama / Web Speech API
            を組み合わせて、外部API課金ゼロでAIと英会話練習ができます。
          </p>
          <p class="text-sm text-text-muted">
            初回セットアップでは Ollama 確認・モデルダウンロード・AIキャラ設定を行います。
          </p>
        </div>

        <div v-else-if="step === 2" class="mt-6 space-y-3">
          <p>Ollama が起動しているか確認します。</p>
          <div class="rounded-lg bg-primary-light/40 p-3 text-sm">
            <code class="text-primary-dark">brew install ollama</code> でインストール、<br />
            <code class="text-primary-dark">brew services start ollama</code> で起動。
          </div>
          <BaseButton variant="secondary">再チェック</BaseButton>
        </div>

        <div v-else-if="step === 3" class="mt-6 space-y-4">
          <p>LLM と Whisper のモデルを選択してください。</p>
          <div class="space-y-2">
            <label class="block text-sm font-medium">LLM(推奨: Gemma 2 9B)</label>
            <select class="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm">
              <option>軽量 (Llama 3.2 3B / ~2GB)</option>
              <option selected>推奨 (Gemma 2 9B / ~5.5GB)</option>
              <option>高精度 (Qwen 2.5 14B / ~9GB)</option>
            </select>
          </div>
          <div class="space-y-2">
            <label class="block text-sm font-medium">Whisper(推奨: medium)</label>
            <select class="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm">
              <option>small (~500MB)</option>
              <option selected>medium (~1.5GB)</option>
              <option>large-v3 (~3GB)</option>
            </select>
          </div>
        </div>

        <div v-else-if="step === 4" class="mt-6 space-y-4">
          <p>モデルをダウンロードしています(Wi-Fi推奨、5〜30分)</p>
          <div>
            <div class="mb-1 flex justify-between text-xs text-text-muted">
              <span>Gemma 2 9B</span>
              <span>0 / 5.5 GB</span>
            </div>
            <div class="h-2 overflow-hidden rounded-full bg-border">
              <div class="h-full w-0 bg-primary" />
            </div>
          </div>
          <div>
            <div class="mb-1 flex justify-between text-xs text-text-muted">
              <span>Whisper medium</span>
              <span>0 / 1.5 GB</span>
            </div>
            <div class="h-2 overflow-hidden rounded-full bg-border">
              <div class="h-full w-0 bg-primary" />
            </div>
          </div>
        </div>

        <div v-else-if="step === 5" class="mt-6 space-y-4">
          <p>AIキャラクターを設定してください。</p>
          <div>
            <label class="block text-sm font-medium">名前</label>
            <input
              type="text"
              value="Emma"
              class="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            />
            <div class="mt-2 flex flex-wrap gap-2 text-xs text-text-muted">
              <span>候補:</span>
              <span>Emma · Mike · Alex · Sarah · James</span>
            </div>
          </div>
          <div>
            <div class="text-sm font-medium">性別 / 声</div>
            <div class="mt-2 flex gap-3">
              <label class="flex items-center gap-2 text-sm">
                <input type="radio" name="gender" value="female" checked />
                女性 (Samantha)
              </label>
              <label class="flex items-center gap-2 text-sm">
                <input type="radio" name="gender" value="male" />
                男性 (Daniel)
              </label>
            </div>
          </div>
        </div>

        <div v-else-if="step === 6" class="mt-6 space-y-3">
          <p class="text-lg font-medium">準備完了!</p>
          <p class="text-sm text-text-muted">
            「会話を始める」をクリックして最初の会話に進みましょう。
          </p>
        </div>
      </BaseCard>

      <footer class="mt-6 flex items-center justify-between">
        <BaseButton variant="ghost" :disabled="step === 1" @click="prev">
          ← 戻る
        </BaseButton>
        <BaseButton v-if="step < 6" @click="next">次へ →</BaseButton>
        <router-link v-else to="/">
          <BaseButton>会話を始める</BaseButton>
        </router-link>
      </footer>

      <p class="mt-4 text-center text-xs text-text-muted">
        Phase 3 — Task 3.5 で完全実装 / Task 2.4 ではスケルトン
      </p>
    </div>
  </div>
</template>

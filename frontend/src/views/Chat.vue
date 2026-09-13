<script setup lang="ts">
import { computed, nextTick, onBeforeMount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import AiMascot from '../components/AiMascot.vue'
import BaseButton from '../components/BaseButton.vue'
import LevelBadge from '../components/LevelBadge.vue'
import TopicChip from '../components/TopicChip.vue'
import { useConversationLoop } from '../composables/useConversationLoop'
import { conversationsRepo } from '../db/repos/conversations'
import { vocabularyRepo } from '../db/repos/vocabulary'
import type { Message, VocabItem } from '../db/types'
import { useConversationStore } from '../stores/conversation'
import { useSettingsStore } from '../stores/settings'
import { useVocabularyStore } from '../stores/vocabulary'
import { storedJapaneseTranslation } from '../utils/stored-translation'

const router = useRouter()
const conversation = useConversationStore()
const settings = useSettingsStore()
const vocabStore = useVocabularyStore()
const loop = useConversationLoop()

const aiName = computed(() => settings.settings.aiCharacter.name)
const aiGender = computed(() => settings.settings.aiCharacter.gender)
// AI が喋っている間は talking、それ以外は idle
const mascotMood = computed<'idle' | 'talking'>(() =>
  conversation.mode === 'aiSpeaking' ? 'talking' : 'idle',
)

// メッセージがまだ無い空状態でも、会話開始直後は AI が最初の挨拶を
// 生成・再生中。この間に「話しかけてください」を出すと実際の動き
// (AI から話す)と矛盾するため、AI 準備中かどうかで文言を出し分ける。
const emptyStateWaitingForAi = computed(() =>
  ['thinking', 'aiSpeaking', 'processing'].includes(conversation.mode),
)

const lastSummary = ref<string | null>(null)
const vocabFocusWords = ref<string[]>([])
const savedVocab = ref<Set<string>>(new Set())
const logEndRef = ref<HTMLDivElement | null>(null)
const showInactivityDialog = ref(false)

onBeforeMount(() => {
  if (!conversation.id) {
    router.replace('/')
  }
})

onMounted(async () => {
  if (!conversation.id) return

  // 別の最近の会話の要約を「前回の話」として渡す
  const recent = await conversationsRepo.list({ limit: 5 })
  const previous = recent.find((c) => c.id !== conversation.id && c.summary)
  lastSummary.value = previous?.summary ?? null

  // vocab focus
  if (conversation.vocabFocusIds.length > 0) {
    const items = await Promise.all(conversation.vocabFocusIds.map((id) => vocabularyRepo.get(id)))
    vocabFocusWords.value = items
      .filter((v): v is NonNullable<typeof v> => v != null)
      .map((v) => v.word)
  }

  await loop.start({
    conversationId: conversation.id,
    vocabFocusWords: vocabFocusWords.value,
    lastConversationSummary: lastSummary.value,
  })
})

watch(
  // 生成中の擬似メッセージが伸びる間もログ末尾に追従させる。
  () => [conversation.messages.length, loop.streamingReplyEn.value],
  async () => {
    await nextTick()
    logEndRef.value?.scrollIntoView({ behavior: 'smooth' })
  },
)

// 3回連続沈黙で「会話続けますか?」ダイアログを表示
watch(
  () => loop.consecutiveSilent.value,
  (count, prev) => {
    if (count >= 3 && (prev ?? 0) < 3) {
      showInactivityDialog.value = true
    }
  },
)

function continueConversation() {
  showInactivityDialog.value = false
  loop.consecutiveSilent.value = 0
}

async function endFromDialog() {
  showInactivityDialog.value = false
  await handleEnd()
}

const isActive = computed(() =>
  ['recording', 'processing', 'thinking', 'aiSpeaking', 'awaitingPromptedSpeech'].includes(
    conversation.mode,
  ),
)

const statusLabel = computed(() => {
  switch (conversation.mode) {
    case 'idle':
      return 'Ready'
    case 'recording':
      return '🎙 Listening...'
    case 'processing':
      return '📝 Transcribing...'
    case 'thinking':
      return '🤔 Thinking...'
    case 'aiSpeaking':
      return '🗣 Speaking...'
    case 'awaitingPromptedSpeech':
      return '👂 言ってみて...'
    default:
      return ''
  }
})

const statusDotClass = computed(() => ({
  'bg-text-muted/50': conversation.mode === 'idle',
  'bg-rose-500 animate-pulse': conversation.mode === 'recording',
  'bg-amber-500 animate-pulse':
    conversation.mode === 'processing' || conversation.mode === 'thinking',
  'bg-sky-500 animate-pulse': conversation.mode === 'aiSpeaking',
  'bg-violet-500 animate-pulse': conversation.mode === 'awaitingPromptedSpeech',
}))

const barCount = 32
const bars = computed(() => {
  const level = loop.recorder.audioLevel.value
  const arr: number[] = []
  for (let i = 0; i < barCount; i++) {
    const t = i / (barCount - 1)
    const distance = Math.abs(t - 0.5) * 2
    const localFactor = Math.cos((distance * Math.PI) / 2)
    arr.push(Math.min(1, level * 12 * localFactor + 0.05))
  }
  return arr
})

const ending = ref(false)
const endErrorMessage = ref<string>('')

async function handleEnd() {
  // 二重押し防止: 1 回目の終了処理が完了するまで 2 回目以降は無視
  if (ending.value) return
  ending.value = true
  endErrorMessage.value = ''
  try {
    loop.stop()
    let id: string | null
    try {
      id = await loop.endAndPersist()
    } catch (e) {
      // 保存失敗時は会話状態(conversation.id / messages)を保持し、
      // ユーザーが「会話を終わる」をもう一度押せば再試行できるようにする。
      // 履歴に endedAt 無しの会話が残るのを防ぐ。
      endErrorMessage.value = `会話の保存に失敗しました: ${(e as Error).message}\nもう一度「会話を終わる」を押すと再試行します。`
      console.error('[chat] endAndPersist failed:', e)
      return
    }
    conversation.end()
    vocabStore.clear()
    if (id) {
      await router.push({ path: '/chat/summary', query: { id } })
    } else {
      await router.push('/')
    }
  } finally {
    ending.value = false
  }
}

// 画面離脱(サイドメニュー・ブラウザバック等)時に会話を確実に終了する。
// 「会話を終わる」ボタン(handleEnd)経由の離脱は既に loop.stop + conversation.end
// 済みなのでスキップ。それ以外の離脱では:
//  - マイク/TTS を即停止(loop.stop は同期)
//  - 会話データを同期キャプチャしてから保存をバックグラウンド実行
//    (要約 API は数秒かかるため、待つとナビゲーションが固まる)
//  - 会話状態をクリアして即ナビゲーションを許可
onBeforeRouteLeave(() => {
  if (!conversation.id || ending.value) return true
  loop.stop()
  // endAndPersist は呼び出し時点で会話データを同期キャプチャするので、
  // 直後に conversation.end() しても保存内容は失われない。
  const persistPromise = loop.endAndPersist()
  conversation.end()
  vocabStore.clear()
  void persistPromise.catch((e) => {
    console.warn('[chat] 離脱時の会話保存に失敗(続行):', e)
  })
  return true
})

async function saveVocabItem(message: Message, item: VocabItem) {
  await vocabularyRepo.create({
    word: item.word,
    meaning: item.meaning,
    example: item.example,
    partOfSpeech: null,
  })
  savedVocab.value = new Set([...savedVocab.value, `${message.id}:${item.word}`])
}

async function saveAllFromMessage(message: Message) {
  if (!message.vocabulary) return
  for (const item of message.vocabulary) {
    if (savedVocab.value.has(`${message.id}:${item.word}`)) continue
    await saveVocabItem(message, item)
  }
}

function replayText(text: string) {
  // 直接 TTS を叩かずキュー経由で割り込む(AI の読み上げ中に押されても
  // 二重再生にならない)。詳細は useConversationLoop.replay のコメント。
  loop.replay(text)
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function isVocabSaved(message: Message, word: string): boolean {
  return savedVocab.value.has(`${message.id}:${word}`)
}

// --- 日本語訳の後追い(enrich)状態 ---
// 「日本語訳を必ず表示」という約束があるので、届くまでは待機表示、
// 失敗したら再取得ボタンを出す(空行のまま放置しない)。
function isEnrichPending(message: Message): boolean {
  return loop.enrichPendingIds.value.has(message.id)
}
function isEnrichFailed(message: Message): boolean {
  return loop.enrichFailedIds.value.has(message.id)
}
/**
 * 日本語訳の欄に「参考訳」と添えるか。AI の返答の訳は小型モデルだと
 * 3 分の 1 程度が部分的にしか合っていないので、正確な訳のように見せない。
 * 日本語入力のターン(「〜と言えますよ」)は訳ではなく案内文なので付けない。
 */
function isReferenceTranslation(message: Message): boolean {
  return message.mode !== 'japanese_help' && message.mode !== 'mixed'
}
function showJapaneseLine(message: Message): boolean {
  if (!settings.settings.showJapanese) return false
  return !!storedJapaneseTranslation(message) || isEnrichPending(message) || isEnrichFailed(message)
}
async function retryJapanese(message: Message) {
  await loop.retryEnrich(message.id)
}
</script>

<template>
  <div class="flex h-screen flex-col text-text">
    <header class="border-b border-border px-6 py-3">
      <div class="mx-auto flex max-w-4xl items-center justify-between">
        <div class="flex items-center gap-3">
          <AiMascot :size="44" :mood="mascotMood" :gender="aiGender" />
          <div>
            <h1 class="text-lg font-semibold">{{ aiName }} と会話中</h1>
            <div class="mt-1 flex items-center gap-2 text-xs">
              <LevelBadge :level="conversation.level" size="sm" />
              <TopicChip :label="conversation.topic" size="sm" />
              <!--
                backend が申告したプロファイル(推定ではなく実際に動いた値)。
                軽量モードは単語カードが出ないので、「出ない」のか「壊れている」のかを
                ユーザーが区別できるようにここで明示する(添削はどちらのモードでも出る)。
              -->
              <span
                v-if="loop.activeProfile.value === 'small'"
                class="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] text-sky-700 dark:bg-sky-900/30 dark:text-sky-300"
                title="小さいモデル向けの設定で動いています(返答は短め・日本語訳と添削は出ます・単語カードは出ません)"
              >
                🪶 軽量モード
              </span>
              <span v-if="conversation.isPaused" class="text-amber-500"> ⏸ 一時停止中 </span>
            </div>
          </div>
        </div>
        <BaseButton variant="danger" size="sm" :disabled="ending" @click="handleEnd">
          {{ ending ? '終了処理中...' : '⏹ 会話を終わる' }}
        </BaseButton>
      </div>
      <div
        v-if="endErrorMessage"
        class="mx-auto mt-2 max-w-4xl whitespace-pre-wrap rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
      >
        {{ endErrorMessage }}
      </div>
    </header>

    <div class="flex-1 overflow-y-auto px-6 py-6">
      <div class="mx-auto max-w-3xl space-y-4">
        <div
          v-if="conversation.messages.length === 0"
          class="flex h-64 flex-col items-center justify-center text-center text-text-muted"
        >
          <template v-if="emptyStateWaitingForAi">
            <AiMascot :size="96" mood="talking" :gender="aiGender" />
            <p class="mt-3 text-sm">{{ aiName }} が話しかける準備をしています...</p>
          </template>
          <template v-else>
            <div class="text-5xl">🎤</div>
            <p class="mt-3 text-sm">話しかけてください...</p>
          </template>
        </div>

        <div v-for="m in conversation.messages" :key="m.id">
          <div v-if="m.role === 'user'" class="flex justify-end">
            <div
              class="max-w-[75%] rounded-3xl rounded-br-lg bg-primary px-4 py-3 text-white shadow-glow-sm"
            >
              <div class="text-sm">{{ m.userText }}</div>
              <div class="mt-1 text-[10px] opacity-80">
                {{ formatTime(m.timestamp) }} · lang:
                {{ m.inputLanguage ?? '—' }}
              </div>
            </div>
          </div>

          <div v-else class="flex flex-col items-start space-y-2">
            <div class="flex w-full justify-start">
              <div
                class="max-w-[75%] rounded-3xl rounded-bl-lg bg-surface px-4 py-3 shadow-glow-sm ring-1 ring-border"
              >
                <div class="text-sm">{{ m.replyEn }}</div>
                <div v-if="showJapaneseLine(m)" class="mt-1 text-xs text-text-muted">
                  <template v-if="storedJapaneseTranslation(m)">
                    <span
                      v-if="isReferenceTranslation(m)"
                      class="mr-1 rounded border border-border px-1 text-[10px]"
                      title="AI による参考の訳です。細かいニュアンスは違うことがあります"
                      >参考訳</span
                    >{{ storedJapaneseTranslation(m) }}
                  </template>
                  <template v-else-if="isEnrichPending(m)">
                    <span class="opacity-60">日本語訳を準備中...</span>
                  </template>
                  <template v-else>
                    <span class="opacity-60">日本語訳を取得できませんでした</span>
                    <button
                      v-if="loop.canRetryEnrich()"
                      class="ml-2 text-[10px] text-primary hover:underline"
                      @click="retryJapanese(m)"
                    >
                      ↻ 再取得
                    </button>
                  </template>
                </div>
                <div class="mt-2 flex items-center gap-2">
                  <button
                    class="text-[10px] text-text-muted hover:text-text"
                    @click="replayText(m.replyEn ?? '')"
                  >
                    🔊 もう一度聞く
                  </button>
                  <span
                    v-if="m.mode === 'japanese_help' || m.mode === 'mixed'"
                    class="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] text-violet-700 dark:bg-violet-900/30 dark:text-violet-300"
                  >
                    言ってみて
                  </span>
                </div>
              </div>
            </div>

            <div
              v-if="m.feedback"
              class="ml-2 max-w-[75%] rounded-xl bg-amber-50 px-3 py-2 text-xs ring-1 ring-amber-200 dark:bg-amber-900/20 dark:ring-amber-700/40"
            >
              <div class="font-semibold text-amber-700 dark:text-amber-300">✏️ 添削</div>
              <div class="mt-1">
                <span class="text-rose-500 line-through">{{ m.feedback.userSaid }}</span>
                <span class="mx-1 text-text-muted">→</span>
                <strong class="text-emerald-600 dark:text-emerald-400">{{
                  m.feedback.corrected
                }}</strong>
              </div>
              <div class="mt-1 text-text-muted">
                {{ m.feedback.explanation }}
              </div>
            </div>

            <div
              v-if="m.vocabulary && m.vocabulary.length > 0"
              class="ml-2 max-w-[75%] rounded-xl bg-primary-light/40 px-3 py-2 text-xs"
            >
              <div class="flex items-center justify-between">
                <div class="font-semibold text-primary-dark">📚 単語・フレーズ</div>
                <button
                  class="text-[10px] text-primary hover:underline"
                  @click="saveAllFromMessage(m)"
                >
                  ♡ 全部覚えたい
                </button>
              </div>
              <ul class="mt-2 space-y-1.5">
                <li
                  v-for="v in m.vocabulary"
                  :key="v.word"
                  class="flex items-start justify-between gap-2"
                >
                  <div>
                    <strong>{{ v.word }}</strong>
                    <span class="ml-2 text-text-muted">— {{ v.meaning }}</span>
                    <div v-if="v.example" class="text-[10px] italic text-text-muted">
                      "{{ v.example }}"
                    </div>
                  </div>
                  <button
                    class="shrink-0 text-[10px]"
                    :class="
                      isVocabSaved(m, v.word) ? 'text-text-muted' : 'text-primary hover:underline'
                    "
                    :disabled="isVocabSaved(m, v.word)"
                    @click="saveVocabItem(m, v)"
                  >
                    {{ isVocabSaved(m, v.word) ? '✓ 保存済み' : '♡ これ覚えたい' }}
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </div>
        <!--
          生成中の返答。まだ DB には無い「擬似メッセージ」で、done が来た時点で
          本物のメッセージに置き換わる(ここでは保存しない)。
        -->
        <div v-if="loop.streamingReplyEn.value" class="flex flex-col items-start space-y-2">
          <div class="flex w-full justify-start">
            <div
              class="max-w-[75%] rounded-3xl rounded-bl-lg bg-surface px-4 py-3 shadow-glow-sm ring-1 ring-border ring-dashed"
            >
              <div class="text-sm">{{ loop.streamingReplyEn.value }}</div>
              <div class="mt-1 text-[10px] text-text-muted">生成中...</div>
            </div>
          </div>
        </div>
        <div ref="logEndRef"></div>
      </div>
    </div>

    <footer class="border-t border-border bg-surface px-6 py-4">
      <div class="mx-auto max-w-3xl">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="h-2.5 w-2.5 rounded-full" :class="statusDotClass" />
            <span class="text-sm font-medium">{{ statusLabel }}</span>
            <span v-if="loop.consecutiveSilent.value > 0" class="text-xs text-text-muted">
              · {{ loop.consecutiveSilent.value }} silent
            </span>
            <span v-if="loop.promptedAttempts.value > 0" class="text-xs text-violet-500">
              · 言ってみて {{ loop.promptedAttempts.value }}/3
            </span>
          </div>
          <span v-if="!isActive" class="text-xs text-text-muted"> 会話セッション終了済み </span>
        </div>
        <div class="mt-3 flex h-12 items-center justify-center gap-1">
          <span
            v-for="(h, i) in bars"
            :key="i"
            class="w-1 rounded-full transition-all duration-75"
            :class="
              conversation.mode === 'recording' || conversation.mode === 'awaitingPromptedSpeech'
                ? 'bg-primary'
                : 'bg-border'
            "
            :style="{ height: `${h * 100}%` }"
          />
        </div>
        <div
          v-if="loop.errorMessage.value"
          class="mt-3 whitespace-pre-wrap rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
        >
          {{ loop.errorMessage.value }}
        </div>
      </div>
    </footer>

    <!-- Inactivity dialog -->
    <div
      v-if="showInactivityDialog"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div class="mx-4 max-w-md rounded-2xl bg-surface p-6 shadow-xl ring-1 ring-border">
        <h3 class="text-lg font-semibold">会話を続けますか?</h3>
        <p class="mt-2 text-sm text-text-muted">
          無音が続いています。会話を続けるか、終了するかを選んでください。
        </p>
        <div class="mt-6 flex gap-2">
          <BaseButton variant="secondary" class="flex-1" @click="endFromDialog">
            会話を終わる
          </BaseButton>
          <BaseButton class="flex-1" @click="continueConversation"> 続ける </BaseButton>
        </div>
      </div>
    </div>
  </div>
</template>

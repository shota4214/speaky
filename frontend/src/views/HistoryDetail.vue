<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import BaseCard from '../components/BaseCard.vue'
import LevelBadge from '../components/LevelBadge.vue'
import TopicChip from '../components/TopicChip.vue'
import { useSpeechQueue } from '../composables/useSpeechQueue'
import { useTextToSpeech } from '../composables/useTextToSpeech'
import { conversationsRepo } from '../db/repos/conversations'
import { messagesRepo } from '../db/repos/messages'
import type { Conversation, Message } from '../db/types'
import { chatEnrich, probeBackendFeatures } from '../services/api'
import { acceptJapaneseTranslation } from '../../../backend/src/shared/text-guards'
import { useSettingsStore } from '../stores/settings'
import {
  FEATURE_CHAT_ENRICH,
  FEATURE_MODEL_PROFILE,
  hasFeature,
  NO_FEATURES,
  type BackendFeatures,
} from '../utils/backend-features'

const route = useRoute()
const settings = useSettingsStore()
const tts = useTextToSpeech()
/**
 * 読み上げはキュー経由に統一する。この画面には会話ループが無いので
 * 単独で tts.speak を呼んでも壊れないが、「割り込み再生の入口は speakNow だけ」
 * という約束を画面ごとに破ると、会話画面で潰したばかりの二重再生が
 * コピペで戻ってくる。
 */
const speechQueue = useSpeechQueue(tts)

const conversation = ref<Conversation | null>(null)
const messages = ref<Message[]>([])
const loading = ref(true)

/**
 * 日本語訳の再取得。
 *
 * なぜ履歴画面にも要るのか: 日本語訳は会話中に **後追い(enrich)** で入る。
 * 次のターンを始めるとき前のターンの enrich は打ち切られるし、会話終了後の
 * 一括埋め合わせ(backfillEnrichment)も、その間にユーザーが次の会話を始めれば
 * 途中で止まる。その結果 **日本語訳の無い行が履歴に残る**。
 * 会話画面には再取得ボタンがあるのに履歴画面には無かったので、
 * そこへ辿り着いた行は「二度と訳が入らない」状態だった —
 * 「日本語訳を必ず表示する」という製品上の約束が最後で破れていた。
 */
const backendFeatures = ref<BackendFeatures>(NO_FEATURES)
/** 再取得中のメッセージ ID。 */
const retryingIds = ref<Set<string>>(new Set())
/** 再取得したが訳を取れなかったメッセージ ID(もう一度押せる)。 */
const retryFailedIds = ref<Set<string>>(new Set())

const canRetryJapanese = computed(() => hasFeature(backendFeatures.value, FEATURE_CHAT_ENRICH))

onMounted(async () => {
  const id = route.params.id as string
  conversation.value = (await conversationsRepo.get(id)) ?? null
  if (conversation.value) {
    messages.value = await messagesRepo.listByConversation(id)
  }
  loading.value = false
  // 機能検出は画面マウント時(起動時に取ると backend がまだ listen していない)。
  backendFeatures.value = await probeBackendFeatures()
})

/** 日本語訳に「参考訳」と添えるか(日本語入力ターンの案内文には付けない)。 */
function isReferenceTranslation(m: Message): boolean {
  return m.mode !== 'japanese_help' && m.mode !== 'mixed'
}

/** 日本語訳が欠けている AI 返答か(= 再取得の対象)。 */
function isJapaneseMissing(m: Message): boolean {
  return m.role === 'ai' && !!m.replyEn?.trim() && !m.replyJa?.trim()
}

/** そのメッセージの直前のユーザー発話(添削の材料)。 */
function previousUserText(messageId: string): string | null {
  const idx = messages.value.findIndex((m) => m.id === messageId)
  for (let i = idx - 1; i >= 0; i--) {
    const m = messages.value[i]!
    if (m.role === 'user') return m.userText
  }
  return null
}

function setFlag(target: typeof retryingIds, id: string, on: boolean): void {
  const next = new Set(target.value)
  if (on) next.add(id)
  else next.delete(id)
  target.value = next
}

async function retryJapanese(message: Message): Promise<void> {
  if (!message.replyEn || retryingIds.value.has(message.id)) return
  setFlag(retryingIds, message.id, true)
  setFlag(retryFailedIds, message.id, false)
  try {
    const enrichment = await chatEnrich(message.replyEn, previousUserText(message.id), {
      aiName: settings.settings.aiCharacter.name,
      level: conversation.value?.level,
      topic: conversation.value?.topic,
      model: settings.settings.llmModel,
      ...(hasFeature(backendFeatures.value, FEATURE_MODEL_PROFILE)
        ? { modelProfile: settings.settings.modelProfile }
        : {}),
    })
    // 訳が空 / 訳として使えない enrich は成功ではない。会話画面(applyEnrichment)と同じ判定にする。
    const replyJa = acceptJapaneseTranslation(enrichment.replyJa, message.replyEn)
    if (!replyJa) {
      setFlag(retryFailedIds, message.id, true)
      return
    }
    // ⚠️ ユーザーが頼んだのは **日本語訳** であって添削のやり直しではない。
    // 既に添削 / 単語が入っている行を今のモデル(当時と別かもしれない、
    // しかも小さいかもしれない)の出力で差し替えると、黙って劣化させることになる。
    // 空のときだけ埋める。
    const updated = await messagesRepo.update(message.id, {
      replyJa,
      ...(message.feedback || !enrichment.feedback
        ? {}
        : {
            feedback: {
              userSaid: enrichment.feedback.user_said,
              corrected: enrichment.feedback.corrected,
              explanation: enrichment.feedback.explanation,
            },
          }),
      ...((message.vocabulary?.length ?? 0) > 0 || enrichment.vocabulary.length === 0
        ? {}
        : { vocabulary: enrichment.vocabulary }),
    })
    if (updated) {
      messages.value = messages.value.map((m) => (m.id === updated.id ? updated : m))
    } else {
      // 行が消えている(30 日で削除された等)。押しっぱなしに見せない。
      setFlag(retryFailedIds, message.id, true)
    }
  } catch (e) {
    console.warn('[history] 日本語訳の再取得に失敗:', e)
    setFlag(retryFailedIds, message.id, true)
  } finally {
    setFlag(retryingIds, message.id, false)
  }
}

const durationMin = computed(() => {
  const c = conversation.value
  if (!c || !c.endedAt) return null
  const ms = c.endedAt.getTime() - c.startedAt.getTime()
  return Math.max(1, Math.round(ms / 60_000))
})

const turnCount = computed(() => messages.value.filter((m) => m.role === 'ai').length)

function formatTime(d: Date): string {
  return d.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function replay(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return
  speechQueue.speakNow(trimmed)
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-8">
    <div class="flex items-center justify-between">
      <h1 class="text-3xl font-bold">会話の詳細</h1>
      <router-link to="/history" class="text-sm text-text-muted hover:underline">
        ← 履歴一覧
      </router-link>
    </div>

    <div v-if="loading" class="mt-6 text-text-muted">読み込み中...</div>

    <div v-else-if="!conversation" class="mt-6">
      <BaseCard>
        <p class="text-text-muted">会話が見つかりませんでした(30日経過で削除済みの可能性)</p>
      </BaseCard>
    </div>

    <template v-else>
      <BaseCard class="mt-6">
        <div class="flex flex-wrap items-center gap-3 text-sm">
          <TopicChip :label="conversation.topic" />
          <LevelBadge :level="conversation.level" size="sm" />
          <span v-if="durationMin" class="text-text-muted"> {{ durationMin }}分 </span>
          <span class="text-text-muted">{{ turnCount }} turns</span>
        </div>
        <p v-if="conversation.summary" class="mt-3 text-sm text-text-muted">
          📝 {{ conversation.summary }}
        </p>
      </BaseCard>

      <div class="mt-6 space-y-3">
        <div v-for="m in messages" :key="m.id">
          <div v-if="m.role === 'user'" class="flex justify-end">
            <div class="max-w-[75%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-white">
              <div class="text-sm">{{ m.userText }}</div>
              <div class="mt-1 text-[10px] opacity-80">
                {{ formatTime(m.timestamp) }}
              </div>
            </div>
          </div>
          <div v-else class="flex flex-col items-start space-y-2">
            <div class="flex w-full justify-start">
              <div
                class="max-w-[75%] rounded-2xl rounded-bl-md bg-surface px-4 py-3 shadow-sm ring-1 ring-border"
              >
                <div class="text-sm">{{ m.replyEn }}</div>
                <!--
                  日本語訳は後追い(enrich)で入るため、届かないまま保存された行が
                  ありうる。無条件に出すと空行だけが残るので、あるときだけ描画する。
                -->
                <div v-if="m.replyJa" class="mt-1 text-xs text-text-muted">
                  <span
                    v-if="isReferenceTranslation(m)"
                    class="mr-1 rounded border border-border px-1 text-[10px]"
                    title="AI による参考の訳です。細かいニュアンスは違うことがあります"
                    >参考訳</span
                  >{{ m.replyJa }}
                </div>
                <div v-else-if="isJapaneseMissing(m)" class="mt-1 text-xs text-text-muted">
                  <span class="opacity-60">
                    {{
                      retryingIds.has(m.id) ? '日本語訳を取得中...' : '日本語訳が保存されていません'
                    }}
                  </span>
                  <button
                    v-if="canRetryJapanese && !retryingIds.has(m.id)"
                    class="ml-2 text-[10px] text-primary hover:underline"
                    @click="retryJapanese(m)"
                  >
                    {{ retryFailedIds.has(m.id) ? '↻ もう一度試す' : '↻ 再取得' }}
                  </button>
                </div>
                <button
                  class="mt-2 text-[10px] text-text-muted hover:text-text"
                  @click="replay(m.replyEn ?? '')"
                >
                  🔊 再生
                </button>
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
              <div class="font-semibold text-primary-dark">📚 単語・フレーズ</div>
              <ul class="mt-2 space-y-1.5">
                <li v-for="v in m.vocabulary" :key="v.word">
                  <strong>{{ v.word }}</strong>
                  <span class="ml-2 text-text-muted">— {{ v.meaning }}</span>
                  <div v-if="v.example" class="text-[10px] italic text-text-muted">
                    "{{ v.example }}"
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

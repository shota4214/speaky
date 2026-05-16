import { ref } from 'vue'
import { conversationsRepo } from '../db/repos/conversations'
import { messagesRepo } from '../db/repos/messages'
import type { Message } from '../db/types'
import {
  chat,
  chatOpening,
  extractFacts,
  summarize,
  transcribeAudio,
  type ChatHistoryItem,
} from '../services/api'
import { useConversationStore } from '../stores/conversation'
import { useProfileStore } from '../stores/profile'
import { useSettingsStore } from '../stores/settings'
import { detectInputMode, isTooShort, looksLikeHallucination } from '../utils/language-detection'
import { useAudioRecorder } from './useAudioRecorder'
import { useTextToSpeech } from './useTextToSpeech'

const MAX_SILENT_BEFORE_HINT = 3
const MAX_PROMPTED_ATTEMPTS = 3

interface StartLoopInput {
  conversationId: string
  vocabFocusWords: string[]
  lastConversationSummary: string | null
}

export function useConversationLoop() {
  const conversation = useConversationStore()
  const settings = useSettingsStore()
  const profile = useProfileStore()

  const recorder = useAudioRecorder({
    silenceDurationMs: settings.settings.silenceDurationMs,
    silenceThreshold: 0.02,
    speechThreshold: 0.05,
    minRecordingMs: 500,
    maxRecordingMs: 30_000,
  })
  const tts = useTextToSpeech({ rate: 1.0 })

  const errorMessage = ref<string | null>(null)
  const stopRequested = ref(false)
  const consecutiveSilent = ref(0)
  const promptedAttempts = ref(0)
  const lastAiReplyEn = ref<string>('')

  function pickExtension(mime: string): string {
    if (mime.includes('mp4')) return 'mp4'
    if (mime.includes('ogg')) return 'ogg'
    return 'webm'
  }

  function buildHistory(): ChatHistoryItem[] {
    return conversation.messages
      .map<ChatHistoryItem | null>((m) => {
        if (m.role === 'user' && m.userText) {
          return { role: 'user', text: m.userText }
        }
        if (m.role === 'ai' && m.replyEn) {
          return { role: 'ai', text: m.replyEn }
        }
        return null
      })
      .filter((x): x is ChatHistoryItem => x !== null)
  }

  async function start(input: StartLoopInput) {
    stopRequested.value = false
    consecutiveSilent.value = 0
    promptedAttempts.value = 0
    errorMessage.value = null
    lastAiReplyEn.value = ''

    await profile.load().catch(() => undefined)
    await playOpening(input)
    if (!stopRequested.value) {
      await runLoop(input)
    }
  }

  /**
   * 会話開始時に AI から最初の挨拶を生成 → 表示 → 読み上げ。
   * 失敗してもループは継続する(挨拶なしで普通に会話開始)。
   */
  async function playOpening(input: StartLoopInput) {
    if (!conversation.id) return

    // Phase 1: 挨拶生成(API失敗時は完全にスキップしてユーザー主導の会話に)
    conversation.setMode('thinking')
    let reply
    try {
      reply = await chatOpening({
        aiName: settings.settings.aiCharacter.name,
        level: conversation.level,
        topic: conversation.topic,
        vocabFocus: input.vocabFocusWords,
        userProfile: profile.facts.map((f) => f.fact),
        lastConversationSummary: input.lastConversationSummary,
        model: settings.settings.llmModel,
      })
    } catch (e) {
      console.warn('[loop] opening generation failed, skipping:', e)
      return
    }

    if (stopRequested.value || !conversation.id) return

    // Phase 2: メッセージ永続化(IndexedDB)
    const aiMsg = await messagesRepo.create({
      conversationId: conversation.id,
      timestamp: new Date(),
      role: 'ai',
      userText: null,
      inputLanguage: null,
      replyEn: reply.reply_en,
      replyJa: reply.reply_ja,
      feedback: null,
      vocabulary: reply.vocabulary,
      mode: 'normal',
    })
    conversation.appendMessage(aiMsg)
    lastAiReplyEn.value = reply.reply_en

    // Phase 3: 読み上げ(失敗してもメッセージは画面に出ているので、
    // ユーザーに「読み上げ失敗」を明示してテキストを読んでもらう導線へ)
    try {
      conversation.setMode('aiSpeaking')
      await tts.speak(reply.reply_en, { rate: speakRateForLevel() })
    } catch (e) {
      console.warn('[loop] opening TTS failed:', e)
      errorMessage.value =
        'AI挨拶の音声合成に失敗しました。上の英文を読んでから話しかけてください。'
    }
  }

  async function runLoop(input: StartLoopInput) {
    try {
      while (!stopRequested.value && conversation.id) {
        conversation.setMode(promptedAttempts.value > 0 ? 'awaitingPromptedSpeech' : 'recording')

        const recording = await recorder.start()
        if (stopRequested.value) break

        if (!recording.hadSpeech) {
          await handleSilentRecording()
          continue
        }

        conversation.setMode('processing')
        let trans
        try {
          trans = await transcribeAudio(recording.blob, {
            filename: `recording.${pickExtension(recording.mimeType)}`,
            model: settings.settings.whisperModel,
          })
        } catch (e) {
          console.warn('[loop] transcribe failed:', e)
          continue
        }

        if (stopRequested.value) break
        if (isTooShort(trans.text) || looksLikeHallucination(trans.text)) {
          console.debug('[loop] dropped (short/hallucination):', trans.text)
          continue
        }

        consecutiveSilent.value = 0
        promptedAttempts.value = 0

        const inputMode = detectInputMode(trans.text)

        const userMsg = await messagesRepo.create({
          conversationId: conversation.id,
          timestamp: new Date(),
          role: 'user',
          userText: trans.text,
          inputLanguage: trans.language === 'unknown' ? null : trans.language,
          replyEn: null,
          replyJa: null,
          feedback: null,
          vocabulary: null,
          mode: inputMode,
        })
        conversation.appendMessage(userMsg)

        conversation.setMode('thinking')
        const reply = await chat(trans.text, {
          aiName: settings.settings.aiCharacter.name,
          level: conversation.level,
          topic: conversation.topic,
          mode: inputMode,
          vocabFocus: input.vocabFocusWords,
          userProfile: profile.facts.map((f) => f.fact),
          lastConversationSummary: input.lastConversationSummary,
          conversationHistory: buildHistory().slice(-20),
          model: settings.settings.llmModel,
        })

        if (stopRequested.value) break

        const aiMsg = await messagesRepo.create({
          conversationId: conversation.id,
          timestamp: new Date(),
          role: 'ai',
          userText: null,
          inputLanguage: null,
          replyEn: reply.reply_en,
          replyJa: reply.reply_ja,
          feedback: reply.feedback
            ? {
                userSaid: reply.feedback.user_said,
                corrected: reply.feedback.corrected,
                explanation: reply.feedback.explanation,
              }
            : null,
          vocabulary: reply.vocabulary,
          mode: reply.mode,
        })
        conversation.appendMessage(aiMsg)

        lastAiReplyEn.value = reply.reply_en
        conversation.setMode('aiSpeaking')
        await tts.speak(reply.reply_en, { rate: speakRateForLevel() })

        if (stopRequested.value) break

        if (reply.mode === 'japanese_help' || reply.mode === 'mixed') {
          promptedAttempts.value = 1
          conversation.setMode('awaitingPromptedSpeech')
        }
      }
    } catch (e) {
      console.error('[loop] error:', e)
      errorMessage.value = (e as Error).message
    } finally {
      conversation.setMode('idle')
    }
  }

  async function handleSilentRecording() {
    if (promptedAttempts.value > 0) {
      // 言ってみてモード中
      if (promptedAttempts.value < MAX_PROMPTED_ATTEMPTS) {
        promptedAttempts.value += 1
        if (lastAiReplyEn.value) {
          conversation.setMode('aiSpeaking')
          await tts.speak(lastAiReplyEn.value, { rate: 0.8 })
        }
      } else {
        if (lastAiReplyEn.value) {
          conversation.setMode('aiSpeaking')
          await tts.speak("Let's move on. 次に進みましょう。")
        }
        promptedAttempts.value = 0
      }
      return
    }

    consecutiveSilent.value += 1
    if (consecutiveSilent.value >= MAX_SILENT_BEFORE_HINT) {
      conversation.setMode('aiSpeaking')
      await tts.speak('もしかして分からない?英語が分からなければ日本語で話してくれてもいいよ。', {
        lang: 'ja-JP',
        rate: 0.95,
      })
      consecutiveSilent.value = 0
    }
  }

  function speakRateForLevel(): number {
    if (!settings.settings.ttsRateConnectedToLevel) return 1.0
    switch (conversation.level) {
      case 'beginner':
        return 0.85
      case 'intermediate':
        return 1.0
      case 'advanced':
        return 1.1
      default:
        return 1.0
    }
  }

  function stop() {
    stopRequested.value = true
    recorder.stop()
    tts.cancel()
  }

  // endAndPersist の二重実行ガード(handleEnd が何らかの理由で 2 回呼ばれても
  // 1 回目だけ実際の処理を走らせる。2 回目は同じ id を返して安全に終わる)
  let endInFlight: Promise<string | null> | null = null

  async function endAndPersist(): Promise<string | null> {
    if (endInFlight) return endInFlight
    endInFlight = doEndAndPersist().finally(() => {
      endInFlight = null
    })
    return endInFlight
  }

  async function doEndAndPersist(): Promise<string | null> {
    // 関数の最初に conversation.id を「キャプチャ」しておく。
    // 以降の await 中に store の id が null に書き換わっても、
    // ここで保持した id を使い続ける(Table.get(null) を避ける)。
    const conversationId = conversation.id
    if (!conversationId) return null

    const topic = conversation.topic
    const transcriptItems: ChatHistoryItem[] = buildHistory()

    // AI からの opening だけで終わった(ユーザー発話無し)場合は
    // 要約・事実抽出をスキップする。そうしないと「挨拶しただけ」のセッションが
    // turn 1 / summary 有りで履歴に残り、次回 lastConversationSummary にも混入する。
    const hasUserTurn = transcriptItems.some((x) => x.role === 'user')

    let summaryText = ''
    if (hasUserTurn) {
      try {
        const res = await summarize(transcriptItems, topic, {
          model: settings.settings.llmModel,
        })
        summaryText = res.summary
      } catch (e) {
        console.warn('[loop] summarize failed:', e)
      }

      // ユーザーの新事実をプロフィールに学習追加
      try {
        const existingFacts = profile.facts.map((f) => f.fact)
        const result = await extractFacts(transcriptItems, existingFacts, profile.name, {
          model: settings.settings.llmModel,
        })
        const knownSet = new Set(existingFacts)
        for (const fact of result.newFacts) {
          if (!knownSet.has(fact)) {
            await profile.addFact({
              fact,
              learnedFromConversationId: conversationId,
            })
            knownSet.add(fact)
          }
        }
        if (result.updatedName && !profile.name) {
          await profile.setName(result.updatedName)
        }
      } catch (e) {
        console.warn('[loop] extract-facts failed:', e)
      }
    } else {
      console.log('[loop] no user turn — skipping summary & fact extraction')
    }

    const endedAt = new Date()
    // endedAt/summary の永続化は会話終了の主処理なので、失敗時は呼び出し側に
    // 投げてユーザーがリトライできるようにする(握りつぶさない)。
    await conversationsRepo.update(conversationId, {
      endedAt,
      summary: summaryText || null,
    })

    return conversationId
  }

  return {
    recorder,
    tts,
    errorMessage,
    consecutiveSilent,
    promptedAttempts,
    start,
    stop,
    endAndPersist,
  }
}

export type ConversationLoopMessage = Message

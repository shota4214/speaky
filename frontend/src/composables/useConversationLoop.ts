import { ref } from 'vue'
import { conversationsRepo } from '../db/repos/conversations'
import { messagesRepo } from '../db/repos/messages'
import type { Message } from '../db/types'
import { chat, summarize, transcribeAudio, type ChatHistoryItem } from '../services/api'
import { useConversationStore } from '../stores/conversation'
import { useProfileStore } from '../stores/profile'
import { useSettingsStore } from '../stores/settings'
import {
  detectInputMode,
  isTooShort,
  looksLikeHallucination,
} from '../utils/language-detection'
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
    await runLoop(input)
  }

  async function runLoop(input: StartLoopInput) {
    try {
      while (!stopRequested.value && conversation.id) {
        conversation.setMode(
          promptedAttempts.value > 0 ? 'awaitingPromptedSpeech' : 'recording',
        )

        const recording = await recorder.start()
        if (stopRequested.value) break

        if (!recording.hadSpeech) {
          await handleSilentRecording()
          continue
        }

        conversation.setMode('processing')
        let trans
        try {
          trans = await transcribeAudio(
            recording.blob,
            `recording.${pickExtension(recording.mimeType)}`,
          )
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
          inputLanguage:
            trans.language === 'unknown' ? null : trans.language,
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
      await tts.speak(
        'もしかして分からない?英語が分からなければ日本語で話してくれてもいいよ。',
        { lang: 'ja-JP', rate: 0.95 },
      )
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

  async function endAndPersist(): Promise<string | null> {
    if (!conversation.id) return null
    const transcriptItems: ChatHistoryItem[] = buildHistory()

    let summaryText = ''
    if (transcriptItems.length > 0) {
      try {
        const res = await summarize(transcriptItems, conversation.topic)
        summaryText = res.summary
      } catch (e) {
        console.warn('[loop] summarize failed:', e)
      }
    }

    const endedAt = new Date()
    await conversationsRepo.update(conversation.id, {
      endedAt,
      summary: summaryText || null,
    })

    return conversation.id
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

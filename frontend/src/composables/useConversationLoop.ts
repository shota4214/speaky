import { ref } from 'vue'
import { conversationsRepo } from '../db/repos/conversations'
import { messagesRepo } from '../db/repos/messages'
import type { Message } from '../db/types'
import {
  ApiError,
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
import {
  detectInputMode,
  isTooShort,
  looksLikeHallucination,
  looksLikeWrongLanguage,
} from '../utils/language-detection'
import { useAudioRecorder } from './useAudioRecorder'
import { getDefaultVoicePreference, useTextToSpeech } from './useTextToSpeech'

const MAX_SILENT_BEFORE_HINT = 3
const MAX_PROMPTED_ATTEMPTS = 3
/**
 * 連続で文字起こしに失敗したらループを止める閾値。
 * これが無いと 503 が続く間ずっとマイクが開いたまま無言で回り続け、
 * ユーザーには「録音中のまま何も起きない」ようにしか見えない。
 */
const MAX_TRANSCRIBE_FAILURES = 3
/**
 * system prompt に載せるユーザープロフィール事実の上限(新しいものから)。
 * 事実は会話のたびに増える一方なので、上限が無いと num_ctx(4096)を圧迫し、
 * 溢れた分は古いメッセージ = JSON 形式を指示している system prompt から
 * 捨てられて JSON パース失敗を招く。送信側だけで抑える(保存は全件のまま)。
 */
const MAX_PROFILE_FACTS_IN_PROMPT = 20

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

  /**
   * 各 tts.speak 呼び出しに渡す共通のオプションを設定から組み立てる。
   * - voiceName は settings の指定が最優先(null なら gender ベースのフォールバック)
   * - voicePreference は gender に応じて並び順を変える
   * - pitch は常にユーザー指定値
   * - rate は呼び出し側で個別指定(speakRateForLevel など)
   */
  function buildTtsOptions(): {
    voiceName: string | null
    voicePreference: string[]
    pitch: number
  } {
    const aiCharacter = settings.settings.aiCharacter
    return {
      voiceName: aiCharacter.voiceName,
      voicePreference: getDefaultVoicePreference(aiCharacter.gender),
      pitch: settings.settings.ttsPitch,
    }
  }

  const errorMessage = ref<string | null>(null)
  const consecutiveTranscribeFailures = ref(0)
  const stopRequested = ref(false)
  const consecutiveSilent = ref(0)
  const promptedAttempts = ref(0)
  const lastAiReplyEn = ref<string>('')

  /** system prompt に渡すプロフィール事実(直近 MAX_PROFILE_FACTS_IN_PROMPT 件)。 */
  function recentProfileFacts(): string[] {
    return profile.facts.slice(-MAX_PROFILE_FACTS_IN_PROMPT).map((f) => f.fact)
  }

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
    consecutiveTranscribeFailures.value = 0
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
        userProfile: recentProfileFacts(),
        lastConversationSummary: input.lastConversationSummary,
        model: settings.settings.llmModel,
        personality: settings.settings.aiCharacter.personality,
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
      const opts = buildTtsOptions()
      await tts.speak(reply.reply_en, {
        rate: speakRateForLevel(),
        pitch: opts.pitch,
        voiceName: opts.voiceName,
        voicePreference: opts.voicePreference,
      })
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
          consecutiveTranscribeFailures.value += 1
          // 503(モデルが無い)は backend がユーザー向けの日本語文言を返すのでそのまま見せる。
          // 500 は内部エラー文字列(ffmpeg のパス等)なのでユーザーには出さない。
          errorMessage.value =
            e instanceof ApiError && e.status === 503
              ? e.message
              : '音声の認識に失敗しました。もう一度話しかけてみてください。'
          if (consecutiveTranscribeFailures.value >= MAX_TRANSCRIBE_FAILURES) {
            errorMessage.value =
              `${errorMessage.value}\n` +
              `音声認識が${MAX_TRANSCRIBE_FAILURES}回続けて失敗したため、録音を停止しました。\n` +
              '「会話を終わる」で終了し、設定画面で Whisper モデルを確認してから会話を始め直してください。'
            // マイクと TTS を確実に止める(stopRequested も立つ)
            stop()
            break
          }
          continue
        }

        // 転写自体は成功した(中身が短い/幻聴でも通信は通っている)。
        // ここでリセットしないと「成功したが捨てられたターン」を挟んだ失敗が
        // 連続扱いで積み上がり、エラー表示も出しっぱなしになる。
        if (consecutiveTranscribeFailures.value > 0) {
          consecutiveTranscribeFailures.value = 0
          errorMessage.value = null
        }

        if (stopRequested.value) break
        if (
          isTooShort(trans.text) ||
          looksLikeHallucination(trans.text) ||
          looksLikeWrongLanguage(trans.text)
        ) {
          console.debug('[loop] dropped (short/hallucination/wrong-lang):', trans.text)
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
          userProfile: recentProfileFacts(),
          lastConversationSummary: input.lastConversationSummary,
          conversationHistory: buildHistory().slice(-20),
          model: settings.settings.llmModel,
          personality: settings.settings.aiCharacter.personality,
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
        {
          const opts = buildTtsOptions()
          await tts.speak(reply.reply_en, {
            rate: speakRateForLevel(),
            pitch: opts.pitch,
            voiceName: opts.voiceName,
            voicePreference: opts.voicePreference,
          })
        }

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
          const opts = buildTtsOptions()
          await tts.speak(lastAiReplyEn.value, {
            rate: 0.8,
            pitch: opts.pitch,
            voiceName: opts.voiceName,
            voicePreference: opts.voicePreference,
          })
        }
      } else {
        if (lastAiReplyEn.value) {
          conversation.setMode('aiSpeaking')
          const opts = buildTtsOptions()
          await tts.speak("Let's move on. 次に進みましょう。", {
            pitch: opts.pitch,
            voiceName: opts.voiceName,
            voicePreference: opts.voicePreference,
          })
        }
        promptedAttempts.value = 0
      }
      return
    }

    consecutiveSilent.value += 1
    if (consecutiveSilent.value >= MAX_SILENT_BEFORE_HINT) {
      conversation.setMode('aiSpeaking')
      // 日本語ヒントは英語 voice 設定の影響を受けないよう、voice 指定を渡さない。
      await tts.speak('もしかして分からない?英語が分からなければ日本語で話してくれてもいいよ。', {
        lang: 'ja-JP',
        rate: 0.95,
      })
      consecutiveSilent.value = 0
    }
  }

  function speakRateForLevel(): number {
    // 連動 OFF: ユーザー設定の ttsRate をそのまま使う
    if (!settings.settings.ttsRateConnectedToLevel) {
      return settings.settings.ttsRate
    }
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
        // 既知判定は全件で行うが、プロンプトに載せるのは直近 N 件だけにする
        // (ここも num_ctx を溢れさせると JSON が壊れて事実抽出ごと失敗する)。
        const existingFacts = profile.facts.map((f) => f.fact)
        const result = await extractFacts(transcriptItems, recentProfileFacts(), profile.name, {
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
    consecutiveTranscribeFailures,
    consecutiveSilent,
    promptedAttempts,
    start,
    stop,
    endAndPersist,
  }
}

export type ConversationLoopMessage = Message

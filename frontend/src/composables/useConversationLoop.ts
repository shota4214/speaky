import { ref } from 'vue'
import { conversationsRepo } from '../db/repos/conversations'
import { messagesRepo } from '../db/repos/messages'
import type { Message } from '../db/types'
import {
  ApiError,
  chat,
  chatEnrich,
  chatOpening,
  chatOpeningStream,
  chatStream,
  extractFacts,
  probeBackendFeatures,
  summarize,
  transcribeAudio,
  type ChatHistoryItem,
  type ChatRequestContext,
  type ChatStreamHandle,
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
import {
  FEATURE_CHAT_ENRICH,
  FEATURE_CHAT_OPENING_STREAM,
  FEATURE_CHAT_STREAM,
  hasFeature,
  NO_FEATURES,
  type BackendFeatures,
} from '../utils/backend-features'
import type {
  ChatEnrichment,
  ChatStreamEffect,
  ChatStreamError,
} from '../utils/chat-stream-reducer'
import { SentenceAccumulator, splitIntoSpeechSegments } from '../utils/sentence-stream'
import { useAudioRecorder } from './useAudioRecorder'
import { useSpeechQueue } from './useSpeechQueue'
import { getDefaultVoicePreference, useTextToSpeech, type SpeakOptions } from './useTextToSpeech'

const MAX_SILENT_BEFORE_HINT = 3
const MAX_PROMPTED_ATTEMPTS = 3
/**
 * 連続で文字起こしに失敗したらループを止める閾値。
 * これが無いと 503 が続く間ずっとマイクが開いたまま無言で回り続け、
 * ユーザーには「録音中のまま何も起きない」ようにしか見えない。
 */
const MAX_TRANSCRIBE_FAILURES = 3
/**
 * 連続で AI 返答(/api/chat)に失敗したらループを止める閾値。
 * 1 回の失敗で会話ごと終わらせると、メモリ逼迫で一時的に詰まっただけの
 * ケースでもセッションが飛んでしまうので、文字起こしと同じく数回は粘る。
 */
const MAX_CHAT_FAILURES = 3
/**
 * system prompt に載せるユーザープロフィール事実の上限(新しいものから)。
 * 事実は会話のたびに増える一方なので、上限が無いと num_ctx(4096)を圧迫し、
 * 溢れた分は古いメッセージ = JSON 形式を指示している system prompt から
 * 捨てられて JSON パース失敗を招く。送信側だけで抑える(保存は全件のまま)。
 */
const MAX_PROFILE_FACTS_IN_PROMPT = 20

/**
 * 会話終了後の一括 enrich で処理するメッセージ数の上限。
 * 1 件あたり LLM 呼び出し 1〜2 回なので、長い会話で無制限に回さない。
 */
const MAX_BACKFILL_MESSAGES = 30

/**
 * ターンを中断した理由。**enrich の後始末を分けるために必要**。
 *
 * - SUPERSEDED: 次のターンを始めるためにこちらから前のターンを切った。
 *   前のターンの enrich(同じストリームに乗っている)は永遠に届かないので、
 *   「取得できませんでした + 再取得」に落とす。これをしないと「日本語訳を準備中」
 *   のまま一生残り、DB の replyJa も null のままになる。
 * - STOPPED: ユーザーが会話を終えた。画面はこの後サマリへ移るので UI 上の
 *   失敗表示に意味は無く、欠けた日本語訳は会話終了後の一括 enrich が埋める。
 */
const ABORT_SUPERSEDED = 'superseded-by-next-turn'
const ABORT_STOPPED = 'conversation-stopped'

/**
 * 中断理由を **AbortError のまま** 運ぶ。
 * 文字列を abort() に渡すと fetch は「文字列」で reject するので、
 * `e.name === 'AbortError'` を見ている isAbortError がすり抜け、
 * 自分で中断しただけのターンがユーザー向けエラーとして表示されてしまう。
 */
function abortReason(kind: string): DOMException {
  return new DOMException(kind, 'AbortError')
}

/** signal.reason から理由の識別子を取り出す(文字列で渡された場合も許容)。 */
function reasonOf(signal: AbortSignal): string | null {
  const reason: unknown = signal.reason
  if (typeof reason === 'string') return reason
  const message = (reason as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : null
}

/**
 * 実行中の一括 enrich。**モジュールスコープ**なのは、会話画面を出入りすると
 * composable のインスタンスが作り直されるため。次の会話が始まったら前の会話の
 * 埋め合わせを止めないと、Ollama の 1 枠を新しい会話の挨拶生成と奪い合う。
 */
let activeBackfill: AbortController | null = null

/** 実行中の一括 enrich を止める(次の会話を始めるとき)。 */
export function cancelEnrichBackfill(): void {
  activeBackfill?.abort()
  activeBackfill = null
}

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
   * 文単位の発話キュー。返答は必ず「文へ分割 → キューへ投入 → 読み終わりを待つ」
   * という 1 本の経路を通す。後段でトークンストリーミングを足すときに、
   * 「まとめて push」を「届いたぶんだけ push」に変えるだけで済むようにするため。
   */
  const speechQueue = useSpeechQueue(tts)

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

  /**
   * テキストを文へ分割してキューに流し、読み終わるまで待つ。
   * 戻り値 = 最後まで問題なく読めたか(false なら呼び出し側がユーザーに知らせる)。
   * 1 文が失敗してもキューは残りを読み続けるので、ここで throw はしない。
   */
  async function speakSegments(text: string, overrides: SpeakOptions = {}): Promise<boolean> {
    const segments = splitIntoSpeechSegments(text)
    if (segments.length === 0) return true
    // 失敗はこの呼び出しぶんだけを見る(キューは drain ごとには消さない)。
    speechQueue.resetError()
    for (const segment of segments) {
      speechQueue.enqueue(segment, overrides)
    }
    await speechQueue.drained()
    return speechQueue.lastError.value === null
  }

  /**
   * 過去のメッセージをもう一度読み上げる(「もう一度聞く」)。
   *
   * **必ずキュー経由**にする。tts.speak(interrupt:true) を直接呼ぶと、
   * キューが 4 セグメント中 2 つ目を喋っている最中に世代カウンタだけが進み、
   * キューは中断を「1 文読み終わった」と解釈して 3 つ目・4 つ目を流し続ける。
   * その結果、再生し直した音声と残りのセグメントが重なって同時に鳴る。
   * speakNow はキューを空にしてから積むので、この競合が起こらない。
   */
  function replay(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const opts = buildTtsOptions()
    speechQueue.speakNow(trimmed, {
      rate: speakRateForLevel(),
      pitch: opts.pitch,
      voiceName: opts.voiceName,
      voicePreference: opts.voicePreference,
    })
  }

  /**
   * ターンごとの AbortController。
   * 会話を終わっても LLM の生成が走り続けると、8GB マシンではそのまま
   * 次の操作(要約・履歴表示)まで重くなるので、停止時に必ず中断させる。
   */
  let turnController: AbortController | null = null

  function beginTurn(): AbortSignal {
    // 前のターンを切る理由は「次のターンを始めるため」。会話終了とは区別する。
    turnController?.abort(abortReason(ABORT_SUPERSEDED))
    turnController = new AbortController()
    return turnController.signal
  }

  function abortTurn(): void {
    turnController?.abort(abortReason(ABORT_STOPPED))
    turnController = null
  }

  /** 会話終了(ユーザー操作)による中断か。次ターンのための中断は false。 */
  function abortedByStop(signal: AbortSignal): boolean {
    return signal.aborted && reasonOf(signal) === ABORT_STOPPED
  }

  /** 自分で abort した結果の失敗をユーザー向けエラーとして出さないための判定。 */
  function isAbortError(e: unknown): boolean {
    return (e as { name?: string } | null)?.name === 'AbortError'
  }

  const errorMessage = ref<string | null>(null)

  // ---- ストリーミング(Tier2 Stage2) ----

  /**
   * バックエンドが申告した機能。**会話画面のマウント時に 1 回だけ取りに行く**。
   * 起動時に取ると Electron の起動と backend の listen が競合するため。
   */
  const backendFeatures = ref<BackendFeatures>(NO_FEATURES)

  /** 生成途中の英文(まだ DB に無い擬似メッセージとして画面に出す)。 */
  const streamingReplyEn = ref<string>('')

  /** 日本語訳などの enrich がまだ届いていないメッセージ ID。 */
  const enrichPendingIds = ref<Set<string>>(new Set())
  /** enrich が失敗した(= 再取得ボタンを出す)メッセージ ID。 */
  const enrichFailedIds = ref<Set<string>>(new Set())

  function markEnrichPending(id: string): void {
    const pending = new Set(enrichPendingIds.value)
    pending.add(id)
    enrichPendingIds.value = pending
    if (enrichFailedIds.value.has(id)) {
      const failed = new Set(enrichFailedIds.value)
      failed.delete(id)
      enrichFailedIds.value = failed
    }
  }

  function clearEnrichPending(id: string): void {
    if (enrichPendingIds.value.has(id)) {
      const pending = new Set(enrichPendingIds.value)
      pending.delete(id)
      enrichPendingIds.value = pending
    }
    if (enrichFailedIds.value.has(id)) {
      const failed = new Set(enrichFailedIds.value)
      failed.delete(id)
      enrichFailedIds.value = failed
    }
  }

  function markEnrichFailed(id: string): void {
    // pending でないもの(= そもそも enrich を待っていない)は触らない。
    // ただし「日本語訳がまだ無いメッセージ」は、pending を経由せずに
    // 失敗が確定することがある(enrich が永続化より先に届いた場合など)ので
    // 対象に含める。訳の無い行に再取得ボタンが出ないのが一番まずい。
    if (!enrichPendingIds.value.has(id)) {
      const message = conversation.messages.find((m) => m.id === id)
      if (!message || message.replyJa?.trim()) return
    }
    const pending = new Set(enrichPendingIds.value)
    pending.delete(id)
    enrichPendingIds.value = pending
    const failed = new Set(enrichFailedIds.value)
    failed.add(id)
    enrichFailedIds.value = failed
  }

  /** ストリーミングを使ってよいか。設定のキルスイッチ AND 機能の肯定的検出。 */
  function canStream(feature: string): boolean {
    return settings.settings.streaming && hasFeature(backendFeatures.value, feature)
  }

  function canRetryEnrich(): boolean {
    return hasFeature(backendFeatures.value, FEATURE_CHAT_ENRICH)
  }

  function buildRequestContext(input: StartLoopInput, mode?: Message['mode']): ChatRequestContext {
    return {
      aiName: settings.settings.aiCharacter.name,
      level: conversation.level,
      topic: conversation.topic,
      ...(mode ? { mode } : {}),
      vocabFocus: input.vocabFocusWords,
      userProfile: recentProfileFacts(),
      lastConversationSummary: input.lastConversationSummary,
      model: settings.settings.llmModel,
      personality: settings.settings.aiCharacter.personality,
    }
  }

  /** enrich の結果を DB とストアへ反映する(保存する形は現行リリースと同一)。 */
  async function applyEnrichment(messageId: string, enrichment: ChatEnrichment): Promise<void> {
    // 日本語訳が空の enrich は **成功ではない**。ここで pending を解除すると
    // 「訳も無い・エラーも無い・再取得ボタンも無い」行になり、DB の replyJa も
    // null のまま残る。取得できなかったものとして再取得できる状態にする。
    if (!enrichment.replyJa.trim()) {
      console.warn('[loop] enrich に日本語訳が無いので失敗として扱う:', messageId)
      markEnrichFailed(messageId)
      return
    }
    const updated = await messagesRepo.update(messageId, {
      replyJa: enrichment.replyJa || null,
      feedback: enrichment.feedback
        ? {
            userSaid: enrichment.feedback.user_said,
            corrected: enrichment.feedback.corrected,
            explanation: enrichment.feedback.explanation,
          }
        : null,
      vocabulary: enrichment.vocabulary,
    })
    if (updated) conversation.updateMessage(updated)
    clearEnrichPending(messageId)
  }

  /** そのメッセージの直前のユーザー発話(enrich の添削材料)。 */
  function previousUserText(messageId: string): string | null {
    const idx = conversation.messages.findIndex((m) => m.id === messageId)
    if (idx <= 0) return null
    for (let i = idx - 1; i >= 0; i--) {
      const m = conversation.messages[i]!
      if (m.role === 'user') return m.userText
    }
    return null
  }

  /** 日本語訳が届かなかったメッセージについて、ユーザー操作で再取得する。 */
  async function retryEnrich(messageId: string): Promise<void> {
    const message = conversation.messages.find((m) => m.id === messageId)
    if (!message?.replyEn) return
    markEnrichPending(messageId)
    try {
      const enrichment = await chatEnrich(message.replyEn, previousUserText(messageId), {
        aiName: settings.settings.aiCharacter.name,
        level: conversation.level,
        topic: conversation.topic,
        model: settings.settings.llmModel,
      })
      await applyEnrichment(messageId, enrichment)
    } catch (e) {
      console.warn('[loop] enrich retry failed:', e)
      markEnrichFailed(messageId)
    }
  }

  type StreamTurnOutcome =
    | { status: 'done'; message: Message }
    | { status: 'aborted' }
    /** 1 文字も読み上げていないので、非ストリーミング経路でやり直してよい。 */
    | { status: 'fallback'; error: unknown }
    /**
     * 既に読み上げてしまった後の失敗。やり直すと二重に喋るので、このターンは失敗扱い。
     * partial = 喋ったぶんを保存したメッセージ(保存できたときだけ)。
     */
    | { status: 'failed'; message: string; partial?: Message }

  interface StreamTurnInput {
    kind: 'chat' | 'opening'
    userText: string | null
    context: ChatRequestContext
    signal: AbortSignal
    ttsOverrides: SpeakOptions
    inputMode: Message['mode']
  }

  /**
   * ストリーミング 1 ターン。
   *
   * 体感速度のすべてがここに懸かっているので、以下は意図的にこの順序にしてある:
   *  - セグメントは **溜めずに** 届いた順でキューへ流す(先読みバッファは作らない)
   *  - メッセージの永続化は **done で 1 回だけ**(デルタごとに書かない /
   *    中断したターンの空行を残さない)
   *  - ターンの終了条件は「done が来た」AND「読み上げキューが空になった」。
   *    enrich は待たない(マイクが日本語訳を待つのが元々の遅さの正体)。
   */
  async function runStreamingTurn(input: StreamTurnInput): Promise<StreamTurnOutcome> {
    const { kind, userText, context, signal, ttsOverrides, inputMode } = input
    const accumulator = new SentenceAccumulator()
    const messageId = crypto.randomUUID()

    /**
     * コールバック(onEffect)から書き換わる状態はオブジェクトにまとめる。
     * ローカル変数にすると TypeScript が「クロージャの中でしか代入されない」と見て
     * null に絞り込んでしまい、読み出し側が never になる。
     */
    const turn = {
      spokeAnything: false,
      /** 読み上げに回した英文の累積(失敗したときに「聞こえた内容」を保存する)。 */
      spokenText: '',
      error: null as ChatStreamError | null,
      replyJa: null as string | null,
      persistedId: null as string | null,
      stashedEnrichment: null as ChatEnrichment | null,
      enrichApplied: false,
      streamFinished: false,
    }

    streamingReplyEn.value = ''
    // 発話失敗はターン単位で見る(キューは drain のたびには消さない)。
    speechQueue.resetError()

    /**
     * **読み上げが始まった後に返る経路は全部ここを通す**。
     *
     * 読み上げキューが空になるのを待たずに返すと、呼び出し側のループは
     * そのまま録音モードに入る。キューにはまだ AI の声が残っているので、
     * マイクが AI 自身の声を拾って Whisper に流し、ユーザーの発話として
     * 保存され、次のプロンプトの履歴にも入る(失敗ターンほど起きやすい)。
     */
    async function finish(outcome: StreamTurnOutcome): Promise<StreamTurnOutcome> {
      await speechQueue.drained()
      return outcome
    }

    function enqueueSegments(segments: string[]): void {
      for (const segment of segments) {
        if (!turn.spokeAnything) {
          turn.spokeAnything = true
          conversation.setMode('aiSpeaking')
        }
        speechQueue.enqueue(segment, ttsOverrides)
      }
    }

    const onEffect = (effect: ChatStreamEffect): void => {
      switch (effect.type) {
        case 'speak':
          streamingReplyEn.value += effect.text
          turn.spokenText += effect.text
          enqueueSegments(accumulator.push(effect.text))
          break
        case 'done':
          enqueueSegments(accumulator.flush())
          streamingReplyEn.value = effect.text
          turn.replyJa = effect.replyJa
          break
        case 'enrich': {
          turn.enrichApplied = true
          const persistedId = turn.persistedId
          if (persistedId) {
            void applyEnrichment(persistedId, effect.enrichment).catch((e) => {
              console.warn('[loop] applying enrichment failed:', e)
            })
          } else {
            // done の直後・永続化の途中に来た場合。保存できてから反映する。
            turn.stashedEnrichment = effect.enrichment
          }
          break
        }
        case 'error':
          turn.error = effect.error
          break
      }
    }

    let handle: ChatStreamHandle
    try {
      handle =
        kind === 'opening'
          ? await chatOpeningStream(context, { signal, onEffect })
          : await chatStream(userText ?? '', context, { signal, onEffect })
    } catch (e) {
      // ヘッダー検証の段階で弾かれた(res.ok でない / Content-Type が SSE でない /
      // ネットワーク失敗)。まだ 1 文字も喋っていないので安全に落とせる。
      streamingReplyEn.value = ''
      if (isAbortError(e) || signal.aborted) return { status: 'aborted' }
      return { status: 'fallback', error: e }
    }

    // enrich は done の後に同じストリームで届く。ここは待たずに背後で回す。
    // ⚠️ ストリームは「永続化より先に」閉じ得る(enrich を出せずに終わったケース)。
    // その順序では下の markEnrichFailed が空振りするので、永続化側でも再判定する。
    void handle.finished
      .then(() => {
        turn.streamFinished = true
        if (!turn.persistedId || turn.enrichApplied) return
        // 会話終了による中断だけは「失敗表示」にしない(画面はサマリへ移る)。
        // 次のターンを始めるために切った場合は **必ず失敗にする** —
        // 放っておくと「日本語訳を準備中」が一生消えない。
        if (abortedByStop(signal)) return
        markEnrichFailed(messageId)
      })
      .catch(() => undefined)

    const done = await handle.done

    if (signal.aborted || stopRequested.value) {
      streamingReplyEn.value = ''
      return finish({ status: 'aborted' })
    }

    if (!done) {
      streamingReplyEn.value = ''
      const message = turn.error?.message ?? 'AIの返答生成に失敗しました。'
      // フォールバックしない条件が 2 つある:
      //  1) 既に読み上げてしまった後 — やり直すと同じ返答を二度聞かせることになる。
      //  2) TIMEOUT(first-token 60 秒 / ストール 15 秒)— これはモデルが遅い or
      //     詰まっているという意味なので、非ストリーミング(90 秒予算)でやり直すと
      //     最悪 150 秒マイクが開かないまま待たせることになる。ここは諦めた方が速い。
      //     MALFORMED / EMPTY / TRUNCATED は「小型モデルが変な出力をした」ケースで、
      //     JSON 経路のリトライ梯子なら通ることがあるのでフォールバックする。
      const shouldFallback = !turn.spokeAnything && turn.error?.code !== 'TIMEOUT'
      if (shouldFallback) return finish({ status: 'fallback', error: turn.error })
      // 読み上げてしまったぶんは「ユーザーには聞こえたのにどこにも存在しない発話」
      // になる(ストアにも DB にも無い = 次のプロンプトの履歴にも入らないので、
      // モデルは同じことをもう一度言える)。喋った内容をそのまま保存して、
      // 日本語訳は再取得できる状態にする。
      const partial = await persistPartialReply(turn.spokenText, inputMode, messageId)
      return finish({ status: 'failed', message, ...(partial ? { partial } : {}) })
    }

    if (!conversation.id) {
      streamingReplyEn.value = ''
      return finish({ status: 'aborted' })
    }

    // 永続化は done の 1 回だけ。保存する形は現行リリースと完全に同じで、
    // 「enrich 待ち」のような一時状態は **DB に書かない**(メモリ上の Set で持つ)。
    const aiMsg = await messagesRepo.create({
      id: messageId,
      conversationId: conversation.id,
      timestamp: new Date(),
      role: 'ai',
      userText: null,
      inputLanguage: null,
      replyEn: done.text,
      replyJa: turn.replyJa,
      feedback: null,
      vocabulary: [],
      mode: inputMode,
    })
    turn.persistedId = aiMsg.id
    conversation.appendMessage(aiMsg)
    streamingReplyEn.value = ''

    if (turn.stashedEnrichment) {
      await applyEnrichment(messageId, turn.stashedEnrichment).catch((e) => {
        console.warn('[loop] applying stashed enrichment failed:', e)
      })
    } else if (!turn.replyJa) {
      // 日本語訳はこの後 enrich で届く。それまで UI にはプレースホルダを出す。
      markEnrichPending(messageId)
      // 既にストリームが閉じていた(= enrich は永遠に来ない)なら、その場で
      // 「取得できませんでした + 再取得」に切り替える。準備中のまま固まらせない。
      if (turn.streamFinished && !turn.enrichApplied) markEnrichFailed(messageId)
    }

    // ターンの終わりは「done」AND「読み上げ終わり」の両方。
    return finish({ status: 'done', message: aiMsg })
  }

  /**
   * ストリームが途中で失敗したとき、**既に読み上げた英文**を保存する。
   * 日本語訳は無いので enrich 失敗(= 再取得ボタンあり)として置く。
   */
  async function persistPartialReply(
    text: string,
    inputMode: Message['mode'],
    messageId: string,
  ): Promise<Message | null> {
    const trimmed = text.trim()
    if (!trimmed || !conversation.id) return null
    try {
      const msg = await messagesRepo.create({
        id: messageId,
        conversationId: conversation.id,
        timestamp: new Date(),
        role: 'ai',
        userText: null,
        inputLanguage: null,
        replyEn: trimmed,
        replyJa: null,
        feedback: null,
        vocabulary: [],
        mode: inputMode,
      })
      conversation.appendMessage(msg)
      markEnrichPending(msg.id)
      markEnrichFailed(msg.id)
      return msg
    } catch (e) {
      console.warn('[loop] 途中まで読み上げた返答の保存に失敗:', e)
      return null
    }
  }

  const consecutiveTranscribeFailures = ref(0)
  const consecutiveChatFailures = ref(0)
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
    // 前の会話の一括 enrich が残っていたら止める。Ollama の枠は 1 つしかないので、
    // 放っておくとこの会話の挨拶生成がその後ろに並ぶ。
    cancelEnrichBackfill()
    stopRequested.value = false
    consecutiveSilent.value = 0
    promptedAttempts.value = 0
    consecutiveTranscribeFailures.value = 0
    consecutiveChatFailures.value = 0
    errorMessage.value = null
    lastAiReplyEn.value = ''
    streamingReplyEn.value = ''
    enrichPendingIds.value = new Set()
    enrichFailedIds.value = new Set()

    // 機能検出はここ(= 会話画面のマウント時)。アプリ起動時ではない。
    // 失敗しても例外は投げず「機能なし」= 非ストリーミング経路になる。
    backendFeatures.value = await probeBackendFeatures()

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
    const openingContext = buildRequestContext(input)
    const openingTtsOverrides: SpeakOptions = (() => {
      const opts = buildTtsOptions()
      return {
        rate: speakRateForLevel(),
        pitch: opts.pitch,
        voiceName: opts.voiceName,
        voicePreference: opts.voicePreference,
      }
    })()

    // ストリーミング経路。ここが会話を始めて最初に音が出るまでの時間を決める。
    if (canStream(FEATURE_CHAT_OPENING_STREAM)) {
      const signal = beginTurn()
      const outcome = await runStreamingTurn({
        kind: 'opening',
        userText: null,
        context: openingContext,
        signal,
        ttsOverrides: openingTtsOverrides,
        inputMode: 'normal',
      })
      if (outcome.status === 'aborted') return
      if (outcome.status === 'done') {
        lastAiReplyEn.value = outcome.message.replyEn ?? ''
        if (speechQueue.lastError.value && !stopRequested.value) {
          console.warn('[loop] opening TTS failed:', speechQueue.lastError.value)
          errorMessage.value =
            'AI挨拶の音声合成に失敗しました。上の英文を読んでから話しかけてください。'
        }
        return
      }
      if (outcome.status === 'failed') {
        console.warn('[loop] opening stream failed after speaking:', outcome.message)
        // 途中まで喋ったぶんが保存できていれば「もう一度言って」の対象にする。
        if (outcome.partial?.replyEn) lastAiReplyEn.value = outcome.partial.replyEn
        return
      }
      console.warn('[loop] opening stream unavailable, falling back:', outcome.error)
    }

    let reply
    try {
      const signal = beginTurn()
      reply = await chatOpening(openingContext, { signal })
    } catch (e) {
      // 会話終了による中断はエラーではない(ユーザーには何も見せない)
      if (!isAbortError(e)) {
        console.warn('[loop] opening generation failed, skipping:', e)
      }
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
    conversation.setMode('aiSpeaking')
    const opts = buildTtsOptions()
    const spoken = await speakSegments(reply.reply_en, {
      rate: speakRateForLevel(),
      pitch: opts.pitch,
      voiceName: opts.voiceName,
      voicePreference: opts.voicePreference,
    })
    if (!spoken && !stopRequested.value) {
      console.warn('[loop] opening TTS failed:', speechQueue.lastError.value)
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
        const turnContext: ChatRequestContext = {
          ...buildRequestContext(input, inputMode),
          conversationHistory: buildHistory().slice(-20),
        }
        const turnTtsOverrides: SpeakOptions = (() => {
          const opts = buildTtsOptions()
          return {
            rate: speakRateForLevel(),
            pitch: opts.pitch,
            voiceName: opts.voiceName,
            voicePreference: opts.voicePreference,
          }
        })()

        // --- ストリーミング経路(最初の一文が出来た時点で喋り始める) ---
        if (canStream(FEATURE_CHAT_STREAM)) {
          const signal = beginTurn()
          const outcome = await runStreamingTurn({
            kind: 'chat',
            userText: trans.text,
            context: turnContext,
            signal,
            ttsOverrides: turnTtsOverrides,
            inputMode,
          })
          if (outcome.status === 'aborted') break
          if (outcome.status === 'done') {
            if (consecutiveChatFailures.value > 0) {
              consecutiveChatFailures.value = 0
              errorMessage.value = null
            }
            lastAiReplyEn.value = outcome.message.replyEn ?? ''
            if (stopRequested.value) break
            if (inputMode === 'japanese_help' || inputMode === 'mixed') {
              promptedAttempts.value = 1
              conversation.setMode('awaitingPromptedSpeech')
            }
            continue
          }
          if (outcome.status === 'failed') {
            // 既に読み上げてしまった後の失敗。やり直すと二重に喋るのでこのターンは諦める。
            if (outcome.partial?.replyEn) lastAiReplyEn.value = outcome.partial.replyEn
            consecutiveChatFailures.value += 1
            errorMessage.value = outcome.message
            if (consecutiveChatFailures.value >= MAX_CHAT_FAILURES) {
              errorMessage.value = chatFailureLimitMessage(errorMessage.value)
              stop()
              break
            }
            continue
          }
          // status === 'fallback': まだ 1 文字も喋っていないので旧経路でやり直す。
          console.warn('[loop] chat stream unavailable, falling back:', outcome.error)
        }

        let reply
        try {
          const signal = beginTurn()
          reply = await chat(trans.text, turnContext, { signal })
        } catch (e) {
          // 会話終了による中断はエラー扱いしない(ユーザーには何も見せずに抜ける)
          if (isAbortError(e) || stopRequested.value) break
          console.warn('[loop] chat failed:', e)
          consecutiveChatFailures.value += 1
          errorMessage.value =
            e instanceof ApiError && e.status === 503
              ? e.message
              : 'AIの返答生成に失敗しました。もう一度話しかけてみてください。'
          if (consecutiveChatFailures.value >= MAX_CHAT_FAILURES) {
            errorMessage.value = chatFailureLimitMessage(errorMessage.value)
            stop()
            break
          }
          continue
        }

        // 返答が返ってきた = LLM は生きている。積み上がった失敗回数をリセット。
        if (consecutiveChatFailures.value > 0) {
          consecutiveChatFailures.value = 0
          errorMessage.value = null
        }

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
          await speakSegments(reply.reply_en, {
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
      // 停止時の abort が例外で出てきても「エラー」として見せない
      if (!isAbortError(e) && !stopRequested.value) {
        console.error('[loop] error:', e)
        errorMessage.value = (e as Error).message
      }
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
          await speakSegments(lastAiReplyEn.value, {
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
          await speakSegments("Let's move on. 次に進みましょう。", {
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
      await speakSegments(
        'もしかして分からない?英語が分からなければ日本語で話してくれてもいいよ。',
        { lang: 'ja-JP', rate: 0.95 },
      )
      consecutiveSilent.value = 0
    }
  }

  /** AI 返答が連続で失敗して会話を止めたときの文面(ストリーミング / 旧経路で共通)。 */
  function chatFailureLimitMessage(base: string | null): string {
    return (
      `${base ?? 'AIの返答生成に失敗しました。'}\n` +
      `AIの返答が${MAX_CHAT_FAILURES}回続けて失敗したため、会話を停止しました。\n` +
      '「会話を終わる」で終了し、設定画面で軽いモデル(llama3.2:3b など)に切り替えてから会話を始め直してください。'
    )
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
    // 生成途中の擬似メッセージは保存しない。画面からも消す。
    streamingReplyEn.value = ''
    // 生成中の LLM リクエストを中断する(放置すると会話を終えた後も
    // Ollama が生成を続けてマシンが重いままになる)
    abortTurn()
    recorder.stop()
    // 読み上げの停止はキューに任せる(cancelAll が待機中を捨て、
    // 再生中も backend.cancel で止める)。ここで tts.cancel() を重ねると
    // 世代カウンタが二度進むだけで、止まり方は何も変わらない。
    speechQueue.cancelAll()
    // 会話が終わったらマイクは手放す。画面に留まったままでも OS の
    // マイク使用インジケータが点きっぱなしにならないようにする。
    recorder.release()
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

  /**
   * 会話終了後に、日本語訳が欠けているメッセージをまとめて埋める。
   *
   * なぜ必要か: セッション中の enrich は次のターンを始めるときに打ち切られる
   * (打ち切らないと Ollama の 1 枠を奪い合って次のターンが遅くなり、
   * first-token 予算に食い込んでターンごと失われる)。その結果、日本語訳が
   * 欠けた行がセッション中に残り得る。ここで埋めれば **履歴は必ず揃う**。
   *
   * 実行タイミングは要約・事実抽出の **後**。ユーザーはサマリ画面でそれらを
   * 待っているのに対し、日本語訳を見るのは履歴画面に入ってからなので、
   * 待っている処理を先に通す。会話行の保存(endedAt/summary)も先に済ませる。
   *
   * 途中で終わっても壊れない: 1 件ずつ独立した更新で、次回また対象になるだけ。
   */
  async function backfillEnrichment(
    conversationId: string,
    context: ChatRequestContext,
  ): Promise<number> {
    cancelEnrichBackfill()
    const ctrl = new AbortController()
    activeBackfill = ctrl
    let filled = 0
    try {
      const rows = await messagesRepo.listByConversation(conversationId)
      const targets = rows
        .filter((m) => m.role === 'ai' && m.replyEn?.trim() && !m.replyJa?.trim())
        .slice(0, MAX_BACKFILL_MESSAGES)
      if (targets.length === 0) return 0
      console.log(`[loop] 会話終了後の一括 enrich: ${targets.length} 件`)

      for (const target of targets) {
        if (ctrl.signal.aborted) break
        const idx = rows.findIndex((m) => m.id === target.id)
        let userText: string | null = null
        for (let i = idx - 1; i >= 0; i--) {
          const m = rows[i]!
          if (m.role === 'user') {
            userText = m.userText
            break
          }
        }
        try {
          const enrichment = await chatEnrich(target.replyEn!, userText, context, {
            signal: ctrl.signal,
          })
          // 保存・ストア反映・pending 解除はセッション中と同じ経路に通す
          // (日本語訳が空なら applyEnrichment が失敗として扱う)。
          await applyEnrichment(target.id, enrichment)
          if (enrichment.replyJa?.trim()) filled += 1
        } catch (e) {
          if (ctrl.signal.aborted || isAbortError(e)) break
          console.warn('[loop] 一括 enrich に失敗(この行は日本語訳なしのまま):', e)
          markEnrichFailed(target.id)
        }
      }
      return filled
    } catch (e) {
      console.warn('[loop] 一括 enrich を実行できませんでした:', e)
      return filled
    } finally {
      if (activeBackfill === ctrl) activeBackfill = null
    }
  }

  async function doEndAndPersist(): Promise<string | null> {
    // 関数の最初に conversation.id を「キャプチャ」しておく。
    // 以降の await 中に store の id が null に書き換わっても、
    // ここで保持した id を使い続ける(Table.get(null) を避ける)。
    const conversationId = conversation.id
    if (!conversationId) return null

    const topic = conversation.topic
    // 一括 enrich 用のコンテキストもここで確保する。離脱経路では直後に
    // conversation.end() が走って store が空になるため。
    const enrichContext: ChatRequestContext = {
      aiName: settings.settings.aiCharacter.name,
      level: conversation.level,
      topic: conversation.topic,
      model: settings.settings.llmModel,
    }
    const canBackfill = canRetryEnrich()
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

    // 日本語訳の埋め合わせは **待たない**。ここで待つとサマリ画面への遷移が
    // 日本語訳の生成回数ぶん遅れる(会話が長いほど遅い)。要約・事実抽出が
    // 終わった後なので、LLM を待たせている処理はもう無い。
    if (canBackfill) {
      void backfillEnrichment(conversationId, enrichContext).catch((e) => {
        console.warn('[loop] 一括 enrich が異常終了:', e)
      })
    }

    return conversationId
  }

  return {
    recorder,
    tts,
    speechQueue,
    errorMessage,
    backendFeatures,
    streamingReplyEn,
    enrichPendingIds,
    enrichFailedIds,
    canRetryEnrich,
    retryEnrich,
    backfillEnrichment,
    consecutiveTranscribeFailures,
    consecutiveChatFailures,
    consecutiveSilent,
    promptedAttempts,
    start,
    stop,
    replay,
    endAndPersist,
  }
}

export type ConversationLoopMessage = Message

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { db } from '../db'
import { messagesRepo } from '../db/repos/messages'
import type { ChatStreamEffect, ChatStreamState } from '../utils/chat-stream-reducer'

/**
 * 会話ループのうち、**ストリーミングの失敗経路** を固定するテスト。
 *
 * ここで守りたいのは 3 つ:
 *  1. 読み上げが始まった後に失敗しても、マイクは **キューが空になってから** 開く。
 *     開いてしまうと AI 自身の声を Whisper が拾い、ユーザー発話として保存され、
 *     次のプロンプトの履歴にも入る。
 *  2. 次のターンを始めるために前のターンを切ったら、前のターンの enrich は
 *     「取得できませんでした(再取得可)」にする。放置すると「日本語訳を準備中」が
 *     一生消えず、DB の replyJa も null のまま残る。
 *  3. 会話終了後の一括 enrich が、日本語訳の欠けた行を埋める。
 *
 * 実機の録音 / Web Speech / HTTP は node 環境に無いので、その 3 つだけを差し替える。
 */

// ---- 差し替える外部依存 ----

/** 起きたことを時系列で残す(マイクと読み上げの重なりを検証するため)。 */
let timeline: string[] = []

/** 進行中の発話を手で解決するための待ち行列。 */
let pendingSpeech: { text: string; resolve: () => void }[] = []

const recorderStart = vi.fn()

vi.mock('./useAudioRecorder', () => ({
  useAudioRecorder: () => ({
    state: ref('idle'),
    error: ref(null),
    audioLevel: ref(0),
    start: recorderStart,
    stop: vi.fn(),
    release: vi.fn(),
  }),
}))

vi.mock('./useTextToSpeech', () => ({
  getDefaultVoicePreference: () => ['Samantha'],
  useTextToSpeech: () => ({
    speaking: ref(false),
    supported: ref(true),
    speak: (text: string) =>
      new Promise<void>((resolve) => {
        timeline.push(`speak:start:${text}`)
        pendingSpeech.push({
          text,
          resolve: () => {
            timeline.push(`speak:end:${text}`)
            resolve()
          },
        })
      }),
    cancel: () => {
      const all = pendingSpeech
      pendingSpeech = []
      for (const p of all) p.resolve()
    },
  }),
}))

const apiMocks = vi.hoisted(() => ({
  probeBackendFeatures: vi.fn(),
  transcribeAudio: vi.fn(),
  chatStream: vi.fn(),
  chatOpeningStream: vi.fn(),
  chatOpening: vi.fn(),
  chat: vi.fn(),
  chatEnrich: vi.fn(),
  summarize: vi.fn(),
  extractFacts: vi.fn(),
}))

vi.mock('../services/api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, ...apiMocks }
})

import { useConversationLoop } from './useConversationLoop'
import { useConversationStore } from '../stores/conversation'

/** イベントループを 1 周回す(Dexie の書き込みはマクロタスクを跨ぐ)。 */
function turn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await turn()
}

/** 条件が満たされるまで待つ。 */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await turn()
  }
  throw new Error(`条件が満たされませんでした: ${label}\n${timeline.join('\n')}`)
}

/** 溜まっている発話を全部終わらせる。 */
async function finishAllSpeech(): Promise<void> {
  for (let i = 0; i < 50 && pendingSpeech.length > 0; i++) {
    pendingSpeech.shift()!.resolve()
    await tick(2)
  }
  await tick(2)
}

interface FakeStreamHandle {
  done: Promise<{ text: string; replyJa: string | null } | null>
  finished: Promise<ChatStreamState>
  /** 呼び出し側(loop)に効果を届ける。 */
  emit(effect: ChatStreamEffect): void
  failAndClose(code: string, message: string): void
  finishTurn(text: string): void
  closeStream(): void
}

/** chatStream / chatOpeningStream の戻り値を手で操れるようにする。 */
function makeFakeStream(onEffect: (e: ChatStreamEffect) => void, signal?: AbortSignal) {
  let settleDone: (v: { text: string; replyJa: string | null } | null) => void = () => undefined
  let settleFinished: (s: ChatStreamState) => void = () => undefined
  const done = new Promise<{ text: string; replyJa: string | null } | null>((r) => {
    settleDone = r
  })
  const finished = new Promise<ChatStreamState>((r) => {
    settleFinished = r
  })
  // 実物と同じく、fetch が abort されるとストリームは閉じる。
  signal?.addEventListener('abort', () => settleFinished({} as ChatStreamState), { once: true })

  const handle: FakeStreamHandle = {
    done,
    finished,
    emit: onEffect,
    failAndClose(code, message) {
      onEffect({ type: 'error', error: { code, message } })
      settleDone(null)
      settleFinished({} as ChatStreamState)
    },
    finishTurn(text) {
      onEffect({ type: 'done', text, replyJa: null })
      settleDone({ text, replyJa: null })
    },
    closeStream() {
      settleFinished({} as ChatStreamState)
    },
  }
  return handle
}

const FEATURES = {
  apiVersion: 3,
  features: ['chat-stream', 'chat-opening-stream', 'chat-enrich', 'model-profile'],
  totalMemoryBytes: 8 * 1024 * 1024 * 1024,
}

const startInput = {
  conversationId: 'conv-loop',
  vocabFocusWords: [],
  lastConversationSummary: null,
}

beforeEach(async () => {
  setActivePinia(createPinia())
  timeline = []
  pendingSpeech = []
  vi.clearAllMocks()
  if (db.isOpen()) db.close()
  await db.delete()
  await db.open()
  apiMocks.probeBackendFeatures.mockResolvedValue(FEATURES)
  apiMocks.summarize.mockResolvedValue({ summary: '' })
  apiMocks.extractFacts.mockResolvedValue({ newFacts: [], updatedName: null })
})

afterEach(() => {
  pendingSpeech = []
})

describe('ストリーミングが読み上げ途中で失敗したとき', () => {
  it('キューが空になるまでマイクを開かず、喋ったぶんを保存する', async () => {
    const conversation = useConversationStore()
    conversation.start({ id: 'conv-loop', level: 'intermediate', topic: 'daily' })

    // 挨拶はストリーミングを使わせない(このテストの対象ではない)
    apiMocks.chatOpeningStream.mockRejectedValue(new Error('no opening'))
    apiMocks.chatOpening.mockRejectedValue(new Error('no opening'))

    apiMocks.transcribeAudio.mockResolvedValue({
      text: 'I went hiking last weekend',
      language: 'en',
      durationMs: 1000,
    })

    let stream: FakeStreamHandle | null = null
    apiMocks.chatStream.mockImplementation(
      (_text: string, _ctx: unknown, options: { signal?: AbortSignal; onEffect: never }) => {
        stream = makeFakeStream(options.onEffect as (e: ChatStreamEffect) => void, options.signal)
        return Promise.resolve(stream)
      },
    )

    const loop = useConversationLoop()
    let micCalls = 0
    recorderStart.mockImplementation(() => {
      micCalls += 1
      timeline.push('mic:start')
      if (micCalls >= 2) {
        // 2 周目はここで会話を終える(無限ループにしない)
        loop.stop()
        return Promise.resolve({ hadSpeech: false, blob: new Blob(), mimeType: 'audio/webm' })
      }
      return Promise.resolve({ hadSpeech: true, blob: new Blob(), mimeType: 'audio/webm' })
    })

    const running = loop.start(startInput)

    await until(() => stream !== null, 'chatStream が呼ばれる')
    // 2 文ぶんのデルタ = 読み上げが始まる
    stream!.emit({ type: 'speak', text: 'Oh nice, that sounds like a really fun weekend. ' })
    stream!.emit({ type: 'speak', text: 'Where exactly did you go hiking? ' })
    await until(() => pendingSpeech.length > 0, '読み上げが始まる')

    // 生成が止まった(ストールタイムアウト)
    stream!.failAndClose('TIMEOUT', 'Ollama の生成が停止しました')
    await tick(30)

    // ⚠️ ここが本丸: まだ喋っているのでマイクは開いていない
    expect(micCalls).toBe(1)
    expect(pendingSpeech.length).toBeGreaterThan(0)

    await finishAllSpeech()
    await running

    // マイクが開いたのは、どの発話とも重なっていないこと
    const overlapping: string[] = []
    let speaking = 0
    for (const entry of timeline) {
      if (entry.startsWith('speak:start')) speaking += 1
      else if (entry.startsWith('speak:end')) speaking -= 1
      else if (entry === 'mic:start' && speaking > 0) overlapping.push(entry)
    }
    expect(overlapping).toEqual([])

    // 喋ったぶんは保存され、日本語訳は「再取得できる失敗」になっている
    const rows = await messagesRepo.listByConversation('conv-loop')
    const ai = rows.filter((m) => m.role === 'ai')
    expect(ai).toHaveLength(1)
    expect(ai[0]!.replyEn).toContain('Oh nice, that sounds like a really fun weekend.')
    expect(ai[0]!.replyJa).toBeNull()
    expect(loop.enrichFailedIds.value.has(ai[0]!.id)).toBe(true)
  })
})

describe('次のターンのために前のターンを切ったとき', () => {
  it('前のターンの enrich を「取得できませんでした」にする(準備中のまま残さない)', async () => {
    const conversation = useConversationStore()
    conversation.start({ id: 'conv-loop', level: 'intermediate', topic: 'daily' })

    apiMocks.chatOpeningStream.mockRejectedValue(new Error('no opening'))
    apiMocks.chatOpening.mockRejectedValue(new Error('no opening'))
    apiMocks.transcribeAudio.mockResolvedValue({
      text: 'I went hiking last weekend',
      language: 'en',
      durationMs: 1000,
    })

    const streams: FakeStreamHandle[] = []
    apiMocks.chatStream.mockImplementation(
      (_text: string, _ctx: unknown, options: { signal?: AbortSignal; onEffect: never }) => {
        const s = makeFakeStream(options.onEffect as (e: ChatStreamEffect) => void, options.signal)
        streams.push(s)
        return Promise.resolve(s)
      },
    )

    const loop = useConversationLoop()
    // 2 周目のマイクはテストが開けるまで待たせる(ターン 1 の状態を観測するため)。
    let openSecondMic: (() => void) | null = null
    const secondMicReady = new Promise<void>((resolve) => {
      openSecondMic = resolve
    })
    let micCalls = 0
    recorderStart.mockImplementation(async () => {
      micCalls += 1
      timeline.push('mic:start')
      if (micCalls === 2) await secondMicReady
      if (micCalls >= 3) {
        loop.stop()
        return { hadSpeech: false, blob: new Blob(), mimeType: 'audio/webm' }
      }
      return { hadSpeech: true, blob: new Blob(), mimeType: 'audio/webm' }
    })

    const running = loop.start(startInput)

    // --- ターン 1: 英文は確定するが、enrich は届かないままストリームを開いておく ---
    await until(() => streams.length === 1, '1 ターン目の chatStream')
    const reply = 'Oh nice, that sounds like a really fun weekend trip.'
    streams[0]!.emit({ type: 'speak', text: reply })
    streams[0]!.finishTurn(reply)
    await tick(5)
    await finishAllSpeech()

    // 日本語訳は enrich 待ち(UI は「準備中」)
    await until(() => loop.enrichPendingIds.value.size === 1, '日本語訳が準備中になる')
    const pendingId = [...loop.enrichPendingIds.value][0]!
    expect(loop.enrichFailedIds.value.has(pendingId)).toBe(false)

    // --- ターン 2 を始める = ターン 1 の signal が abort され、ストリームが閉じる ---
    await until(() => micCalls === 2, '2 周目のマイク待ち')
    openSecondMic!()
    await until(() => streams.length === 2, '2 ターン目の chatStream')
    await tick(5)

    // 準備中のまま残さず、再取得できる失敗になっている
    expect(loop.enrichPendingIds.value.has(pendingId)).toBe(false)
    expect(loop.enrichFailedIds.value.has(pendingId)).toBe(true)

    // 後始末
    const reply2 = 'That sounds great, I would love to try that trail too.'
    streams[1]!.emit({ type: 'speak', text: reply2 })
    streams[1]!.finishTurn(reply2)
    await tick(5)
    await finishAllSpeech()
    streams[1]!.closeStream()
    await running
  })
})

describe('会話終了後の一括 enrich', () => {
  it('日本語訳が欠けている行を埋めて保存する', async () => {
    const conversation = useConversationStore()
    conversation.start({ id: 'conv-backfill', level: 'intermediate', topic: 'daily' })

    await messagesRepo.create({
      conversationId: 'conv-backfill',
      timestamp: new Date('2026-05-15T10:00:00Z'),
      role: 'user',
      userText: 'I go hiking',
      inputLanguage: 'en',
      replyEn: null,
      replyJa: null,
      feedback: null,
      vocabulary: null,
      mode: 'normal',
    })
    const missing = await messagesRepo.create({
      conversationId: 'conv-backfill',
      timestamp: new Date('2026-05-15T10:00:01Z'),
      role: 'ai',
      userText: null,
      inputLanguage: null,
      replyEn: 'Oh nice, where did you go?',
      replyJa: null,
      feedback: null,
      vocabulary: [],
      mode: 'normal',
    })
    const alreadyFine = await messagesRepo.create({
      conversationId: 'conv-backfill',
      timestamp: new Date('2026-05-15T10:00:02Z'),
      role: 'ai',
      userText: null,
      inputLanguage: null,
      replyEn: 'That sounds fun!',
      replyJa: 'それは楽しそう!',
      feedback: null,
      vocabulary: [],
      mode: 'normal',
    })

    apiMocks.chatEnrich.mockResolvedValue({
      replyJa: 'いいね、どこに行ったの?',
      feedback: { user_said: 'I go hiking', corrected: 'I went hiking', explanation: '過去形に' },
      vocabulary: [{ word: 'hiking', meaning: 'ハイキング', example: null }],
    })

    const loop = useConversationLoop()
    loop.backendFeatures.value = { ...FEATURES, features: [...FEATURES.features, 'grammar-check'] }

    const filled = await loop.backfillEnrichment('conv-backfill', { model: 'llama3.2:3b' })
    expect(filled).toBe(1)

    // 直前のユーザー発話を添削材料として渡している
    expect(apiMocks.chatEnrich).toHaveBeenCalledTimes(1)
    expect(apiMocks.chatEnrich.mock.calls[0]![0]).toBe('Oh nice, where did you go?')
    expect(apiMocks.chatEnrich.mock.calls[0]![1]).toBe('I go hiking')

    const rows = await messagesRepo.listByConversation('conv-backfill')
    const updated = rows.find((m) => m.id === missing.id)!
    expect(updated.replyJa).toBe('いいね、どこに行ったの?')
    expect(updated.feedback?.corrected).toBe('I went hiking')
    // 既に日本語訳がある行は触らない
    expect(rows.find((m) => m.id === alreadyFine.id)!.replyJa).toBe('それは楽しそう!')
  })

  it('日本語訳が空で返ってきた行は書き換えない', async () => {
    await messagesRepo.create({
      conversationId: 'conv-empty',
      timestamp: new Date(),
      role: 'ai',
      userText: null,
      inputLanguage: null,
      replyEn: 'Oh nice, where did you go?',
      replyJa: null,
      feedback: null,
      vocabulary: [],
      mode: 'normal',
    })
    apiMocks.chatEnrich.mockResolvedValue({ replyJa: '   ', feedback: null, vocabulary: [] })

    const loop = useConversationLoop()
    const filled = await loop.backfillEnrichment('conv-empty', { model: 'llama3.2:3b' })
    expect(filled).toBe(0)
    const rows = await messagesRepo.listByConversation('conv-empty')
    expect(rows[0]!.replyJa).toBeNull()
  })
})

describe('添削(grammar-check)', () => {
  it('ストリームの feedback イベントを AI メッセージの添削として保存する', async () => {
    const conversation = useConversationStore()
    conversation.start({ id: 'conv-fb', level: 'intermediate', topic: 'daily' })
    apiMocks.probeBackendFeatures.mockResolvedValue({
      ...FEATURES,
      features: [...FEATURES.features, 'grammar-check'],
    })
    apiMocks.chatOpeningStream.mockRejectedValue(new Error('no opening'))
    apiMocks.chatOpening.mockRejectedValue(new Error('no opening'))
    apiMocks.transcribeAudio.mockResolvedValue({
      text: 'Yesterday I go to the park',
      language: 'en',
      durationMs: 1000,
    })
    const streams: FakeStreamHandle[] = []
    apiMocks.chatStream.mockImplementation(
      (_text: string, _ctx: unknown, options: { signal?: AbortSignal; onEffect: never }) => {
        const s = makeFakeStream(options.onEffect as (e: ChatStreamEffect) => void, options.signal)
        streams.push(s)
        return Promise.resolve(s)
      },
    )

    const loop = useConversationLoop()
    let micCalls = 0
    recorderStart.mockImplementation(() => {
      micCalls += 1
      if (micCalls >= 2) {
        loop.stop()
        return Promise.resolve({ hadSpeech: false, blob: new Blob(), mimeType: 'audio/webm' })
      }
      return Promise.resolve({ hadSpeech: true, blob: new Blob(), mimeType: 'audio/webm' })
    })

    const running = loop.start(startInput)
    await until(() => streams.length === 1, 'chatStream が呼ばれる')
    const reply = 'Oh nice, what did you do at the park yesterday?'
    streams[0]!.emit({ type: 'speak', text: reply })
    streams[0]!.finishTurn(reply)
    // 永続化より先に届く形(保存できてから反映される)
    const feedback = {
      user_said: 'Yesterday I go to the park',
      corrected: 'Yesterday I went to the park',
      explanation: '「Yesterday」と過去のことを話しているので、「go」を過去形の「went」にします。',
    }
    streams[0]!.emit({ type: 'feedback', feedback })
    await tick(5)
    await finishAllSpeech()
    streams[0]!.closeStream()
    await running

    const ai = (await messagesRepo.listByConversation('conv-fb')).filter((m) => m.role === 'ai')
    expect(ai).toHaveLength(1)
    expect(ai[0]!.feedback).toEqual({
      userSaid: feedback.user_said,
      corrected: feedback.corrected,
      explanation: feedback.explanation,
    })
  })

  it('grammar-check を申告しない backend の添削(モデルが書いたもの)は保存しない', async () => {
    await messagesRepo.create({
      conversationId: 'conv-old-fb',
      timestamp: new Date('2026-05-15T10:00:00Z'),
      role: 'user',
      userText: 'I go hiking',
      inputLanguage: 'en',
      replyEn: null,
      replyJa: null,
      feedback: null,
      vocabulary: null,
      mode: 'normal',
    })
    const ai = await messagesRepo.create({
      conversationId: 'conv-old-fb',
      timestamp: new Date('2026-05-15T10:00:01Z'),
      role: 'ai',
      userText: null,
      inputLanguage: null,
      replyEn: 'Oh nice, where did you go?',
      replyJa: null,
      feedback: null,
      vocabulary: [],
      mode: 'normal',
    })
    apiMocks.chatEnrich.mockResolvedValue({
      replyJa: 'いいね、どこに行ったの?',
      feedback: { user_said: 'I go hiking', corrected: 'I went hiking', explanation: 'past tense' },
      vocabulary: [],
    })

    const loop = useConversationLoop()
    loop.backendFeatures.value = FEATURES
    expect(await loop.backfillEnrichment('conv-old-fb', { model: 'llama3.2:3b' })).toBe(1)

    const row = (await messagesRepo.listByConversation('conv-old-fb')).find((m) => m.id === ai.id)!
    expect(row.replyJa).toBe('いいね、どこに行ったの?')
    expect(row.feedback).toBeNull()
  })
})

describe('非ストリーミング経路(古い backend)', () => {
  it('モデルが JSON に書いた mode ではなく、こちらで判定した入力モードを使う', async () => {
    const conversation = useConversationStore()
    conversation.start({ id: 'conv-json', level: 'intermediate', topic: 'daily' })

    // ストリーミング機能を申告しない backend
    apiMocks.probeBackendFeatures.mockResolvedValue({
      ...FEATURES,
      features: ['chat-enrich', 'model-profile'],
    })
    apiMocks.chatOpening.mockRejectedValue(new Error('no opening'))
    apiMocks.transcribeAudio.mockResolvedValue({
      text: 'I went hiking last weekend',
      language: 'en',
      durationMs: 1000,
    })
    // 古い backend はモデルの "mixed" をそのまま返す
    apiMocks.chat.mockResolvedValue({
      reply_en: 'Oh nice, where did you go hiking?',
      reply_ja: 'いいね、どこにハイキングに行ったの？',
      feedback: null,
      vocabulary: [],
      mode: 'mixed',
    })

    const loop = useConversationLoop()
    let micCalls = 0
    let promptedAtSecondMic = -1
    recorderStart.mockImplementation(() => {
      micCalls += 1
      if (micCalls >= 2) {
        promptedAtSecondMic = loop.promptedAttempts.value
        loop.stop()
        return Promise.resolve({ hadSpeech: false, blob: new Blob(), mimeType: 'audio/webm' })
      }
      return Promise.resolve({ hadSpeech: true, blob: new Blob(), mimeType: 'audio/webm' })
    })

    const running = loop.start(startInput)
    await until(() => apiMocks.chat.mock.calls.length === 1, 'chat が呼ばれる')
    await until(() => pendingSpeech.length > 0, '読み上げが始まる')
    await finishAllSpeech()
    await running

    expect(apiMocks.chatStream).not.toHaveBeenCalled()
    // 「言ってみて」状態に入っていない
    expect(promptedAtSecondMic).toBe(0)
    const ai = (await messagesRepo.listByConversation('conv-json')).filter((m) => m.role === 'ai')
    expect(ai).toHaveLength(1)
    expect(ai[0]!.mode).toBe('normal')
    // 通常のターンとして訳を検証して保存している(= 「参考訳」の札が付く)
    expect(ai[0]!.replyJa).toBe('いいね、どこにハイキングに行ったの？')
  })
})

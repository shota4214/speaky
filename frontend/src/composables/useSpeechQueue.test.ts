import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSpeechQueue, type SpeechBackend } from './useSpeechQueue'
import type { SpeakOptions } from './useTextToSpeech'

/**
 * 偽の読み上げバックエンド。
 * node 環境には window.speechSynthesis が無いので、キューの検証は
 * 「注入されたバックエンド」を通して行う(これが注入可能にしてある理由)。
 */
class FakeBackend implements SpeechBackend {
  /** speak が呼ばれた順のテキスト。 */
  calls: string[] = []
  /** 最後まで喋り切ったテキスト。 */
  finished: string[] = []
  optionsSeen: SpeakOptions[] = []
  cancelCount = 0

  /** speak を自動で解決せず、テスト側から制御する。 */
  manual = false
  /** このテキストの発話は失敗させる(ウォッチドッグ相当の異常系)。 */
  failOn: string | null = null

  private pending: { text: string; resolve: () => void; reject: (e: Error) => void } | null = null

  speak(text: string, options: SpeakOptions = {}): Promise<void> {
    this.calls.push(text)
    this.optionsSeen.push(options)
    if (this.failOn === text) {
      return Promise.reject(new Error(`boom: ${text}`))
    }
    if (!this.manual) {
      this.finished.push(text)
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      this.pending = {
        text,
        resolve: () => {
          this.finished.push(text)
          resolve()
        },
        reject,
      }
    })
  }

  cancel(): void {
    this.cancelCount++
    // 実機の Web Speech も cancel すると onerror('canceled') 経由で
    // speak() の Promise は resolve される。偽物も同じ挙動にする。
    const p = this.pending
    this.pending = null
    p?.resolve()
  }

  /** 再生中の 1 件を喋り終わらせる。 */
  finishCurrent(): void {
    const p = this.pending
    this.pending = null
    p?.resolve()
  }

  get current(): string | null {
    return this.pending?.text ?? null
  }
}

/** マイクロタスクを一巡させる。 */
async function tick(times = 3) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('useSpeechQueue', () => {
  it('積んだ順に、前の発話を打ち切らずに読み上げる', async () => {
    const backend = new FakeBackend()
    const q = useSpeechQueue(backend)

    q.enqueue('First sentence.')
    q.enqueue('Second sentence.')
    q.enqueue('Third sentence.')
    await q.drained()

    expect(backend.finished).toEqual(['First sentence.', 'Second sentence.', 'Third sentence.'])
    // interrupt:true のまま並べると次が前を cancel して最後の 1 文しか聞こえない
    expect(backend.optionsSeen.every((o) => o.interrupt === false)).toBe(true)
    expect(backend.cancelCount).toBe(0)
    expect(q.speaking.value).toBe(false)
    expect(q.pendingCount()).toBe(0)
  })

  it('空文字は積まない', async () => {
    const backend = new FakeBackend()
    const q = useSpeechQueue(backend)
    q.enqueue('   ')
    q.enqueue('')
    await q.drained()
    expect(backend.calls).toEqual([])
  })

  it('再生中に cancelAll すると即座に止まり、待機中は破棄される', async () => {
    const backend = new FakeBackend()
    backend.manual = true
    const q = useSpeechQueue(backend)

    q.enqueue('one one one')
    q.enqueue('two two two')
    q.enqueue('three three three')
    await tick()
    expect(backend.current).toBe('one one one')
    expect(q.pendingCount()).toBe(2)

    q.cancelAll()
    expect(backend.cancelCount).toBe(1)
    expect(q.pendingCount()).toBe(0)

    await q.drained()
    expect(backend.calls).toEqual(['one one one'])
    expect(backend.finished).toEqual(['one one one']) // cancel で解決されただけ
    expect(q.speaking.value).toBe(false)
  })

  it('cancelAll のあとに積み直せば再び読み上げる', async () => {
    const backend = new FakeBackend()
    backend.manual = true
    const q = useSpeechQueue(backend)

    q.enqueue('old turn text')
    await tick()
    q.cancelAll()
    await q.drained()

    backend.manual = false
    q.enqueue('new turn text')
    await q.drained()
    expect(backend.finished).toEqual(['old turn text', 'new turn text'])
  })

  it('1 件が失敗しても残りは読み上げ続ける(ウォッチドッグ打ち切り相当)', async () => {
    const backend = new FakeBackend()
    backend.failOn = 'broken sentence'
    const q = useSpeechQueue(backend)

    q.enqueue('before it')
    q.enqueue('broken sentence')
    q.enqueue('after it')
    await q.drained()

    expect(backend.finished).toEqual(['before it', 'after it'])
    expect(q.lastError.value).toBeInstanceOf(Error)
  })

  it('遅れて解決する発話があっても後続は止まらない', async () => {
    const backend = new FakeBackend()
    backend.manual = true
    const q = useSpeechQueue(backend)

    q.enqueue('slow sentence')
    q.enqueue('next sentence')
    const drained = q.drained()
    await tick()
    expect(backend.current).toBe('slow sentence')
    // ウォッチドッグが打ち切って resolve した、という想定
    backend.finishCurrent()
    await tick()
    expect(backend.current).toBe('next sentence')
    backend.finishCurrent()
    await drained
    expect(backend.finished).toEqual(['slow sentence', 'next sentence'])
  })

  it('speakNow は再生中のキューを捨てて、その 1 件だけを読む(二重再生の防止)', async () => {
    const backend = new FakeBackend()
    backend.manual = true
    const q = useSpeechQueue(backend)

    // 4 セグメントのターンを流し始め、2 つ目を再生中にする。
    q.enqueue('segment one')
    q.enqueue('segment two')
    q.enqueue('segment three')
    q.enqueue('segment four')
    await tick()
    backend.finishCurrent()
    await tick()
    expect(backend.current).toBe('segment two')

    // ここで「もう一度聞く」。残りの 3・4 は鳴らしてはいけない。
    q.speakNow('replay of the whole reply')
    await tick()
    expect(q.pendingCount()).toBe(0)
    expect(backend.current).toBe('replay of the whole reply')

    backend.finishCurrent()
    await q.drained()

    expect(backend.calls).toEqual(['segment one', 'segment two', 'replay of the whole reply'])
    expect(backend.finished).toContain('replay of the whole reply')
    expect(backend.calls).not.toContain('segment three')
    expect(backend.calls).not.toContain('segment four')
  })

  it('speakNow は何も再生していない時でも読み上げる', async () => {
    const backend = new FakeBackend()
    const q = useSpeechQueue(backend)
    q.speakNow('standalone replay', { rate: 0.9 })
    await q.drained()
    expect(backend.finished).toEqual(['standalone replay'])
    expect(backend.optionsSeen[0]?.rate).toBe(0.9)
    expect(backend.optionsSeen[0]?.interrupt).toBe(false)
  })

  it('再生中に cancelAll されたら、そのあと積まれていない限り次へ進まない', async () => {
    const backend = new FakeBackend()
    backend.manual = true
    const q = useSpeechQueue(backend)

    q.enqueue('first of two')
    await tick()
    // cancelAll のあとに(他所から)積まれたセグメントが、止めたはずの
    // drain に拾われて鳴り出さないことを確認する。
    q.cancelAll()
    await q.drained()
    expect(backend.calls).toEqual(['first of two'])
  })

  it('drained は積んでいない時も即座に解決する', async () => {
    const backend = new FakeBackend()
    const q = useSpeechQueue(backend)
    await expect(q.drained()).resolves.toBeUndefined()
  })

  it('読み上げ中に追加された分も同じ drain で処理される', async () => {
    const backend = new FakeBackend()
    backend.manual = true
    const q = useSpeechQueue(backend)

    q.enqueue('first chunk here')
    await tick()
    q.enqueue('appended chunk here')
    backend.finishCurrent()
    await tick()
    expect(backend.current).toBe('appended chunk here')
    backend.finishCurrent()
    await q.drained()
    expect(backend.finished).toEqual(['first chunk here', 'appended chunk here'])
  })
})

/**
 * 実機の TTS を模した最小の speechSynthesis。
 * cancel してもコールバックを一切呼ばない = macOS で実際に起きる
 * 「onend が来ない」状況を再現する。
 */
describe('useSpeechQueue + 無反応バックエンド', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ハングした 1 件をバックエンドが打ち切れば残りが流れる', async () => {
    const finished: string[] = []
    let hangResolve: (() => void) | null = null
    const backend: SpeechBackend = {
      speak(text: string) {
        if (text.startsWith('hang')) {
          return new Promise<void>((resolve) => {
            hangResolve = () => {
              finished.push(text)
              resolve()
            }
            // バックエンド側のウォッチドッグ相当
            setTimeout(() => hangResolve?.(), 10_000)
          })
        }
        finished.push(text)
        return Promise.resolve()
      },
      cancel() {},
    }
    const q = useSpeechQueue(backend)
    q.enqueue('hang sentence')
    q.enqueue('later sentence')
    const drained = q.drained()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(finished).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    await drained
    expect(finished).toEqual(['hang sentence', 'later sentence'])
  })
})

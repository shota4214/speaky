import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTextToSpeech, watchdogTimeoutMs } from './useTextToSpeech'

/**
 * Web Speech API の最小モック。
 * node 環境 (vitest.config.ts の environment: 'node') には window ごと無いので、
 * useAudioRecorder.test.ts と同じく vi.stubGlobal で生やす。
 */
class FakeUtterance {
  text: string
  rate = 1
  pitch = 1
  lang = ''
  voice: unknown = null
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((e: { error: string }) => void) | null = null
  constructor(text: string) {
    this.text = text
  }
}

class FakeSynth {
  voices: { name: string; lang: string }[] = [{ name: 'Samantha', lang: 'en-US' }]
  /** getVoices() を空で返し、voiceschanged を待たせる (実機の初回起動の挙動)。 */
  voicesPending = false
  spoken: FakeUtterance[] = []
  cancelCount = 0
  /** speak されたら自動で onend を発火するか (false = 無反応 = ハング再現)。 */
  autoEnd = true
  private listeners: Record<string, (() => void)[]> = {}

  getVoices() {
    return this.voicesPending ? [] : this.voices
  }
  addEventListener(type: string, cb: () => void) {
    ;(this.listeners[type] ??= []).push(cb)
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((x) => x !== cb)
  }
  speak(u: FakeUtterance) {
    this.spoken.push(u)
    if (this.autoEnd) {
      queueMicrotask(() => {
        u.onstart?.()
        u.onend?.()
      })
    }
  }
  cancel() {
    this.cancelCount++
  }
  /** voiceschanged を発火して ensureVoicesLoaded の await を解く。 */
  resolveVoices() {
    this.voicesPending = false
    for (const cb of this.listeners['voiceschanged'] ?? []) cb()
  }
}

let synth: FakeSynth

beforeEach(() => {
  vi.useFakeTimers()
  synth = new FakeSynth()
  vi.stubGlobal('window', { speechSynthesis: synth })
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('watchdogTimeoutMs', () => {
  it('短文でも下限、長文でも上限を超えない', () => {
    expect(watchdogTimeoutMs('Hi.', 1)).toBe(5_000)
    expect(watchdogTimeoutMs('x'.repeat(100_000), 1)).toBe(180_000)
  })

  it('文字数と rate に比例して伸びる', () => {
    const short = watchdogTimeoutMs('x'.repeat(100), 1)
    const long = watchdogTimeoutMs('x'.repeat(200), 1)
    expect(long).toBeGreaterThan(short)
    // rate が遅いほど長く待つ
    expect(watchdogTimeoutMs('x'.repeat(200), 0.5)).toBeGreaterThan(long)
  })
})

describe('useTextToSpeech', () => {
  it('正常系: onend で解決し、cancel は呼ばれない', async () => {
    const tts = useTextToSpeech()
    const p = tts.speak('Hello there.')
    await vi.advanceTimersByTimeAsync(0)
    await p
    expect(synth.spoken.map((u) => u.text)).toEqual(['Hello there.'])
    expect(tts.speaking.value).toBe(false)
    // 発話後にウォッチドッグが残って cancel を撃たないこと
    await vi.advanceTimersByTimeAsync(200_000)
    expect(synth.cancelCount).toBe(1) // speak 冒頭の interrupt 1 回だけ
  })

  it('voice 読み込み待ちの最中に cancel されたら発話しない (キャンセル競合)', async () => {
    synth.voicesPending = true
    const tts = useTextToSpeech()

    const p = tts.speak('Should never be spoken.')
    await vi.advanceTimersByTimeAsync(0)
    // まだ voice 待ちなので utterance は積まれていない
    expect(synth.spoken).toEqual([])

    tts.cancel()
    synth.resolveVoices()
    await vi.advanceTimersByTimeAsync(0)
    await expect(p).resolves.toBeUndefined()

    // ここが本丸: cancel 後に積まれて喋り出してはいけない
    expect(synth.spoken).toEqual([])
    expect(tts.speaking.value).toBe(false)
  })

  it('cancel 前に始まった発話は普通に完了する', async () => {
    synth.voicesPending = true
    const tts = useTextToSpeech()
    const p = tts.speak('This one is fine.')
    synth.resolveVoices()
    await vi.advanceTimersByTimeAsync(0)
    await p
    expect(synth.spoken.map((u) => u.text)).toEqual(['This one is fine.'])
  })

  it('interrupt: false なら既存の発話を打ち切らない', async () => {
    const tts = useTextToSpeech()
    const p = tts.speak('First.', { interrupt: false })
    await vi.advanceTimersByTimeAsync(0)
    await p
    expect(synth.cancelCount).toBe(0)

    const p2 = tts.speak('Second.')
    await vi.advanceTimersByTimeAsync(0)
    await p2
    expect(synth.cancelCount).toBe(1)
  })

  it('onend が来なくてもウォッチドッグで解決する (reject しない)', async () => {
    synth.autoEnd = false
    const tts = useTextToSpeech()
    const text = 'This utterance never ends.'
    const p = tts.speak(text)
    let settled = false
    void p.then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(synth.spoken.length).toBe(1)
    await vi.advanceTimersByTimeAsync(watchdogTimeoutMs(text, 1) - 100)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(200)
    await expect(p).resolves.toBeUndefined()
    expect(settled).toBe(true)
    // 打ち切り時は cancel して次の発話に備える (interrupt 分 + 打ち切り分)
    expect(synth.cancelCount).toBe(2)
    expect(tts.speaking.value).toBe(false)
  })

  it('canceled / interrupted の onerror は resolve、それ以外は reject', async () => {
    synth.autoEnd = false
    const tts = useTextToSpeech()

    const p1 = tts.speak('a')
    await vi.advanceTimersByTimeAsync(0)
    synth.spoken[0]!.onerror?.({ error: 'interrupted' })
    await expect(p1).resolves.toBeUndefined()

    const p2 = tts.speak('b')
    await vi.advanceTimersByTimeAsync(0)
    synth.spoken[1]!.onerror?.({ error: 'synthesis-failed' })
    await expect(p2).rejects.toThrow('synthesis-failed')
  })
})

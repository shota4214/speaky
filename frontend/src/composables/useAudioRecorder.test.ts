import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIO_LEVEL_INTERVAL_MS, MONITOR_INTERVAL_MS, useAudioRecorder } from './useAudioRecorder'

/**
 * Web Audio / MediaRecorder の最小モック。
 * node 環境 (vitest.config.ts の environment: 'node') には存在しないので自前で生やす。
 *
 * ここで検証したいのは「タイマー駆動の監視ループ」「audioLevel の間引き」
 * 「マイクの使い回しと解放」であって、実際の音声処理ではない。
 * そのため analyser は「与えられた振幅を返すだけ」の器にしてある。
 */

/** analyser が返す RMS 相当の振幅 (0-1)。テストから書き換える。 */
let currentAmplitude = 0

class FakeMediaStreamTrack {
  readyState: 'live' | 'ended' = 'live'
  stop() {
    this.readyState = 'ended'
  }
}

class FakeMediaStream {
  tracks: FakeMediaStreamTrack[] = [new FakeMediaStreamTrack()]
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks
  }
}

class FakeAnalyser {
  fftSize = 1024
  getByteTimeDomainData(buf: Uint8Array) {
    // rms = sqrt(mean(((v - 128) / 128)^2)) なので、全サンプルを
    // 128 + amplitude*128 にすれば rms == amplitude になる。
    buf.fill(Math.round(128 + currentAmplitude * 128))
  }
}

class FakeSourceNode {
  disconnected = false
  connect() {}
  disconnect() {
    this.disconnected = true
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state: 'running' | 'suspended' | 'closed' = 'running'
  closed = false
  sources: FakeSourceNode[] = []
  constructor() {
    FakeAudioContext.instances.push(this)
  }
  createAnalyser() {
    return new FakeAnalyser()
  }
  createMediaStreamSource() {
    const s = new FakeSourceNode()
    this.sources.push(s)
    return s
  }
  async resume() {
    this.state = 'running'
  }
  async close() {
    this.closed = true
    this.state = 'closed'
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported() {
    return true
  }
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  started = false
  stopped = false
  constructor() {
    FakeMediaRecorder.instances.push(this)
  }
  start() {
    this.started = true
  }
  stop() {
    this.stopped = true
    this.ondataavailable?.({ data: new Blob(['x']) })
    this.onstop?.()
  }
}

let getUserMediaCalls = 0
let lastStream: FakeMediaStream | null = null

beforeEach(() => {
  vi.useFakeTimers()
  currentAmplitude = 0
  getUserMediaCalls = 0
  lastStream = null
  FakeAudioContext.instances = []
  FakeMediaRecorder.instances = []

  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => {
        getUserMediaCalls++
        lastStream = new FakeMediaStream()
        return lastStream
      },
    },
  })
  // rAF が呼ばれたら即座に分かるようにしておく (タイマー駆動に移行済みの確認)
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** fake timer を ms 進める (Date.now も一緒に進む)。 */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('useAudioRecorder', () => {
  it('requestAnimationFrame ではなくタイマーで監視ループを回す', async () => {
    const rec = useAudioRecorder({ minRecordingMs: 100, maxRecordingMs: 5_000 })
    const promise = rec.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(rec.state.value).toBe('recording')
    expect(requestAnimationFrame).not.toHaveBeenCalled()

    // 無音のまま放置すれば無音検出で止まる
    await advance(3_000)
    await promise
    expect(rec.state.value).toBe('stopped')
    expect(requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('audioLevel の書き込みはサンプリングより間引かれる', async () => {
    const rec = useAudioRecorder({
      silenceDurationMs: 60_000, // 無音では止めない
      minRecordingMs: 100,
      maxRecordingMs: 60_000,
    })
    void rec.start()
    await vi.advanceTimersByTimeAsync(0)

    // ref の setter を直接観測できないので、ティックごとに値の変化を数える。
    // 間引きが効いていなければ「毎ティック = ticks 回」変化するはず。
    let writes = 0
    let prev = rec.audioLevel.value

    const durationMs = 1_000
    const ticks = durationMs / MONITOR_INTERVAL_MS
    for (let i = 0; i < ticks; i++) {
      // 毎ティック違う振幅にする
      currentAmplitude = 0.3 + ((i + 1) % 7) * 0.05
      await advance(MONITOR_INTERVAL_MS)
      if (rec.audioLevel.value !== prev) {
        prev = rec.audioLevel.value
        writes++
      }
    }

    const maxExpected = Math.ceil(durationMs / AUDIO_LEVEL_INTERVAL_MS) + 1
    expect(writes).toBeGreaterThan(0)
    expect(writes).toBeLessThanOrEqual(maxExpected)
    // サンプリング回数 (= ticks) よりは明確に少ない
    expect(writes).toBeLessThan(ticks)

    rec.stop()
    rec.release()
  })

  it('maxRecordingMs を超えたら強制停止する', async () => {
    const rec = useAudioRecorder({
      silenceDurationMs: 60_000,
      minRecordingMs: 100,
      maxRecordingMs: 1_000,
    })
    const promise = rec.start()
    await vi.advanceTimersByTimeAsync(0)
    currentAmplitude = 0.4 // 喋り続けている = 無音検出では止まらない

    await advance(900)
    expect(rec.state.value).toBe('recording')

    await advance(200)
    const result = await promise
    expect(rec.state.value).toBe('stopped')
    expect(result.durationMs).toBeGreaterThanOrEqual(1_000)
    expect(result.hadSpeech).toBe(true)
  })

  it('minRecordingMs より前に無音になっても停止しない', async () => {
    const rec = useAudioRecorder({
      silenceDurationMs: 200,
      minRecordingMs: 2_000,
      maxRecordingMs: 60_000,
    })
    const promise = rec.start()
    await vi.advanceTimersByTimeAsync(0)

    // 最初からずっと無音でも minRecordingMs までは録り続ける
    await advance(1_500)
    expect(rec.state.value).toBe('recording')

    await advance(1_000)
    await promise
    expect(rec.state.value).toBe('stopped')
  })

  it('無音が silenceDurationMs 続いたら停止する', async () => {
    const rec = useAudioRecorder({
      silenceDurationMs: 500,
      minRecordingMs: 100,
      maxRecordingMs: 60_000,
    })
    const promise = rec.start()
    await vi.advanceTimersByTimeAsync(0)

    currentAmplitude = 0.4
    await advance(1_000)
    expect(rec.state.value).toBe('recording')

    // 喋るのをやめる
    currentAmplitude = 0
    await advance(400)
    expect(rec.state.value).toBe('recording')

    await advance(300)
    const result = await promise
    expect(rec.state.value).toBe('stopped')
    expect(result.hadSpeech).toBe(true)
  })

  it('停止後にタイマーが残らない', async () => {
    const rec = useAudioRecorder({ silenceDurationMs: 300, minRecordingMs: 100 })
    const promise = rec.start()
    await vi.advanceTimersByTimeAsync(0)
    await advance(1_000)
    await promise

    expect(vi.getTimerCount()).toBe(0)
  })

  it('2 ターン目は getUserMedia / AudioContext を作り直さない', async () => {
    const rec = useAudioRecorder({ silenceDurationMs: 300, minRecordingMs: 100 })

    const first = rec.start()
    await vi.advanceTimersByTimeAsync(0)
    await advance(1_000)
    await first

    expect(getUserMediaCalls).toBe(1)
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(FakeMediaRecorder.instances).toHaveLength(1)

    const second = rec.start()
    await vi.advanceTimersByTimeAsync(0)
    await advance(1_000)
    await second

    // マイクと AudioContext は使い回し、MediaRecorder だけ作り直す
    expect(getUserMediaCalls).toBe(1)
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(FakeMediaRecorder.instances).toHaveLength(2)
    expect(lastStream!.getAudioTracks()[0]!.readyState).toBe('live')

    rec.release()
    expect(lastStream!.getAudioTracks()[0]!.readyState).toBe('ended')
    expect(FakeAudioContext.instances[0]!.closed).toBe(true)
  })

  it('release 後に start するとマイクを取り直す', async () => {
    const rec = useAudioRecorder({ silenceDurationMs: 300, minRecordingMs: 100 })
    const first = rec.start()
    await vi.advanceTimersByTimeAsync(0)
    await advance(1_000)
    await first
    rec.release()

    const second = rec.start()
    await vi.advanceTimersByTimeAsync(0)
    await advance(1_000)
    await second

    expect(getUserMediaCalls).toBe(2)
    expect(FakeAudioContext.instances).toHaveLength(2)
    rec.release()
  })

  it('トラックが ended になっていたら取り直す', async () => {
    const rec = useAudioRecorder({ silenceDurationMs: 300, minRecordingMs: 100 })
    const first = rec.start()
    await vi.advanceTimersByTimeAsync(0)
    await advance(1_000)
    await first

    // OS 側 / デバイス抜去でトラックが死んだ状況を再現
    lastStream!.getAudioTracks()[0]!.stop()

    const second = rec.start()
    await vi.advanceTimersByTimeAsync(0)
    await advance(1_000)
    await second

    expect(getUserMediaCalls).toBe(2)
    rec.release()
  })

  it('suspended な AudioContext は resume される', async () => {
    const originalCreate = FakeAudioContext.prototype.createAnalyser
    expect(originalCreate).toBeTruthy()

    const rec = useAudioRecorder({ silenceDurationMs: 300, minRecordingMs: 100 })
    const first = rec.start()
    await vi.advanceTimersByTimeAsync(0)
    await advance(1_000)
    await first

    const ctx = FakeAudioContext.instances[0]!
    ctx.state = 'suspended'

    const second = rec.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.state).toBe('running')
    await advance(1_000)
    await second
    rec.release()
  })

  it('release は冪等で、録音していないときでも安全', () => {
    const rec = useAudioRecorder()
    expect(() => {
      rec.release()
      rec.release()
    }).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})

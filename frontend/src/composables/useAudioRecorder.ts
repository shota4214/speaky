import { onUnmounted, ref } from 'vue'

export type RecorderState = 'idle' | 'requestingPermission' | 'recording' | 'stopped' | 'error'

export interface RecorderOptions {
  silenceDurationMs?: number
  silenceThreshold?: number
  speechThreshold?: number
  minRecordingMs?: number
  maxRecordingMs?: number
}

export interface RecordingResult {
  blob: Blob
  durationMs: number
  hadSpeech: boolean
  peakLevel: number
  mimeType: string
}

/**
 * 音声レベル計測 / 無音検出のティック間隔 (ms)。
 *
 * requestAnimationFrame ではなく setInterval を使う理由:
 * - ウィンドウが非表示 / 非フォーカス / マシンが高負荷だと rAF は 1Hz 程度まで
 *   間引かれるか完全に止まる。すると無音検出も maxRecordingMs の強制停止も効かず、
 *   「録音が終わらない」状態になる。
 * - タイマーなら (Electron 側で backgroundThrottling: false にしてあるので)
 *   非フォーカスでも 50ms 間隔で回り続ける。
 * - 20Hz あれば無音判定の粒度としては十分 (silenceDurationMs は最短でも数百 ms)。
 */
export const MONITOR_INTERVAL_MS = 50

/**
 * audioLevel ref を実際に書き換える最小間隔 (ms)。
 *
 * Chat.vue は audioLevel から 32 本のビジュアライザバーを computed で導出しており、
 * 毎フレーム (=60Hz) 書くと録音中ずっと「32 要素の inline style パッチ + CSS transition」
 * が走り、メモリ逼迫した MacBook Air だとコアを 1 つ食い潰す。
 *
 * RMS のサンプリング自体は MONITOR_INTERVAL_MS のまま (無音検出の精度は不変) で、
 * ref への書き込みだけ間引く。ティックが 50ms なので実効レートは 2 ティックに 1 回 =
 * 約 10Hz となり、60Hz から約 1/6 に落ちる。
 */
export const AUDIO_LEVEL_INTERVAL_MS = 66

export function useAudioRecorder(options: RecorderOptions = {}) {
  const {
    // 既定値は DEFAULT_SETTINGS.silenceDurationMs と揃える(常に呼び出し側が
    // 設定値を渡すので実際には使われないが、値がズレていると読んだ人を惑わせる)。
    silenceDurationMs = 1500,
    silenceThreshold = 0.02,
    speechThreshold = 0.05,
    minRecordingMs = 500,
    maxRecordingMs = 30_000,
  } = options

  const state = ref<RecorderState>('idle')
  const error = ref<string | null>(null)
  const audioLevel = ref(0) // 0-1

  // --- セッション中は使い回すリソース ---------------------------------------
  // turn ごとに getUserMedia + AudioContext を作り直すと macOS では 100-400ms
  // かかり、OS のマイク使用インジケータも毎ターン点滅する。会話が終わる /
  // 画面を離れるまで保持して、MediaRecorder だけを turn ごとに作り直す。
  let stream: MediaStream | null = null
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let sourceNode: MediaStreamAudioSourceNode | null = null
  let analyserBuffer: Uint8Array<ArrayBuffer> | null = null

  // --- turn ごとのリソース ---------------------------------------------------
  let recorder: MediaRecorder | null = null
  let chunks: Blob[] = []
  let silenceStartedAt: number | null = null
  let recordingStartedAt: number | null = null
  let monitorTimerId: ReturnType<typeof setInterval> | null = null
  let lastLevelEmittedAt = 0
  let resolveStop: ((result: RecordingResult) => void) | null = null
  let rejectStop: ((err: Error) => void) | null = null
  let activeMimeType = ''
  let peakLevel = 0
  let hadSpeech = false

  function pickMimeType(): string {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      '',
    ]
    for (const t of candidates) {
      if (t === '' || MediaRecorder.isTypeSupported(t)) return t
    }
    return ''
  }

  /** マイクトラックが生きているか(デバイス抜去 / OS 側の停止を検出する)。 */
  function hasLiveAudioTrack(): boolean {
    const tracks = stream?.getAudioTracks() ?? []
    return tracks.length > 0 && tracks.some((t) => t.readyState === 'live')
  }

  /**
   * マイクストリームと解析グラフを(無ければ)用意する。冪等。
   * 既に確保済みなら getUserMedia を叩かないので 2 ターン目以降は即座に返る。
   */
  async function ensureMicrophone(): Promise<void> {
    // トラックが死んでいたら作り直す(デバイス抜き差し / スリープ復帰対策)
    if (stream && !hasLiveAudioTrack()) releaseMicrophone()

    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
    }
    if (!audioContext) {
      audioContext = new AudioContext()
    }
    // macOS では AudioContext が suspended のまま生成される / スリープ復帰後に
    // suspended に落ちることがある。そのままだと analyser のデータが更新されず
    // 「ずっと無音」扱いになって会話が進まないので必ず resume する。
    if (audioContext.state === 'suspended') {
      await Promise.resolve(audioContext.resume()).catch(() => undefined)
    }
    if (!analyser) {
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 1024
      analyserBuffer = new Uint8Array(analyser.fftSize)
    }
    if (!sourceNode) {
      sourceNode = audioContext.createMediaStreamSource(stream)
      sourceNode.connect(analyser)
    }
  }

  /**
   * マイクを完全に解放する(トラック停止 + AudioContext クローズ)。
   * 会話終了 / 画面アンマウント時に呼ぶ。冪等。
   */
  function releaseMicrophone(): void {
    stopMonitor()
    try {
      sourceNode?.disconnect()
    } catch {
      // 既に切断済み
    }
    sourceNode = null
    analyser = null
    analyserBuffer = null
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    const ctx = audioContext
    audioContext = null
    try {
      ctx?.close().catch(() => undefined)
    } catch {
      // 既に closed
    }
    recorder = null
  }

  /** turn の後始末。マイクは保持したまま、録音まわりだけ片付ける。 */
  function endTurn(): void {
    stopMonitor()
    recorder = null
  }

  async function start(): Promise<RecordingResult> {
    if (state.value === 'recording' || state.value === 'requestingPermission') {
      throw new Error(`Already in state: ${state.value}`)
    }
    error.value = null
    chunks = []
    peakLevel = 0
    hadSpeech = false
    state.value = 'requestingPermission'

    try {
      await ensureMicrophone()
    } catch (e) {
      releaseMicrophone()
      state.value = 'error'
      error.value = `マイクの権限取得に失敗: ${(e as Error).message}`
      throw e
    }

    activeMimeType = pickMimeType()
    recorder = new MediaRecorder(
      stream as MediaStream,
      activeMimeType ? { mimeType: activeMimeType } : undefined,
    )
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.onstop = () => {
      const blob = new Blob(chunks, {
        type: activeMimeType || 'audio/webm',
      })
      const durationMs = recordingStartedAt ? Date.now() - recordingStartedAt : 0
      const result: RecordingResult = {
        blob,
        durationMs,
        hadSpeech,
        peakLevel,
        mimeType: activeMimeType || 'audio/webm',
      }
      endTurn()
      state.value = 'stopped'
      resolveStop?.(result)
      resolveStop = null
      rejectStop = null
    }
    recorder.onerror = (e) => {
      // 録音自体が壊れているのでストリームごと作り直させる
      releaseMicrophone()
      state.value = 'error'
      const err = (e as unknown as { error?: Error }).error ?? new Error('MediaRecorder error')
      error.value = err.message
      rejectStop?.(err)
      resolveStop = null
      rejectStop = null
    }

    state.value = 'recording'
    recordingStartedAt = Date.now()
    silenceStartedAt = null
    recorder.start()
    startMonitor()

    return new Promise<RecordingResult>((resolve, reject) => {
      resolveStop = resolve
      rejectStop = reject
    })
  }

  function startMonitor(): void {
    stopMonitor()
    // 0 にしておくと最初のティックで必ず audioLevel が 1 回書かれる
    lastLevelEmittedAt = 0
    monitorTimerId = setInterval(tick, MONITOR_INTERVAL_MS)
  }

  function stopMonitor(): void {
    if (monitorTimerId !== null) {
      clearInterval(monitorTimerId)
      monitorTimerId = null
    }
  }

  function tick(): void {
    if (!analyser || !analyserBuffer || state.value !== 'recording') {
      stopMonitor()
      return
    }
    analyser.getByteTimeDomainData(analyserBuffer)

    let sum = 0
    for (let i = 0; i < analyserBuffer.length; i++) {
      const sample = (analyserBuffer[i]! - 128) / 128
      sum += sample * sample
    }
    const rms = Math.sqrt(sum / analyserBuffer.length)
    if (rms > peakLevel) peakLevel = rms
    if (rms >= speechThreshold) hadSpeech = true

    const now = Date.now()

    // ビジュアライザ用の ref は間引いて書く(描画コスト削減)。
    // peak / hadSpeech / 無音判定は毎ティック評価しているので検出精度は不変。
    if (now - lastLevelEmittedAt >= AUDIO_LEVEL_INTERVAL_MS) {
      audioLevel.value = rms
      lastLevelEmittedAt = now
    }

    // 強制停止: maxRecordingMs を超えたら止める
    if (recordingStartedAt !== null && now - recordingStartedAt > maxRecordingMs) {
      stop()
      return
    }

    if (rms < silenceThreshold) {
      if (silenceStartedAt === null) {
        silenceStartedAt = now
      } else if (
        now - silenceStartedAt > silenceDurationMs &&
        recordingStartedAt !== null &&
        now - recordingStartedAt > minRecordingMs
      ) {
        stop()
        return
      }
    } else {
      silenceStartedAt = null
    }
  }

  function stop() {
    if (state.value !== 'recording') return
    stopMonitor()
    recorder?.stop()
  }

  onUnmounted(() => {
    if (state.value === 'recording') stop()
    // 画面を離れたらマイクは必ず手放す(release を呼ばない既存の呼び出し側でも
    // マイクが開きっぱなしにならないようにする)
    releaseMicrophone()
  })

  return {
    state,
    error,
    audioLevel,
    activeMimeType: () => activeMimeType,
    start,
    stop,
    /** 会話終了時などに明示的にマイクを解放する(任意。未呼び出しでも unmount で解放される)。 */
    release: releaseMicrophone,
  }
}

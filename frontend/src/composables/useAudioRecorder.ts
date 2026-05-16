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

export function useAudioRecorder(options: RecorderOptions = {}) {
  const {
    silenceDurationMs = 2000,
    silenceThreshold = 0.02,
    speechThreshold = 0.05,
    minRecordingMs = 500,
    maxRecordingMs = 30_000,
  } = options

  const state = ref<RecorderState>('idle')
  const error = ref<string | null>(null)
  const audioLevel = ref(0) // 0-1

  let stream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let chunks: Blob[] = []
  let silenceStartedAt: number | null = null
  let recordingStartedAt: number | null = null
  let animationFrameId: number | null = null
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
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
    } catch (e) {
      state.value = 'error'
      error.value = `マイクの権限取得に失敗: ${(e as Error).message}`
      throw e
    }

    audioContext = new AudioContext()
    const source = audioContext.createMediaStreamSource(stream)
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)

    activeMimeType = pickMimeType()
    recorder = new MediaRecorder(stream, activeMimeType ? { mimeType: activeMimeType } : undefined)
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
      cleanup()
      state.value = 'stopped'
      resolveStop?.(result)
      resolveStop = null
      rejectStop = null
    }
    recorder.onerror = (e) => {
      cleanup()
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
    monitor()

    return new Promise<RecordingResult>((resolve, reject) => {
      resolveStop = resolve
      rejectStop = reject
    })
  }

  function monitor() {
    if (!analyser) return
    const data = new Uint8Array(analyser.fftSize)

    const tick = () => {
      if (!analyser || state.value !== 'recording') return
      analyser.getByteTimeDomainData(data)

      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const sample = (data[i]! - 128) / 128
        sum += sample * sample
      }
      const rms = Math.sqrt(sum / data.length)
      audioLevel.value = rms
      if (rms > peakLevel) peakLevel = rms
      if (rms >= speechThreshold) hadSpeech = true

      const now = Date.now()

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

      animationFrameId = requestAnimationFrame(tick)
    }

    animationFrameId = requestAnimationFrame(tick)
  }

  function stop() {
    if (state.value !== 'recording') return
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    recorder?.stop()
  }

  function cleanup() {
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    audioContext?.close().catch(() => undefined)
    audioContext = null
    analyser = null
    recorder = null
  }

  onUnmounted(() => {
    if (state.value === 'recording') stop()
    else cleanup()
  })

  return {
    state,
    error,
    audioLevel,
    activeMimeType: () => activeMimeType,
    start,
    stop,
  }
}

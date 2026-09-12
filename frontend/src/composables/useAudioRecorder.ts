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
 * - 20Hz あれば無音判定の粒度としては十分 (silenceDurationMs は設定 UI の最小が
 *   1000ms = 20 ティック)。
 *
 * rAF から変わった唯一の実質的な差は「デューティ比」:
 * analyser の窓は fftSize 1024 / 48kHz = 約 21ms なので、50ms ごとに 1 回だけ
 * 読むと音声の約 43% しか観測していない (rAF はほぼ連続に観測していた)。
 * それでも実用上問題にならないと判断した根拠:
 * - 無音送信が誤爆するには「観測された無音」が silenceDurationMs (最小 1000ms
 *   = 20 ティック) 連続する必要がある。つまり 29ms の隙間にすっぽり収まる発話が
 *   20 回以上連続しないと起きない。音節は 100ms 以上あるので現実には起こらない。
 * - hadSpeech / peakLevel は 1 ティックでも閾値を超えれば立つので、
 *   数百 ms 続く発話なら必ず複数回捕まる。
 * サンプリング間隔を詰めれば取りこぼしは減るが、低スペック機の負荷を下げるという
 * この変更の目的と真っ向から矛盾するので、間隔は上げない。
 */
export const MONITOR_INTERVAL_MS = 50

/**
 * audioLevel ref を実際に書き換える最小間隔 (ms)。
 *
 * Chat.vue は audioLevel から 32 本のビジュアライザバーを computed で導出しており、
 * 毎フレーム (=60Hz) 書くと録音中ずっと「32 要素の inline style パッチ + CSS transition」
 * が走り、メモリ逼迫した MacBook Air だとコアを 1 つ食い潰す。
 *
 * 間引くのは ref への書き込みだけで、RMS のサンプリング / 無音判定 / hadSpeech は
 * MONITOR_INTERVAL_MS ごとに毎回評価する (この間引きは検出側には影響しない)。
 * ティックが 50ms なので実効レートは 2 ティックに 1 回 = 約 10Hz となり、
 * 60Hz から約 1/6 に落ちる。
 */
export const AUDIO_LEVEL_INTERVAL_MS = 66

/**
 * release() が「取得中の getUserMedia / AudioContext.resume」を打ち切ったときと、
 * 録音中に release() されて start() の Promise を決着させるときに投げるエラー。
 *
 * name を 'AbortError' にしてあるのは、呼び出し側 (useConversationLoop の
 * isAbortError()) が「ユーザーに見せないキャンセル」として既に扱えるから。
 * ここで普通の Error を投げると「会話を終わる」を押しただけで
 * エラーメッセージが画面に出てしまう。
 */
function createMicAbortError(): Error {
  const err = new Error('マイクが解放されたため録音を中断しました')
  err.name = 'AbortError'
  return err
}

/** start() の reject がマイク解放による中断かどうか。 */
export function isMicAbortError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError'
}

/** AudioContext.close() は closed 済みだと reject / throw するので握りつぶす。 */
function closeContext(ctx: AudioContext | null): void {
  if (!ctx) return
  try {
    void Promise.resolve(ctx.close()).catch(() => undefined)
  } catch {
    // 既に closed
  }
}

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

  /**
   * マイク取得の「世代」。releaseMicrophone() のたびに +1 する。
   *
   * ensureMicrophone() は await をまたぐたびにこの値を見直し、変わっていたら
   * 自分が確保したリソースを自分で捨てて中断する。これが無いと:
   * getUserMedia の解決待ち (初回は権限シート表示中ずっと、2 回目以降でも
   * 100-400ms) に会話終了 / アンマウントで release() が走っても、その時点では
   * stream が null なので release は何も止められず、あとから解決した
   * MediaStream が誰にも解放されないまま生き続ける = OS のマイクインジケータが
   * アプリ終了まで点きっぱなしになる。
   */
  let micEpoch = 0

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

    // await のたびに「この取得がまだ有効か」を確かめるための世代スナップショット。
    const epoch = micEpoch

    if (!stream) {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      if (epoch !== micEpoch) {
        // 待っている間に release された。このトラックはまだ誰にも見えていない
        // ので、ここで止めないと永遠に生き残る。
        acquired.getTracks().forEach((t) => t.stop())
        throw createMicAbortError()
      }
      stream = acquired
    }
    const activeStream = stream

    // audioContext を await をまたいで参照しない。releaseMicrophone() は
    // audioContext に同期的に null を入れるので、await の後にもう一度
    // audioContext.createAnalyser() と書くと(型上は narrowing が残るため
    // コンパイルは通るのに)実行時に落ちる。落ちた TypeError は start() の
    // catch で「マイクの権限取得に失敗」として表示されてしまい、原因を
    // 完全に取り違えたメッセージになる。
    let ctx = audioContext
    if (!ctx) {
      ctx = new AudioContext()
      audioContext = ctx
    }
    // macOS では AudioContext が suspended のまま生成される / スリープ復帰後に
    // suspended に落ちることがある。そのままだと analyser のデータが更新されず
    // 「ずっと無音」扱いになって会話が進まないので必ず resume する。
    if (ctx.state === 'suspended') {
      await Promise.resolve(ctx.resume()).catch(() => undefined)
      if (epoch !== micEpoch) {
        // 待っている間に release された。release 側で close 済みのはずだが、
        // その後に別の取得が始まっていた場合に備えて自分の ctx だけ閉じる。
        if (ctx !== audioContext) closeContext(ctx)
        throw createMicAbortError()
      }
    }
    if (!analyser) {
      analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyserBuffer = new Uint8Array(analyser.fftSize)
    }
    if (!sourceNode) {
      sourceNode = ctx.createMediaStreamSource(activeStream)
      sourceNode.connect(analyser)
    }
  }

  /**
   * マイクを完全に解放する(トラック停止 + AudioContext クローズ)。
   * 会話終了 / 画面アンマウント時に呼ぶ。冪等。
   *
   * 録音中 / 取得中でも安全に呼べる:
   * - 取得中の ensureMicrophone は世代チェックで中断され、後から解決した
   *   MediaStream は向こう側で止まる。
   * - 録音中なら、待機している start() の Promise を AbortError で reject して
   *   state を 'idle' に戻す(呼び出し順やブラウザの stream inactive →
   *   onstop という仕様任せの挙動に頼らない)。
   */
  function releaseMicrophone(): void {
    // 取得途中の ensureMicrophone を無効化する(向こうが自分で後始末する)
    micEpoch += 1
    stopMonitor()

    // 録音中に呼ばれた場合に備えて、MediaRecorder のハンドラを先に外してから
    // 止める。外さないと、トラック停止 → ブラウザが stream を inactive にする →
    // 後から onstop が発火して state が 'stopped' に書き戻される。
    const activeRecorder = recorder
    recorder = null
    if (activeRecorder) {
      activeRecorder.ondataavailable = null
      activeRecorder.onstop = null
      activeRecorder.onerror = null
      try {
        activeRecorder.stop()
      } catch {
        // 既に inactive
      }
    }

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
    closeContext(ctx)

    // 待っている start() の Promise を必ず決着させる。
    // 「解放 = そのターンの中断」なので、途中まで録れた音声で resolve する
    // のではなく reject する:
    // - resolve すると呼び出し側は切れた断片を転写しに行き、そのまま次の
    //   ターンでマイクを取り直す。手放したはずのインジケータが即座に点き直る。
    // - 音声が欲しい場合の正規の経路は stop()(onstop で resolve)であって
    //   release() ではない。
    // reject するエラーは name='AbortError' なので、useConversationLoop 側は
    // 「ユーザーに見せないキャンセル」として静かに抜ける。
    const reject = rejectStop
    resolveStop = null
    rejectStop = null
    chunks = []
    recordingStartedAt = null
    silenceStartedAt = null
    if (state.value === 'recording' || state.value === 'requestingPermission') {
      state.value = 'idle'
    }
    reject?.(createMicAbortError())
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
      if (isMicAbortError(e)) {
        // release() が割り込んだ = 呼び出し側は既にマイクを手放している。
        // ここで releaseMicrophone() を呼ぶと世代が進み、その間に始まった
        // 新しい取得まで巻き添えで壊すので、何も片付けずに抜ける。
        if (state.value === 'requestingPermission') state.value = 'idle'
        throw e
      }
      releaseMicrophone()
      state.value = 'error'
      error.value = `マイクの権限取得に失敗: ${(e as Error).message}`
      throw e
    }

    // ensureMicrophone の解決と release() が競合しても、死んだ(あるいは
    // 手放した)ストリームで MediaRecorder を作らない。
    if (!stream || !hasLiveAudioTrack()) {
      if (state.value === 'requestingPermission') state.value = 'idle'
      throw createMicAbortError()
    }

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
    // peak / hadSpeech / 無音判定は毎ティック評価しているので、この間引き自体は
    // 検出に影響しない(ティック間隔そのものの影響は MONITOR_INTERVAL_MS の
    // コメントを参照)。
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
    /**
     * 会話終了時などに明示的にマイクを解放する(任意。未呼び出しでも unmount で解放される)。
     * 録音中に呼ぶと、待機中の start() の Promise は AbortError で reject される。
     */
    release: releaseMicrophone,
  }
}

import { onUnmounted, ref } from 'vue'
import type { Gender } from '../db/types'
import { stripEmoji } from '../../../backend/src/shared/text-guards'

/**
 * AI キャラの gender(female / male)に対応した、フォールバック用の voice 名
 * 優先順位を返す。voiceName 未指定時に useTextToSpeech / Settings の試聴で共有する。
 *
 * 配列を 1 箇所で管理することで、将来音声プリセットを追加・並び替えしたい時に
 * 修正漏れ(片方だけ更新される)を防ぐ。
 */
export function getDefaultVoicePreference(gender: Gender): string[] {
  if (gender === 'male') return ['Daniel', 'Alex', 'Karen', 'Samantha']
  return ['Samantha', 'Karen', 'Daniel', 'Alex']
}

/**
 * 会話練習に適した英語音声(macOS)のホワイトリスト。
 *
 * 除外する対象:
 *  - ノベルティ音声(Albert / Bad News / Bahh / Bells / Boing / Bubbles / Cellos /
 *    Deranged / Good News / Hysterical / Jester / Organ / Pipe Organ / Princess /
 *    Superstar / Trinoids / Whisper / Wobble / Zarvox / Junior 等)
 *  - 古いロボ調の合成音声(Agnes / Bruce / Fred / Kathy / Ralph / Vicki / Victoria 等)
 *
 * voice.name の startsWith で判定する。"Samantha (Enhanced)" のような派生名も拾える。
 * macOS Sequoia 以降の "Siri Voice N" は自然な音声なので無条件で許可する。
 */
const CONVERSATIONAL_VOICE_BASE_NAMES: ReadonlyArray<string> = [
  // Female
  'Samantha',
  'Karen',
  'Moira',
  'Fiona',
  'Tessa',
  'Veena',
  'Allison',
  'Susan',
  'Ava',
  'Nicky',
  'Serena',
  'Kate',
  'Zoe',
  'Joelle',
  'Noelle',
  'Sandy',
  // Male
  'Alex',
  'Daniel',
  'Tom',
  'Lee',
  'Oliver',
  'Aaron',
  'Arthur',
  'Rishi',
]

export function isConversationalEnglishVoice(voice: SpeechSynthesisVoice): boolean {
  if (!voice.lang.toLowerCase().startsWith('en')) return false
  if (voice.name.startsWith('Siri')) return true
  return CONVERSATIONAL_VOICE_BASE_NAMES.some((base) => voice.name.startsWith(base))
}

/**
 * 1 発話あたりのウォッチドッグ(onend が来なかったときの保険)の係数。
 *
 * macOS の Web Speech は稀に onend / onerror をどちらも発火しないことがあり、
 * その場合 speak() の Promise が永久に解決されず、会話ループが
 * 「AI が喋っている」表示のまま止まってマイクが二度と開かない。
 *
 * 見積り: 英語の合成音声は rate=1.0 でおよそ 12-16 文字/秒。
 * 安全側に倒して 1 文字 = 120ms (= 約 8 文字/秒) とし、rate で割る。
 * 実時間のおよそ 2 倍の猶予になるので、正常な発話を途中で切ることはまず無い。
 * WATCHDOG_BASE_MS は音声エンジンの起動待ち(最初の発話は数百 ms かかる)分。
 */
const WATCHDOG_BASE_MS = 3_000
const WATCHDOG_MS_PER_CHAR = 120
/** 極端に短い文でも最低これだけは待つ。 */
const WATCHDOG_MIN_MS = 5_000
/**
 * 上限。会話ループのセグメントは最大 180 文字程度なので通常は 30 秒前後で収まる。
 * 履歴画面の「もう一度聞く」は長文全体を 1 発話で読むため、正常な発話を
 * 切らないよう上限は大きめに取る(ハング時の最悪待ち時間とのトレードオフ)。
 */
const WATCHDOG_MAX_MS = 180_000

export function watchdogTimeoutMs(text: string, rate: number): number {
  const effectiveRate = rate > 0 ? rate : 1
  const estimated = WATCHDOG_BASE_MS + (text.length * WATCHDOG_MS_PER_CHAR) / effectiveRate
  return Math.min(WATCHDOG_MAX_MS, Math.max(WATCHDOG_MIN_MS, Math.round(estimated)))
}

export interface TTSOptions {
  rate?: number
  pitch?: number
  /**
   * 明示的に指定する voice.name(Web Speech API)。
   * 指定があれば最優先で適用される。
   */
  voiceName?: string | null
  /**
   * voiceName が指定されなかった、または見つからなかった場合に
   * 上から順にマッチを試みるフォールバックの voice 名リスト。
   */
  voicePreference?: string[]
  lang?: string
}

export interface SpeakOptions extends Partial<TTSOptions> {
  /**
   * 発話前に既存の発話を打ち切るか。既定は true(従来の挙動)。
   * 連続してキューから流し込む場合だけ false にする。true のまま並べると
   * 次の発話が前の発話を cancel してしまい、最後の 1 文しか聞こえない。
   */
  interrupt?: boolean
}

export function useTextToSpeech(options: TTSOptions = {}) {
  const {
    rate = 1,
    pitch = 1,
    voiceName = null,
    voicePreference = ['Samantha', 'Karen', 'Daniel', 'Alex'],
    lang = 'en-US',
  } = options

  const speaking = ref(false)
  const supported = ref(typeof window !== 'undefined' && 'speechSynthesis' in window)

  function ensureVoicesLoaded(): Promise<SpeechSynthesisVoice[]> {
    return new Promise((resolve) => {
      const initial = window.speechSynthesis.getVoices()
      if (initial.length > 0) {
        resolve(initial)
        return
      }
      const onVoicesChanged = () => {
        const list = window.speechSynthesis.getVoices()
        if (list.length > 0) {
          window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged)
          resolve(list)
        }
      }
      window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged)
      setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1000)
    })
  }

  function pickVoice(
    voices: SpeechSynthesisVoice[],
    preferredName: string | null | undefined,
    fallback: string[],
  ): SpeechSynthesisVoice | undefined {
    // 1) 明示指定があれば完全一致を最優先(部分一致も許容)
    if (preferredName) {
      const exact = voices.find((v) => v.name === preferredName)
      if (exact) return exact
      const partial = voices.find((v) => v.name.toLowerCase().includes(preferredName.toLowerCase()))
      if (partial) return partial
    }
    // 2) フォールバックリストの順に検索
    for (const pref of fallback) {
      const v = voices.find(
        (vc) => vc.name === pref || vc.name.toLowerCase().includes(pref.toLowerCase()),
      )
      if (v) return v
    }
    return undefined
  }

  /**
   * cancel() のたびに進む世代カウンタ。
   *
   * speak() は「cancel → voice 読み込み待ち(await) → speak」という順序なので、
   * await の最中に会話が停止されると、停止後に utterance が積まれて喋り出す
   * (= 会話を終わったのに AI が喋り続ける)。世代を await のたびに突き合わせ、
   * 自分より新しい cancel が入っていたら何もせず解決する。
   */
  let generation = 0

  async function speak(rawText: string, overrides: SpeakOptions = {}): Promise<void> {
    if (!supported.value) {
      throw new Error('Web Speech API SpeechSynthesis is not supported')
    }
    // 絵文字は読み上げない(macOS の音声は「smiling face with smiling eyes」と
    // 文字どおり喋る)。絵文字だけの断片なら何もせずに終える。
    const text = stripEmoji(rawText).trim()
    if (!text) return
    const interrupt = overrides.interrupt ?? true
    if (interrupt) {
      generation += 1
      window.speechSynthesis.cancel()
    }
    const myGeneration = generation

    const voices = await ensureVoicesLoaded()
    // await 中に cancel() された。ここで積むと「停止後に喋る」ので捨てる。
    if (myGeneration !== generation) return

    const effectiveRate = overrides.rate ?? rate

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = effectiveRate
      utterance.pitch = overrides.pitch ?? pitch
      utterance.lang = overrides.lang ?? lang

      const effectiveName =
        typeof overrides.voiceName !== 'undefined' ? overrides.voiceName : voiceName
      const effectivePreference = overrides.voicePreference ?? voicePreference
      const v = pickVoice(voices, effectiveName, effectivePreference)
      if (v) utterance.voice = v

      let settled = false
      let watchdogId: ReturnType<typeof setTimeout> | null = null
      function clearWatchdog() {
        if (watchdogId !== null) {
          clearTimeout(watchdogId)
          watchdogId = null
        }
      }
      function finish(fn: () => void) {
        if (settled) return
        settled = true
        clearWatchdog()
        speaking.value = false
        fn()
      }

      utterance.onstart = () => {
        speaking.value = true
      }
      utterance.onend = () => finish(resolve)
      utterance.onerror = (e) => {
        const err = e.error as string
        if (err === 'canceled' || err === 'interrupted') {
          finish(resolve)
        } else {
          finish(() => reject(new Error(`Speech synthesis error: ${err}`)))
        }
      }

      // 積む直前にもう一度世代を確認する(Promise 生成と speak の間に
      // cancel() が割り込む余地を潰す)。
      if (myGeneration !== generation) {
        finish(resolve)
        return
      }

      watchdogId = setTimeout(
        () => {
          // onend / onerror がどちらも来なかった。ここで reject すると
          // 1 文の詰まりが会話ターンごと落としてしまうので、必ず resolve する。
          console.warn('[tts] onend が来なかったためウォッチドッグで打ち切り:', text.slice(0, 40))
          finish(() => {
            try {
              window.speechSynthesis.cancel()
            } catch {
              // cancel 自体が投げても無視(どのみち打ち切る)
            }
            resolve()
          })
        },
        watchdogTimeoutMs(text, effectiveRate),
      )

      window.speechSynthesis.speak(utterance)
    })
  }

  function cancel() {
    generation += 1
    window.speechSynthesis.cancel()
    speaking.value = false
  }

  onUnmounted(() => cancel())

  return { speaking, supported, speak, cancel }
}

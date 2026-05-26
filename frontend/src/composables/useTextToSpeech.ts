import { onUnmounted, ref } from 'vue'
import type { Gender } from '../db/types'

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

  async function speak(text: string, overrides: Partial<TTSOptions> = {}): Promise<void> {
    if (!supported.value) {
      throw new Error('Web Speech API SpeechSynthesis is not supported')
    }
    window.speechSynthesis.cancel()
    const voices = await ensureVoicesLoaded()

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = overrides.rate ?? rate
      utterance.pitch = overrides.pitch ?? pitch
      utterance.lang = overrides.lang ?? lang

      const effectiveName =
        typeof overrides.voiceName !== 'undefined' ? overrides.voiceName : voiceName
      const effectivePreference = overrides.voicePreference ?? voicePreference
      const v = pickVoice(voices, effectiveName, effectivePreference)
      if (v) utterance.voice = v

      utterance.onstart = () => {
        speaking.value = true
      }
      utterance.onend = () => {
        speaking.value = false
        resolve()
      }
      utterance.onerror = (e) => {
        speaking.value = false
        const err = e.error as string
        if (err === 'canceled' || err === 'interrupted') {
          resolve()
        } else {
          reject(new Error(`Speech synthesis error: ${err}`))
        }
      }

      window.speechSynthesis.speak(utterance)
    })
  }

  function cancel() {
    window.speechSynthesis.cancel()
    speaking.value = false
  }

  onUnmounted(() => cancel())

  return { speaking, supported, speak, cancel }
}

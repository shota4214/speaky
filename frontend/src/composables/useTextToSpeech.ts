import { onUnmounted, ref } from 'vue'

export interface TTSOptions {
  rate?: number
  pitch?: number
  voicePreference?: string[]
  lang?: string
}

export function useTextToSpeech(options: TTSOptions = {}) {
  const {
    rate = 1,
    pitch = 1,
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

      for (const pref of voicePreference) {
        const v = voices.find(
          (vc) => vc.name === pref || vc.name.toLowerCase().includes(pref.toLowerCase()),
        )
        if (v) {
          utterance.voice = v
          break
        }
      }

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

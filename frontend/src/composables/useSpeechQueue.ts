import { ref } from 'vue'
import type { SpeakOptions } from './useTextToSpeech'

/**
 * 読み上げバックエンド。useTextToSpeech() の戻り値がそのまま渡せる形にしてある。
 *
 * window.speechSynthesis を直接触らずここで抽象化しているのは、
 * vitest の node 環境(window 無し)でキューの順序・キャンセル・ウォッチドッグを
 * 偽バックエンドで検証できるようにするため。
 */
export interface SpeechBackend {
  speak(text: string, options?: SpeakOptions): Promise<void>
  cancel(): void
}

export interface SpeechQueueItem {
  text: string
  options: SpeakOptions
}

/**
 * 文単位に分割された発話を「順番に・間を空けずに」流し込むキュー。
 *
 * ポイント:
 *  - 2 件目以降は interrupt: false で渡す。true(既定)のままだと次の発話が
 *    前の発話を cancel してしまい、最後の 1 文しか聞こえない。
 *  - 1 件が失敗しても(ウォッチドッグ打ち切り含む)残りは流し続ける。
 *  - cancelAll() は待機中を全部捨て、再生中もその場で止める。
 */
export function useSpeechQueue(backend: SpeechBackend) {
  const queue: SpeechQueueItem[] = []
  const speaking = ref(false)
  /** 直近の drain で発生した最後のエラー(呼び出し側のユーザー通知用)。 */
  const lastError = ref<Error | null>(null)

  let draining: Promise<void> | null = null
  let drainId = 0

  function enqueue(text: string, options: SpeakOptions = {}): void {
    const trimmed = text.trim()
    if (!trimmed) return
    queue.push({ text: trimmed, options })
    startDrain()
  }

  function startDrain(): void {
    if (draining) return
    const id = ++drainId
    // finally のコールバックはマイクロタスクなので、draining への代入が必ず先に走る。
    draining = runDrain().finally(() => {
      if (drainId === id) draining = null
    })
  }

  async function runDrain(): Promise<void> {
    speaking.value = true
    lastError.value = null
    try {
      while (queue.length > 0) {
        const item = queue.shift()!
        try {
          // interrupt: false が肝。ここを既定の true にすると前の発話を潰す。
          await backend.speak(item.text, { ...item.options, interrupt: false })
        } catch (e) {
          // 1 文の失敗でターンごと落とさない。残りは読み上げ続ける。
          lastError.value = e instanceof Error ? e : new Error(String(e))
          console.warn('[speech-queue] 発話に失敗(残りは継続):', e)
        }
      }
    } finally {
      speaking.value = false
    }
  }

  /** 待機中を破棄し、再生中も即停止する。 */
  function cancelAll(): void {
    queue.length = 0
    backend.cancel()
  }

  /** 現在キューに積まれている(未再生の)件数。 */
  function pendingCount(): number {
    return queue.length
  }

  /** キューが空になる(= 全部喋り終わる / キャンセルされる)まで待つ。 */
  async function drained(): Promise<void> {
    while (draining) {
      await draining
    }
  }

  return { speaking, lastError, enqueue, cancelAll, drained, pendingCount }
}

export type SpeechQueue = ReturnType<typeof useSpeechQueue>

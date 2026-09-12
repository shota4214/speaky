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
 *  - **読み上げバックエンドの所有者はこのキューだけ**。割り込み再生をしたい
 *    呼び出し側は speakNow() を使う(backend.speak を直接叩かない)。
 *    理由は speakNow / cancelAll のコメントを参照。
 */
export function useSpeechQueue(backend: SpeechBackend) {
  const queue: SpeechQueueItem[] = []
  const speaking = ref(false)
  /** 直近の drain で発生した最後のエラー(呼び出し側のユーザー通知用)。 */
  const lastError = ref<Error | null>(null)

  let draining: Promise<void> | null = null
  /**
   * cancelAll() のたびに進む世代。再生中の 1 件が解決したあとに
   * 「その発話を始めた時点の世代」と突き合わせ、違っていればその drain は畳む。
   * バックエンドの cancel は再生中の speak() を **正常終了として** 解決するので、
   * この突き合わせが無いと「止めたのに次のセグメントを喋り出す」ことになる。
   */
  let cancelEpoch = 0

  function enqueue(text: string, options: SpeakOptions = {}): void {
    const trimmed = text.trim()
    if (!trimmed) return
    queue.push({ text: trimmed, options })
    startDrain()
  }

  function startDrain(): void {
    if (draining) return
    // finally のコールバックはマイクロタスクなので、draining への代入が必ず先に走る。
    draining = runDrain().finally(() => {
      draining = null
      // cancelAll の直後に積み直された(= speakNow)ぶんは、畳んだ drain では
      // 処理されない。ここで拾い直さないとキューに残ったまま誰も喋らない。
      if (queue.length > 0) startDrain()
    })
  }

  async function runDrain(): Promise<void> {
    speaking.value = true
    // ⚠️ ここで lastError を消してはいけない。ストリーミング経路では
    // 生成が読み上げより遅いとキューが文と文の間で一度空になり、次の文で
    // 新しい drain が始まる。drain 開始時に消すと、その前に起きた発話失敗が
    // ターン終了時には残っておらず、ユーザーに通知できない。
    // 消す責任は呼び出し側(ターンの開始 = resetError)だけが持つ。
    try {
      while (queue.length > 0) {
        const item = queue.shift()!
        const epochAtStart = cancelEpoch
        try {
          // interrupt: false が肝。ここを既定の true にすると前の発話を潰す。
          await backend.speak(item.text, { ...item.options, interrupt: false })
        } catch (e) {
          // 1 文の失敗でターンごと落とさない。残りは読み上げ続ける。
          lastError.value = e instanceof Error ? e : new Error(String(e))
          console.warn('[speech-queue] 発話に失敗(残りは継続):', e)
        }
        // 自分が喋っている間にキャンセルが入っていた。この drain は続けない。
        if (cancelEpoch !== epochAtStart) break
      }
    } finally {
      speaking.value = false
    }
  }

  /** 直近の発話失敗を忘れる(ターンの開始時に呼ぶ)。 */
  function resetError(): void {
    lastError.value = null
  }

  /**
   * 待機中を破棄し、再生中も即停止する。
   * ⚠️ lastError はここでも消さない。stop() は cancelAll を呼ぶので、
   * ここで消すと「最後のターンの読み上げ失敗」が通知される前に消えてしまう。
   * 消す責任はターンの開始(resetError)だけが持つ。
   */
  function cancelAll(): void {
    queue.length = 0
    cancelEpoch += 1
    backend.cancel()
  }

  /**
   * 今流れているものを全部捨てて、このテキストだけを読む(「もう一度聞く」用)。
   *
   * これを用意してあるのは、割り込み再生を backend.speak(interrupt:true) で
   * 直接やると **キューと二重再生になる**ため。バックエンドの cancel は
   * 再生中の speak() を正常終了として解決するので、キューは「1 文読み終わった」と
   * 解釈して次のセグメントを流し始め、割り込み再生と同時に鳴ってしまう。
   * 入口をここに一本化すれば、割り込みもキューの世代管理の下に入る。
   */
  function speakNow(text: string, options: SpeakOptions = {}): void {
    cancelAll()
    enqueue(text, options)
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

  return { speaking, lastError, resetError, enqueue, speakNow, cancelAll, drained, pendingCount }
}

export type SpeechQueue = ReturnType<typeof useSpeechQueue>

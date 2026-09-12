import type { Response } from 'express'
import { OllamaError } from './ollama.js'

/**
 * クライアントの切断を AbortSignal に変換する。
 *
 * なぜ必要か:
 * Express はクライアントの切断をハンドラへ伝えてくれない。fetch を abort しても
 * 止まるのは「ブラウザ → backend」の HTTP だけで、backend → Ollama の生成は
 * 走り続ける。NUM_PARALLEL=1 の設定では、会話終了直後に走る要約 / 事実抽出が
 * その「ゾンビ生成」の後ろに並ぶため、**会話を終える操作がむしろ遅くなる**。
 * ここで作った signal を chatWithOllama に渡して初めて、Ollama へのソケットが
 * 閉じて生成が止まる。
 *
 * ⚠️ `req.on('close')` ではなく **`res.on('close')`** を使う。
 * express.json() がボディを読み切った時点で `req` は完了扱いになり、
 * リクエスト直後に `req` の 'close' が発火してしまう(= 全ターンが即 abort する)。
 * 切断の観測点はレスポンス側にしかない。
 *
 * 正常終了後に close が来ても発火しないよう、ハンドラの finally で dispose して
 * リスナーを外す(dispose はレスポンスの flush より前に走る)。
 */
export function watchClientAbort(res: Response): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController()
  let done = false
  const onClose = () => {
    if (done || res.writableFinished) return
    ctrl.abort()
  }
  res.on('close', onClose)
  return {
    signal: ctrl.signal,
    dispose: () => {
      done = true
      res.off('close', onClose)
    },
  }
}

/**
 * **クライアントが切ったこと**による失敗か。タイムアウトとは別物。
 *
 * 2 つの形を受ける:
 *  - `OllamaError('ABORTED')` … LLM 経路。`chatWithOllama` が自分のデッドラインで
 *    切ったのか外から切られたのかを区別して詰め替えている。
 *  - 名前が `AbortError` の例外 … 転写経路。whisper は Ollama を通らないので
 *    素の `AbortError` がそのまま上がってくる(`routes/transcribe.ts` の Deadline)。
 *
 * ⚠️ **判定には必ずそのリクエストの client signal を渡すこと**(第 2 引数)。
 * 名前が `AbortError` というだけで「中断」に倒すと、**将来**このルートが
 * 自前のデッドラインを持ったり(`AbortSignal.timeout()` は name が `TimeoutError` だが、
 * 自前の `AbortController` で締め切るなら `AbortError` になる)、abort で
 * 畳む子プロセスを持った瞬間に、**本物の失敗が静かに 499 になる** —
 * ユーザーにはエラーも出ず、ログにも何も残らない、いちばん見つけにくい形で。
 * いまは「この経路の abort は必ず詰め替わっている」から正しいだけで、
 * それはコードの構造ではなく偶然に支えられた正しさだった。
 * client signal が立っているときだけ中断と認めれば、内部由来の abort は
 * 通常のエラー経路(503 / 504 / 500)へ落ちる。
 *
 * この関数が false を返しても「タイムアウトだ」とは言っていない。
 * 呼び出し側は従来どおり TIMEOUT の分岐を続けて評価すること。
 */
export function isClientAbort(e: unknown, clientSignal: AbortSignal): boolean {
  // クライアントが切っていないなら、その abort は内部由来(= 障害)。
  if (!clientSignal.aborted) return false
  if (e instanceof OllamaError) return e.code === 'ABORTED'
  return (e as { name?: string } | null)?.name === 'AbortError'
}

/**
 * クライアントが切った後のレスポンス。返す相手はもういないので、
 * ユーザー向けエラー(503 + タイムアウト文言)は **絶対に出さない**。
 * ステータスだけ付けて静かに閉じる(499 = client closed request)。
 */
export function endAborted(res: Response): Response {
  if (res.headersSent) return res.end()
  return res.status(499).end()
}

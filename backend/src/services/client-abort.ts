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
 * 外部 abort(= クライアントが切った)による失敗か。タイムアウトとは別物。
 *
 * 2 つの形を受ける:
 *  - `OllamaError('ABORTED')` … LLM 経路。`chatWithOllama` が自分のデッドラインで
 *    切ったのか外から切られたのかを区別して詰め替えている。
 *  - 名前が `AbortError` の例外 … 転写経路。whisper は Ollama を通らないので
 *    素の `AbortError` がそのまま上がってくる(`routes/transcribe.ts` の Deadline)。
 *    ⚠️ LLM 経路で素の AbortError が漏れてくることは無い(必ず OllamaError に
 *    詰め替わる)ので、ここで名前を見てもタイムアウトを中断と誤認することはない。
 */
export function isAbortedError(e: unknown): boolean {
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

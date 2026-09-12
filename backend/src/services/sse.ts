import type { Response } from 'express'

/**
 * SSE(Server-Sent Events)の共通ヘルパ。
 *
 * routes/models.ts のダウンロード進捗と routes/chat.ts のトークンストリーミングで
 * 同じものを使う。会話ストリーミング用に、進捗 SSE には無かった 2 点を足してある:
 *
 *  1) **Nagle 無効化(setNoDelay)**
 *     1 トークンごとの SSE フレームは数十バイトしかないため、Nagle が効いていると
 *     カーネルが「もう少し溜めてから送る」と判断して 1 フレームあたり数十 ms 遅れる。
 *     トークン単位で見ると無視できる遅延だが、まさにこのステージで削りに来ている
 *     「最初の一文が聞こえるまでの時間」に直撃するので必ず切る。
 *  2) **レスポンスタイムアウトの無効化**
 *     Node の既定タイムアウトで、生成が長いターンの接続が切られるのを防ぐ。
 */
export function setupSSE(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  // 1 トークンごとの小さなフレームがカーネルにバッファされないようにする。
  res.socket?.setNoDelay(true)
  // 長い生成でレスポンスが勝手に切られないようにする(0 = 無効)。
  res.setTimeout?.(0)
  res.socket?.setTimeout(0)
  ;(res as Response & { flushHeaders?: () => void }).flushHeaders?.()
}

/** `data:` 行として JSON を 1 イベント送る。 */
export function sseSend(res: Response, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

/**
 * SSE コメント(`:` 行)を送る。クライアントの parseSSE は `data:` 行しか読まないので
 * イベントとしては観測されない。dev プロキシ等が「無通信」と判断して接続を切るのを
 * 防ぐためだけに使う keepalive。
 */
export function sseComment(res: Response, text = 'keepalive'): void {
  res.write(`: ${text}\n\n`)
}

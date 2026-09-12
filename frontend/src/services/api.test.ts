import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatStream } from './api'

/**
 * ストリーミング経路のクライアント側の締め切りのテスト。
 *
 * backend の予算(first-token 60〜90 秒 / ストール 15 秒)は backend が生きて
 * いれば効く。効かないのは「ソケットが半開きのまま死んだ」場合 —
 * スリープ復帰が典型で、read が永遠に返らずターンが固まる(UI は生成中のまま、
 * マイクは閉じたまま)。ここではその締め切りが働くことを固定する。
 */

const encoder = new TextEncoder()

interface FakeStream {
  push(text: string): void
  close(): void
  aborted: boolean
}

/** SSE を手で流せる fetch。signal が abort されたら read を失敗させる(実物と同じ)。 */
function makeStreamFetch(options: { holdHeaders?: boolean } = {}): {
  fetch: typeof fetch
  stream: Promise<FakeStream>
  sendHeaders: () => void
} {
  let settle: (s: FakeStream) => void = () => undefined
  const stream = new Promise<FakeStream>((resolve) => {
    settle = resolve
  })
  let releaseHeaders: () => void = () => undefined
  const headersReady = new Promise<void>((resolve) => {
    releaseHeaders = resolve
  })

  const fakeFetch = ((_url: unknown, init?: { signal?: AbortSignal }) => {
    const signal = init?.signal
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const handle: FakeStream = {
          aborted: false,
          push(text: string) {
            controller.enqueue(encoder.encode(text))
          },
          close() {
            controller.close()
          },
        }
        signal?.addEventListener(
          'abort',
          () => {
            handle.aborted = true
            controller.error(new Error('aborted'))
          },
          { once: true },
        )
        settle(handle)
      },
    })
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    // ヘッダーを返すまで待たせる(backend が Ollama の応答を待っている区間の再現)。
    return options.holdHeaders ? headersReady.then(() => response) : Promise.resolve(response)
  }) as unknown as typeof fetch

  return { fetch: fakeFetch, stream, sendHeaders: () => releaseHeaders() }
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('chatStream の無通信タイムアウト', () => {
  it('1 バイトも届かないまま時間が過ぎたらターンを打ち切る', async () => {
    const { fetch: fakeFetch, stream } = makeStreamFetch()
    vi.stubGlobal('fetch', fakeFetch)

    const handle = await chatStream('hello', {})
    const fake = await stream

    // 締め切り前は待ち続ける
    await vi.advanceTimersByTimeAsync(40_000)
    expect(fake.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.aborted).toBe(true)

    expect(await handle.done).toBeNull()
    const state = await handle.finished
    // TRUNCATED ではなく TIMEOUT。TRUNCATED だと呼び出し側が
    // 「変な出力をした」と解釈して締め切りの無い非ストリーミング経路で
    // やり直してしまい、同じ半開きソケットでまた固まる。
    expect(state.error?.code).toBe('TIMEOUT')
  })

  it('ヘッダーが返るまでの区間は長い予算で待つ(コールドロード・翻訳生成)', async () => {
    // backend は Ollama の応答を待っている間 1 バイトも書けない
    // (会話は最大 90 秒、翻訳ターンは最大 120 秒)。ここを 45 秒で切ると
    // 正常な生成を殺す。
    const { fetch: fakeFetch, stream, sendHeaders } = makeStreamFetch({ holdHeaders: true })
    vi.stubGlobal('fetch', fakeFetch)

    const handlePromise = chatStream('hello', {})
    const fake = await stream

    await vi.advanceTimersByTimeAsync(120_000)
    expect(fake.aborted).toBe(false)

    sendHeaders()
    const handle = await handlePromise

    // ヘッダーが返った後は短い締め切りに切り替わる
    await vi.advanceTimersByTimeAsync(46_000)
    expect(fake.aborted).toBe(true)
    const state = await handle.finished
    expect(state.error?.code).toBe('TIMEOUT')
  })

  it('受信があるたびに締め切りは延びる(keepalive コメントでも延びる)', async () => {
    const { fetch: fakeFetch, stream } = makeStreamFetch()
    vi.stubGlobal('fetch', fakeFetch)

    const handle = await chatStream('hello', {})
    const fake = await stream
    fake.push(sse({ type: 'meta', mode: 'normal', model: 'llama3.2:3b', speakDeltas: true }))

    // parseSSE はコメント行をイベントにしないが、受信としては数える
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(30_000)
      expect(fake.aborted).toBe(false)
      fake.push(': keepalive\n\n')
    }

    const text = 'Oh nice, where did you go last weekend?'
    fake.push(sse({ type: 'delta', text }))
    fake.push(sse({ type: 'done', text }))
    fake.close()

    expect(await handle.done).toEqual({ text, replyJa: null })
    const state = await handle.finished
    expect(state.error).toBeNull()
  })

  it('ストリームが閉じたらタイマーを残さない', async () => {
    const { fetch: fakeFetch, stream } = makeStreamFetch()
    vi.stubGlobal('fetch', fakeFetch)

    const handle = await chatStream('hello', {})
    const fake = await stream
    const text = 'That sounds like a lot of fun!'
    fake.push(sse({ type: 'done', text }))
    fake.close()

    await handle.finished
    expect(vi.getTimerCount()).toBe(0)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  chat,
  chatEnrich,
  chatOpening,
  chatStream,
  deleteOllamaModel,
  transcribeAudio,
} from './api'
import {
  BACKEND_WORST_CASE_MS,
  CHAT_ROUTE_WORST_CASE_MS,
  CLIENT_DEADLINE_MS,
  TRANSCRIBE_BUDGET_MS,
} from '../../../backend/src/shared/request-budget'

/** 締め切りの「ちょうど手前」と「ちょうど過ぎ」を作る。 */
const JUST_BEFORE = (deadline: number) => deadline - 1_000
const JUST_AFTER = 2_000

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

/**
 * 非ストリーミング経路の締め切り。
 *
 * ストリーミング経路には締め切りが入っていたが、フォールバックで通る
 * `POST /api/chat` / `/api/chat/opening` / `/api/chat/enrich` には無かった。
 * backend の予算は backend が生きていれば効く。効かないのは半開きソケット
 * (スリープ復帰)で、その場合ターンは応答も失敗もしないまま止まり、
 * UI は「Thinking...」のまま・マイクは閉じたままになる。
 */
describe('非ストリーミング経路の締め切り', () => {
  /** 永遠に応答しない fetch。渡された signal でだけ AbortError になる。 */
  function hangingFetch(): { fetch: typeof fetch; aborted: () => boolean } {
    let wasAborted = false
    const fakeFetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const fail = () => {
          wasAborted = true
          const e = new Error('The operation was aborted')
          e.name = 'AbortError'
          reject(e)
        }
        if (!signal) return
        if (signal.aborted) fail()
        else signal.addEventListener('abort', fail, { once: true })
      })) as unknown as typeof fetch
    return { fetch: fakeFetch, aborted: () => wasAborted }
  }

  it('/api/chat は backend の最悪値を過ぎてから打ち切って TIMEOUT を返す', async () => {
    const { fetch: fakeFetch, aborted } = hangingFetch()
    vi.stubGlobal('fetch', fakeFetch)

    const promise = chat('hello', {}).catch((e: unknown) => e)

    // ⚠️ backend のリトライ梯子(最悪 240 秒)を **過ぎてから** でないと切らない。
    // v1.1.0 はここが 120 秒で、遅いだけの健全なターンを殺して通信エラーにし、
    // 会話ループの連続失敗カウンタ(3 回で停止)を積み上げていた。
    await vi.advanceTimersByTimeAsync(CHAT_ROUTE_WORST_CASE_MS)
    expect(aborted()).toBe(false)

    await vi.advanceTimersByTimeAsync(
      CLIENT_DEADLINE_MS.chat - CHAT_ROUTE_WORST_CASE_MS + JUST_AFTER,
    )
    const error = await promise
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('TIMEOUT')
    expect((error as ApiError).status).toBe(504)
  })

  it('/api/chat/opening にも同じ締め切りが効く', async () => {
    const { fetch: fakeFetch } = hangingFetch()
    vi.stubGlobal('fetch', fakeFetch)

    const promise = chatOpening({}).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(CLIENT_DEADLINE_MS.opening + JUST_AFTER)
    expect((await promise) as ApiError).toBeInstanceOf(ApiError)
  })

  it('/api/chat/enrich は会話ターンより短いが、enrich の梯子(120 秒)は必ず超える', async () => {
    // enrich は「日本語訳を再取得」ボタンの経路 = ユーザーが失敗を直に見る。
    // v1.1.0 は 90 秒で、backend の最悪値(enrich 60 + en→ja 補完 60)より短かった。
    expect(CLIENT_DEADLINE_MS.enrich).toBeGreaterThan(BACKEND_WORST_CASE_MS.enrich)
    expect(CLIENT_DEADLINE_MS.enrich).toBeLessThan(CLIENT_DEADLINE_MS.chat)

    const { fetch: fakeFetch, aborted } = hangingFetch()
    vi.stubGlobal('fetch', fakeFetch)

    const promise = chatEnrich('Hello there!', null, {}).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(JUST_BEFORE(CLIENT_DEADLINE_MS.enrich))
    expect(aborted()).toBe(false)

    await vi.advanceTimersByTimeAsync(JUST_AFTER)
    expect((await promise) as ApiError).toBeInstanceOf(ApiError)
  })

  /**
   * 転写は **毎ターン必ず通る唯一の経路**。v1.1.0 まではここだけ締め切りも
   * signal も無く、whisper が詰まると「認識中」のままマイクを閉じて
   * 二度と戻ってこなかった(会話を終わる以外に出口が無い)。
   */
  it('/api/transcribe は backend の転写予算を過ぎてから打ち切る', async () => {
    const { fetch: fakeFetch, aborted } = hangingFetch()
    vi.stubGlobal('fetch', fakeFetch)

    const promise = transcribeAudio(new Blob(['dummy']), { model: 'small' }).catch(
      (e: unknown) => e,
    )
    await vi.advanceTimersByTimeAsync(TRANSCRIBE_BUDGET_MS)
    expect(aborted()).toBe(false)

    await vi.advanceTimersByTimeAsync(
      CLIENT_DEADLINE_MS.transcribe - TRANSCRIBE_BUDGET_MS + JUST_AFTER,
    )
    const error = await promise
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('TIMEOUT')
  })

  it('/api/transcribe は呼び出し側の中断を AbortError のまま返す(会話終了)', async () => {
    const { fetch: fakeFetch } = hangingFetch()
    vi.stubGlobal('fetch', fakeFetch)

    const ctrl = new AbortController()
    const promise = transcribeAudio(new Blob(['dummy']), { signal: ctrl.signal }).catch(
      (e: unknown) => e,
    )
    ctrl.abort(new DOMException('conversation-stopped', 'AbortError'))

    const error = await promise
    expect(error).not.toBeInstanceOf(ApiError)
    expect((error as Error).name).toBe('AbortError')
  })

  /**
   * ⚠️ ここが肝。締め切り切れと「ユーザーが会話を終えた」はどちらも AbortError
   * なので、区別せずに ApiError へ変換すると **会話を終えただけ**が
   * 「応答がありませんでした」というエラー表示になる。
   */
  it('呼び出し側の中断は AbortError のまま返す(タイムアウトにしない)', async () => {
    const { fetch: fakeFetch } = hangingFetch()
    vi.stubGlobal('fetch', fakeFetch)

    const ctrl = new AbortController()
    const promise = chat('hello', {}, { signal: ctrl.signal }).catch((e: unknown) => e)
    ctrl.abort(new DOMException('conversation-stopped', 'AbortError'))

    const error = await promise
    expect(error).not.toBeInstanceOf(ApiError)
    expect((error as Error).name).toBe('AbortError')
  })

  it('成功したらタイマーを残さない', async () => {
    vi.stubGlobal('fetch', (() =>
      Promise.resolve(
        new Response(JSON.stringify({ reply_en: 'Hi!', reply_ja: 'やあ!' }), { status: 200 }),
      )) as unknown as typeof fetch)

    await chat('hello', {})
    expect(vi.getTimerCount()).toBe(0)
  })
})

/**
 * `fetch()` はヘッダーが返った時点で解決する。そこで締め切りを止めると
 * **本文の読み取りが無防備な区間**になり、半開きソケットが
 * 「ステータス行だけ届いて本文が来ない」形で起きたときにまた固まる。
 */
describe('非ストリーミング経路: 本文の読み取りも締め切りの内側', () => {
  /** ヘッダーだけ返して本文を永久に握ったままの fetch。 */
  function headersOnlyFetch(): typeof fetch {
    return ((_url: unknown, init?: { signal?: AbortSignal }) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener(
            'abort',
            () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          )
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    }) as unknown as typeof fetch
  }

  it('ヘッダーだけ返って本文が来ないときも締め切りが効く', async () => {
    vi.stubGlobal('fetch', headersOnlyFetch())
    const promise = chat('hello', {}).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(CLIENT_DEADLINE_MS.chat + JUST_AFTER)
    const error = await promise
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('TIMEOUT')
  })

  it('本文の読み取り中でも呼び出し側の中断が効く(会話終了でぶら下がらない)', async () => {
    vi.stubGlobal('fetch', headersOnlyFetch())
    const ctrl = new AbortController()
    const promise = chat('hello', {}, { signal: ctrl.signal }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1_000)
    ctrl.abort(new DOMException('conversation-stopped', 'AbortError'))
    const error = await promise
    expect(error).not.toBeInstanceOf(ApiError)
    expect((error as Error).name).toBe('AbortError')
  })

  /**
   * ⚠️ 締め切りで固まったターンにしびれを切らしたユーザーが「会話を終わる」を
   * 押す、という順序。`signal.aborted` だけを見ていると判定がひっくり返って、
   * 締め切り用の内部エラーがそのままユーザーに出る(ApiError でも AbortError
   * でもないので loop の isAbortError もすり抜ける)。先に起きた方を採る。
   */
  it('締め切り切れの後に会話を終えても TIMEOUT のまま', async () => {
    const { fetch: fakeFetch } = (() => {
      let reject: (e: unknown) => void = () => undefined
      const f = ((_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_res, rej) => {
          reject = rej
          init?.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          )
        })) as unknown as typeof fetch
      return { fetch: f }
    })()
    vi.stubGlobal('fetch', fakeFetch)

    const ctrl = new AbortController()
    const promise = chat('hello', {}, { signal: ctrl.signal }).catch((e: unknown) => e)
    // 先に締め切りが切れる
    await vi.advanceTimersByTimeAsync(CLIENT_DEADLINE_MS.chat + JUST_AFTER)
    // その後でユーザーが会話を終える
    ctrl.abort(new DOMException('conversation-stopped', 'AbortError'))

    const error = await promise
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('TIMEOUT')
  })
})

/**
 * 削除の保護は **backend にも効いていること**。
 *
 * backend はユーザーの設定を持っていないので、「いま使っているモデル」を
 * 申告しないと守れるのは backend の既定(= 同梱の 1B)だけになる。
 * 同梱を 1B に変えた v1.2.0 では、3B に乗り換えた人のサーバー側の保護が
 * そこで抜け落ちていた(残っていたのは画面の disabled だけ)。
 */
describe('deleteOllamaModel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(): { urls: string[] } {
    const urls: string[] = []
    const fakeFetch = ((url: unknown) => {
      const u = String(url)
      urls.push(u)
      const body = u.includes('/api/auth/admin-token')
        ? JSON.stringify({ token: 'test-token' })
        : JSON.stringify({ ok: true })
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
    }) as typeof fetch
    vi.stubGlobal('fetch', fakeFetch)
    return { urls }
  }

  it('使用中のモデル名を activeModel として送る', async () => {
    const { urls } = stubFetch()
    await deleteOllamaModel('llama3.2:1b', 'llama3.2:3b')
    const del = urls.find((u) => u.includes('/api/models/ollama/'))
    expect(del).toBe('/api/models/ollama/llama3.2%3A1b?activeModel=llama3.2%3A3b')
  })

  it('申告が無いときは従来どおりのパス(古い backend でも壊れない)', async () => {
    const { urls } = stubFetch()
    await deleteOllamaModel('gemma2:2b')
    const del = urls.find((u) => u.includes('/api/models/ollama/'))
    expect(del).toBe('/api/models/ollama/gemma2%3A2b')
  })
})

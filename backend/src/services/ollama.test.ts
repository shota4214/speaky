import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatWithOllama, OllamaError } from './ollama.js'

/**
 * 「中断」と「タイムアウト」の区別を固定するテスト。
 *
 * どちらも中身は同じ AbortError なので、区別する情報を自分で持っていないと
 * 一緒くたになる。実際、UI キャンセルを渡せるようにした瞬間に
 * 「ユーザーが会話を終えただけ」が TIMEOUT として記録され、ルートが
 * 503 +「Ollama 呼び出しがタイムアウトしました」を返す状態になっていた。
 */

/** 永遠に応答しない fetch。渡された signal でだけ AbortError になる。 */
function hangingFetch(): typeof fetch {
  return ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal
      const fail = () => {
        const e = new Error('The operation was aborted')
        e.name = 'AbortError'
        reject(e)
      }
      if (!signal) return
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })) as unknown as typeof fetch
}

const messages = [{ role: 'user' as const, content: 'hello' }]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chatWithOllama の中断', () => {
  it('外部 signal による中断は ABORTED(TIMEOUT ではない)', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const ctrl = new AbortController()
    const promise = chatWithOllama(messages, {
      firstTokenTimeoutMs: 60_000,
      signal: ctrl.signal,
    })
    ctrl.abort()

    const error = await promise.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OllamaError)
    expect((error as OllamaError).code).toBe('ABORTED')
  })

  it('呼ぶ前から中断済みの signal でも ABORTED', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const error = await chatWithOllama(messages, { signal: AbortSignal.abort() }).catch(
      (e: unknown) => e,
    )
    expect((error as OllamaError).code).toBe('ABORTED')
  })

  it('自前のデッドラインで切れた場合は TIMEOUT のまま', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const ctrl = new AbortController()
    const error = await chatWithOllama(messages, {
      firstTokenTimeoutMs: 20,
      signal: ctrl.signal,
    }).catch((e: unknown) => e)
    expect((error as OllamaError).code).toBe('TIMEOUT')
  })

  it('signal を渡さない従来の呼び出しは TIMEOUT のまま', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const error = await chatWithOllama(messages, { firstTokenTimeoutMs: 20 }).catch(
      (e: unknown) => e,
    )
    expect((error as OllamaError).code).toBe('TIMEOUT')
  })

  it('接続自体ができない場合は NOT_RUNNING', async () => {
    vi.stubGlobal('fetch', (() =>
      Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch)
    const error = await chatWithOllama(messages, { firstTokenTimeoutMs: 1_000 }).catch(
      (e: unknown) => e,
    )
    expect((error as OllamaError).code).toBe('NOT_RUNNING')
  })

  it('正常終了後は signal のリスナーを残さない(ターン中に積み上がらない)', async () => {
    vi.stubGlobal('fetch', (() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ message: { role: 'assistant', content: 'hi' } }),
      })) as unknown as typeof fetch)

    const ctrl = new AbortController()
    const removed: unknown[] = []
    const originalRemove = ctrl.signal.removeEventListener.bind(ctrl.signal)
    ctrl.signal.removeEventListener = ((type: string, listener: unknown, options?: unknown) => {
      removed.push(listener)
      return originalRemove(type, listener as EventListener, options as EventListenerOptions)
    }) as typeof ctrl.signal.removeEventListener

    const res = await chatWithOllama(messages, { signal: ctrl.signal })
    expect(res.message.content).toBe('hi')
    expect(removed).toHaveLength(1)
  })
})

describe('chatWithOllama の stop', () => {
  function captureBody(): { body?: { options: Record<string, unknown> } } {
    const box: { body?: { options: Record<string, unknown> } } = {}
    vi.stubGlobal('fetch', ((_url: unknown, init: { body: string }) => {
      box.body = JSON.parse(init.body)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ message: { role: 'assistant', content: 'hi' } }),
      })
    }) as unknown as typeof fetch)
    return box
  }

  it('stop を渡したら options.stop として送る', async () => {
    const box = captureBody()
    await chatWithOllama(messages, { stop: ['<en>', '\n\n'] })
    expect(box.body?.options.stop).toEqual(['<en>', '\n\n'])
  })

  it('渡さなければ送らない(会話経路の挙動は変えない)', async () => {
    const box = captureBody()
    await chatWithOllama(messages, {})
    expect(box.body?.options).not.toHaveProperty('stop')
  })
})

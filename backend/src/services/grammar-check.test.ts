import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildGrammarCheckMessages,
  checkGrammar,
  GRAMMAR_CHECK_ATTEMPTS,
  GRAMMAR_CHECK_SHOTS,
  GRAMMAR_CHECK_SYSTEM_PROMPT,
  grammarCheckSkipReason,
} from './grammar-check.js'

/**
 * 添削の LLM 呼び出し。**研究で測ったものと同じ呼び出しを投げている**ことを固定する。
 * プロンプト・例示・デコード設定のどれか 1 つでも変わると、測った数字
 * (正しい文を書き換えた 0/78、直せた誤り 49/62)はもう当てにならない。
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

interface CapturedRequest {
  body: {
    model: string
    messages: { role: string; content: string }[]
    stream: boolean
    format?: string
    options: Record<string, unknown>
  }
  signal: AbortSignal | undefined
}

/** リクエストを記録して、指定した本文を返す fetch。 */
function recordingFetch(content: string, captured: CapturedRequest[]): typeof fetch {
  return (async (_input: unknown, init?: { body?: string; signal?: AbortSignal }) => {
    captured.push({ body: JSON.parse(init?.body ?? '{}'), signal: init?.signal })
    return new Response(JSON.stringify({ message: { role: 'assistant', content } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

/** 永遠に応答しない fetch。渡された signal でだけ AbortError になる。 */
function hangingFetch(captured: CapturedRequest[]): typeof fetch {
  return ((_input: unknown, init?: { body?: string; signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      captured.push({ body: JSON.parse(init?.body ?? '{}'), signal: init?.signal })
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

describe('プロンプト(研究の V6 と一字一句同じ)', () => {
  it('システムプロンプト', () => {
    expect(GRAMMAR_CHECK_SYSTEM_PROMPT).toBe(
      'Fix the grammar of the English sentence inside <said></said>, spoken by a Japanese learner. Change as few words as possible. If it is already correct, repeat it unchanged. Output only the sentence.',
    )
  })

  it('8 往復の例示(SHOTS8_ECHO)', () => {
    expect(GRAMMAR_CHECK_SHOTS).toEqual([
      ['My mother like cooking.', 'My mother likes cooking.'],
      ["i'm gonna play soccer tomorrow", "i'm gonna play soccer tomorrow"],
      ['i watched tv with my son last night', 'i watched tv with my son last night'],
      ['He have a lot of friend.', 'He has a lot of friends.'],
      ["We've known each other since high school.", "We've known each other since high school."],
      ['i went to shopping in shinjuku yesterday', 'i went shopping in shinjuku yesterday'],
      ['Where did you stay in Nagoya?', 'Where did you stay in Nagoya?'],
      ['sounds good', 'sounds good'],
    ])
  })

  it('メッセージ列 = system + 例示 8 往復 + <said>発話</said>', () => {
    const messages = buildGrammarCheckMessages('My sister is nurse.')
    expect(messages).toHaveLength(1 + 8 * 2 + 1)
    expect(messages[0]).toEqual({ role: 'system', content: GRAMMAR_CHECK_SYSTEM_PROMPT })
    expect(messages[1]).toEqual({ role: 'user', content: '<said>My mother like cooking.</said>' })
    expect(messages[2]).toEqual({ role: 'assistant', content: 'My mother likes cooking.' })
    expect(messages.at(-1)).toEqual({ role: 'user', content: '<said>My sister is nurse.</said>' })
  })
})

describe('grammarCheckSkipReason(LLM を呼ぶ前の足切り)', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['sounds good', 'too-short'],
    ['私は学生です', 'non-latin'],
    ['I want to eat 寿司 tonight', 'non-latin'],
    [Array.from({ length: 26 }, () => 'word').join(' '), 'too-long'],
  ])('%s -> %s', (text, reason) => {
    expect(grammarCheckSkipReason(text)).toBe(reason)
  })

  it('3〜25 語の英語は見る', () => {
    expect(grammarCheckSkipReason('My sister is nurse.')).toBeNull()
    expect(grammarCheckSkipReason(Array.from({ length: 25 }, () => 'word').join(' '))).toBeNull()
  })
})

describe('checkGrammar', () => {
  it('研究と同じデコード設定で投げる(温度 0 / seed 0 / 60 トークン / stop / 繰り返しペナルティ 1.0)', async () => {
    const captured: CapturedRequest[] = []
    vi.stubGlobal('fetch', recordingFetch('My sister is a nurse.', captured))
    await checkGrammar({ userText: 'My sister is nurse.', model: 'qwen2.5:1.5b', numCtx: 4096 })
    expect(captured).toHaveLength(1)
    const { body } = captured[0]!
    expect(body.model).toBe('qwen2.5:1.5b')
    expect(body.stream).toBe(false)
    // プレーンテキスト(JSON を書かせない)
    expect(body.format).toBeUndefined()
    expect(body.options).toMatchObject({
      temperature: 0,
      seed: 0,
      num_predict: 60,
      num_ctx: 4096,
      top_p: 0.9,
      top_k: 40,
      // ⚠️ 既定の 1.1 だと「正しい文をそのまま写す」ことが罰される
      repeat_penalty: 1.0,
      stop: ['<said>', '</said>', '\n'],
    })
    expect(GRAMMAR_CHECK_ATTEMPTS).toHaveLength(1)
  })

  it('説明できる直しは表示用の添削になる', async () => {
    vi.stubGlobal('fetch', recordingFetch('My sister is a nurse.', []))
    const feedback = await checkGrammar({ userText: '  My sister is nurse. ' })
    expect(feedback).toEqual({
      user_said: 'My sister is nurse.',
      corrected: 'My sister is a nurse.',
      explanation: '数えられる名詞が 1 つのときは、「a nurse」のように前に「a」を付けます。',
    })
  })

  it('正しい文をそのまま返したら null', async () => {
    vi.stubGlobal('fetch', recordingFetch('I usually take the train to work.', []))
    expect(await checkGrammar({ userText: 'I usually take the train to work.' })).toBeNull()
  })

  it('言い換え(フィルタが捨てる)も、説明できない直しも null', async () => {
    vi.stubGlobal('fetch', recordingFetch('I love Japanese food.', []))
    expect(await checkGrammar({ userText: 'I like Japanese food.' })).toBeNull()
    vi.stubGlobal('fetch', recordingFetch('I play tennis every Sunday.', []))
    expect(await checkGrammar({ userText: 'I play the tennis every Sunday.' })).toBeNull()
  })

  it('空の出力は null(例外にしない)', async () => {
    vi.stubGlobal('fetch', recordingFetch('', []))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await checkGrammar({ userText: 'My sister is nurse.' })).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('Ollama に繋がらなくても null(例外にしない・警告ログだけ)', async () => {
    vi.stubGlobal('fetch', (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await checkGrammar({ userText: 'My sister is nurse.' })).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('足切りに当たる発話では LLM を呼ばない', async () => {
    const captured: CapturedRequest[] = []
    vi.stubGlobal('fetch', recordingFetch('x', captured))
    expect(await checkGrammar({ userText: 'sounds good' })).toBeNull()
    expect(await checkGrammar({ userText: '今日は寒いね' })).toBeNull()
    expect(await checkGrammar({ userText: null })).toBeNull()
    expect(captured).toHaveLength(0)
  })

  it('実行中に中断されたら Ollama へのリクエストも切り、null を返す(警告ログも出さない)', async () => {
    // 次のターンが始まるとクライアントがストリームを切る → その signal がここまで届き、
    // Ollama へのソケットを閉じる(1 枠を次のターンに譲る)。
    const captured: CapturedRequest[] = []
    vi.stubGlobal('fetch', hangingFetch(captured))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ctrl = new AbortController()
    const pending = checkGrammar({ userText: 'My sister is nurse.', signal: ctrl.signal })
    await Promise.resolve()
    expect(captured).toHaveLength(1)
    expect(captured[0]!.signal?.aborted).toBe(false)
    ctrl.abort()
    expect(await pending).toBeNull()
    expect(captured[0]!.signal?.aborted).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('最初から中断済みなら LLM を呼ばない', async () => {
    const captured: CapturedRequest[] = []
    vi.stubGlobal('fetch', recordingFetch('x', captured))
    expect(
      await checkGrammar({ userText: 'My sister is nurse.', signal: AbortSignal.abort() }),
    ).toBeNull()
    expect(captured).toHaveLength(0)
  })
})

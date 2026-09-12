import { describe, expect, it } from 'vitest'
import {
  finalizeChatStream,
  initialChatStreamState,
  looksLikeJsonScaffold,
  reduceChatStreamEvent,
  salvageReplyText,
  type ChatStreamEffect,
  type ChatStreamState,
} from './chat-stream-reducer'

/** イベント列を順に畳み込んで、最終 state と発生した effect を全部返す。 */
function run(
  events: unknown[],
  finalize = true,
): { state: ChatStreamState; effects: ChatStreamEffect[] } {
  let state = initialChatStreamState()
  const effects: ChatStreamEffect[] = []
  for (const event of events) {
    const result = reduceChatStreamEvent(state, event)
    state = result.state
    effects.push(...result.effects)
  }
  if (finalize) {
    const result = finalizeChatStream(state)
    state = result.state
    effects.push(...result.effects)
  }
  return { state, effects }
}

const meta = (speakDeltas = true) => ({
  type: 'meta',
  mode: 'normal',
  model: 'llama3.2:3b',
  speakDeltas,
})
const delta = (text: string) => ({ type: 'delta', text })

function spokenText(effects: ChatStreamEffect[]): string {
  return effects
    .filter((e): e is Extract<ChatStreamEffect, { type: 'speak' }> => e.type === 'speak')
    .map((e) => e.text)
    .join('')
}

describe('reduceChatStreamEvent', () => {
  it('累積した delta を漏れなく読み上げに回し、done で全文を確定する', () => {
    const full = 'Oh nice, that sounds fun. I went hiking last weekend too. Where did you go?'
    const events: unknown[] = [meta()]
    // 1 文字ずつ流しても結果が変わらないこと(ストリームの切れ目に依存しない)
    for (const ch of full) events.push(delta(ch))
    events.push({ type: 'done', text: full })

    const { state, effects } = run(events)
    expect(spokenText(effects)).toBe(full)
    expect(state.replyEn).toBe(full)
    expect(state.error).toBeNull()
    expect(effects.filter((e) => e.type === 'done')).toHaveLength(1)
  })

  it('最初の 30 文字が貯まるまでは 1 文字も読み上げに出さない', () => {
    const { effects } = run([meta(), delta('Hey there, how'), delta(' are')], false)
    expect(effects.filter((e) => e.type === 'speak')).toHaveLength(0)
  })

  it('30 文字に満たないまま done が来たら done 側でまとめて読み上げる', () => {
    const { state, effects } = run([
      meta(),
      delta('Sounds good!'),
      { type: 'done', text: 'Sounds good!' },
    ])
    expect(spokenText(effects)).toBe('Sounds good!')
    expect(state.replyEn).toBe('Sounds good!')
  })

  it('モデルが JSON を吐き始めたら一切読み上げず、done で英文を救出する', () => {
    const raw = '{"reply_en": "Oh nice, where did you go?", "reply_ja": "いいね"}'
    const events: unknown[] = [meta()]
    for (const ch of raw) events.push(delta(ch))
    events.push({ type: 'done', text: raw })

    const { state, effects } = run(events)
    // JSON の足場は 1 文字も読み上げていない
    expect(spokenText(effects)).toBe('Oh nice, where did you go?')
    expect(state.suppressed).toBe(true)
    expect(state.replyEn).toBe('Oh nice, where did you go?')
  })

  it('コードフェンスで包まれた出力も読み上げ前に剥がす', () => {
    const raw = '```\nOh nice, that sounds like a fun trip. Where did you go?\n```'
    const { state, effects } = run([meta(), delta(raw), { type: 'done', text: raw }])
    expect(spokenText(effects)).toBe('Oh nice, that sounds like a fun trip. Where did you go?')
    expect(state.replyEn).toBe('Oh nice, that sounds like a fun trip. Where did you go?')
  })

  it('救出できない JSON は error にする(読み上げない)', () => {
    const raw = '{"unexpected": "shape", "nothing": "usable here at all really"}'
    const { state, effects } = run([meta(), delta(raw), { type: 'done', text: raw }])
    expect(spokenText(effects)).toBe('')
    expect(state.error?.code).toBe('MALFORMED')
    expect(effects.some((e) => e.type === 'done')).toBe(false)
  })

  it('done が来ないままストリームが閉じたら TRUNCATED エラーにする', () => {
    const { state, effects } = run([meta(), delta('Oh nice, that sounds fun. I went hi')])
    expect(state.done).toBe(false)
    expect(state.error?.code).toBe('TRUNCATED')
    expect(effects.filter((e) => e.type === 'error')).toHaveLength(1)
  })

  it('error イベントをそのまま伝える', () => {
    const { state, effects } = run([
      meta(),
      { type: 'error', code: 'TIMEOUT', error: 'Ollama の生成が停止しました' },
    ])
    expect(state.error).toEqual({ code: 'TIMEOUT', message: 'Ollama の生成が停止しました' })
    expect(effects.filter((e) => e.type === 'error')).toHaveLength(1)
    // finalize が二重にエラーを足さないこと
    expect(effects.filter((e) => e.type === 'error')).toHaveLength(1)
  })

  it('done の後に届いた enrich を取り込む', () => {
    const full = 'Oh nice, that sounds fun. Where did you go exactly?'
    const { state, effects } = run([
      meta(),
      delta(full),
      { type: 'done', text: full },
      {
        type: 'enrich',
        replyJa: 'いいね、楽しそう。どこに行ったの?',
        feedback: { user_said: 'I go hiking', corrected: 'I went hiking', explanation: '過去形に' },
        vocabulary: [{ word: 'hiking', meaning: 'ハイキング', example: 'I went hiking.' }],
      },
    ])
    expect(state.enrich?.replyJa).toBe('いいね、楽しそう。どこに行ったの?')
    expect(state.enrich?.feedback?.corrected).toBe('I went hiking')
    expect(state.enrich?.vocabulary).toHaveLength(1)
    const order = effects.map((e) => e.type)
    expect(order.indexOf('enrich')).toBeGreaterThan(order.indexOf('done'))
  })

  it('enrich が来ないまま閉じてもエラーにしない', () => {
    const full = 'Oh nice, that sounds fun. Where did you go exactly?'
    const { state } = run([meta(), delta(full), { type: 'done', text: full }])
    expect(state.enrich).toBeNull()
    expect(state.error).toBeNull()
  })

  it('壊れた enrich は落とせるものだけ落として取り込む', () => {
    const full = 'Oh nice, that sounds fun. Where did you go exactly?'
    const { state } = run([
      meta(),
      delta(full),
      { type: 'done', text: full },
      { type: 'enrich', replyJa: 'いいね', feedback: { corrected: 'x' }, vocabulary: 'nope' },
    ])
    expect(state.enrich).toEqual({ replyJa: 'いいね', feedback: null, vocabulary: [] })
  })

  it('speakDeltas=false(日本語入力)は逐次読み上げせず、done で全文を 1 回だけ読む', () => {
    const text = 'I went to a movie with my friends over the weekend.'
    const { state, effects } = run([
      meta(false),
      delta('この delta は無視される'),
      { type: 'done', text, replyJa: '「...」と言えますよ' },
    ])
    const speaks = effects.filter((e) => e.type === 'speak')
    expect(speaks).toHaveLength(1)
    expect(spokenText(effects)).toBe(text)
    expect(state.replyJa).toBe('「...」と言えますよ')
  })

  it('未知の type と壊れたイベントは無視する', () => {
    const { state, effects } = run(
      [meta(), { type: 'future-thing', x: 1 }, 'nonsense', null],
      false,
    )
    expect(effects).toHaveLength(0)
    expect(state.raw).toBe('')
  })

  it('state を破壊しない(同じ state に 2 回適用しても結果が同じ)', () => {
    const base = reduceChatStreamEvent(initialChatStreamState(), meta()).state
    const a = reduceChatStreamEvent(base, delta('hello'))
    const b = reduceChatStreamEvent(base, delta('hello'))
    expect(base.raw).toBe('')
    expect(a.state.raw).toBe('hello')
    expect(b.state.raw).toBe('hello')
  })
})

describe('looksLikeJsonScaffold', () => {
  it('JSON / 配列 / コードフェンスの始まりを検出する', () => {
    expect(looksLikeJsonScaffold('{"reply_en"')).toBe(true)
    expect(looksLikeJsonScaffold('  \n```json')).toBe(true)
    expect(looksLikeJsonScaffold('["a"]')).toBe(true)
  })
  it('普通の英文は検出しない', () => {
    expect(looksLikeJsonScaffold('Oh nice, where did you go?')).toBe(false)
    expect(looksLikeJsonScaffold('"Really?" he said.')).toBe(false)
  })
})

describe('salvageReplyText', () => {
  it('完全な JSON から reply_en を取り出す', () => {
    expect(salvageReplyText('{"reply_en":"Hello there","reply_ja":"やあ"}')).toBe('Hello there')
  })
  it('途中で切れた JSON からも reply_en を取り出す', () => {
    expect(salvageReplyText('{"reply_en":"Hello there","reply_ja":"や')).toBe('Hello there')
  })
  it('救出できなければ null', () => {
    expect(salvageReplyText('{"reply_ja":"やあ"')).toBeNull()
  })
})

/**
 * 前置きの自然文 → JSON、という出力の扱い。
 *
 * 「先頭 30 文字が `{` で始まるか」だけを見ていた頃は、この形が素通りして
 * JSON をそのまま読み上げ・保存し、次のプロンプトにも食わせていた。
 */
describe('前置きの後に JSON を書き始める出力', () => {
  const preamble = 'Of course! Here is my reply to you.'
  const json = '{"reply_en": "Hi there, how are you doing?", "reply_ja": "やあ"}'

  it('デルタの途中で JSON に化けたら、そこから先は読み上げない', () => {
    const raw = `${preamble}\n\n${json}`
    const events: unknown[] = [meta()]
    for (const ch of raw) events.push(delta(ch))
    events.push({ type: 'done', text: raw })

    const { state, effects } = run(events)
    const spoken = spokenText(effects)
    expect(spoken).not.toContain('{')
    expect(spoken).not.toContain('reply_en')
    expect(state.suppressed).toBe(true)
    // 保存・履歴に渡るのは JSON ではなく英文だけ
    expect(state.replyEn).toBe('Hi there, how are you doing?')
  })

  it('デルタを 1 つも見ていなくても done の全文検査で捕まえる', () => {
    const raw = `${preamble}\n\n${json}`
    const { state, effects } = run([meta(), { type: 'done', text: raw }])
    expect(spokenText(effects)).toBe('Hi there, how are you doing?')
    expect(state.replyEn).toBe('Hi there, how are you doing?')
  })
})

describe('JSON 足場の判定が普通の返答を誤検出しないこと', () => {
  const legitimate = [
    'Oh nice, where did you go?',
    '"Really?" he said. That is a common reaction.',
    'He said "hello": that is a normal greeting in English.',
    'In math class we write {1, 2, 3} for a set of numbers.',
    'My meeting is at 9:00, so I said "sure" and went.',
    'You can say: I went hiking last weekend. That sounds natural!',
    'I use emoji like :) a lot when I text my friends.',
  ]

  it.each(legitimate)('「%s」は JSON 扱いしない', (text) => {
    expect(looksLikeJsonScaffold(text)).toBe(false)
  })

  it('普通の返答はそのまま全文が読み上げられる', () => {
    const full =
      'He said "hello": that is a normal greeting. You can reply with "hi" or "hey" too, you know.'
    const events: unknown[] = [meta()]
    for (const ch of full) events.push(delta(ch))
    events.push({ type: 'done', text: full })
    const { state, effects } = run(events)
    expect(spokenText(effects)).toBe(full)
    expect(state.suppressed).toBe(false)
    expect(state.error).toBeNull()
  })

  it('波括弧を含むだけの普通の返答は、止めた後にちゃんと全部読み上げる', () => {
    const full = 'In math class we write {1, 2, 3} for a set of numbers, and that is useful.'
    const events: unknown[] = [meta()]
    for (const ch of full) events.push(delta(ch))
    events.push({ type: 'done', text: full })
    const { state, effects } = run(events)
    expect(spokenText(effects)).toBe(full)
    expect(state.suppressed).toBe(false)
  })

  it('先頭以外に現れた JSON の足場も検出する', () => {
    expect(looksLikeJsonScaffold('Sure!\n\n{"reply_en": "hi"}')).toBe(true)
    expect(looksLikeJsonScaffold('Here you go:\n```json\n{}\n```')).toBe(true)
    expect(looksLikeJsonScaffold('items: [ {"word": "x"} ]')).toBe(true)
    expect(looksLikeJsonScaffold('the key "reply_ja": comes later')).toBe(true)
  })
})

describe('終端イベントの冪等性', () => {
  const full = 'Oh nice, that sounds fun. Where did you go exactly?'

  it('done が 2 回来ても 1 回しか確定させない(二重読み上げ・二重保存を防ぐ)', () => {
    const { state, effects } = run([
      meta(),
      delta(full),
      { type: 'done', text: full },
      { type: 'done', text: full },
    ])
    expect(effects.filter((e) => e.type === 'done')).toHaveLength(1)
    expect(spokenText(effects)).toBe(full)
    expect(state.replyEn).toBe(full)
  })

  it('成功した後に届いた error は無視する(生成中のまま残る泡を作らない)', () => {
    const { state, effects } = run([
      meta(),
      delta(full),
      { type: 'done', text: full },
      { type: 'error', code: 'TIMEOUT', error: 'too slow' },
    ])
    expect(effects.filter((e) => e.type === 'error')).toHaveLength(0)
    expect(state.error).toBeNull()
    expect(state.replyEn).toBe(full)
  })

  it('error の後に届いた done / delta は無視する', () => {
    const { state, effects } = run([
      meta(),
      { type: 'error', code: 'TIMEOUT', error: 'too slow' },
      delta(full),
      { type: 'done', text: full },
    ])
    expect(effects.filter((e) => e.type === 'done')).toHaveLength(0)
    expect(spokenText(effects)).toBe('')
    expect(state.error?.code).toBe('TIMEOUT')
  })
})

describe('日本語訳が空の enrich', () => {
  const full = 'Oh nice, that sounds fun. Where did you go exactly?'

  it('成功として扱わない(準備中を解除させない)', () => {
    const { state, effects } = run([
      meta(),
      delta(full),
      { type: 'done', text: full },
      { type: 'enrich', replyJa: '', feedback: null, vocabulary: [] },
    ])
    expect(effects.filter((e) => e.type === 'enrich')).toHaveLength(0)
    expect(state.enrich).toBeNull()
  })

  it('空白だけの日本語訳も同じ', () => {
    const { effects } = run([
      meta(),
      delta(full),
      { type: 'done', text: full },
      { type: 'enrich', replyJa: '   ', feedback: null, vocabulary: [] },
    ])
    expect(effects.filter((e) => e.type === 'enrich')).toHaveLength(0)
  })
})

describe('salvageReplyText の前置き救出', () => {
  it('reply_en が無い JSON でも、その手前に書かれた自然文を拾う', () => {
    expect(salvageReplyText('Sure, here you go!\n\n{"text": "nope"}')).toBe('Sure, here you go!')
  })
  it('前置きが短すぎる場合は拾わない', () => {
    expect(salvageReplyText('ok\n{"text": "nope"}')).toBeNull()
  })
})

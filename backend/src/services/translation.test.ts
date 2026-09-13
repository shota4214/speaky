import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EN_TO_JA_ATTEMPTS,
  EN_TO_JA_FRESH_ATTEMPTS,
  EN_TO_JA_NUM_PREDICT,
  enToJaNumPredict,
  extractTranslationParagraphs,
  firstTranslationParagraph,
  isAcceptableEnglishRendering,
  TRANSLATION_ATTEMPTS,
  translateEnglishToJapanese,
  translateToNaturalEnglish,
} from './translation.js'
import { RETRY_SEED } from './ollama.js'

interface SentBody {
  messages: { role: string; content: string }[]
  format?: string
  options: { temperature: number; seed: number; stop?: string[]; num_predict?: number }
}

/** 返答を順に返す fetch のスタブ。送られた body を記録する。 */
function stubOllama(replies: string[]): SentBody[] {
  const sent: SentBody[] = []
  vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as SentBody)
    const content = replies[Math.min(sent.length - 1, replies.length - 1)]
    return new Response(JSON.stringify({ message: { role: 'assistant', content } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return sent
}

/**
 * 応答ごとに content / done_reason を指定できる fetch のスタブ。
 * `'timeout'` はデッドラインで切れた fetch(AbortError)として振る舞う。
 */
function stubOllamaResponses(
  replies: ({ content: string; done_reason?: string } | 'timeout')[],
): SentBody[] {
  const sent: SentBody[] = []
  vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as SentBody)
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)]!
    if (reply === 'timeout') throw new DOMException('The operation was aborted.', 'AbortError')
    return new Response(
      JSON.stringify({
        message: { role: 'assistant', content: reply.content },
        done: true,
        ...(reply.done_reason !== undefined && { done_reason: reply.done_reason }),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('translateEnglishToJapanese', () => {
  it('区切りタグ + 1 行指示 + 過去ターンの例 2 往復 + 温度 0 + stop で頼む', async () => {
    const sent = stubOllama(['映画は楽しいね！どんな映画が好き？'])
    const ja = await translateEnglishToJapanese(
      'Movies are fun! 🎬 What kind of movies do you like?',
      {},
    )
    expect(ja).toBe('映画は楽しいね！どんな映画が好き？')
    expect(sent).toHaveLength(1)
    const body = sent[0]!
    expect(body.messages).toHaveLength(6)
    expect(body.messages[0]).toEqual({
      role: 'system',
      content:
        'Translate the English text inside <en></en> into natural Japanese. Output only the Japanese translation.',
    })
    expect(body.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ])
    // 絵文字は訳させない
    expect(body.messages[5]!.content).toBe(
      '<en>Movies are fun!  What kind of movies do you like?</en>',
    )
    expect(body.options.temperature).toBe(0)
    expect(body.options.stop).toEqual(['<en>', '</en>'])
    expect(body.format).toBeUndefined()
  })

  it('検証で弾いたら温度 0.3 + 固定 seed で 1 回だけ引き直す', async () => {
    const sent = stubOllama(['Konnichiwa, watashi wa Emma desu.', 'こんにちは、エマだよ！'])
    const ja = await translateEnglishToJapanese("Hi, I'm Emma!", {})
    expect(ja).toBe('こんにちは、エマだよ！')
    expect(sent).toHaveLength(2)
    expect(sent[1]!.options.temperature).toBe(0.3)
    expect(sent[1]!.options.seed).toBe(RETRY_SEED)
  })

  it('2 回とも使えなければ空文字(= 画面には何も出さず再取得ボタン)', async () => {
    const sent = stubOllama(['Nice to meet you too!', "kon'nichiwa"])
    expect(await translateEnglishToJapanese('Nice to meet you!', {})).toBe('')
    expect(sent).toHaveLength(EN_TO_JA_ATTEMPTS.length)
  })

  it('返事の続きを書き始めた長すぎる出力も弾く', async () => {
    stubOllama([
      'こんにちは！私はどうですか。日本人である人は、英語で日常生活をしているかもしれません。',
    ])
    expect(await translateEnglishToJapanese('Hi! How are you?', {})).toBe('')
  })

  it('再取得(fresh)では seed を固定せず温度も上げる(押すたびに同じ失敗を繰り返さない)', async () => {
    const sent = stubOllama(['Nice to meet you!', 'はじめまして！'])
    expect(await translateEnglishToJapanese('Nice to meet you!', { fresh: true })).toBe(
      'はじめまして！',
    )
    expect(sent.map((b) => b.options.temperature)).toEqual(
      EN_TO_JA_FRESH_ATTEMPTS.map((a) => a.temperature),
    )
    expect(sent.every((b) => b.options.seed !== RETRY_SEED)).toBe(true)
    expect(EN_TO_JA_FRESH_ATTEMPTS).toHaveLength(EN_TO_JA_ATTEMPTS.length)
  })

  it('出力が空行で始まっても空にしない(stop に "\\n\\n" を入れない)', async () => {
    const sent = stubOllama(['\n\n映画は楽しいね！どんな映画が好き？'])
    const ja = await translateEnglishToJapanese(
      'Movies are fun! What kind of movies do you like?',
      {},
    )
    expect(ja).toBe('映画は楽しいね！どんな映画が好き？')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.options.stop).not.toContain('\n\n')
  })

  it('2 段落目(返事の続き)は検証にも画面にも渡さない', async () => {
    // 2 段落目まで含めると英文の 0.9 倍を超えて too-long になる長さにしてある。
    // 1 段落目だけが検証に渡っていれば 1 回目で通る。
    const sent = stubOllama([
      'カレーはおいしいよね！辛くしたの？\n\n私も昨日カレーを作りました。とても辛くて、家族みんなで食べました。',
    ])
    const ja = await translateEnglishToJapanese('Curry is so good! Did you make it spicy?', {})
    expect(ja).toBe('カレーはおいしいよね！辛くしたの？')
    expect(sent).toHaveLength(1)
  })

  it('閉じタグの残骸は剥がす', async () => {
    stubOllama(['こんにちは！</en>'])
    expect(await translateEnglishToJapanese('Hello!', {})).toBe('こんにちは！')
  })
})

describe('translateToNaturalEnglish', () => {
  it('区切りタグ + 「答えるな」の 1 行指示 + 質問を含む例 2 往復 + 温度 0 + stop で頼む', async () => {
    const sent = stubOllama(['What is your hobby?'])
    expect(await translateToNaturalEnglish('あなたの趣味は何ですか？', {})).toBe(
      'What is your hobby?',
    )
    const body = sent[0]!
    expect(body.messages[0]!.content).toContain('Do not answer it.')
    expect(body.messages[4]).toEqual({ role: 'assistant', content: 'What is your favorite food?' })
    expect(body.messages[5]).toEqual({ role: 'user', content: '<ja>あなたの趣味は何ですか？</ja>' })
    expect(body.options.temperature).toBe(0)
    expect(body.options.stop).toEqual(['<ja>'])
  })

  it('日本語が残った出力は弾いて引き直す(梯子の本数は変えない)', async () => {
    const sent = stubOllama([
      'I like 料理, especially カレー.',
      'I like cooking, especially curry.',
    ])
    expect(await translateToNaturalEnglish('I like 料理, especially カレー', {})).toBe(
      'I like cooking, especially curry.',
    )
    expect(sent).toHaveLength(TRANSLATION_ATTEMPTS.length)
    expect(sent[1]!.options.seed).toBe(RETRY_SEED)
  })

  it('2 回とも使えなければ空文字(ルートが 502 を返す)', async () => {
    stubOllama(['趣味は読書です。'])
    expect(await translateToNaturalEnglish('My 趣味 is 読書', {})).toBe('')
  })

  it('出力が空行で始まっても空にしない', async () => {
    const sent = stubOllama(['\n\nI have a meeting in Tokyo next week.'])
    expect(await translateToNaturalEnglish('来週、東京で meeting があります', {})).toBe(
      'I have a meeting in Tokyo next week.',
    )
    expect(sent).toHaveLength(1)
  })

  it('2 段落目(質問への答え等)は捨てる', async () => {
    stubOllama(['What is your hobby?\n\nMy hobby is reading books.'])
    expect(await translateToNaturalEnglish('あなたの趣味は何ですか？', {})).toBe(
      'What is your hobby?',
    )
  })
})

describe('firstTranslationParagraph', () => {
  const enToJa = { direction: 'en-to-ja' } as const
  const jaToEn = { direction: 'ja-to-en' } as const

  it('先頭の空行を読み飛ばし、最初の段落だけを返す', () => {
    for (const opts of [enToJa, jaToEn]) {
      expect(firstTranslationParagraph('\n\n  \nこんにちは！\n\n私も元気です。', opts)).toBe(
        'こんにちは！',
      )
      expect(firstTranslationParagraph('こんにちは！\n \n私も元気です。\n\nまたね。', opts)).toBe(
        'こんにちは！',
      )
      expect(firstTranslationParagraph('\r\n\r\nこんにちは！\r\n\r\n続き', opts)).toBe(
        'こんにちは！',
      )
    }
  })

  it('段落の中の改行はそのまま(1 行目を拾うのは stripTranslationPreamble の仕事)', () => {
    expect(firstTranslationParagraph('一行目\n二行目\n\n続き', enToJa)).toBe('一行目\n二行目')
  })

  it('前置きだけの段落は訳ではないので読み飛ばす(その次の段落で打ち切る)', () => {
    expect(
      firstTranslationParagraph("Here's the translation:\n\nこんにちは！\n\n続き", enToJa),
    ).toBe('こんにちは！')
  })

  it('en→ja: かなも漢字も無い前置きの段落は読み飛ばす(本物の訳を捨てない)', () => {
    expect(firstTranslationParagraph('Sure!\n\nこんにちは！', enToJa)).toBe('こんにちは！')
    expect(
      firstTranslationParagraph('Here is the Japanese translation:\n\nこんにちは！', enToJa),
    ).toBe('こんにちは！')
  })

  it('コロンで終わる見出しの段落は、日本語でも読み飛ばす', () => {
    expect(firstTranslationParagraph('日本語訳：\n\nこんにちは！', enToJa)).toBe('こんにちは！')
    expect(firstTranslationParagraph('日本語訳:\n\nこんにちは！\n\n続き', enToJa)).toBe(
      'こんにちは！',
    )
    expect(
      firstTranslationParagraph('Here is the English sentence:\n\nI have a meeting.', jaToEn),
    ).toBe('I have a meeting.')
  })

  it('本物の日本語の段落は読み飛ばさない(2 段落目の返事の続きを訳にしない)', () => {
    expect(firstTranslationParagraph('いいね！\n\nそれで、次は何する？', enToJa)).toBe('いいね！')
    // 最後の段落はコロンで終わっていても見出しではない
    expect(firstTranslationParagraph('理由は次のとおり：', enToJa)).toBe('理由は次のとおり：')
    // 原文がコロンで終わるなら、コロンで終わる訳は本物
    expect(
      firstTranslationParagraph('いくつか案があるよ：\n\n続きの返事', {
        direction: 'en-to-ja',
        source: 'I have a few ideas:',
      }),
    ).toBe('いくつか案があるよ：')
  })

  it('en→ja で日本語の段落が 1 つも無ければ、最初の段落を返す(検証で弾かれる)', () => {
    expect(firstTranslationParagraph('Nice to meet you!\n\nHow are you?', enToJa)).toBe(
      'Nice to meet you!',
    )
  })

  it('空・空白だけなら空文字', () => {
    expect(firstTranslationParagraph('', enToJa)).toBe('')
    expect(firstTranslationParagraph('\n\n \n', jaToEn)).toBe('')
  })
})

describe('enToJaNumPredict(英文の長さから生成上限を決める)', () => {
  it('短い英文は下限 40', () => {
    expect(EN_TO_JA_NUM_PREDICT.floor).toBe(40)
    expect(enToJaNumPredict('Wow.')).toBe(40)
    expect(enToJaNumPredict('')).toBe(40)
    // 1.2 × 16 + 20 = 39.2 → 40(下限)/ 1.2 × 17 + 20 = 40.4 → 41
    expect(enToJaNumPredict('a'.repeat(16))).toBe(40)
    expect(enToJaNumPredict('a'.repeat(17))).toBe(41)
  })

  it('その間は ceil(文字数 × 1.2 + 20)', () => {
    const en = 'Curry is so good! Did you make it spicy?' // 40 文字
    expect(enToJaNumPredict(en)).toBe(68)
    expect(enToJaNumPredict('a'.repeat(100))).toBe(140)
    // 前後の空白は数えない
    expect(enToJaNumPredict(`  ${en}  `)).toBe(68)
  })

  it('長い英文は上限 400', () => {
    expect(EN_TO_JA_NUM_PREDICT.cap).toBe(400)
    // 1.2 × 316 + 20 = 399.2 → ceil で 400(上限ちょうど。上限が効くのはここから)
    // 1.2 × 317 + 20 = 400.4 → ceil で 401 → 上限で 400 に切る
    expect(enToJaNumPredict('a'.repeat(316))).toBe(400)
    expect(enToJaNumPredict('a'.repeat(317))).toBe(400)
    expect(enToJaNumPredict('a'.repeat(2000))).toBe(400)
  })

  it('検証が通す長さの訳(英文 × 0.9 文字、1 文字 1.3 トークン)は上限に収まる', () => {
    for (const n of [20, 50, 120, 250, 316]) {
      expect(enToJaNumPredict('a'.repeat(n))).toBeGreaterThanOrEqual(Math.ceil(n * 0.9 * 1.3))
    }
  })

  it('translateEnglishToJapanese は英文(絵文字を除いた後)の長さから num_predict を送る', async () => {
    const sent = stubOllama(['カレーはおいしいよね！辛くしたの？'])
    await translateEnglishToJapanese('Curry is so good! Did you make it spicy? 🍛', {})
    expect(sent[0]!.options.num_predict).toBe(
      enToJaNumPredict('Curry is so good! Did you make it spicy?'),
    )
  })
})

describe('translateEnglishToJapanese(前置きの段落)', () => {
  it.each([
    'Sure!\n\nこんにちは！',
    'Here is the Japanese translation:\n\nこんにちは！',
    '日本語訳：\n\nこんにちは！',
  ])('%j でも 1 回目で本物の訳を返す', async (raw) => {
    const sent = stubOllama([raw])
    expect(await translateEnglishToJapanese('Hello!', {})).toBe('こんにちは！')
    expect(sent).toHaveLength(1)
  })
})

describe('extractTranslationParagraphs / firstTranslationParagraph(前置きは先頭の段落だけ)', () => {
  it('en→ja: 先頭の段落が前置きでなければ、後ろの日本語の段落を拾わない(返事を訳にしない)', () => {
    expect(
      firstTranslationParagraph('Yes, I watched it last night!\n\nうん、昨日の夜見たよ！', {
        direction: 'en-to-ja',
        source: 'Did you watch it?',
      }),
    ).toBe('Yes, I watched it last night!')
  })

  it('en→ja: 原文をそのまま繰り返した段落は前置きではない(後ろの補足を訳にしない)', () => {
    expect(
      firstTranslationParagraph('OK!\n\n（そのまま「OK!」で通じます）', {
        direction: 'en-to-ja',
        source: 'OK!',
      }),
    ).toBe('OK!')
  })

  it('en→ja: 2 段落目以降の前置きは読み飛ばさない', () => {
    expect(
      firstTranslationParagraph('Hmm.\n\nSure!\n\nこんにちは！', {
        direction: 'en-to-ja',
        source: 'Hello!',
      }),
    ).toBe('Hmm.')
  })

  it('ja→en: 相づちだけの段落は訳でありうるので読み飛ばさない', () => {
    expect(
      firstTranslationParagraph('Sure!\n\nThat means yes.', {
        direction: 'ja-to-en',
        source: 'もちろん！',
      }),
    ).toBe('Sure!')
  })

  it('en→ja: 英文が複数の段落なら、訳も同じ数の段落までつなげる', () => {
    const source = 'Hi!\n\nHow are you today?'
    expect(
      extractTranslationParagraphs('やあ！\n\n今日の調子はどう？', {
        direction: 'en-to-ja',
        source,
      }),
    ).toEqual({ text: 'やあ！\n\n今日の調子はどう？', reachesEnd: true })
    // 前置きは読み飛ばし、3 段落目(返事の続き)は捨てる
    expect(
      extractTranslationParagraphs('Sure!\n\nやあ！\n\n今日の調子はどう？\n\n私は元気！', {
        direction: 'en-to-ja',
        source,
      }),
    ).toEqual({ text: 'やあ！\n\n今日の調子はどう？', reachesEnd: false })
    // 訳が 1 段落にまとまっていればそれだけ
    expect(
      firstTranslationParagraph('やあ！今日の調子はどう？', { direction: 'en-to-ja', source }),
    ).toBe('やあ！今日の調子はどう？')
  })

  it('原文の途中にコロンがあれば、コロンで終わる段落は訳の前半としてつなげる', () => {
    expect(
      firstTranslationParagraph('私のアドバイス：\n\nたくさん水を飲んでね。', {
        direction: 'en-to-ja',
        source: "Here's my tip: drink lots of water.",
      }),
    ).toBe('私のアドバイス：たくさん水を飲んでね。')
    expect(
      firstTranslationParagraph('My tip:\n\nDrink lots of water.', {
        direction: 'ja-to-en',
        source: '私のアドバイス：水をたくさん飲んで',
      }),
    ).toBe('My tip: Drink lots of water.')
  })

  it('原文にコロンがあっても、訳について述べる見出しは読み飛ばす', () => {
    expect(
      firstTranslationParagraph('日本語訳：\n\n私のアドバイス：たくさん水を飲んでね。', {
        direction: 'en-to-ja',
        source: "Here's my tip: drink lots of water.",
      }),
    ).toBe('私のアドバイス：たくさん水を飲んでね。')
  })

  it('ja→en: 原文がコロンで終わっても、見出しの段落は訳にしない', () => {
    expect(
      firstTranslationParagraph("Here's a natural way to say it:\n\nI want to say this:", {
        direction: 'ja-to-en',
        source: 'これを言いたい：',
      }),
    ).toBe('I want to say this:')
  })

  it('原文にコロンが無くても、長いコロン終わりの段落は見出しとみなさない', () => {
    // 41 文字以上(LEAD_IN_MAX_CHARS = 40 を超える)
    const long =
      '昨日の夜に友だちと駅前にできた新しいイタリアンのレストランへ行ったときの話をすると、こんな感じ：'
    expect(Array.from(long).length).toBeGreaterThan(40)
    expect(
      firstTranslationParagraph(`${long}\n\nとてもおいしかった。`, {
        direction: 'en-to-ja',
        source: 'Let me tell you about the new restaurant.',
      }),
    ).toBe(long)
  })

  it('reachesEnd: 使った段落が出力の最後の段落か', () => {
    const opts = { direction: 'en-to-ja', source: 'Hello!' } as const
    expect(extractTranslationParagraphs('こんにちは', opts).reachesEnd).toBe(true)
    expect(extractTranslationParagraphs('Sure!\n\nこんにちは', opts).reachesEnd).toBe(true)
    expect(extractTranslationParagraphs('こんにちは！\n\n私は', opts).reachesEnd).toBe(false)
  })
})

describe('translateEnglishToJapanese(レビュー指摘の失敗例)', () => {
  it.each([
    ['Did you watch it?', 'Yes, I watched it last night!\n\nうん、昨日の夜見たよ！'],
    ['OK!', 'OK!\n\n（そのまま「OK!」で通じます）'],
  ])('%j → %j は訳ではないので弾いて引き直す', async (en, raw) => {
    const sent = stubOllama([raw])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await translateEnglishToJapanese(en, {})).toBe('')
    expect(sent).toHaveLength(EN_TO_JA_ATTEMPTS.length)
  })

  it('英文に空行があっても、段落をそろえた訳を 1 回目で返す', async () => {
    const sent = stubOllama(['やあ！\n\n今日の調子はどう？'])
    expect(await translateEnglishToJapanese('Hi!\n\nHow are you today?', {})).toBe(
      'やあ！\n\n今日の調子はどう？',
    )
    expect(sent).toHaveLength(1)
  })

  it('英文が複数行なら、訳の行を 1 行目だけにしない', async () => {
    stubOllama(['いいね！\nどこに行ったの？'])
    expect(await translateEnglishToJapanese('Nice!\nWhere did you go?', {})).toBe(
      'いいね！\nどこに行ったの？',
    )
  })

  it('原文の途中のコロンで分かれた訳を、後半だけにしない', async () => {
    stubOllama(['私のアドバイス：\n\nたくさん水を飲んでね。'])
    expect(await translateEnglishToJapanese("Here's my tip: drink lots of water.", {})).toBe(
      '私のアドバイス：たくさん水を飲んでね。',
    )
  })
})

describe('translateEnglishToJapanese(生成上限 / タイムアウト)', () => {
  it("訳が done_reason='length' で切れていたら弾いて引き直し、ログに残す", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sent = stubOllamaResponses([
      { content: 'カレーはおいしいよね！辛く', done_reason: 'length' },
      { content: 'カレーはおいしいよね！辛くしたの？', done_reason: 'stop' },
    ])
    expect(await translateEnglishToJapanese('Curry is so good! Did you make it spicy?', {})).toBe(
      'カレーはおいしいよね！辛くしたの？',
    )
    expect(sent).toHaveLength(2)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('num_predict'))).toBe(true)
  })

  it('切れたのが訳の後ろの余談だけなら、訳は使う', async () => {
    const sent = stubOllamaResponses([
      { content: 'カレーはおいしいよね！辛くしたの？\n\n私も昨日カレーを', done_reason: 'length' },
    ])
    expect(await translateEnglishToJapanese('Curry is so good! Did you make it spicy?', {})).toBe(
      'カレーはおいしいよね！辛くしたの？',
    )
    expect(sent).toHaveLength(1)
  })

  it('1 回目がタイムアウトしても 2 回目を試す(梯子の本数は変わらない)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sent = stubOllamaResponses(['timeout', { content: 'こんにちは！', done_reason: 'stop' }])
    expect(await translateEnglishToJapanese('Hello!', {})).toBe('こんにちは！')
    expect(sent).toHaveLength(EN_TO_JA_ATTEMPTS.length)
  })

  it('2 回ともタイムアウトなら空文字(試行は梯子の本数まで)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sent = stubOllamaResponses(['timeout'])
    expect(await translateEnglishToJapanese('Hello!', {})).toBe('')
    expect(sent).toHaveLength(EN_TO_JA_ATTEMPTS.length)
  })

  it('Ollama が起動していなければ引き直さない', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      throw new TypeError('fetch failed')
    })
    expect(await translateEnglishToJapanese('Hello!', {})).toBe('')
    expect(calls).toBe(1)
  })

  it('中断は呼び出し元へ投げ返す', async () => {
    // 本物の fetch と同じく、中断済みの signal なら AbortError で失敗するスタブ
    vi.stubGlobal('fetch', async (_url: unknown, init: { signal?: AbortSignal }) => {
      if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: 'こんにちは！' } }),
      )
    })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      translateEnglishToJapanese('Hello!', { signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' })
  })
})

describe('isAcceptableEnglishRendering', () => {
  it('英字を含み、非ラテン文字体系が無いこと', () => {
    expect(isAcceptableEnglishRendering('I went to Montréal — it was fun!')).toBe(true)
    expect(isAcceptableEnglishRendering('I want to 旅行 to Kyoto.')).toBe(false)
    expect(isAcceptableEnglishRendering('...')).toBe(false)
  })
})

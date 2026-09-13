import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EN_TO_JA_ATTEMPTS,
  EN_TO_JA_FRESH_ATTEMPTS,
  EN_TO_JA_NUM_PREDICT,
  enToJaNumPredict,
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

afterEach(() => {
  vi.unstubAllGlobals()
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
    // 1.2 × 317 + 20 = 400.4 → 400(上限)
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

describe('isAcceptableEnglishRendering', () => {
  it('英字を含み、非ラテン文字体系が無いこと', () => {
    expect(isAcceptableEnglishRendering('I went to Montréal — it was fun!')).toBe(true)
    expect(isAcceptableEnglishRendering('I want to 旅行 to Kyoto.')).toBe(false)
    expect(isAcceptableEnglishRendering('...')).toBe(false)
  })
})

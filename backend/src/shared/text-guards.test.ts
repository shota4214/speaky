import { describe, expect, it } from 'vitest'
import {
  acceptJapaneseTranslation,
  containsNonLatinScript,
  JA_LENGTH_FLOOR,
  judgeJapaneseTranslation,
  sourceProperNouns,
  stripEmoji,
  stripEmojiLines,
  stripLoneSurrogates,
  type JapaneseTranslationVerdict,
} from './text-guards.js'

/**
 * 日本語訳の検証ルールの **較正を固定する** テスト。
 *
 * 下の 60 件は実モデル評価(llama3.2:1b / qwen2.5:1.5b / gemma3:1b / gemma2:2b /
 * llama3.2:3b × 同じ 12 文)で実際に出た en→ja 訳と、それを人が読んで付けた判定
 * (y = 意味が正しい / p = 部分的 / n = 間違い・ローマ字・返事になっている)。
 * 期待値は評価で使った validator_v2.py の判定そのもの。
 *
 * ルールを変えるとここが赤くなる。緩めるなら「n を通すようになった件数」、
 * 締めるなら「y / p を落とすようになった件数」を見て判断すること。
 * 現在の較正: y 22 件は全部通す / p 21 件のうち落とすのは 1 件(訳の後ろに
 * 括弧でローマ字を足したもの)/ n 17 件のうち 7 件を落とす
 * (残りの n はかな漢字で書かれた「間違った訳」で、文字だけでは見分けられない)。
 */
type Judged = [
  model: string,
  judged: 'y' | 'p' | 'n',
  verdict: JapaneseTranslationVerdict,
  en: string,
  ja: string,
]
const MANUAL_CASES: Judged[] = [
  [
    'llama3.2:1b',
    'n',
    'no-kana',
    "hi my name emma i'm doing great thanks for saying hi how was your morning? do u have a daily routine in japan?",
    "ohayou gozaimasu emma! nice to meet you back atcha. as for my morning, it's been pretty chill so far. i usually wake up around 7 am and head straight to the train station to catch the subway to work. yeah, i know, it's not exactly a relaxing routine but it gets me there on time. by the way, how was your morning?",
  ],
  ['llama3.2:1b', 'n', 'ok', 'Hi! What do you usually eat for breakfast?', 'お早めのご飯です。'],
  [
    'llama3.2:1b',
    'n',
    'ok',
    'That sounds like a busy morning. Do you like taking the train?',
    'お疲れさまです。 train にはどうですか。',
  ],
  [
    'llama3.2:1b',
    'p',
    'ok',
    'Movies are fun! What kind of movies do you like?',
    '動画が楽しいです。私が好きな映画はいつでもあるです。',
  ],
  [
    'llama3.2:1b',
    'n',
    'latin-heavy',
    'Oh, you went shopping. What vegetables did you buy?',
    'お店に行った。 carrot、tomato、lettuce etc.',
  ],
  [
    'llama3.2:1b',
    'n',
    'ok',
    "I'm sorry to hear that. Try to get some rest tonight.",
    'お迷惑です。夜に寝ることができないと疲れます。',
  ],
  [
    'llama3.2:1b',
    'n',
    'ok',
    'Curry is so good! Did you make it spicy?',
    'おいしいです。火を入れてみてください。',
  ],
  [
    'llama3.2:1b',
    'n',
    'ok',
    'Yes, I love sushi and ramen. What is your favorite food?',
    'たべるものが好きです。',
  ],
  [
    'llama3.2:1b',
    'n',
    'no-kana',
    'Nice to meet you, Shota! How long have you lived in Tokyo?',
    'Konnichiwa, watashi wa Tokyo ni ikimasu desu.',
  ],
  [
    'llama3.2:1b',
    'n',
    'no-kana',
    'I usually go for a walk in the park. Do you have any plans this weekend?',
    "kon'nichiwa desu ne. oishii desu ka?",
  ],
  [
    'llama3.2:1b',
    'n',
    'no-kana',
    'Kyoto is beautiful in the fall. Which temple did you visit?',
    'Kokoku ni arimasu ka wa koko ni arimasu.',
  ],
  ['llama3.2:1b', 'n', 'ok', 'No problem! I asked: what do you do in the morning?', 'お昼です。'],
  [
    'qwen2.5:1.5b',
    'p',
    'ok',
    "hi my name emma i'm doing great thanks for saying hi how was your morning? do u have a daily routine in japan?",
    'こんにちは、エミです。元気です。おはようございますか？日本では一日のスケジュールを何していますか？',
  ],
  [
    'qwen2.5:1.5b',
    'y',
    'ok',
    'Hi! What do you usually eat for breakfast?',
    'こんにちは！朝食は何をよく食べますか？',
  ],
  [
    'qwen2.5:1.5b',
    'y',
    'ok',
    'That sounds like a busy morning. Do you like taking the train?',
    'それは忙しい朝ですね。列車に乗るのが好きですか？',
  ],
  [
    'qwen2.5:1.5b',
    'y',
    'ok',
    'Movies are fun! What kind of movies do you like?',
    '映画は面白い！何の映画が好きですか？',
  ],
  [
    'qwen2.5:1.5b',
    'y',
    'ok',
    'Oh, you went shopping. What vegetables did you buy?',
    '買い物に行きました。何の野菜を買いましたか？',
  ],
  [
    'qwen2.5:1.5b',
    'p',
    'ok',
    "I'm sorry to hear that. Try to get some rest tonight.",
    '申し訳ありません。 Tonightは充分に休息しましょう。',
  ],
  [
    'qwen2.5:1.5b',
    'y',
    'ok',
    'Curry is so good! Did you make it spicy?',
    'Curryは美味しい！ 辛さを加えましたか？',
  ],
  [
    'qwen2.5:1.5b',
    'y',
    'ok',
    'Yes, I love sushi and ramen. What is your favorite food?',
    'はい、私は寿司とラーメンが大好きです。あなたの好きな食べ物は何ですか？',
  ],
  [
    'qwen2.5:1.5b',
    'p',
    'ok',
    'Nice to meet you, Shota! How long have you lived in Tokyo?',
    'すみません、会っていただけて嬉しいです！ 東京に住んで何年いますか？',
  ],
  [
    'qwen2.5:1.5b',
    'y',
    'ok',
    'I usually go for a walk in the park. Do you have any plans this weekend?',
    '公園で散歩するのが好きです。この週末は何か予定がありますか？',
  ],
  [
    'qwen2.5:1.5b',
    'y',
    'ok',
    'Kyoto is beautiful in the fall. Which temple did you visit?',
    '京都の秋は美しいです。どの仏閣を訪れたでしょうか？',
  ],
  [
    'qwen2.5:1.5b',
    'p',
    'ok',
    'No problem! I asked: what do you do in the morning?',
    '何を朝にしますか？',
  ],
  [
    'gemma3:1b',
    'y',
    'ok',
    "hi my name emma i'm doing great thanks for saying hi how was your morning? do u have a daily routine in japan?",
    'やあ、私の名前エマだよ。元気だね、ありがとうね。朝は？日本での日々の生活ってどんな感じ？',
  ],
  ['gemma3:1b', 'y', 'ok', 'Hi! What do you usually eat for breakfast?', '朝ご飯は何を食べます？'],
  [
    'gemma3:1b',
    'y',
    'ok',
    'That sounds like a busy morning. Do you like taking the train?',
    '朝、ちょっと忙しいね。電車に乗るの好き？',
  ],
  [
    'gemma3:1b',
    'y',
    'ok',
    'Movies are fun! What kind of movies do you like?',
    '映画って楽しいよね！好きな映画はありますか？',
  ],
  [
    'gemma3:1b',
    'p',
    'ok',
    'Oh, you went shopping. What vegetables did you buy?',
    'それで何か買いにいく？　野菜は何を買ったの？',
  ],
  [
    'gemma3:1b',
    'p',
    'ok',
    "I'm sorry to hear that. Try to get some rest tonight.",
    '大丈夫だよ。今夜はゆっくり休んでね。',
  ],
  [
    'gemma3:1b',
    'y',
    'ok',
    'Curry is so good! Did you make it spicy?',
    'カレー、めっちゃ美味しいね！辛い感じある？',
  ],
  [
    'gemma3:1b',
    'p',
    'ok',
    'Yes, I love sushi and ramen. What is your favorite food?',
    'めっちゃ美味しいよね！寿司とかラーメン、好き？好きな食べ物ある？',
  ],
  [
    'gemma3:1b',
    'p',
    'ok',
    'Nice to meet you, Shota! How long have you lived in Tokyo?',
    'やあ、シャトー！東京にどれくらい住んできてる？',
  ],
  [
    'gemma3:1b',
    'p',
    'ok',
    'I usually go for a walk in the park. Do you have any plans this weekend?',
    'そうなんだ、週末に散歩に行く予定あるの？',
  ],
  [
    'gemma3:1b',
    'y',
    'ok',
    'Kyoto is beautiful in the fall. Which temple did you visit?',
    '京都は秋によく見えますね。どの寺院に行ったの？',
  ],
  [
    'gemma3:1b',
    'p',
    'latin-heavy',
    'No problem! I asked: what do you do in the morning?',
    'おはよう、何してるの？ (Ohayou, nani shiteru no?)',
  ],
  [
    'gemma2:2b',
    'y',
    'ok',
    "hi my name emma i'm doing great thanks for saying hi how was your morning? do u have a daily routine in japan?",
    'こんにちは、私はエマです。元気ですよ！ありがとう、こんにちは！朝はどうだった？日本での日課はありますか？',
  ],
  [
    'gemma2:2b',
    'p',
    'ok',
    'Hi! What do you usually eat for breakfast?',
    'おはよう！普段、朝食は何が好き？',
  ],
  [
    'gemma2:2b',
    'y',
    'ok',
    'That sounds like a busy morning. Do you like taking the train?',
    '忙しい朝ですね。電車が好きですか？',
  ],
  [
    'gemma2:2b',
    'y',
    'ok',
    'Movies are fun! What kind of movies do you like?',
    '映画は楽しい！どんな映画が好き？',
  ],
  [
    'gemma2:2b',
    'p',
    'ok',
    'Oh, you went shopping. What vegetables did you buy?',
    '買い物したよ。野菜は何を買った？',
  ],
  [
    'gemma2:2b',
    'p',
    'ok',
    "I'm sorry to hear that. Try to get some rest tonight.",
    '申し訳ありませんが、ゆっくり休んでね。',
  ],
  [
    'gemma2:2b',
    'y',
    'ok',
    'Curry is so good! Did you make it spicy?',
    'カレーが美味しい！辛いの？',
  ],
  [
    'gemma2:2b',
    'y',
    'ok',
    'Yes, I love sushi and ramen. What is your favorite food?',
    '寿司とラーメンが好きです。あなたは何が好き？',
  ],
  [
    'gemma2:2b',
    'p',
    'ok',
    'Nice to meet you, Shota! How long have you lived in Tokyo?',
    'はじめまして、翔太さん！東京でいつ住んでいるんですか？',
  ],
  [
    'gemma2:2b',
    'y',
    'ok',
    'I usually go for a walk in the park. Do you have any plans this weekend?',
    '公園で散歩するのが定番だよ。週末は何か予定ある？',
  ],
  [
    'gemma2:2b',
    'p',
    'ok',
    'Kyoto is beautiful in the fall. Which temple did you visit?',
    '京都は秋に綺麗だよ。どこに行ったの？',
  ],
  ['gemma2:2b', 'p', 'ok', 'No problem! I asked: what do you do in the morning?', '朝は何をする？'],
  [
    'llama3.2:3b',
    'n',
    'ok',
    "hi my name emma i'm doing great thanks for saying hi how was your morning? do u have a daily routine in japan?",
    'おはよう、僕の名前はたんです。朝はいつもとてもすばらしいです。日本では毎日同じルーチンを繰り返しますが、毎晩はお母さんから伝えられたお菓子を食べるのが好きです。',
  ],
  [
    'llama3.2:3b',
    'p',
    'ok',
    'Hi! What do you usually eat for breakfast?',
    'おはんに何を食べますか？',
  ],
  [
    'llama3.2:3b',
    'n',
    'ok',
    'That sounds like a busy morning. Do you like taking the train?',
    'はらさめをよく好きですか',
  ],
  [
    'llama3.2:3b',
    'y',
    'ok',
    'Movies are fun! What kind of movies do you like?',
    '映画を見るのが楽しい！あなたはどんな映画が好きですか？',
  ],
  [
    'llama3.2:3b',
    'n',
    'ok',
    'Oh, you went shopping. What vegetables did you buy?',
    '昨日はスーパーに行き、多くの野菜を買った',
  ],
  [
    'llama3.2:3b',
    'p',
    'ok',
    "I'm sorry to hear that. Try to get some rest tonight.",
    'お疲れさまでした。夜の間に休むことを試してください。',
  ],
  [
    'llama3.2:3b',
    'y',
    'ok',
    'Curry is so good! Did you make it spicy?',
    'カレーはとても美味しい！あなたはそれを辛いようにしたの?',
  ],
  [
    'llama3.2:3b',
    'p',
    'ok',
    'Yes, I love sushi and ramen. What is your favorite food?',
    'あなたの好きな食べ物はどれですか?',
  ],
  [
    'llama3.2:3b',
    'n',
    'ok',
    'Nice to meet you, Shota! How long have you lived in Tokyo?',
    'すきで、ショタ！東京に住む時間は？',
  ],
  [
    'llama3.2:3b',
    'p',
    'ok',
    'I usually go for a walk in the park. Do you have any plans this weekend?',
    '週末に一般的に散歩する公園に行きます。今年はどのような計画がありますか?',
  ],
  [
    'llama3.2:3b',
    'n',
    'disallowed-char',
    'Kyoto is beautiful in the fall. Which temple did you visit?',
    'Kyoto wa akari suru autumn no kōri wa, ogenki desu ka, miyajima no taisha ni ikimashita ka?',
  ],
  [
    'llama3.2:3b',
    'n',
    'no-kana',
    'No problem! I asked: what do you do in the morning?',
    'Anata wa ashi o tsukamu no wa nan desu ka?',
  ],
]

/** 評価の他の経路(挨拶・会話・JSON)で出た、各判定理由の実例。 */
const ROUTE_CASES: [where: string, verdict: JapaneseTranslationVerdict, en: string, ja: string][] =
  [
    [
      'gemma2:2b opening_stream',
      'ok',
      "Hi! What's something you do on a daily basis?",
      '毎日何かやってます？',
    ],
    [
      'gemma2:2b chat_stream',
      'disallowed-char',
      'Wow, that sounds nice! Did you like it there?  😊',
      '素敵だったね！ понравилось？ 😊',
    ],
    [
      'gemma2:2b chat_json',
      'latin-heavy',
      'Wow, that sounds yummy! Do you like cooking?',
      'えー、おいしそうな料理ですね！何か作るのが好きですか？」} </td>  </tr></tbody></table></div>   <script src=',
    ],
    ['gemma3:1b opening_json', 'no-kana', 'Hello! How are you?', '元気？'],
    ['llama3.2:1b opening_json', 'too-long', 'Hello!', 'どうすみます。 dailyは何日ですか?'],
  ]

describe('judgeJapaneseTranslation(評価データで較正)', () => {
  it.each(MANUAL_CASES)('%s [%s] → %s: %s', (_model, _judged, verdict, en, ja) => {
    expect(judgeJapaneseTranslation(ja, en)).toBe(verdict)
  })

  it.each(ROUTE_CASES)('%s → %s', (_where, verdict, en, ja) => {
    expect(judgeJapaneseTranslation(ja, en)).toBe(verdict)
  })

  it('較正の要約: 正しい訳は全部通し、部分的な訳を落とすのは 1 件だけ', () => {
    const tally = (j: 'y' | 'p' | 'n', accepted: boolean) =>
      MANUAL_CASES.filter(([, judged, v]) => judged === j && (v === 'ok') === accepted).length
    expect(tally('y', false)).toBe(0)
    expect(tally('p', false)).toBe(1)
    expect(tally('n', false)).toBe(7)
  })

  it('スクリーンショットの症状(英語 / ローマ字)を弾く', () => {
    const en = 'Hi! What do you usually eat for breakfast?'
    expect(judgeJapaneseTranslation('Konnichiwa, watashi wa asagohan desu.', en)).toBe('no-kana')
    expect(judgeJapaneseTranslation('I usually eat toast for breakfast.', en)).toBe('no-kana')
  })

  it('絵文字は先に取り除いてから判定する', () => {
    expect(judgeJapaneseTranslation('こんにちは！😊', 'Hi there! How are you?')).toBe('ok')
    expect(judgeJapaneseTranslation('😊', 'Hi!')).toBe('empty')
  })

  it('漢字だけ(中国語)・かなの比率が低いものは弾く', () => {
    expect(judgeJapaneseTranslation('你好吗今天怎么样', 'How are you today?')).toBe('no-kana')
    expect(
      judgeJapaneseTranslation(
        '東京都新宿区西新宿駅前広場の',
        'Tokyo station square in Shinjuku ward',
      ),
    ).toBe('kana-share')
  })

  it('長さの下限は 18 文字(短い英文の自然な訳を「長すぎる」にしない)', () => {
    expect(JA_LENGTH_FLOOR).toBe(18)
    expect(judgeJapaneseTranslation('こんにちは、元気ですか？', 'Hi!')).toBe('ok')
    expect(judgeJapaneseTranslation('こんにちは、元気ですか？今日は', 'Hi!')).toBe('ok')
    // 18 文字ちょうどは通し、19 文字は落とす
    expect(judgeJapaneseTranslation('あ'.repeat(18), 'Hi!')).toBe('ok')
    expect(judgeJapaneseTranslation('あ'.repeat(19), 'Hi!')).toBe('too-long')
    expect(
      judgeJapaneseTranslation('こんにちは、元気ですか？今日は何をしていましたか？', 'Hi!'),
    ).toBe('too-long')
  })

  it('短い相づちの自然な訳は通す(下限 12 だった頃は落としていた)', () => {
    // 13 文字。max(12, 0.9 × 4) = 12 を超えるので旧ルールでは too-long だった
    expect(judgeJapaneseTranslation('わあ、それはすごいですね！', 'Wow.')).toBe('ok')
    expect(judgeJapaneseTranslation('いいね！それは楽しそう！', 'Nice!')).toBe('ok')
  })

  it('長い英文では比率 0.9 が効く(返事の続きは落とす)', () => {
    const en = 'Curry is so good! Did you make it spicy?' // 40 文字 → 上限 36
    expect(judgeJapaneseTranslation('カレーは本当においしいよね！辛くしたの？', en)).toBe('ok')
    expect(
      judgeJapaneseTranslation(
        'カレーは本当においしいよね！辛くしたの？私も昨日カレーを作りました。とても楽しかったです。',
        en,
      ),
    ).toBe('too-long')
  })
})

describe('judgeJapaneseTranslation(JSON の残骸)', () => {
  it('英文に無い波括弧は壊れた JSON の残骸として落とす', () => {
    // 曲がった引用符で閉じられ、matchJsonStringField が JSON の続きまで拾った形
    expect(judgeJapaneseTranslation('こんにちは”},{', 'Hello!')).toBe('json-remnant')
    expect(judgeJapaneseTranslation('いいね！"}', 'Nice!')).toBe('json-remnant')
    expect(judgeJapaneseTranslation('{いいね！', 'Nice!')).toBe('json-remnant')
    // 全角の波括弧も NFKC で ASCII に寄るので同じく落ちる
    expect(judgeJapaneseTranslation('いいね！｝', 'Nice!')).toBe('json-remnant')
  })

  it('英文に波括弧があれば訳にあってもよい', () => {
    expect(judgeJapaneseTranslation('{A}さん、こんにちは！', 'Hi {A}!')).toBe('ok')
  })

  it('角括弧は見ない(「[笑]」は訳として普通にありうる)', () => {
    expect(judgeJapaneseTranslation('それは面白いね[笑]', "That's funny!")).toBe('ok')
  })

  it('acceptJapaneseTranslation も空文字を返す(= en→ja で訳し直す)', () => {
    expect(acceptJapaneseTranslation('こんにちは”},{', 'Hello!')).toBe('')
  })
})

describe('judgeJapaneseTranslation(2 段落目)', () => {
  it('空行を含む訳は落とす(訳の後ろに返事の続きを書いている)', () => {
    expect(judgeJapaneseTranslation('いいね！\n\nそれで、次は何する', 'Nice!')).toBe(
      'multi-paragraph',
    )
    expect(judgeJapaneseTranslation('いいね！\n  \nそれで', 'Nice!')).toBe('multi-paragraph')
    expect(judgeJapaneseTranslation('いいね！\r\n\r\nそれで', 'Nice!')).toBe('multi-paragraph')
  })

  it('段落の中の改行 1 つは落とさない', () => {
    expect(judgeJapaneseTranslation('いいね！\nどこに行ったの？', 'Nice! Where did you go?')).toBe(
      'ok',
    )
  })

  it('前後の空行は trim されるので落とさない', () => {
    expect(judgeJapaneseTranslation('\n\nいいね！\n\n', 'Nice!')).toBe('ok')
  })

  it('英文自体に空行があっても、空行を含む訳は落とす(英文は 1 段落にしてから訳すので例外にしない)', () => {
    const en = 'Hi!\n\nHow are you today?'
    expect(judgeJapaneseTranslation('やあ！\n\n今日の調子はどう？', en)).toBe('multi-paragraph')
    expect(
      judgeJapaneseTranslation('やあ！\r\n\r\n今日の調子はどう？', 'Hi!\r\n\r\nHow are you?'),
    ).toBe('multi-paragraph')
    expect(acceptJapaneseTranslation('やあ！\n\n今日の調子はどう？', en)).toBe('')
    // 英文の空行が絵文字だけの行の跡なら、英文に空行は無い扱い
    expect(judgeJapaneseTranslation('いいね！\n\nそれで', 'Nice!\n😊\nSo')).toBe('multi-paragraph')
  })

  it('絵文字だけの行を消した跡は空行にしない', () => {
    expect(judgeJapaneseTranslation('いいね！\n😊\nどう？', 'Nice! How is it?')).toBe('ok')
    expect(acceptJapaneseTranslation('いいね！\n😊\nどう？', 'Nice! How is it?')).toBe(
      'いいね！\nどう？',
    )
    // 本物の空行は絵文字があっても 2 段落目
    expect(judgeJapaneseTranslation('いいね！😊\n\nどう？', 'Nice! How is it?')).toBe(
      'multi-paragraph',
    )
  })
})

describe('judgeJapaneseTranslation(validator_v2 が落としていた正しい訳)', () => {
  it.each([
    ['See you at 3.', '３時に会いましょう。'],
    ["I'm 100% sure!", '１００％確信してる！'],
    ['Is your name Tanaka?', 'お名前は〇〇さんですか？'],
    ['He said it was fun.', '彼は“楽しい”と言った。'],
    ['Great; really.', 'すごいね；本当に。'],
    ['Well done! ⭐', 'よくできました！⭐'],
  ])('%s → %s', (en, ja) => {
    expect(judgeJapaneseTranslation(ja, en)).toBe('ok')
  })
})

describe('judgeJapaneseTranslation(英文の固有名詞はラテン文字のままでよい)', () => {
  it.each([
    ['Do you like Netflix?', 'Netflixは好き？'],
    ['I watched a new drama on Netflix yesterday.', '昨日Netflixで新しいドラマを見たよ'],
    ['Do you use an iPhone?', 'iPhoneを使ってる？'],
    ['Which do you like better, YouTube or Netflix?', 'YouTubeとNetflix、どっちが好き？'],
    ['Did you watch the NBA game?', 'NBAの試合を見た？'],
    // 大文字小文字を問わず、語全体で一致すればよい
    ['Do you like Netflix?', 'NETFLIXは好き？'],
  ])('%j → %j は通す', (en, ja) => {
    expect(judgeJapaneseTranslation(ja, en)).toBe('ok')
  })

  it('ローマ字の訳は、英文の固有名詞を含んでいても弾く', () => {
    expect(
      judgeJapaneseTranslation('Anata wa Netflix ga suki desu ka?', 'Do you like Netflix?'),
    ).not.toBe('ok')
  })

  it('原文の繰り返しは弾く(名前以外の語は数える)', () => {
    expect(
      judgeJapaneseTranslation('Do you like Netflix? Netflixは好き？', 'Do you like Netflix?'),
    ).toBe('latin-heavy')
    // 語のほとんどが名前の英文でも、名前ではない語と文頭の語は数える
    expect(
      judgeJapaneseTranslation('Netflix, YouTube, or Hulu? どれ？', 'Netflix, YouTube, or Hulu?'),
    ).toBe('latin-heavy')
    expect(
      judgeJapaneseTranslation(
        'I love Taylor Swift and Ed Sheeran. 大好き！',
        'I love Taylor Swift and Ed Sheeran.',
      ),
    ).toBe('latin-heavy')
  })

  it('英文に無いラテン文字の語は数える / 英文が分からなければ除外しない', () => {
    expect(judgeJapaneseTranslation('Huluは好き？', 'Do you like Netflix?')).toBe('latin-heavy')
    expect(judgeJapaneseTranslation('Netflixは好き？', '')).toBe('latin-heavy')
    // 英文にあっても一部だけ一致する語は数える(語全体で一致させる)
    expect(judgeJapaneseTranslation('Netflixerは好き？', 'Do you like Netflix?')).toBe(
      'latin-heavy',
    )
  })

  it('文頭の大文字の語・ストップリストの語は名前とみなさない', () => {
    expect(judgeJapaneseTranslation('Pizzaは最高！', 'Pizza is great. Do you like it?')).toBe(
      'latin-heavy',
    )
    expect(judgeJapaneseTranslation('Sushiは最高！', 'I agree. Sushi is great!')).toBe(
      'latin-heavy',
    )
    expect(judgeJapaneseTranslation('Mondayね！', 'See you on Monday!')).toBe('latin-heavy')
    expect(judgeJapaneseTranslation('OKだよ！', 'That is OK with me.')).toBe('latin-heavy')
  })

  it('sourceProperNouns', () => {
    expect(
      sourceProperNouns('Did you watch the NBA game on YouTube with Ken? I think so. OK!'),
    ).toEqual(new Set(['nba', 'youtube', 'ken']))
    expect(sourceProperNouns('Mr. Smith likes iPhone apps.')).toEqual(new Set(['iphone']))
    expect(sourceProperNouns('')).toEqual(new Set())
  })
})

describe('acceptJapaneseTranslation', () => {
  it('使える訳は絵文字と孤立サロゲートを落とした形で返す', () => {
    expect(acceptJapaneseTranslation(' 映画は楽しいね！😊 ', 'Movies are fun!')).toBe(
      '映画は楽しいね！',
    )
  })
  it('使えない訳は空文字(= 取得失敗として再取得ボタンに回る)', () => {
    expect(acceptJapaneseTranslation("kon'nichiwa desu ne", 'Hello there, how are you?')).toBe('')
    // 評価で素通りしていた孤立サロゲート入りの出力
    expect(acceptJapaneseTranslation('ごれ„浹 \udbdc', 'Oh nice, where did you go?')).toBe('')
  })
})

describe('stripEmoji / stripLoneSurrogates', () => {
  it('絵文字・異体字セレクタ・結合子・国旗を取り除く', () => {
    expect(stripEmoji('Nice! 😊👍🏽 ❤️ 👨‍👩‍👧 🇯🇵 done')).toBe('Nice!     done')
  })
  it('stripEmojiLines: 絵文字だけの行は行ごと消し、本物の空行と行内の空白は残す', () => {
    expect(stripEmojiLines('いいね！\n😊 👍\nどう？')).toBe('いいね！\nどう？')
    expect(stripEmojiLines('いいね！\n\nどう？')).toBe('いいね！\n\nどう？')
    expect(stripEmojiLines('Nice! 😊 done')).toBe('Nice!  done')
  })
  it('記号絵文字(⭐ ⏰ ⌛)も取り除く', () => {
    expect(stripEmoji('Good job ⭐ ⏰⌛!')).toBe('Good job  !')
  })
  it('普通の英文・日本語・記号は変えない', () => {
    const text = 'Café at 3:00 — €5, ¥500. 「いいね」！'
    expect(stripEmoji(text)).toBe(text)
  })
  it('対になっていないサロゲートだけを落とす(正しいペアは残す)', () => {
    expect(stripLoneSurrogates('a\ud83db\ude0ac😊')).toBe('abc😊')
  })
})

describe('containsNonLatinScript', () => {
  const bad = [
    'I love 寿司 and ramen.',
    'That is すごい!',
    'Nice to meet you, 翔太.',
    'Annyeong 안녕하세요!',
    'Привет, how are you?',
    'Sawasdee สวัสดี',
    'Namaste नमस्ते',
    'Shalom שלום',
    'Marhaba مرحبا',
    'Broken \ufffd text',
  ]
  it.each(bad)('非ラテン文字体系を検出する: %s', (text) => {
    expect(containsNonLatinScript(text)).toBe(true)
  })

  const good = [
    'José and Zoë went to a café in Montréal.',
    "That's a naïve question, but it's fine!",
    'It costs €5, £4, or ¥800.',
    'Well — I think so… “Really?” she said.',
    'The price is $3.50 (about 500 yen).',
    'Nice！Where did you go？',
  ]
  it.each(good)('正当な英文は通す: %s', (text) => {
    expect(containsNonLatinScript(text)).toBe(false)
  })
})

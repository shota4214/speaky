/**
 * 翻訳系の LLM 呼び出し(日本語/混在 → 英語、英語 → 日本語)。
 *
 * 非ストリーミング経路とストリーミング経路の両方から使うため routes から
 * services へ切り出した。**中身は routes/chat.ts にあった時点から変えていない。**
 */
import type { Level } from './conversation-prompt.js'
import { looksLikeJsonScaffold, matchJsonStringField } from './json-salvage.js'
import {
  chatWithOllama,
  OllamaError,
  RETRY_SEED,
  type OllamaChatMessage,
  type OllamaChatResponse,
} from './ollama.js'
import { OLLAMA_BUDGET_MS } from '../shared/request-budget.js'
import {
  acceptJapaneseTranslation,
  containsNonLatinScript,
  stripEmoji,
  stripEmojiLines,
  stripLoneSurrogates,
} from '../shared/text-guards.js'

/**
 * japanese_help / mixed モードは LLM のシステムプロンプトに「翻訳して」と書くだけでは
 * 小型モデル(Llama 3.2 3B 等)が会話継続に流れてしまうため、
 * バックエンドで専用の翻訳プロンプトに完全分離する。
 *
 * - 会話の system prompt と履歴は一切渡さない(会話継続の引力を断つ)
 * - 単一タスク「日本語/混在文を自然な英語に翻訳する」だけを LLM に依頼
 * - 出力 string をそのまま reply_en として返し、reply_ja はサーバー側で組み立てる
 */
/**
 * モデルが返す自然文の前置き(「Sure! Here's the translation: ...」「Translation: ...」
 * 「"..."」 等)を剥がして純粋な英文だけを残す。
 *
 * 順序が重要:
 *  1) 前置きを先に剥がす(同行 / 直後改行 どちらにも対応)
 *  2) 残りが複数行なら「最初の英語っぽい行」だけ採用する。
 *     ※ 末尾を拾うと "This is a natural way to say it." のような
 *     モデルの補足説明が翻訳結果として返ってしまうため、必ず先頭側を拾う。
 *  3) 全体を囲う引用符を剥がす
 */
export function stripTranslationPreamble(
  raw: string,
  /**
   * 'paired' は **開き・閉じの両方がそろっているときだけ** 全体を囲う引用符を剥がす
   * (日本語訳用。「「OK」は英語でもそのまま通じるよ」の先頭の 「 だけを剥がさない)。
   */
  quotes: 'either' | 'paired' = 'either',
): string {
  let out = raw.trim()

  // 1) 典型的な前置きパターン(同行末コロン + オプションの直後改行)を順に剥がす。
  //    "Sure" / "Of course" / "OK" 等の interjection は単独では削らない:
  //    「もちろん行くよ」→ "Sure, I'll go." の "Sure," まで削ってしまうため。
  //    後続に "Here's the translation" / "I'd translate that as" / "Translation:"
  //    などの明確な前置きが続く場合だけ、合わせて剥がす。
  const INTERJECTION_PREFIX = '(?:(?:Sure|Of course|Certainly|Got it|Okay|OK)[!.,]?\\s+)?'
  // 前置きと本文を分ける区切り文字を「必須」にする:
  //   - ASCII コロン `:` (U+003A) / 全角コロン `:` (U+FF1A)
  //   - 改行
  //   - 直後に引用符(本文を囲っているケース。引用符は step 3 で剥がす)
  //
  // optional にすると `Here's my sentence.` のような正しい翻訳本文を
  // `Here's my sentence` までマッチして `.` だけ残してしまうリスクがある。
  const SEPARATOR = '(?:\\s*[:：]\\s*|\\s*\\n|\\s+(?=["\'「『]))'
  const PREAMBLE_PATTERNS: RegExp[] = [
    new RegExp(
      `^\\s*${INTERJECTION_PREFIX}Here\\s*(?:'s|is|are|you go)\\s+(?:the\\s+|my\\s+|a\\s+)?(?:suggested\\s+|natural\\s+)?(?:translation|English(?:\\s+version)?|version|sentence)${SEPARATOR}`,
      'i',
    ),
    new RegExp(
      `^\\s*${INTERJECTION_PREFIX}I\\s*(?:'d|would)\\s+(?:translate\\s+(?:that|it)\\s+as|say|put\\s+(?:that|it))${SEPARATOR}`,
      'i',
    ),
    new RegExp(
      `^\\s*${INTERJECTION_PREFIX}(?:The\\s+)?(?:Output|Translation|English|Answer|Result|In\\s+English)${SEPARATOR}`,
      'i',
    ),
  ]
  for (const pat of PREAMBLE_PATTERNS) {
    out = out.replace(pat, '').trim()
  }

  // 2) 残りが複数行なら、明らかにメタ説明と分かる行(Note:, This sentence...,
  //    括弧書き 等)を除外したうえで先頭の行を採用する。
  //    ASCII 比率では "I'm 30." のような短く数字を含む正しい翻訳を弾いて
  //    後続の説明文を拾うリスクがあるため、比率は使わない。
  //    一方 "This is ..." / "It means ..." / "That means ..." は翻訳本文として
  //    自然に出るため META 判定から外す(`This sentence`/`This phrase` 等の
  //    明確に説明と分かる表現のみを除外する)。
  if (out.includes('\n')) {
    const lines = out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const line of lines) {
      if (!META_LINE_PATTERN.test(line)) {
        out = line
        break
      }
    }
  }

  // 3) 全体を囲う引用符/括弧を剥がす
  if (quotes === 'paired') return stripPairedQuotes(out)
  out = out.replace(/^["'「『]\s*|\s*["'」』]\s*$/g, '').trim()
  return out
}

/**
 * 明らかにメタ説明と分かる行(Note:, This sentence..., 括弧書き 等)。
 * ASCII 比率では "I'm 30." のような短く数字を含む正しい翻訳を弾いて
 * 後続の説明文を拾うリスクがあるため、比率は使わない。
 */
const META_LINE_PATTERN =
  /^(Note|Notice|Tip|Explanation|Translation note|This (?:sentence|phrase|expression|translation|wording)|In other words|\(|\*|—|–)/i

const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ['「', '」'],
  ['『', '』'],
]

/** 開き・閉じの引用符が両方そろって全体を囲っているときだけ剥がす(中に同じ引用符があれば剥がさない)。 */
function stripPairedQuotes(text: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length < 2 || !text.startsWith(open) || !text.endsWith(close)) continue
    const inner = text.slice(open.length, -close.length)
    if (!inner.includes(open) && !inner.includes(close)) return inner.trim()
  }
  return text
}

/** 行全体が括弧で囲まれている(「（カジュアルな言い方です）」)。全角は NFKC で ASCII に寄せてから見る。 */
const BRACKETED_LINE_RE = /^(?:\([^()]*\)|\[[^[\]]*\]|【[^【】]*】)$/

/** 末尾がコロン(「Here is the Japanese translation:」「日本語訳：」のような見出し)。 */
const ENDS_WITH_COLON_RE = /[:：]\s*$/

/**
 * コロンで終わる段落を「原文に無い見出し」とみなして読み飛ばす長さの上限(コードポイント数)。
 * 見出し(「Here is the Japanese translation:」33 文字)は短い。長い段落は訳の本文である。
 */
const LEAD_IN_MAX_CHARS = 40

/** en→ja で、訳の前に置かれる相づちだけの段落(「Sure!」「OK.」)。 */
const INTERJECTION_ONLY_RE =
  /^(?:sure|ok|okay|of course|certainly|got it|alright|all right|no problem|absolutely|here you go)\s*[!.。！]*$/i

/**
 * 訳について述べる見出し(末尾のコロンを除いた形で照合する)。
 * 「Here's a natural way to say it」「You could say」「Here is the Japanese translation」
 * 「In English」「日本語訳」など。**訳の本文には現れない言い回しに限る**
 * (「Here are some tips」のような普通の文は含めない)。
 */
const META_LEAD_IN_RE =
  /^(?:(?:sure|ok|okay|of course|certainly|got it|alright)[!.,]?\s+)?(?:here(?:'s|\s+is|\s+are)\b.*\b(?:translation|translated|english|japanese|version|sentence|phrase|way to say)\b|(?:you|we|i)\s+(?:could|can|would|might)\s+say\b|(?:a|one|the)\s+(?:more\s+)?(?:natural|simple|common|casual)\s+way\s+to\s+say\b|in\s+(?:english|japanese)\b|(?:the\s+)?(?:japanese\s+|english\s+)?translation\b)/i
const JA_HEADING_RE = /^(?:日本語訳|和訳|英訳|翻訳|訳文?|日本語|英語)(?:です|は)?$/

/** 空行で段落に分ける(空白だけの段落は捨てる)。 */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\r?\n[^\S\r\n]*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/** 原文にコロンがあるか(「3:30」のような時刻は数えない)。 */
function hasColon(source: string): boolean {
  return /[:：]/.test(source.replace(/\d\s*[:：]\s*\d/g, ''))
}

/** 比較用に、文字と数字だけを小文字で残す(「OK!」と「ok」を同じとみなす)。 */
function comparable(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * 先頭の段落が「訳の前置き」か。**先頭の段落(かつ後ろに段落がある)ときだけ** 呼ぶ。
 *
 *  - 原文をそのまま繰り返した段落(原文「OK!」→「OK!」)は前置きではない
 *    (読み飛ばすと後ろの補足「(そのまま通じます)」を訳として出してしまう)
 *  - 前置きだけの段落(stripTranslationPreamble で空になる「Here's the translation:」)
 *  - en→ja の相づちだけの段落(「Sure!」)。ja→en では相づちそのものが訳でありうるので見ない
 *  - 末尾がコロンで、訳について述べる見出し(「Here's a natural way to say it:」「日本語訳：」)。
 *    原文がコロンで終わっていても読み飛ばす(その訳もコロンで終わるので、見出しかどうかは
 *    言い回しでしか分からない)
 *  - それ以外の末尾がコロンの段落は、**原文にコロンが無く、しかも短い** ときだけ見出しとみなす。
 *    原文にコロンがあるなら、コロンで終わる段落は訳の一部である
 *    (「Here's my tip: drink lots of water.」→「私のアドバイス：\n\nたくさん水を飲んでね。」)
 */
function isLeadInParagraph(
  paragraph: string,
  direction: 'ja-to-en' | 'en-to-ja',
  source: string,
  following: readonly string[],
): boolean {
  const echo = comparable(paragraph)
  if (echo && echo === comparable(source)) {
    // en→ja で「Did you watch it?\n\n見た？」のように、原文を繰り返してから訳した出力は
    // 繰り返しを読み飛ばす(返すと no-kana で弾かれ、温度 0 の引き直しも同じ形になる)。
    // ただし後ろが **1 段落だけ** で、括弧書きで始まらず、原文の英単語を含まないときに限る。
    // 「OK!\n\n（そのまま「OK!」で通じます）」の補足は訳ではないので、繰り返しのまま返して弾く。
    return (
      direction === 'en-to-ja' &&
      following.length === 1 &&
      !OPENING_BRACKET_RE.test(following[0]!) &&
      !sharesEnglishWord(following[0]!, source)
    )
  }
  if (!stripTranslationPreamble(paragraph)) return true
  if (direction === 'en-to-ja' && INTERJECTION_ONLY_RE.test(paragraph)) return true
  if (!ENDS_WITH_COLON_RE.test(paragraph)) return false
  const heading = paragraph.replace(ENDS_WITH_COLON_RE, '').trim()
  if (META_LEAD_IN_RE.test(heading) || JA_HEADING_RE.test(heading)) return true
  return !hasColon(source) && Array.from(paragraph).length <= LEAD_IN_MAX_CHARS
}

export interface ExtractedTranslation {
  /** 訳として検証へ渡す文字列。 */
  text: string
  /**
   * 出力の最後の段落まで使ったか。生成上限(num_predict)で切れた出力では、
   * これが true のときだけ **訳そのものが切れている**(false なら切れたのは後ろの余談)。
   */
  reachesEnd: boolean
}

/**
 * 翻訳出力から **訳の部分** だけを取り出す(空行で区切られた後ろの段落は捨てる)。
 *
 * v1.2.0 直後の実装は stop に `'\n\n'` を入れて 2 段落目を生成させなかったが、
 * それだと **出力が空行で始まるモデルは 1 文字も出さずに止まる**。温度 0 では
 * 引き直しても同じなので、訳が永久に空になる。stop からは外し、ここで切る。
 *
 *  - 先頭の空行は読み飛ばす(これが直したい症状)
 *  - **先頭の段落が前置き**(isLeadInParagraph)なら、それだけを読み飛ばす。
 *    前置きの段落を返すと検証で弾かれ、後ろにあった本物の訳まで捨てる
 *    (「Sure!\n\nこんにちは！」が 1 回分の試行ごと無駄になる)
 *  - それ以外は **先頭の段落で打ち切る**。2 段落目以降は「返事の続き」や補足説明で、
 *    日本語で書かれていても訳ではない(原文「Did you watch it?」→
 *    「Yes, I watched it last night!\n\nうん、昨日の夜見たよ！」の 2 段落目は返事)。
 *    先頭の段落が訳でなければ検証で弾かれて引き直される。それでよい
 *  - 例外 1: en→ja で **英文自体が複数の段落** なら、訳も同じ数の段落までつなげて返す
 *    (「Hi!\n\nHow are you today?」→「やあ！\n\n今日の調子はどう？」の 1 段落目だけを返すと、
 *    半分だけの訳が検証を通って表示される)
 *  - 例外 2: 原文の途中にコロンがあり、先頭の段落がコロンで終わるなら、次の段落とつなげる
 *    (「私のアドバイス：」+「たくさん水を飲んでね。」)
 */
export function extractTranslationParagraphs(
  raw: string,
  options: { direction: 'ja-to-en' | 'en-to-ja'; source?: string },
): ExtractedTranslation {
  const paragraphs = splitParagraphs(raw)
  if (paragraphs.length === 0) return { text: '', reachesEnd: true }
  // 出力が空行で終わっている = 最後の段落は書き終わっていて、生成上限で切れたのは
  // その後ろの(空の)段落。訳が完結しているのに「切れた」と数えない。
  const openTail = !TRAILING_BLANK_LINE_RE.test(raw)
  const source = options.source ?? ''
  const start =
    paragraphs.length > 1 &&
    isLeadInParagraph(paragraphs[0]!, options.direction, source, paragraphs.slice(1))
      ? 1
      : 0
  const head = paragraphs[start]!

  const sourceParagraphs = splitParagraphs(source).length
  if (options.direction === 'en-to-ja' && sourceParagraphs > 1) {
    // 先頭の段落だけで英文全体の訳になっていれば、つなげない(後ろの段落はモデルの返事)。
    // 検証だけでは「やあ！」(英文 2 段落の前半だけの訳)も通るので、文の数も見る。
    if (passesJapaneseValidator(head, source) && sentenceCount(head) >= sourceParagraphs) {
      return { text: head, reachesEnd: start + 1 === paragraphs.length && openTail }
    }
    const end = Math.min(paragraphs.length, start + sourceParagraphs)
    return {
      text: paragraphs.slice(start, end).join('\n\n'),
      reachesEnd: end === paragraphs.length && openTail,
    }
  }

  const next = paragraphs[start + 1]
  const colonInMiddle = hasColon(source) && !ENDS_WITH_COLON_RE.test(source.trim())
  if (next !== undefined && ENDS_WITH_COLON_RE.test(head) && colonInMiddle) {
    return {
      text: head + (options.direction === 'en-to-ja' ? '' : ' ') + next,
      reachesEnd: start + 2 === paragraphs.length && openTail,
    }
  }
  return { text: head, reachesEnd: start + 1 === paragraphs.length && openTail }
}

/** 空行(= 次の段落の始まり)で終わっている。 */
const TRAILING_BLANK_LINE_RE = /\r?\n[^\S\r\n]*\r?\n\s*$/

/** 括弧書きの始まり(「（そのまま通じます）」「【補足】」)。 */
const OPENING_BRACKET_RE = /^[（(「『【［[]/

/** 原文の英単語を 1 つでも含むか(「そのまま OK で通じます」は原文「OK!」の補足)。 */
function sharesEnglishWord(text: string, source: string): boolean {
  const words = (s: string) =>
    s
      .normalize('NFKC')
      .toLowerCase()
      .match(/[a-z]+/g) ?? []
  const sourceWords = new Set(words(source))
  return words(text).some((w) => sourceWords.has(w))
}

/** 文の数(文末の約物か改行で区切る)。 */
function sentenceCount(text: string): number {
  return text.split(/[。！？!?]+|\n/).filter((s) => s.trim().length > 0).length
}

/** translateEnglishToJapanese と同じ整形をしたうえで、日本語訳の検証を通るか。 */
function passesJapaneseValidator(text: string, source: string): boolean {
  return (
    acceptJapaneseTranslation(
      stripTags(sanitizeJapaneseTranslation(text, source), 'en'),
      source,
    ) !== ''
  )
}

/** extractTranslationParagraphs の訳の部分だけを返す。 */
export function firstTranslationParagraph(
  raw: string,
  options: { direction: 'ja-to-en' | 'en-to-ja'; source?: string },
): string {
  return extractTranslationParagraphs(raw, options).text
}

/**
 * en→ja 翻訳の生成トークン数の上限(英文の長さから決める)。
 *
 * `'\n\n'` を stop から外したので、訳の後ろに書き続けるモデルは上限まで走る
 * (弾かれて引き直すと 2 回)。固定の 200 だと、短い英文では無駄に待たされ、
 * 標準プロファイルの 4〜5 文の返答では **訳が途中で切れて、切れたまま検証を通る**。
 *
 *   numPredict = clamp(ceil(英文の文字数 × 1.2 + 20), 40, 400)
 *
 *  - 係数 1.2: 検証(judgeJapaneseTranslation)が通す訳の長さは
 *    **英文の文字数 × 0.9 文字** まで(JA_LENGTH_RATIO)。日本語は同梱・推奨の
 *    トークナイザ(Qwen 2.5 / Llama 3.2 / Gemma 2)でおおむね 1 文字 1〜1.3 トークン
 *    (かなと常用漢字は 1 トークン、頻度の低い漢字はバイト単位で 2〜3 に割れる)。
 *    0.9 × 1.3 ≈ 1.2 なので、**検証を通りうる長さの訳は必ず最後まで書ける**。
 *    それより長い出力は書かせても too-long で捨てるだけなので、途中で止めてよい。
 *  - +20: 訳の前に置かれがちな前置き・空行(firstTranslationParagraph が読み飛ばす
 *    ぶん。「Here is the Japanese translation:」で 8 トークン前後)と、文末の
 *    絵文字や閉じタグの余白。
 *  - 下限 40: 検証の長さの下限は 18 文字(JA_LENGTH_FLOOR)で、短い相づち(「Wow.」)
 *    にもその長さの訳が許される。18 × 1.3 ≈ 24 トークン + 前置きの余白 = 40。
 *  - 上限 400: 1 回の試行の時間予算は OLLAMA_BUDGET_MS.translation(60 秒、
 *    shared/request-budget.ts)で、ここは生成トークン数ではなく時間で決まっている。
 *    8GB の M1 で 3B が 1 秒 10 トークン強なので、400 トークンなら
 *    プロンプト評価込みで予算に収まる。英文 316 文字(4〜5 文の返答)で上限に届く。
 *    それより長い英文は訳が切れうるが、返答の文数上限からまず起きない長さであり、
 *    切れた訳は Ollama の done_reason('length')で見分けて弾く(translateEnglishToJapanese)。
 */
export const EN_TO_JA_NUM_PREDICT = {
  perSourceChar: 1.2,
  margin: 20,
  floor: 40,
  cap: 400,
} as const

export function enToJaNumPredict(source: string): number {
  const { perSourceChar, margin, floor, cap } = EN_TO_JA_NUM_PREDICT
  const chars = Array.from(source.trim()).length
  return Math.min(cap, Math.max(floor, Math.ceil(chars * perSourceChar + margin)))
}

/**
 * ja→en(日本語 / 英日混在の学習者発話 → 言うべき英文)のプロンプト。
 *
 * v1.2.0 は「Input: … / Output: …」の例を 5 本並べた長い system prompt に
 * 学習者の発話を **素の user メッセージ** として渡していた。実モデル評価では
 *  - 例文をそのまま返す(llama3.2:1b 12 件中 3 件)
 *  - 質問の形の入力(「あなたの趣味は何ですか？」)に **答えてしまう**(全モデル)
 * が起きていた。区切りタグで「これは訳す対象であって話しかけられた文ではない」と
 * 明示し、例は **過去の会話ターン** として 2 往復だけ見せる(うち 1 つは質問)。
 *
 * 評価で検証した文面そのもの。レベル指示(CEFR)は載せていない — 載せない形で
 * 検証しており、1 行指示を太らせると小型モデルが守らなくなるため。
 */
const JA_TO_EN_INSTRUCTION =
  "Rewrite the learner's sentence inside <ja></ja> as one natural, simple English sentence that they could say. It may mix Japanese and English. Do not answer it. Output only the English sentence."

const JA_TO_EN_FEW_SHOT: readonly OllamaChatMessage[] = [
  { role: 'user', content: '<ja>明日は meeting があるんだ</ja>' },
  { role: 'assistant', content: 'I have a meeting tomorrow.' },
  { role: 'user', content: '<ja>好きな食べ物は何？</ja>' },
  { role: 'assistant', content: 'What is your favorite food?' },
]

/**
 * ja→en 翻訳の試行設定。
 * ⚠️ **本数は shared/request-budget.ts の OLLAMA_ATTEMPTS.translation と一致させること。**
 * /api/chat の日本語入力経路はこの梯子だけを通るので、クライアント側の締め切りが
 * 「本数 × first-token 予算」から計算されている(v1.1.0 は 120 秒 対 120 秒の同値で、
 * どちらが先に諦めるかが運になっていた)。
 *
 * 1 回目は温度 0(決定的な 1 本)。温度 0 の出力を検証で弾いたときに同じ設定で
 * 引き直しても同じ出力が返るだけなので、2 回目は温度を少し上げ seed を固定する
 * (再現可能な別の 1 本)。
 */
export const TRANSLATION_ATTEMPTS: readonly { temperature: number; seed?: number }[] = [
  { temperature: 0 },
  { temperature: 0.3, seed: RETRY_SEED },
]

/** 区切りタグの残骸を取り除く(stop で止めきれずに閉じタグだけ出ることがある)。 */
function stripTags(text: string, tag: 'en' | 'ja'): string {
  return text.replace(new RegExp(`</?${tag}>`, 'gi'), '')
}

/**
 * ja→en の出力として使ってよいか。英字を含み、日本語や他の文字体系が残っていないこと。
 * 残っている = 訳しきれていない / 日本語で答えてしまった出力。
 */
export function isAcceptableEnglishRendering(text: string): boolean {
  return /[A-Za-z]/.test(text) && !containsNonLatinScript(text)
}

export async function translateToNaturalEnglish(
  userText: string,
  options: { model?: string; level?: Level; numCtx?: number; signal?: AbortSignal },
): Promise<string> {
  const source = stripTags(stripEmoji(userText), 'ja').trim()
  const messages: OllamaChatMessage[] = [
    { role: 'system', content: JA_TO_EN_INSTRUCTION },
    ...JA_TO_EN_FEW_SHOT,
    { role: 'user', content: `<ja>${source}</ja>` },
  ]
  for (const a of TRANSLATION_ATTEMPTS) {
    const ollamaRes = await chatWithOllama(messages, {
      model: options.model,
      numCtx: options.numCtx,
      // 予算は shared/request-budget.ts が出典。**attempts の本数**(2)も
      // OLLAMA_ATTEMPTS.translation と一致させること: /api/chat の日本語入力経路は
      // この梯子だけを通るので、クライアント締め切りがここから計算されている。
      firstTokenTimeoutMs: OLLAMA_BUDGET_MS.translation,
      temperature: a.temperature,
      ...(a.seed !== undefined && { seed: a.seed }),
      topP: 0.9,
      numPredict: 120,
      // '\n\n' は stop に入れない(firstTranslationParagraph の注記)。2 段落目は後処理で捨てる。
      stop: ['<ja>'],
      // 自然文を返してほしいので Ollama の JSON モードを必ず OFF にする。
      // ここを忘れると format:'json' が送られてモデルが {"sentence":"..."}
      // のような JSON を返し、reply_en にそのまま入って UI 表示が壊れる。
      jsonFormat: false,
      signal: options.signal,
    })
    const raw = ollamaRes.message?.content ?? ''
    const candidate = stripLoneSurrogates(
      stripTags(
        stripTranslationPreamble(firstTranslationParagraph(raw, { direction: 'ja-to-en', source })),
        'ja',
      ),
    ).trim()
    if (candidate && isAcceptableEnglishRendering(candidate)) return candidate
    console.warn(
      `[chat:translate] rejected ja→en output at temperature=${a.temperature}:`,
      candidate.slice(0, 120),
    )
  }
  return ''
}

/**
 * 英文 → 日本語訳のプロンプト(「日本語訳」の欄に出るもの)。
 *
 * v1.2.0 は 2 行の system prompt の下に **英文をそのまま user メッセージとして**
 * 渡していた。小型モデルにとってそれは「話しかけられた」のと同じで、訳さずに
 * **返事を書く**(英語やローマ字で)。M1 実機のスクリーンショットはこれだった。
 * 区切りタグ + 1 行指示 + 過去ターンとしての例 2 往復 + 温度 0 + stop にし、
 * 出力を検証して、弾いたら 1 回だけ引き直す。評価で検証した文面そのもの。
 */
const EN_TO_JA_INSTRUCTION =
  'Translate the English text inside <en></en> into natural Japanese. Output only the Japanese translation.'

const EN_TO_JA_FEW_SHOT: readonly OllamaChatMessage[] = [
  { role: 'user', content: '<en>Hi! How are you today?</en>' },
  { role: 'assistant', content: 'こんにちは！今日の調子はどう？' },
  { role: 'user', content: '<en>I like cooking. What do you usually eat for dinner?</en>' },
  { role: 'assistant', content: '料理が好きなんだ。夕ごはんはいつも何を食べるの？' },
]

/**
 * en→ja 翻訳の試行設定。
 * ⚠️ **本数は shared/request-budget.ts の OLLAMA_ATTEMPTS.translationEnToJa と一致させること。**
 */
export const EN_TO_JA_ATTEMPTS: readonly { temperature: number; seed?: number }[] = [
  { temperature: 0 },
  { temperature: 0.3, seed: RETRY_SEED },
]

/**
 * ユーザーが「↻ 再取得」を押したとき(と会話終了後の一括 enrich)の試行設定。
 * 上の梯子は 2 本とも決定的なので、それで弾かれた訳は **何度押しても同じ結果** になる。
 * 再取得では seed を固定せず温度も少し上げて、別の出力を引く。
 * ⚠️ 本数は EN_TO_JA_ATTEMPTS と同じにすること(予算は同じ宣言から計算している)。
 */
export const EN_TO_JA_FRESH_ATTEMPTS: readonly { temperature: number; seed?: number }[] = [
  { temperature: 0.3 },
  { temperature: 0.5 },
]

/**
 * 日本語訳として使ってよい文字列か確かめる。
 *
 * このプロンプトはプレーンテキストを求めているが、小型モデルは JSON
 * エンベロープ(`{"reply_ja": "..."}`)で返すことがある。そのまま通すと
 * **その JSON が日本語訳として画面に出て DB にも保存される**。
 * 中の reply_ja を拾えれば拾い、拾えなければ空にする(空 = 取得失敗として
 * 扱われ、UI に再取得ボタンが出る。JSON を見せるよりはるかにまし)。
 */
export function sanitizeJapaneseTranslation(raw: string, source = ''): string {
  // 括弧で囲まれただけの行(「（カジュアルな言い方です）」)とメタ説明の行は、
  // 行数に関わらず先に落とす(複数行の英文の経路では下の行ごとの処理が拾わなかった)。
  const text = raw
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t || !(BRACKETED_LINE_RE.test(t.normalize('NFKC')) || META_LINE_PATTERN.test(t))
    })
    .join('\n')
  const stripped = stripTranslationPreamble(text, 'paired')
  if (looksLikeJsonScaffold(stripped)) return jsonTranslationField(stripped)
  if (!source.includes('\n')) return stripped
  // 英文自体が複数行なら、訳の行も残す。stripTranslationPreamble は **最初の行だけ** を
  // 残すので(ja→en の補足説明を捨てるための動き)、そのまま通すと
  // 「やあ！\n\n今日の調子はどう？」が「やあ！」になり、半分の訳が検証を通ってしまう。
  if (looksLikeJsonScaffold(text.trim())) return jsonTranslationField(text.trim())
  return text
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? stripTranslationPreamble(line, 'paired') : ''))
    .join('\n')
    .trim()
}

function jsonTranslationField(json: string): string {
  const inner = matchJsonStringField(json, 'reply_ja')
  if (inner?.trim()) return inner.trim()
  console.warn('[chat] en→ja 翻訳が JSON で返ってきたので破棄した')
  return ''
}

export async function translateEnglishToJapanese(
  englishText: string,
  options: {
    model?: string
    numCtx?: number
    signal?: AbortSignal
    /** ユーザー操作による再取得。決定的な梯子ではなく、毎回違う出力を引く梯子を使う。 */
    fresh?: boolean
  },
): Promise<string> {
  // 絵文字は訳させない(訳に絵文字や「笑顔」が混ざる / 検証の長さ判定が狂う)。
  // 絵文字だけの行は行ごと消す(検証と同じ扱い。消した跡を空行 = 段落の区切りにしない)。
  const source = stripTags(stripEmojiLines(englishText), 'en').trim()
  if (!source) return ''
  const messages: OllamaChatMessage[] = [
    { role: 'system', content: EN_TO_JA_INSTRUCTION },
    ...EN_TO_JA_FEW_SHOT,
    { role: 'user', content: `<en>${source}</en>` },
  ]
  // 英文の長さから決める(enToJaNumPredict の注記)。固定の 200 だと長い返答の訳が切れる。
  const numPredict = enToJaNumPredict(source)
  for (const a of options.fresh ? EN_TO_JA_FRESH_ATTEMPTS : EN_TO_JA_ATTEMPTS) {
    // try は **1 回の試行ごと** に置く。梯子全体を包むと、1 回目のタイムアウト
    // (8GB 機のコールドロード)で 2 回目を試さずに諦めてしまう。
    // 本数は変わらないので、最悪時間は request-budget.ts の宣言(60 秒 × 2)のまま。
    let ollamaRes: OllamaChatResponse
    try {
      ollamaRes = await chatWithOllama(messages, {
        model: options.model,
        numCtx: options.numCtx,
        firstTokenTimeoutMs: OLLAMA_BUDGET_MS.translation,
        temperature: a.temperature,
        ...(a.seed !== undefined && { seed: a.seed }),
        topP: 0.9,
        numPredict,
        // '\n\n' は stop に入れない(extractTranslationParagraphs の注記)。2 段落目は後処理で捨てる。
        stop: ['<en>', '</en>'],
        jsonFormat: false,
        signal: options.signal,
      })
    } catch (e) {
      // 中断は「失敗」ではない。空文字を返して先へ進むと、切れたソケットへ
      // レスポンスを組み立てる無駄な処理が続くので、呼び出し元へ投げ返す。
      if (e instanceof OllamaError && e.code === 'ABORTED') throw e
      console.warn(`[chat] en→ja translation failed at temperature=${a.temperature}:`, e)
      // Ollama が起動していない / モデルが無いのは、引き直しても変わらない。
      if (e instanceof OllamaError && (e.code === 'NOT_RUNNING' || e.code === 'MODEL_NOT_FOUND')) {
        return ''
      }
      continue
    }
    const extracted = extractTranslationParagraphs(ollamaRes.message?.content ?? '', {
      direction: 'en-to-ja',
      source,
    })
    // 生成上限で切れ、しかも **訳の段落そのもの** が最後まで書けていない出力は、
    // 文字だけ見ると正しい訳の前半なので検証を通ってしまう。試行ごと捨てる。
    // (訳の後ろの余談が切れただけなら、訳は完結しているので使う)
    if (ollamaRes.done_reason === 'length' && extracted.reachesEnd) {
      console.warn(
        `[chat] rejected en→ja translation at temperature=${a.temperature}: 生成上限(num_predict=${numPredict})で切れた:`,
        extracted.text.slice(0, 120),
      )
      continue
    }
    const raw = sanitizeJapaneseTranslation(extracted.text, source)
    const ja = acceptJapaneseTranslation(stripTags(raw, 'en'), source)
    if (ja) return ja
    console.warn(
      `[chat] rejected en→ja translation at temperature=${a.temperature}:`,
      raw.slice(0, 120),
    )
  }
  return ''
}

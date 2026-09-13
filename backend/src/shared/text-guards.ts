/**
 * LLM の出力を **ユーザーに見せる / 読み上げる前に** 通す純粋関数群。
 *
 * ── なぜ要るのか ──
 * v1.2.0 まで、モデルの出力を検証する処理はどこにも無かった。M1 実機では
 * 日本語訳の欄に英語やローマ字(「Konnichiwa, watashi wa ...」)が出て、
 * 英語の返答に日本語や他の文字体系が混ざることもあった。フロントは受け取った
 * ものをそのまま表示していた。ここはそれを止める最後の関所である。
 *
 * **このファイルは node/DOM の API を一切使わないこと**(backend と frontend の
 * 両方から読むため。llm-models.ts / request-budget.ts と同じ制約)。
 */

/**
 * 絵文字(と、それを組み立てる結合子・異体字セレクタ・タグ文字)。
 * U+2600–U+27BF(☀〜➿ の記号・装飾記号)も含める。読み上げると
 * "smiling face with smiling eyes" のように文字どおり喋ってしまうため。
 */
const EMOJI_RE =
  // ⭐(U+2B50)・⏰(U+23F0)などの記号絵文字も含める。結合子・異体字セレクタ・キーキャップは
  // 文字クラスに入れると lint が「結合文字」と誤読するので分けて書く。
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{3030}\u{303D}\u{3297}\u{3299}\u{E0020}-\u{E007F}]|\u{FE0E}|\u{FE0F}|\u{200D}|\u{20E3}/gu

/** 絵文字を取り除く(連続した空白は 1 つに畳まない。呼び出し側で trim する)。 */
export function stripEmoji(text: string): string {
  return text.replace(EMOJI_RE, '')
}

/**
 * 絵文字を取り除き、**絵文字だけだった行はその行ごと消す**。
 *
 * stripEmoji だけだと「いいね！\n😊\nどう？」が「いいね！\n\nどう？」になり、
 * 元には無かった **空行(= 段落の区切り)** が生まれる。日本語訳の検証は空行を
 * 「2 段落目を書いた出力」として落とすので、絵文字の行 1 つで正しい訳を捨ててしまう。
 * 元から空白だけだった行(本物の空行)はそのまま残す。
 */
export function stripEmojiLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !(line.trim() !== '' && stripEmoji(line).trim() === ''))
    .map(stripEmoji)
    .join('\n')
}

/** 空行(空白だけの行)を含むか。\r\n の改行も同じに扱う。 */
export function hasBlankLine(text: string): boolean {
  return /\n[^\S\n]*\n/.test(text.trim())
}

/**
 * 対になっていない UTF-16 サロゲートを取り除く。
 * 実モデル評価で `"ごれ„浹 \udbdc"` のような孤立サロゲートが素通りしていた
 * (JSON.stringify は通るが、表示で豆腐になり、IndexedDB やテキスト処理を壊しうる)。
 */
export function stripLoneSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}

// ---------------------------------------------------------------------------
// 日本語訳の検証
// ---------------------------------------------------------------------------

/**
 * 日本語訳に現れてよい文字だけ。かな / CJK 統合漢字 / 々 / よく使う和文約物 /
 * ASCII / 空白。これ以外(キリル文字・ハングル・„ などの記号・HTML の残骸を
 * 構成する非 ASCII)が 1 文字でもあれば訳ではない。
 */
const JA_ALLOWED_RE =
  /^[\u3040-\u30FF\u4E00-\u9FFF\u3005\u3007\u3010\u3011\u201C\u201D\u2018\u2019\u3000-\u3002\u300C-\u300F\uFF08\uFF09\uFF01\uFF1F\uFF1A\uFF5E\u301C\u2026\u30FB\u2014\u2015\x20-\x7E\s]*$/
const KANA_RE = /[\u3040-\u30FF]/g
const HAN_RE = /[\u4E00-\u9FFF\u3005]/g
/** \u30E9\u30C6\u30F3\u6587\u5B57\u306E\u8A9E(\u9023\u7D9A\u3057\u305F\u82F1\u5B57)\u3002\u539F\u6587\u3068\u8A33\u306E\u4E21\u65B9\u3092\u3053\u306E\u540C\u3058\u533A\u5207\u308A\u3067\u8A9E\u306B\u5206\u3051\u308B\u3002 */
const LATIN_WORD_RE = /[A-Za-z]+/g

/**
 * \u8A9E\u3068\u8A9E\u306E\u9593\u306B\u3053\u308C\u304C\u3042\u308C\u3070\u3001\u6B21\u306E\u8A9E\u306F **\u6587\u306E\u5148\u982D** \u3068\u307F\u306A\u3059(\u6587\u982D\u306E\u5927\u6587\u5B57\u306F\u540D\u524D\u306E\u8A3C\u62E0\u306B\u306A\u3089\u306A\u3044)\u3002
 * \u5F15\u7528\u7B26\u30FB\u62EC\u5F27\u30FB\u30B3\u30ED\u30F3\u306E\u76F4\u5F8C\u3082\u6587\u982D\u6271\u3044\u306B\u3059\u308B\u3002\u6587\u982D\u3092\u591A\u3081\u306B\u898B\u7A4D\u3082\u3063\u3066\u3082\u3001\u9664\u5916\u304C\u6E1B\u3063\u3066
 * \u691C\u8A3C\u304C\u53B3\u3057\u3044\u5074\u306B\u5012\u308C\u308B\u3060\u3051(\u300CMr. Smith\u300D\u306E Smith \u306F\u9664\u5916\u3055\u308C\u306A\u3044\u3002\u305D\u308C\u3067\u3088\u3044)\u3002
 */
const SENTENCE_BREAK_RE = /[.!?:;"\u201C(\n]/

/**
 * \u5927\u6587\u5B57\u3067\u66F8\u304B\u308C\u3066\u3044\u3066\u3082 **\u540D\u524D\u3067\u306F\u306A\u3044** \u666E\u901A\u306E\u8A9E\u3002\u8A33\u3067\u306F\u3053\u308C\u3089\u3092\u65E5\u672C\u8A9E\u306B\u3059\u308B\u3079\u304D\u3067\u3001
 * \u30E9\u30C6\u30F3\u6587\u5B57\u306E\u307E\u307E\u6B8B\u3063\u3066\u3044\u308C\u3070\u8A33\u3057\u304D\u308C\u3066\u3044\u306A\u3044\u3002
 *  - \u4EE3\u540D\u8A5E\u306E I(\u5E38\u306B\u5927\u6587\u5B57)\u30021 \u6587\u5B57\u306E\u8A9E\u306F\u305D\u3082\u305D\u3082\u540D\u524D\u3068\u307F\u306A\u3055\u306A\u3044\u304C\u3001\u660E\u793A\u3057\u3066\u304A\u304F
 *  - OK / \u9593\u6295\u8A5E / \u5F37\u8ABF(\u30C1\u30E3\u30C3\u30C8\u3067\u5168\u90E8\u5927\u6587\u5B57\u306B\u306A\u308A\u3084\u3059\u3044: WOW, SO, LOL)\u3002
 *    \u5168\u90E8\u5927\u6587\u5B57\u306E\u8A9E\u306F\u6587\u4E2D\u306E\u4F4D\u7F6E\u306B\u3088\u3089\u305A\u540D\u524D\u3068\u307F\u306A\u3059\u898F\u5247\u306A\u306E\u3067\u3001\u3053\u3053\u3067\u6B62\u3081\u308B
 *  - \u66DC\u65E5\u30FB\u6708\u30FB\u8A00\u8A9E\u540D\u3002\u82F1\u8A9E\u306E\u6587\u6CD5\u3067\u5927\u6587\u5B57\u306B\u3059\u308B\u3060\u3051\u3067\u56FA\u6709\u306E\u540D\u524D\u3067\u306F\u306A\u304F\u3001
 *    \u65E5\u672C\u8A9E\u306B\u306F\u6C7A\u307E\u3063\u305F\u8A00\u3044\u65B9(\u6708\u66DC\u65E5\u30FB5 \u6708\u30FB\u82F1\u8A9E)\u304C\u3042\u308B
 * \u5C0F\u3055\u304F\u4FDD\u3064\u3053\u3068\u3002\u3053\u3053\u306B\u7121\u3044\u666E\u901A\u306E\u8A9E\u304C\u5927\u6587\u5B57\u3067\u66F8\u304B\u308C\u3066\u3044\u3066\u3082\u3001\u9664\u5916\u3055\u308C\u308B\u306E\u306F
 * **\u539F\u6587\u306B\u3082\u305D\u306E\u8A9E\u304C\u3042\u308B** \u3068\u304D\u3060\u3051\u3067\u3001\u8A33\u306E\u4ED6\u306E\u30E9\u30C6\u30F3\u6587\u5B57\u306F\u6570\u3048\u7D9A\u3051\u308B\u3002
 */
const PROPER_NOUN_STOPLIST: ReadonlySet<string> = new Set([
  'i',
  'ok',
  'okay',
  'oh',
  'wow',
  'yes',
  'no',
  'yay',
  'hey',
  'hi',
  'hello',
  'so',
  'very',
  'really',
  'lol',
  'omg',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'english',
  'japanese',
])

/**
 * \u82F1\u6587\u306E\u4E2D\u3067 **\u540D\u524D\u3089\u3057\u304F\u66F8\u304B\u308C\u3066\u3044\u308B\u8A9E**(\u5C0F\u6587\u5B57\u306B\u3057\u305F\u3082\u306E)\u3002\u8A33\u306B\u30E9\u30C6\u30F3\u6587\u5B57\u306E\u307E\u307E\u6B8B\u3063\u3066\u3044\u3066\u3082
 * \u8A33\u3057\u304D\u308C\u3066\u3044\u306A\u3044\u3068\u306F\u307F\u306A\u3055\u306A\u3044(\u300CDo you like Netflix?\u300D\u2192\u300CNetflix\u306F\u597D\u304D\uFF1F\u300D)\u3002
 *
 * \u540D\u524D\u3089\u3057\u3044\u3068\u307F\u306A\u3059\u306E\u306F\u6B21\u306E\u3069\u308C\u304B(\u30B9\u30C8\u30C3\u30D7\u30EA\u30B9\u30C8\u306E\u8A9E\u306F\u9664\u304F):
 *  - 2 \u6587\u5B57\u76EE\u4EE5\u964D\u306B\u5927\u6587\u5B57\u304C\u3042\u308B(iPhone, YouTube)\u3002\u5168\u90E8\u5927\u6587\u5B57\u306E 2 \u6587\u5B57\u4EE5\u4E0A(NBA)\u3082\u3053\u308C\u306B\u5F53\u305F\u308B
 *  - \u5148\u982D\u3060\u3051\u304C\u5927\u6587\u5B57\u306E 2 \u6587\u5B57\u4EE5\u4E0A\u306E\u8A9E\u3067\u3001**\u6587\u306E\u5148\u982D\u3067\u306F\u306A\u3044**(\u2026 on Netflix)
 */
export function sourceProperNouns(en: string): Set<string> {
  const names = new Set<string>()
  const text = (en ?? '').normalize('NFKC')
  let atSentenceStart = true
  let gapStart = 0
  for (const m of text.matchAll(LATIN_WORD_RE)) {
    const word = m[0]
    const index = m.index ?? 0
    if (SENTENCE_BREAK_RE.test(text.slice(gapStart, index))) atSentenceStart = true
    gapStart = index + word.length
    const looksLikeName =
      /[A-Z]/.test(word.slice(1)) || (!atSentenceStart && /^[A-Z][a-z]/.test(word))
    atSentenceStart = false
    const key = word.toLowerCase()
    if (looksLikeName && !PROPER_NOUN_STOPLIST.has(key)) names.add(key)
  }
  return names
}

/** \u8A33\u306E\u30E9\u30C6\u30F3\u6587\u5B57\u306E\u6570\u3002\u539F\u6587\u3067\u540D\u524D\u3089\u3057\u304F\u66F8\u304B\u308C\u305F\u8A9E(\u5927\u6587\u5B57\u5C0F\u6587\u5B57\u3092\u554F\u308F\u305A\u8A9E\u5168\u4F53\u3067\u4E00\u81F4)\u306F\u6570\u3048\u306A\u3044\u3002 */
function countLatinOutsideNames(text: string, names: ReadonlySet<string>): number {
  let n = 0
  for (const m of text.matchAll(LATIN_WORD_RE)) {
    if (!names.has(m[0].toLowerCase())) n += m[0].length
  }
  return n
}

export type JapaneseTranslationVerdict =
  | 'ok'
  | 'empty'
  | 'disallowed-char'
  | 'no-kana'
  | 'kana-share'
  | 'latin-heavy'
  | 'too-long'
  | 'json-remnant'
  | 'multi-paragraph'

/**
 * 日本語訳の長さの上限 = max(JA_LENGTH_FLOOR, 英文の長さ × JA_LENGTH_RATIO)。
 * 下限は短い相づち(「Wow.」「Nice!」)の自然な訳のため、比率は長い英文の
 * 「返事の続き」を落とすため。
 *
 * 下限を 20 にすると較正ケース「Hello!」→「どうすみます。 dailyは何日ですか?」
 * (ちょうど 20 文字の意味不明な訳)が通ってしまう。18 なら短い相づちの自然な訳
 * (「わあ、それはすごいですね！」13 文字)を通し、較正ケースの判定は 1 件も変わらない。
 */
export const JA_LENGTH_FLOOR = 18
export const JA_LENGTH_RATIO = 0.9

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0
}

/** コードポイント数(絵文字などのサロゲートペアを 1 と数える)。 */
function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * 日本語訳として出してよいかを判定する(実モデル評価で較正したルール)。
 *
 *  1) 絵文字を先に取り除く
 *  2) 許可された文字だけで出来ている
 *  3) かなが 1 文字以上あり、かな / (かな + 漢字) が 25% 以上
 *     (かなの無い出力 = ローマ字 / 英語の続き / 中国語)
 *  4) ラテン文字が日本語の文字数の半分以下
 *     (「お店に行った。 carrot、tomato、lettuce etc.」のような半訳を落とす)。
 *     英文で名前らしく書かれた語(Netflix / iPhone / NBA)は数えない(sourceProperNouns)
 *  5) 長さが max(18, 英文の長さ × 0.9) 以下
 *     (翻訳ではなく「返事の続き」を書き始めた出力を落とす)
 *     下限は validator_v2 では 12 だったが、「Wow.」→「わあ、それはすごいですね！」
 *     (13 文字)のような短い相づちの自然な訳まで落としていたので 18 に上げた。
 *     長い英文の続きを捕まえるのは比率 0.9 の方なので、比率は変えていない。
 *  6) 英文に無い ASCII の波括弧 { } を含まない(壊れた JSON の残骸)
 *  7) 空行を含まない(訳の後ろに 2 段落目を書いた出力)。英文自体に空行があっても除外しない
 *     6 と 7 は評価の後に足した規則で、**較正ケースの判定を変えないよう最後に置く**
 *     (「」} </td>…」の較正ケースは 4 で latin-heavy のまま)。
 *
 * 評価の validator_v2 からの差分は 2 つだけ: 判定前の NFKC 正規化と、〇 “” ‘’ 【】 の許可。
 * どちらも「落としていた正しい訳を通す」方向で、下の較正ケースの判定は変わらない。
 *
 * 評価データ(5 モデル × 12 件の目視判定)で、正しい / 部分的に正しい訳
 * 43 件のうち落としたのは 1 件だけ(訳の後ろに括弧書きのローマ字を足したもの)。
 * **ここを緩めるときは validator のテストの較正ケースを先に見ること。**
 */
export function judgeJapaneseTranslation(ja: string, en: string): JapaneseTranslationVerdict {
  // NFKC で全角英数字・全角記号(３ ％ ； ，)を ASCII に寄せてから判定する。
  // 評価の validator_v2 はこれをせず、「３時に会いましょう。」のような普通の訳を
  // 許可外の文字として落としていた(3B の標準プロファイルで実際に出る書き方)。
  // 〇 “” ‘’ 【】 は NFKC で変わらないので許可文字に直接足してある。
  // 絵文字だけの行は行ごと消す(stripEmojiLines の注記。空行を作らない)。
  const t = stripEmojiLines(ja ?? '')
    .normalize('NFKC')
    .trim()
  if (!t) return 'empty'
  if (!JA_ALLOWED_RE.test(t)) return 'disallowed-char'
  const kana = count(t, KANA_RE)
  const han = count(t, HAN_RE)
  // 4) の数え方: 英文に名前らしく書かれた語(sourceProperNouns)は数えない。
  //    固有名詞をラテン文字のまま残すのは普通の訳で、7 文字のブランド名 1 つに
  //    かな漢字 14 文字が要ると、25 文字未満の英文の訳(「Netflixは好き？」)は長さの上限と
  //    両立せず、決して通らなかった。英文が分からない呼び出し(en が空)では除外は起きない。
  const latin = countLatinOutsideNames(t, sourceProperNouns(en))
  if (kana < 1) return 'no-kana'
  if (kana / (kana + han) < 0.25) return 'kana-share'
  if (latin > (kana + han) / 2) return 'latin-heavy'
  if (
    codePointLength(t) >
    Math.max(JA_LENGTH_FLOOR, JA_LENGTH_RATIO * codePointLength((en ?? '').trim()))
  ) {
    return 'too-long'
  }
  // 6) ASCII の波括弧が英文に無いのに訳にある = 壊れた JSON の残骸。
  //    非ストリーミング経路は壊れた JSON を matchJsonStringField で拾うが、それは
  //    **最初の straight quote まで** 読むので、モデルが曲がった引用符で閉じると
  //    「こんにちは”},{」のように JSON の続きまで reply_ja に入る(1〜5 を全部通る)。
  //    全角の ｛ ｝ は上の NFKC で ASCII に寄っているのでここで一緒に落ちる。
  //    角括弧は見ない: 「[笑]」は訳として普通にありうる。
  if (/[{}]/.test(t) && !/[{}]/.test((en ?? '').normalize('NFKC'))) return 'json-remnant'
  // 7) 空行を含む = 訳の後ろに 2 段落目(返事の続き・補足説明)を書いている。
  //    翻訳経路は extractTranslationParagraphs で 1 段落に切ってから来るので、
  //    ここで落ちるのは JSON 経路(会話の reply_ja / 標準プロファイルの enrich)の
  //    出力だけで、落ちたものは en→ja 翻訳で訳し直される。
  //    **英文自体に空行があっても例外にしない**(6 の波括弧とは扱いが違う)。
  //    en→ja 翻訳は英文を 1 段落にしてから頼む(translation.ts の normalizeTranslationSource)
  //    ので、訳に空行が入る正当な理由は無い。空行のある訳が「訳の 2 段落目」なのか
  //    「訳の後ろに書いた返事」なのかは文字だけでは分からず、曖昧なものは通さない。
  if (hasBlankLine(t)) return 'multi-paragraph'
  return 'ok'
}

export function isAcceptableJapaneseTranslation(ja: string, en: string): boolean {
  return judgeJapaneseTranslation(ja, en) === 'ok'
}

/**
 * 表示用に整えた日本語訳を返す。使えなければ空文字。
 * 空文字は呼び出し側で「取得失敗」として扱われ、UI に再取得ボタンが出る
 * (間違った訳を見せるより、訳が無いと正直に出す方がよい)。
 */
export function acceptJapaneseTranslation(ja: string, en: string): string {
  const cleaned = stripLoneSurrogates(stripEmojiLines(ja ?? '')).trim()
  return isAcceptableJapaneseTranslation(cleaned, en) ? cleaned : ''
}

// ---------------------------------------------------------------------------
// 英語の返答の文字体系チェック
// ---------------------------------------------------------------------------

/**
 * 英語の返答に現れてはいけない文字体系。
 * 漢字 / かな / ハングル / キリル / ギリシャ / ヘブライ / アラビア /
 * インド系(デーヴァナーガリー〜シンハラ。先頭の結合記号 U+0900–0903 は単独では出ないので除く)/ タイ / ラオ / アルメニア / ジョージア /
 * 置換文字(U+FFFD)。
 *
 * **狭く保つこと**。アクセント付きのラテン文字(José, café, naïve)、通貨記号
 * (€ ¥ £)、ダッシュや曲がった引用符は正当な英文に普通に出るので含めない。
 * 全角の句読点(！ 。)も「文字体系」ではないので含めない。
 */
const NON_LATIN_SCRIPT_RE =
  /[\u0370-\u03FF\u0400-\u04FF\u0530-\u058F\u0590-\u05FF\u0600-\u06FF\u0904-\u0DFF\u0E00-\u0EFF\u10A0-\u10FF\u1100-\u11FF\u3005\u3040-\u30FF\u31F0-\u31FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF66-\uFF9F\uFFFD]/

export function containsNonLatinScript(text: string): boolean {
  return NON_LATIN_SCRIPT_RE.test(text)
}

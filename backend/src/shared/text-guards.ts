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
const LATIN_RE = /[A-Za-z]/g

export type JapaneseTranslationVerdict =
  | 'ok'
  | 'empty'
  | 'disallowed-char'
  | 'no-kana'
  | 'kana-share'
  | 'latin-heavy'
  | 'too-long'

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
 *     (「お店に行った。 carrot、tomato、lettuce etc.」のような半訳を落とす)
 *  5) 長さが max(12, 英文の長さ × 0.9) 以下
 *     (翻訳ではなく「返事の続き」を書き始めた出力を落とす)
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
  const t = stripEmoji(ja ?? '')
    .normalize('NFKC')
    .trim()
  if (!t) return 'empty'
  if (!JA_ALLOWED_RE.test(t)) return 'disallowed-char'
  const kana = count(t, KANA_RE)
  const han = count(t, HAN_RE)
  const latin = count(t, LATIN_RE)
  if (kana < 1) return 'no-kana'
  if (kana / (kana + han) < 0.25) return 'kana-share'
  if (latin > (kana + han) / 2) return 'latin-heavy'
  if (codePointLength(t) > Math.max(12, 0.9 * codePointLength((en ?? '').trim()))) {
    return 'too-long'
  }
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
  const cleaned = stripLoneSurrogates(stripEmoji(ja ?? '')).trim()
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

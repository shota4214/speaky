/**
 * 英文の「文の切れ目」の判定規則。**唯一の出典**。
 *
 * もとは frontend の utils/sentence-stream.ts(読み上げ単位への分割)にあった規則を
 * そのまま切り出したもの。backend も同じ規則で「小型モデルの返答を 2 文で止める」
 * 判定をするため共有にした。規則が 2 系統に分かれると、略語や小数の扱いが
 * 読み上げと打ち切りで食い違う(「Dr.」で返答が切れる等)。
 *
 * **このファイルは node/DOM の API を一切使わないこと**(backend と frontend の両方から読む)。
 */

/** 文末候補となる終端記号。 */
export const SENTENCE_END_CHARS: ReadonlySet<string> = new Set([
  '.',
  '!',
  '?',
  '…',
  '！',
  '？',
  '。',
])

/** 終端記号の直後に続けて 1 セグメントに含めてよい閉じ記号(引用符・括弧)。 */
export const CLOSING_CHARS: ReadonlySet<string> = new Set([
  '"',
  "'",
  '”',
  '’',
  '）',
  ')',
  ']',
  '}',
  '»',
  '」',
  '』',
])

/**
 * ピリオドで切ってはいけない略語。すべて小文字・末尾ピリオド込みで持つ。
 * ここに無い略語(会社固有の略記など)は分割されうるが、読み上げが少し細切れに
 * なるだけで発話内容は壊れないため、実用上の許容範囲としている。
 */
export const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'prof.',
  'sr.',
  'jr.',
  'st.',
  'mt.',
  'ft.',
  'no.',
  'vs.',
  'etc.',
  'e.g.',
  'i.e.',
  'a.m.',
  'p.m.',
  'am.',
  'pm.',
  'u.s.',
  'u.k.',
  'u.n.',
  'inc.',
  'ltd.',
  'co.',
  'corp.',
  'dept.',
  'est.',
  'fig.',
  'approx.',
  'min.',
  'max.',
  'sgt.',
  'capt.',
  'gen.',
  'lt.',
  'col.',
  'rev.',
  'hon.',
  'ph.d.',
  'm.d.',
  'b.a.',
  'm.a.',
  'p.s.',
  'cf.',
  'al.',
  'vol.',
  'pp.',
])

/** このセグメント長未満なら「次のセグメントに合流」させる(読み上げの既定値)。 */
export const DEFAULT_MIN_SEGMENT_CHARS = 12
/** 1 セグメントの上限。句読点を打たずに喋り続けたときの安全弁。 */
export const DEFAULT_MAX_SEGMENT_CHARS = 180

export function isWhitespace(ch: string): boolean {
  return /\s/.test(ch)
}

/**
 * buffer[i] を文末記号とみなしてよいか(略語・イニシャルでないか)を判定する。
 * 判定対象は '.' のみ。'!' '?' は略語になりえない。
 */
export function isAbbreviationDot(buffer: string, i: number): boolean {
  const before = buffer.slice(0, i)
  const m = /([A-Za-z][A-Za-z.]*)$/.exec(before)
  if (!m) return false
  const word = m[1]!
  // 1 文字 = イニシャル ("J. R. R. Tolkien" / "Dr. J. Smith")。
  // 文末の "...was I." のような稀なケースは切れないが、読み上げ上は無害。
  if (word.length === 1) return true
  return ABBREVIATIONS.has(`${word}.`.toLowerCase())
}

/**
 * from 以降で最初の「文の切れ目」を探し、セグメント末尾の排他インデックスを返す。
 * 見つからなければ -1。
 *
 * 切れ目の条件: 文末記号(+続く終端記号 + 閉じ記号)の **直後に空白が既に届いている** こと。
 * バッファ末尾の文字では絶対に切らないので、
 *   - "3.14" の途中で切らない(次が数字だと分かるまで待つ)
 *   - "Dr." が届いた時点で切らない("Smith" を待てる)
 * が 1 つのルールで同時に成立する。
 */
export function findBreak(buffer: string, from: number): number {
  for (let i = from; i < buffer.length; i++) {
    const ch = buffer[i]!
    if (!SENTENCE_END_CHARS.has(ch)) continue

    let j = i + 1
    // "?!" や "..." のような連続した終端記号はまとめて 1 つの切れ目にする
    while (j < buffer.length && SENTENCE_END_CHARS.has(buffer[j]!)) j++
    const terminatorEnd = j
    // 直後の閉じ引用符・閉じ括弧はセグメントに含める("Really?" he said.)
    while (j < buffer.length && CLOSING_CHARS.has(buffer[j]!)) j++

    // 空白がまだ届いていない(= バッファ末尾)。ここでは切らずに次の push を待つ。
    if (j >= buffer.length) return -1
    if (!isWhitespace(buffer[j]!)) {
      i = j - 1
      continue
    }
    if (ch === '.' && terminatorEnd === i + 1 && isAbbreviationDot(buffer, i)) {
      i = j - 1
      continue
    }
    return j
  }
  return -1
}

export interface SegmentCut {
  /** buffer 先頭からの排他インデックス。 */
  end: number
  /** 句読点による切れ目なら true、長さの安全弁で切ったなら false。 */
  sentenceEnd: boolean
}

/**
 * 先頭に空白を含まない buffer について、次に切るべき位置を返す(切れなければ null)。
 * 句点による切れ目を優先し、上限に達していてそこまでに切れ目が無ければ
 * 上限直前の空白で切る。短すぎるセグメント(「Hi!」等)は次の文と合流させる。
 */
export function nextSegmentCut(
  buffer: string,
  minSegmentChars = DEFAULT_MIN_SEGMENT_CHARS,
  maxSegmentChars = DEFAULT_MAX_SEGMENT_CHARS,
): SegmentCut | null {
  let from = 0
  let punctuationCut = -1
  for (;;) {
    const end = findBreak(buffer, from)
    if (end < 0) break
    if (buffer.slice(0, end).trim().length < minSegmentChars) {
      from = end
      continue
    }
    punctuationCut = end
    break
  }

  // 上限超え: 句点の切れ目が上限より後ろ(または無い)なら安全弁で切る。
  // 「1 文字ずつ来た場合は length == max の瞬間に発火する」ので、
  // 判定を必ず max 以内の範囲だけで行い、一括投入時と同じ位置で切る。
  if (
    buffer.length >= maxSegmentChars &&
    (punctuationCut < 0 || punctuationCut >= maxSegmentChars)
  ) {
    return { end: maxLengthCut(buffer, minSegmentChars, maxSegmentChars), sentenceEnd: false }
  }
  return punctuationCut < 0 ? null : { end: punctuationCut, sentenceEnd: true }
}

function maxLengthCut(buffer: string, minSegmentChars: number, maxSegmentChars: number): number {
  const head = buffer.slice(0, maxSegmentChars)
  let last = -1
  for (let i = head.length - 1; i >= 0; i--) {
    if (isWhitespace(head[i]!)) {
      last = i
      break
    }
  }
  // 空白が無い / 早すぎる位置にしか無い場合は上限ちょうどで固く切る
  if (last < minSegmentChars) return maxSegmentChars
  return last
}

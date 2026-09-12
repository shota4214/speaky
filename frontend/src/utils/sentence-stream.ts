/**
 * ストリーム(またはまとめて渡されたテキスト)を「読み上げ単位」に切り出すアキュムレータ。
 *
 * ここは **純粋なテキスト処理だけ** を担当する。DOM も Web Speech API も参照しない
 * (vitest の environment は 'node' で window が無いため。ここを純粋に保つことで
 *  分割ルールを単体テストで固定できる)。
 *
 * 最重要の性質:
 *   「1 文字ずつ push した結果」と「1 回でまとめて push した結果」が完全に一致すること。
 * この不変条件が崩れると、後段のストリーミング読み上げで「チャンクの切れ目によって
 * 文の切れ方が変わる」= 再現しないバグになる。そのため各ルールは
 * 「現時点のバッファの接頭辞だけで決まり、後から覆らない」形で書いてある。
 */

/** 文末候補となる終端記号。 */
const SENTENCE_END_CHARS = new Set(['.', '!', '?', '…', '！', '？', '。'])

/** 終端記号の直後に続けて 1 セグメントに含めてよい閉じ記号(引用符・括弧)。 */
const CLOSING_CHARS = new Set(['"', "'", '”', '’', '）', ')', ']', '}', '»', '」', '』'])

/**
 * ピリオドで切ってはいけない略語。すべて小文字・末尾ピリオド込みで持つ。
 * ここに無い略語(会社固有の略記など)は分割されうるが、読み上げが少し細切れに
 * なるだけで発話内容は壊れないため、実用上の許容範囲としている。
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
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

export interface SentenceAccumulatorOptions {
  /**
   * このセグメント長未満なら「次のセグメントに合流」させる。
   * Web Speech は極端に短い utterance を連発すると発話間の間延び・取りこぼしが
   * 目立つため、細切れを避ける。
   */
  minSegmentChars?: number
  /**
   * 1 セグメントの上限。小さいモデルは句読点を打たずに延々と喋ることがあるので、
   * 上限を超えたら「上限直前の空白」で強制的に切る(安全弁)。
   */
  maxSegmentChars?: number
  /**
   * 最初の 1 セグメントだけは、この文字数が貯まるまで出さない(ストリーム終了時は除く)。
   * 後段のストリーミング実装で「モデルが誤って JSON を吐き始めた」ことを
   * 読み上げ開始前に検知・救済するための猶予。
   */
  firstEmitMinChars?: number
}

const DEFAULT_MIN_SEGMENT_CHARS = 12
const DEFAULT_MAX_SEGMENT_CHARS = 180
const DEFAULT_FIRST_EMIT_MIN_CHARS = 30

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch)
}

/**
 * buffer[i] を文末記号とみなしてよいか(略語・イニシャルでないか)を判定する。
 * 判定対象は '.' のみ。'!' '?' は略語になりえない。
 */
function isAbbreviationDot(buffer: string, i: number): boolean {
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
function findBreak(buffer: string, from: number): number {
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

export class SentenceAccumulator {
  private buffer = ''
  private emitted = false
  private readonly minSegmentChars: number
  private readonly maxSegmentChars: number
  private readonly firstEmitMinChars: number

  constructor(options: SentenceAccumulatorOptions = {}) {
    this.minSegmentChars = options.minSegmentChars ?? DEFAULT_MIN_SEGMENT_CHARS
    this.maxSegmentChars = options.maxSegmentChars ?? DEFAULT_MAX_SEGMENT_CHARS
    this.firstEmitMinChars = options.firstEmitMinChars ?? DEFAULT_FIRST_EMIT_MIN_CHARS
  }

  /** チャンクを追加し、確定した読み上げセグメントを返す(無ければ空配列)。 */
  push(chunk: string): string[] {
    if (chunk) this.buffer += chunk
    return this.extract(false)
  }

  /**
   * ストリーム終了。バッファに残った分を trim して返す。
   * ここが「言い残しを絶対に作らない」保証になっているので、
   * 呼び出し側は必ず flush まで呼ぶこと。
   */
  flush(): string[] {
    const out = this.extract(true)
    const rest = this.buffer.trim()
    this.buffer = ''
    if (rest) {
      this.emitted = true
      out.push(rest)
    }
    return out
  }

  /** まだ読み上げに出していないバッファ(デバッグ・JSON 検知用)。 */
  pending(): string {
    return this.buffer
  }

  /** 使い回す場合の初期化。 */
  reset(): void {
    this.buffer = ''
    this.emitted = false
  }

  private extract(force: boolean): string[] {
    const out: string[] = []
    for (;;) {
      // 先頭の空白は常にこの時点で落とす。1 文字ずつ来ても一括で来ても
      // 「先頭に空白が残らない」状態が同じになり、長さ判定がズレない。
      const stripped = this.buffer.replace(/^\s+/, '')
      if (stripped !== this.buffer) this.buffer = stripped
      if (!this.buffer) break

      // 最初の 1 回だけ、ある程度貯まるまで出さない(ストリーム終了時は無視)
      if (!this.emitted && !force && this.buffer.length < this.firstEmitMinChars) break

      const cut = this.nextCut()
      if (cut < 0) break

      const segment = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut)
      if (segment) {
        this.emitted = true
        out.push(segment)
      }
    }
    return out
  }

  /**
   * 次に切るべき排他インデックスを返す(-1 = まだ切れない)。
   * 句点による切れ目を優先し、上限に達していてそこまでに切れ目が無ければ
   * 上限直前の空白で切る。
   */
  private nextCut(): number {
    let from = 0
    let punctuationCut = -1
    for (;;) {
      const end = findBreak(this.buffer, from)
      if (end < 0) break
      // 短すぎるセグメントは切らずに次の文と合流させる
      if (this.buffer.slice(0, end).trim().length < this.minSegmentChars) {
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
      this.buffer.length >= this.maxSegmentChars &&
      (punctuationCut < 0 || punctuationCut >= this.maxSegmentChars)
    ) {
      return this.maxLengthCut()
    }
    return punctuationCut
  }

  private maxLengthCut(): number {
    const head = this.buffer.slice(0, this.maxSegmentChars)
    let last = -1
    for (let i = head.length - 1; i >= 0; i--) {
      if (isWhitespace(head[i]!)) {
        last = i
        break
      }
    }
    // 空白が無い / 早すぎる位置にしか無い場合は上限ちょうどで固く切る
    if (last < this.minSegmentChars) return this.maxSegmentChars
    return last
  }
}

/**
 * 文字列全体を 1 回で読み上げセグメントへ分割するショートカット。
 * ストリーミングでない返答も必ずこの経路を通すことで、読み上げの分割ロジックを
 * 1 本に保つ(後からストリーミングを足すときに差分が小さくなる)。
 */
export function splitIntoSpeechSegments(
  text: string,
  options: SentenceAccumulatorOptions = {},
): string[] {
  const acc = new SentenceAccumulator(options)
  return [...acc.push(text), ...acc.flush()]
}

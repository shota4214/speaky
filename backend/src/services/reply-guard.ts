/**
 * 英語の返答を「文」単位でふるいにかける純粋ロジック(small プロファイル用)。
 *
 * 2 つの問題を 1 つの仕組みで扱う:
 *  1) **英語の返答に別の文字体系が混ざる**(漢字・かな・ハングル・キリル等)。
 *     その文は読み上げさせず、保存もしない。前後のラテン文字だけの文は残す。
 *  2) **返答が長すぎる**。実モデル評価で qwen2.5:1.5b は「1〜2 文」の指示を
 *     挨拶 12/12・会話 4/12 で破った。初心者には長すぎるので、2 文目の文末で
 *     打ち切る(ストリーミングでは Ollama の生成も止める)。
 *
 * 文の切れ目は frontend の読み上げ分割と **同じ規則**(shared/sentence-boundary.ts の
 * findBreak: 終端記号 + 空白。略語(Dr. / e.g.)や小数(3.14)は文末に数えない)。
 * 読み上げ分割の「12 文字未満の断片は次の文と合流」は **使わない**。使うと
 * 「Was it fun? I think so.」が 1 文扱いになって 3 文が素通りし、日本語の短い文が
 * 後ろの英文と合流して英文ごと落ちる。
 *
 * 「Hello!」のような短い感嘆も 1 文と数える(英字を含む文はすべて数える)。
 * そのため「Hello! How are you today? Do you like trains?」は 2 文目で切れて
 * 質問が落ちる。数えない案も試したが、実モデルでは挨拶 12 件中 10 件が
 * 「Hello! + 質問 2 つ」になり、長さの問題がまったく解決しなかった。
 *
 * standard プロファイルには使わない(3B は長さを守れており、打ち切りは退行になる)。
 */
import { nextSegmentCut } from '../shared/sentence-boundary.js'
import { containsNonLatinScript } from '../shared/text-guards.js'

export interface ReplyGateOptions {
  /** この数の文を受け入れたら打ち切る。null なら打ち切らない。 */
  maxSentences: number | null
  /** 非ラテン文字体系を含む文を落とすか。 */
  dropNonLatin: boolean
}

export class ReplySentenceGate {
  private consumed = 0
  private acceptedText = ''
  private sentences = 0
  private capped = false
  private dropped = 0

  constructor(private readonly options: ReplyGateOptions) {}

  /**
   * full の [consumed, limit) を読み進め、確定した文のうち受け入れたものを返す
   * (返した文字列はそのまま delta として送ってよい。先頭の空白も含む)。
   *
   * - final=false: 文の切れ目が確定したところまでしか読まない(末尾は保留)。
   * - final=true : ストリームが終わった。残りを最後の 1 文として扱う。
   */
  advance(full: string, limit: number = full.length, final = false): string {
    let out = ''
    while (!this.capped) {
      const view = full.slice(this.consumed, limit)
      const lead = view.length - view.trimStart().length
      const body = view.slice(lead)
      if (!body) {
        if (final) this.consumed = limit
        break
      }
      let cut = nextSegmentCut(body, 1)
      if (!cut) {
        if (!final) break
        cut = { end: body.length, sentenceEnd: true }
      }
      const segment = view.slice(0, lead + cut.end)
      this.consumed += segment.length
      if (this.options.dropNonLatin && containsNonLatinScript(segment)) {
        this.dropped += 1
        continue
      }
      this.acceptedText += segment
      out += segment
      if (cut.sentenceEnd && /[A-Za-z]/.test(segment)) {
        this.sentences += 1
        const max = this.options.maxSentences
        if (max !== null && this.sentences >= max) this.capped = true
      }
    }
    return out
  }

  /** full の中で判定を終えた位置(delta の送出済み位置として使う)。 */
  get consumedIndex(): number {
    return this.consumed
  }

  /** 文数の上限に達したか(達したら呼び出し側は生成を止めてよい)。 */
  get isCapped(): boolean {
    return this.capped
  }

  /** 非ラテン文字体系のために落とした文の数。 */
  get droppedCount(): number {
    return this.dropped
  }

  /** 受け入れた文をつないだ最終テキスト。 */
  get text(): string {
    return this.acceptedText.trim()
  }
}

export interface FilteredReply {
  text: string
  /** 元のテキストから何か落とした / 切り詰めたか。 */
  changed: boolean
  droppedNonLatin: number
}

/** 完成済みのテキストに同じ規則を一括で適用する(非ストリーミング経路 / salvage 後)。 */
export function filterReplySentences(text: string, options: ReplyGateOptions): FilteredReply {
  const gate = new ReplySentenceGate(options)
  gate.advance(text, text.length, true)
  return { text: gate.text, changed: gate.text !== text.trim(), droppedNonLatin: gate.droppedCount }
}

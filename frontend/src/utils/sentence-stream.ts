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

import {
  DEFAULT_MAX_SEGMENT_CHARS,
  DEFAULT_MIN_SEGMENT_CHARS,
  nextSegmentCut,
} from '../../../backend/src/shared/sentence-boundary'

/*
 * 文の切れ目の規則(終端記号 / 閉じ記号 / 略語 / 空白待ち / 短い断片の合流 /
 * 長さの安全弁)は backend/src/shared/sentence-boundary.ts が唯一の出典。
 * backend が small プロファイルの返答を「2 文で止める」判定にも同じ規則を使うため、
 * ここに複製を置かないこと(略語や小数の扱いが読み上げと打ち切りで食い違う)。
 */

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

const DEFAULT_FIRST_EMIT_MIN_CHARS = 30

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

  /** 次に切るべき排他インデックスを返す(-1 = まだ切れない)。 */
  private nextCut(): number {
    return nextSegmentCut(this.buffer, this.minSegmentChars, this.maxSegmentChars)?.end ?? -1
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

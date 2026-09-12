/**
 * LLM が返した「壊れた JSON」から使える値だけを救出するためのヘルパ群。
 *
 * 小型モデル(Llama 3.2 3B 等)は
 *   - コードフェンス(```json ... ```)や前置きで JSON を包む
 *   - num_predict 上限に当たって JSON の途中でぶつ切りになる
 * という壊し方をする。どちらも「返答自体は出来ている」ケースなので、
 * 即リトライして 2 回目のフル生成を待たせるより、ここで拾えるものを拾って
 * 1 回目の生成をそのまま活かす方が体感速度が圧倒的に良い。
 *
 * ここに置く関数はすべて純粋関数(ネットワーク・I/O なし)。
 */

/**
 * 前後の余計なテキスト(コードフェンス / 「Here is the JSON:」等)を剥がして、
 * 最初の `{` から最後の `}` までを切り出す。
 *
 * 切り出した結果が入力そのもの(= 剥がす余地がなかった)の場合は null を返す。
 * その場合は呼び出し側が既に strict parse に失敗しているはずで、
 * 同じ文字列をもう一度 parse しても無駄なため。
 */
export function extractJsonObjectSlice(raw: string): string | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  const slice = raw.slice(start, end + 1)
  if (slice === raw.trim()) return null
  return slice
}

/**
 * JSON 文字列リテラルの中身(エスケープ済み)をデコードする。
 * `\n` や `\"` や `\uXXXX` を正しく戻すため、自前の置換ではなく JSON.parse を使う。
 */
export function decodeJsonStringLiteral(escaped: string): string | null {
  try {
    const decoded: unknown = JSON.parse(`"${escaped}"`)
    return typeof decoded === 'string' ? decoded : null
  } catch {
    return null
  }
}

/**
 * 壊れた JSON テキストから `"<field>": "..."` の値を 1 つ拾う。
 *
 * 閉じ引用符まで揃っているものだけにマッチさせる(= その値は最後まで生成されている)。
 * 途中で切れた値を拾うと文の途中で終わった英文を返答として出してしまうため、
 * 敢えて救済しない。
 *
 * field は呼び出し側のリテラルのみを想定しているため正規表現エスケープはしない。
 */
export function matchJsonStringField(raw: string, field: string): string | null {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const m = re.exec(raw)
  if (!m?.[1]) return null
  return decodeJsonStringLiteral(m[1])
}

export interface JsonStringArrayMatch {
  /** 最後まで生成されていた(閉じ引用符が揃っている)要素だけ。 */
  items: string[]
  /**
   * 配列の閉じ括弧 `]` まで出力に含まれていたか。
   *
   * **これが救済の可否を決める**。false は「num_predict 上限で配列の途中で
   * 切れた」= 残りが何件あったのか誰にも分からない状態で、拾えた分を成功として
   * 返すと、欠けたことに気付かないまま確定保存されてしまう(事実抽出は
   * 1 ターンの取りこぼしと違って永久に失われる)。
   */
  closed: boolean
}

/**
 * 壊れた JSON テキストから `"<field>": ["...", "..."]` の文字列要素を拾う。
 * フィールド自体が見つからなければ null(= 救済不能)、見つかれば結果を返す
 * (要素 0 件もあり得る)。
 *
 * 文字列リテラルを 1 つずつ読み進めることで、
 *  - 要素の中に `]` や `}` が含まれていても配列の終わりと誤認しない
 *  - ネストした配列 / オブジェクトの中身を要素として混ぜない(深さ 1 だけ拾う)
 *  - 途中で切れた(閉じ引用符が無い)最後の要素は捨てる
 * を同時に満たす。
 */
export function matchJsonStringArrayField(raw: string, field: string): JsonStringArrayMatch | null {
  const head = new RegExp(`"${field}"\\s*:\\s*\\[`).exec(raw)
  if (!head) return null
  return scanJsonStringArray(raw, head.index + head[0].length)
}

/** `[` の直後から配列を走査する。深さ 1 の文字列要素と、配列が閉じたかを返す。 */
function scanJsonStringArray(raw: string, start: number): JsonStringArrayMatch {
  const items: string[] = []
  let depth = 1
  let closed = false
  let i = start

  while (i < raw.length) {
    const ch = raw[i]!
    if (ch === '"') {
      // 文字列リテラルを読み切る。エスケープ(\" \\ 等)は 2 文字まとめて飛ばす。
      let j = i + 1
      let terminated = false
      for (; j < raw.length; j++) {
        const c = raw[j]!
        if (c === '\\') {
          j++
          continue
        }
        if (c === '"') {
          terminated = true
          break
        }
      }
      // 閉じ引用符が無い = 出力がこの要素の途中で切れた。捨てて走査も終える。
      if (!terminated) break
      if (depth === 1) {
        const decoded = decodeJsonStringLiteral(raw.slice(i + 1, j))
        if (decoded && decoded.trim().length > 0) items.push(decoded.trim())
      }
      i = j + 1
      continue
    }
    if (ch === '[' || ch === '{') {
      depth++
    } else if (ch === ']' || ch === '}') {
      depth--
      if (depth === 0) {
        // `]` で閉じたときだけ「完結した配列」とみなす。
        closed = ch === ']'
        break
      }
    }
    i++
  }

  return { items, closed }
}

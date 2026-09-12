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

/**
 * 壊れた JSON テキストから `"<field>": ["...", "..."]` の文字列要素を拾う。
 * 配列が閉じていなくても、そこまでに完結している要素は拾う。
 * フィールド自体が見つからなければ null(= 救済不能)、見つかれば配列(空もあり得る)。
 */
export function matchJsonStringArrayField(raw: string, field: string): string[] | null {
  const head = new RegExp(`"${field}"\\s*:\\s*\\[`).exec(raw)
  if (!head) return null
  const start = head.index + head[0].length
  // 要素の中に `]` が含まれると早めに切ってしまうが、救済用途では許容する
  // (ここで拾いすぎて別フィールドの文字列を混ぜる方が有害)。
  const close = raw.indexOf(']', start)
  const body = close === -1 ? raw.slice(start) : raw.slice(start, close)

  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const decoded = m[1] === undefined ? null : decodeJsonStringLiteral(m[1])
    if (decoded && decoded.trim().length > 0) out.push(decoded.trim())
  }
  return out
}

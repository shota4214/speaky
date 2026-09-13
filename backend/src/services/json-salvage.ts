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
  // キー名の内側の空白も許す。小型モデルは `" reply_ja":` のように書くことがある
  // (llama3.2:1b の挨拶で 12 件中 9 件)。
  const re = new RegExp(`"\\s*${field}\\s*"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
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

/**
 * JSON 足場の検出パターン。**先頭だけでなく全体を走査する**。
 *
 * 「先頭が `{` か」だけを見ると、
 *   Sure, here's my reply!\n\n{"reply_en": "..."}
 * のように前置きの後に JSON を書く出力(小型モデルで実際に起こる)を素通しし、
 * JSON をそのまま読み上げ・保存し、次のプロンプトにも食わせてしまう。
 *
 * 誤検出を避けるため、パターンは「自然な英会話の返答には出ない形」に絞る:
 * コードフェンス / `{` 直後のキー + コロン(引用符は無くてもよい。小型モデルは
 * `{reply_en: "..."}` と書くことがある)/ `[` 直後のオブジェクト・文字列 /
 * 出力契約の snake_case キー。波括弧 1 個や引用符付きの語句では発火しない。
 * **フロント側(utils/chat-stream-reducer.ts)と同じ判定を保つこと。**
 */
const JSON_SCAFFOLD_PATTERNS: RegExp[] = [
  /```/,
  // { "key": / {'key': / {key:  — 自然な英文には出ない形
  /\{\s*["']?[A-Za-z_][A-Za-z0-9_]{1,63}["']?\s*:/,
  /\[\s*[{"]/,
  // 出力契約のキー名(引用符付き)
  /["'](?:reply_en|reply_ja|user_said|vocabulary)["']\s*:/,
  // 引用符なしのキーは snake_case のものだけ。英単語の "vocabulary:" は
  // 「New vocabulary: hiking」のように自然な返答にも出るので含めない。
  /\b(?:reply_en|reply_ja|user_said)\s*:/,
]

/** 上のパターンのどれかを含むか(先頭が `{` かどうかは見ない)。 */
export function containsJsonScaffoldPattern(text: string): boolean {
  return JSON_SCAFFOLD_PATTERNS.some((re) => re.test(text))
}

/** JSON / コードフェンスが混ざっていないか(先頭に限らず走査する)。 */
export function looksLikeJsonScaffold(text: string): boolean {
  // 先頭が波括弧なら、キーがまだ届いていなくても JSON と判断する
  // (30 文字のプローブ窓では `{\n  "reply_en` の途中で切れることがある)。
  // 角括弧は `[Laughs] Oh really?` のような書き方があり得るので、
  // 直後がオブジェクト / 文字列のときだけ JSON 配列とみなす。
  if (/^\s*\{/.test(text)) return true
  if (/^\s*\[\s*[{"']/.test(text)) return true
  return containsJsonScaffoldPattern(text)
}

/**
 * 「JSON の始まりかもしれない文字」の位置(from 以降の最初の `{` / `[` / バッククォート)。
 * チャンクは細切れに届くので、`{` を delta として送ってから `"reply_en":` が
 * 完成しても手遅れになる。疑わしい文字が出た時点で **いったん止める** ために使う。
 */
export function findScaffoldOpener(text: string, from: number): number {
  const idx = text.slice(from).search(/[{[`]/)
  return idx === -1 ? -1 : from + idx
}

/** 「前置きの自然文 → JSON」の出力から、前置きの自然文だけを取り出す。 */
export function proseBeforeScaffold(raw: string): string | null {
  let cut = -1
  for (const re of JSON_SCAFFOLD_PATTERNS) {
    const m = re.exec(raw)
    if (m && (cut === -1 || m.index < cut)) cut = m.index
  }
  const brace = raw.search(/[{[]/)
  if (brace !== -1 && (cut === -1 || brace < cut)) cut = brace
  if (cut <= 0) return null
  const prose = raw.slice(0, cut).trim()
  if (prose.length < 12 || !/[A-Za-z]/.test(prose)) return null
  if (looksLikeJsonScaffold(prose)) return null
  return prose
}

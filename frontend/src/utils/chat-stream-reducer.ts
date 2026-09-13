import type { ModelProfileLevel } from '../storage/settings'
import type { Mode, VocabItem } from '../db/types'

/**
 * 会話ストリーム(SSE)のイベント列を畳み込む **純粋な** リデューサ。
 *
 * ここに fetch も Vue も DOM も持ち込まないのは、vitest の environment が 'node'
 * だから(jsdom 無し)。ネットワークを一切張らずに
 *   「途切れた」「JSON を吐いた」「done が来なかった」「enrich が後から来た」
 * を全部テストできる状態を保つ。
 *
 * バックエンドが送ってくるイベント(data-only SSE。type は JSON の中に入っている):
 *   {"type":"meta","mode":"normal","model":"...","speakDeltas":true,"profile":"small"}
 *   {"type":"delta","text":" I went"}
 *   {"type":"done","text":"<英文全体>","replyJa":"..."(翻訳モードのみ)}
 *   {"type":"enrich","replyJa":"...","feedback":{...}|null,"vocabulary":[...]}
 *   {"type":"feedback","feedback":{"user_said":"...","corrected":"...","explanation":"..."}}
 *   {"type":"error","code":"TIMEOUT","error":"..."}
 *
 * `feedback` は enrich の **後** に届く添削(grammar-check 対応の backend だけが送る)。
 * 表示できる添削が無いターンでは届かない。
 */

export interface StreamFeedback {
  user_said: string
  corrected: string
  explanation: string
}

export interface ChatEnrichment {
  replyJa: string
  feedback: StreamFeedback | null
  vocabulary: VocabItem[]
}

export interface ChatStreamMeta {
  mode: Mode
  model: string | null
  /** false = このターンはデルタを読み上げない(日本語/混在入力の翻訳ターン)。 */
  speakDeltas: boolean
  /**
   * backend が実際に使った会話プロファイル。
   * 'model-profile' を知らない古いバックエンドは送らないので null。
   */
  profile: ModelProfileLevel | null
}

export interface ChatStreamError {
  code: string | null
  message: string
}

/**
 * リデューサが「呼び出し側にやってほしいこと」を返す形。
 * 副作用(読み上げ・DB 保存)はすべてここを経由するので、リデューサ本体は純粋に保てる。
 */
export type ChatStreamEffect =
  | { type: 'speak'; text: string }
  | { type: 'done'; text: string; replyJa: string | null }
  | { type: 'enrich'; enrichment: ChatEnrichment }
  | { type: 'feedback'; feedback: StreamFeedback }
  | { type: 'error'; error: ChatStreamError }

export interface ChatStreamState {
  meta: ChatStreamMeta | null
  /** 受け取った delta の累積(生のまま)。 */
  raw: string
  /** すでに speak 効果として外へ出した文字数。 */
  released: number
  /** 先頭の JSON 足場チェックが済んだか。 */
  probed: boolean
  /** JSON 足場を検出したので読み上げを止めているか。 */
  suppressed: boolean
  /** done で確定した英文。 */
  replyEn: string | null
  /** done に同梱された日本語訳(翻訳ターンのみ)。 */
  replyJa: string | null
  enrich: ChatEnrichment | null
  /** enrich の後に届いた添削(grammar-check)。 */
  feedback: StreamFeedback | null
  error: ChatStreamError | null
  done: boolean
}

/**
 * JSON 足場の判定に覗く先頭文字数。
 * バックエンドの SCAFFOLD_PROBE_CHARS と SentenceAccumulator の firstEmitMinChars
 * と同じ 30。ここが小さすぎると判定前に喋り出し、大きすぎると最初の発話が遅れる。
 */
export const SCAFFOLD_PROBE_CHARS = 30

/**
 * JSON 足場の検出パターン。**先頭だけでなく全体を走査する**。
 *
 * 「先頭が `{` か」だけを見ていると、
 *   Sure, here's my reply!\n\n{"reply_en": "..."}
 * のように前置き → JSON と続く出力を素通しして、JSON をそのまま読み上げ・保存し、
 * 次のプロンプトにも食わせてしまう(小型モデルで実際に起こる出力)。
 *
 * 誤検出を避けるため、パターンは「自然な英会話の返答には出ない形」に絞ってある:
 *  - コードフェンス
 *  - `{` の直後にキー + コロン(引用符は無くてもよい。小型モデルは
 *    `{reply_en: "..."}` や `{'reply_en': ...}` と書くことがある)
 *  - `[` の直後にオブジェクト / 文字列の開始
 *  - 出力契約のキー名そのもの(snake_case なので英文には現れない)
 * 単なる波括弧 1 個や、引用符で括った語句(He said "hi": ...)では発火しない。
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
function containsJsonScaffoldPattern(text: string): boolean {
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
 * デルタは 1 トークンずつ届くので、`{` を読み上げに回してから `"reply_en":` が
 * 完成しても手遅れになる。疑わしい文字が出た時点で **いったん止める** ために使う。
 */
export const SCAFFOLD_OPENERS = /[{[`]/

function findScaffoldOpener(text: string, from: number): number {
  const idx = text.slice(from).search(SCAFFOLD_OPENERS)
  return idx === -1 ? -1 : from + idx
}

/**
 * 「前置きの自然文 → JSON」の出力から、前置きの自然文だけを取り出す。
 * JSON の reply_en を拾えなかったときの最後の手段。
 */
function proseBeforeScaffold(raw: string): string | null {
  let cut = -1
  for (const re of JSON_SCAFFOLD_PATTERNS) {
    const m = re.exec(raw)
    if (m && (cut === -1 || m.index < cut)) cut = m.index
  }
  const brace = raw.search(/[{[]/)
  if (brace !== -1 && (cut === -1 || brace < cut)) cut = brace
  if (cut <= 0) return null
  const prose = raw.slice(0, cut).trim()
  // 記号だけ / 短すぎる断片は「文」とは呼べないので採用しない。
  if (prose.length < 12 || !/[A-Za-z]/.test(prose)) return null
  if (looksLikeJsonScaffold(prose)) return null
  return prose
}

/**
 * プレーンテキストのはずが JSON で返ってきたときに英文を救い出す。
 * バックエンドにも同じ救済があるが、ここは「バックエンドがすり抜けた場合でも
 * ユーザーに `{"reply_en": ...` を読み上げさせない」ための最後の砦。
 */
export function salvageReplyText(raw: string): string | null {
  // 1) 素直に JSON として読めるなら reply_en を取る
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
      if (typeof parsed.reply_en === 'string' && parsed.reply_en.trim()) {
        return parsed.reply_en.trim()
      }
    } catch {
      // 続けて正規表現での救出を試みる
    }
  }
  // 2) 途中で切れた JSON から "reply_en": "..." だけ拾う(閉じ引用符まで揃っているもの)
  const m = /"reply_en"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)
  if (m?.[1]) {
    try {
      const decoded = JSON.parse(`"${m[1]}"`) as unknown
      if (typeof decoded === 'string' && decoded.trim()) return decoded.trim()
    } catch {
      // ignore
    }
  }
  // 3) コードフェンスだけを剥がす
  const unfenced = raw
    .replace(/^\s*```[a-zA-Z]*\s*/, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  if (unfenced && !looksLikeJsonScaffold(unfenced)) return unfenced
  // 4) 前置きの自然文 → JSON、の前置きだけを拾う
  return proseBeforeScaffold(raw)
}

export function initialChatStreamState(): ChatStreamState {
  return {
    meta: null,
    raw: '',
    released: 0,
    probed: false,
    suppressed: false,
    replyEn: null,
    replyJa: null,
    enrich: null,
    feedback: null,
    error: null,
    done: false,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  return value as Record<string, unknown>
}

function parseVocabulary(value: unknown): VocabItem[] {
  if (!Array.isArray(value)) return []
  const out: VocabItem[] = []
  for (const item of value) {
    const r = asRecord(item)
    if (!r) continue
    if (typeof r.word !== 'string' || typeof r.meaning !== 'string') continue
    out.push({
      word: r.word,
      meaning: r.meaning,
      example: typeof r.example === 'string' ? r.example : null,
    })
  }
  return out.slice(0, 3)
}

function parseFeedback(value: unknown): StreamFeedback | null {
  const r = asRecord(value)
  if (!r) return null
  if (
    typeof r.user_said !== 'string' ||
    typeof r.corrected !== 'string' ||
    typeof r.explanation !== 'string'
  ) {
    return null
  }
  return { user_said: r.user_said, corrected: r.corrected, explanation: r.explanation }
}

function parseEnrichment(r: Record<string, unknown>): ChatEnrichment {
  return {
    replyJa: typeof r.replyJa === 'string' ? r.replyJa : '',
    feedback: parseFeedback(r.feedback),
    vocabulary: parseVocabulary(r.vocabulary),
  }
}

function speakDeltasOf(state: ChatStreamState): boolean {
  // meta が来ていない場合は「喋ってよい」に倒す(通常は meta が先頭に来る)。
  return state.meta?.speakDeltas ?? true
}

export interface ReduceResult {
  state: ChatStreamState
  effects: ChatStreamEffect[]
}

/**
 * イベントを 1 つ畳み込む。state は破壊しない(常に新しいオブジェクトを返す)。
 */
export function reduceChatStreamEvent(state: ChatStreamState, event: unknown): ReduceResult {
  const r = asRecord(event)
  if (!r || typeof r.type !== 'string') return { state, effects: [] }

  switch (r.type) {
    case 'meta': {
      const mode = r.mode
      return {
        state: {
          ...state,
          meta: {
            mode:
              mode === 'normal' || mode === 'japanese_help' || mode === 'mixed' ? mode : 'normal',
            model: typeof r.model === 'string' ? r.model : null,
            speakDeltas: r.speakDeltas !== false,
            profile: r.profile === 'small' || r.profile === 'standard' ? r.profile : null,
          },
        },
        effects: [],
      }
    }

    case 'delta': {
      const text = typeof r.text === 'string' ? r.text : ''
      // 終端(done / error)の後に届いた delta は捨てる。
      if (!text || state.done || state.error) return { state, effects: [] }
      const raw = state.raw + text
      const next: ChatStreamState = { ...state, raw }

      if (!speakDeltasOf(state)) return { state: next, effects: [] }
      if (next.suppressed) return { state: next, effects: [] }

      if (!next.probed) {
        // 先頭 30 文字が貯まるまでは外へ出さない。
        // ここで溜めているぶん、JSON を吐き始めたモデルを「1 文字も読み上げる前に」
        // 捕まえられる。30 文字未満で done が来た場合は done 側でまとめて出す。
        if (raw.length < SCAFFOLD_PROBE_CHARS) return { state: next, effects: [] }
        next.probed = true
        if (looksLikeJsonScaffold(raw.slice(0, SCAFFOLD_PROBE_CHARS))) {
          next.suppressed = true
          return { state: next, effects: [] }
        }
      }

      // 途中から JSON に化ける出力(前置きの自然文 → JSON)を捕まえる。
      // `{` を見た時点でいったん止め、その先が JSON なら読み上げに回さない。
      const opener = findScaffoldOpener(raw, next.released)
      if (opener !== -1) {
        const tail = raw.slice(opener)
        if (containsJsonScaffoldPattern(tail)) {
          next.suppressed = true
          return { state: next, effects: [] }
        }
        if (tail.length < SCAFFOLD_PROBE_CHARS) {
          // まだ判断がつかない。疑わしい文字の **手前まで** を読み上げに回す。
          const head = raw.slice(next.released, opener)
          next.released = opener
          return { state: next, effects: head ? [{ type: 'speak', text: head }] : [] }
        }
        // 30 文字見ても JSON にならなかった = ただの記号(「{1, 2, 3} は集合」等)。
      }

      const pending = raw.slice(next.released)
      next.released = raw.length
      return { state: next, effects: pending ? [{ type: 'speak', text: pending }] : [] }
    }

    case 'done': {
      // 2 通目の終端イベント(現行バックエンドは出さないが、出ても
      // 二重に読み上げ・二重に保存しないよう畳む)。
      if (state.done || state.error) return { state, effects: [] }
      const provided = typeof r.text === 'string' ? r.text : ''
      let finalText = (provided || state.raw).trim()
      // 先頭だけでなく **全文** を見る。前置き → JSON の出力はここでしか捕まらない。
      if (state.suppressed || looksLikeJsonScaffold(finalText)) {
        const salvaged = salvageReplyText(finalText)
        if (!salvaged) {
          const error: ChatStreamError = {
            code: 'MALFORMED',
            message: 'AI の返答を読み取れませんでした。',
          }
          return {
            state: { ...state, done: true, error },
            effects: [{ type: 'error', error }],
          }
        }
        finalText = salvaged
      }
      if (!finalText) {
        const error: ChatStreamError = { code: 'EMPTY', message: 'AI の返答が空でした。' }
        return { state: { ...state, done: true, error }, effects: [{ type: 'error', error }] }
      }

      const replyJa = typeof r.replyJa === 'string' && r.replyJa.trim() ? r.replyJa : null
      const effects: ChatStreamEffect[] = []

      // まだ読み上げに回していない残りを出す。
      //
      // speakDeltas が false のターン(日本語/混在入力の翻訳)はここが唯一の
      // 読み上げ経路になる。released が 0 なので全文が 1 回で出る =
      // 現行リリースとまったく同じ挙動。
      //
      // done の本文がストリームで受け取った内容と食い違う(= salvage された)場合、
      // 既に読み上げ済みのぶんは取り消せないので、続きが取れるときだけ足す。
      //
      // ⚠️ finalText は trim 済みで、raw は先頭に空白 / 改行を含むことがある。
      // 生の released 長で切ると 1 文字ずれて「残りを喋らない」ことがあるので、
      // 先頭の空白ぶんを差し引いた「読み上げ済みの本文」で比較する。
      const leading = state.raw.length - state.raw.trimStart().length
      const releasedText = state.raw.slice(leading, Math.max(leading, state.released))
      if (state.released === 0 || !releasedText) {
        effects.push({ type: 'speak', text: finalText })
      } else if (finalText.startsWith(releasedText)) {
        const rest = finalText.slice(releasedText.length)
        if (rest.trim()) effects.push({ type: 'speak', text: rest })
      }
      effects.push({ type: 'done', text: finalText, replyJa })

      return {
        state: {
          ...state,
          done: true,
          probed: true,
          replyEn: finalText,
          replyJa,
          released: finalText.length,
        },
        effects,
      }
    }

    case 'enrich': {
      const enrichment = parseEnrichment(r)
      // 日本語訳が空の enrich は **成功ではない**。ここで通すと呼び出し側が
      // 「準備中」を解除してしまい、訳も無い・エラーも無い・再取得もできない
      // 行が残る(DB の replyJa も null のまま)。届かなかったものとして扱う。
      if (!enrichment.replyJa.trim()) {
        console.warn('[chat-stream] enrich に日本語訳が無いので失敗として扱う')
        return { state, effects: [] }
      }
      return {
        state: { ...state, enrich: enrichment },
        effects: [{ type: 'enrich', enrichment }],
      }
    }

    case 'feedback': {
      // 添削は enrich と同じく後追い。形が壊れていたら何も表示しない(エラーにもしない)。
      const feedback = parseFeedback(r.feedback)
      if (!feedback) return { state, effects: [] }
      return {
        state: { ...state, feedback },
        effects: [{ type: 'feedback', feedback }],
      }
    }

    case 'error': {
      // 成功後に届いたエラーは無視する(既に読み上げ・保存が終わっている)。
      if (state.done || state.error) return { state, effects: [] }
      const error: ChatStreamError = {
        code: typeof r.code === 'string' ? r.code : null,
        message: typeof r.error === 'string' && r.error ? r.error : 'AI の返答生成に失敗しました。',
      }
      return { state: { ...state, error }, effects: [{ type: 'error', error }] }
    }

    default:
      // 知らない type は無視する(将来バックエンドがイベントを足しても壊れない)。
      return { state, effects: [] }
  }
}

/**
 * ストリームが閉じた時点の後始末。
 * done も error も無いまま閉じた = 途中で切れたので、失敗として扱う。
 * (enrich が来ないまま閉じるのは正常。日本語訳は別途 retry できる)
 */
export function finalizeChatStream(state: ChatStreamState): ReduceResult {
  if (state.done || state.error) return { state, effects: [] }
  const error: ChatStreamError = {
    code: 'TRUNCATED',
    message: 'AI の返答が途中で途切れました。',
  }
  return { state: { ...state, error }, effects: [{ type: 'error', error }] }
}

/**
 * 添削(文法チェック)の **決定的な後段**: モデルの書き直しを受け入れてよいかの判定と、
 * 変更の分類、そして **固定の日本語テンプレート** による説明文。
 *
 * ── なぜモデルに説明を書かせないのか ──
 * 実モデル評価で、モデルが書いた説明は英語 / 崩れた日本語 / 中国語になっていた。
 * 学習者に見せる説明は「こちらが書いた文面」だけにする。モデルに任せるのは
 * 「文を最小限に直す(正しければそのまま繰り返す)」ことだけで、その差分を
 * ここで単語単位に分解し、**全部の変更がテンプレートで説明できたときだけ**表示する。
 *
 * ── 出どころ ──
 * 研究段階のプロトタイプ(scratchpad の correction-research/filter.mjs)を
 * **そのまま移植**したもの。140 件のラベル付き発話 × 2 モデルの記録済み出力に対して、
 * 研究時と同じ判定・分類・説明文を返すことを `correction-guard.test.ts` が固定している
 * (fixtures/grammar-correction-research.json)。**ルールを変えるときはそのテストを
 * 先に見ること**。1 件でも判定が変わるなら、正しい文を「間違い」と言う率(0/78)と
 * 直せた率(49/62)を測り直す必要がある。
 *
 * 移植で意図的に変えた点は 1 つだけ: 説明文の差し込み位置に入る語が存在しない
 * (プロトタイプでは例外で落ちるか「undefined」と表示される)場合は、
 * 説明できない変更として扱う(= 表示しない)。記録済みの 280 件ではこの経路を通らない。
 *
 * **このファイルは node/DOM の API を一切使わない**(純粋関数のみ)。
 * backend(grammar-check.ts)と frontend(履歴画面で保存済みの添削を検証し直す
 * utils/stored-feedback.ts)の **両方がこの 1 つの実装を使う**。
 * 置き場所が shared/ なのはそのため(request-budget.ts / text-guards.ts と同じ)。
 */

import { containsNonLatinScript } from './text-guards.js'

// ---------------------------------------------------------------- word classes
const ARTICLES: ReadonlySet<string> = new Set(['a', 'an', 'the'])
const DETERMINERS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  'some',
  'any',
  'many',
  'much',
  'a_lot_of',
  'lots_of',
  'every',
  'each',
  'no',
])
const PREPOSITIONS: ReadonlySet<string> = new Set([
  'in',
  'on',
  'at',
  'to',
  'for',
  'from',
  'with',
  'about',
  'of',
  'by',
  'into',
  'onto',
  'during',
  'since',
  'until',
  'till',
  'around',
  'near',
  'over',
  'under',
  'after',
  'before',
  'through',
  'without',
  'toward',
  'towards',
])
const BE: ReadonlySet<string> = new Set(['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being'])
const DO: ReadonlySet<string> = new Set(['do', 'does', 'did'])
const HAVE: ReadonlySet<string> = new Set(['have', 'has', 'had'])
const MODALS: ReadonlySet<string> = new Set([
  'will',
  'would',
  'can',
  'could',
  'shall',
  'should',
  'may',
  'might',
  'must',
])
const AUX: ReadonlySet<string> = new Set([...BE, ...DO, ...HAVE, ...MODALS])
const SUBJECT_PRONOUNS: ReadonlySet<string> = new Set(['i', 'you', 'he', 'she', 'it', 'we', 'they'])
const PRONOUNS: ReadonlySet<string> = new Set([
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'its',
  'our',
  'their',
  'mine',
  'yours',
  'hers',
  'ours',
  'theirs',
  'myself',
  'yourself',
])
const INTENSIFIERS: ReadonlySet<string> = new Set(['very', 'really', 'so', 'too'])
const NUMBER_WORDS: ReadonlySet<string> = new Set([
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
  'hundred',
  'thousand',
  'million',
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'half',
  'dozen',
])
const PLURAL_CUES: ReadonlySet<string> = (() => {
  const s = new Set([
    ...NUMBER_WORDS,
    'many',
    'several',
    'few',
    'these',
    'those',
    'both',
    'a_lot_of',
    'lots_of',
  ])
  s.delete('one')
  s.delete('first')
  s.delete('half')
  return s
})()
const SINGULAR_CUES: ReadonlySet<string> = new Set([
  'every',
  'each',
  'one',
  'a',
  'an',
  'this',
  'that',
])
const UNCOUNTABLE: ReadonlySet<string> = new Set([
  'bread',
  'homework',
  'advice',
  'information',
  'furniture',
  'luggage',
  'baggage',
  'money',
  'water',
  'music',
  'news',
  'work',
  'equipment',
  'knowledge',
  'fun',
  'weather',
  'traffic',
  'rice',
  'hair',
  'paper',
  'research',
  'evidence',
  'feedback',
  'housework',
  'milk',
  'coffee',
  'tea',
  'meat',
  'fruit',
  'staff',
  'jewelry',
  'scenery',
  'stuff',
  'progress',
  'software',
  'sushi',
])
const GERUND_VERBS: ReadonlySet<string> = new Set([
  'enjoy',
  'enjoyed',
  'enjoys',
  'finish',
  'finished',
  'finishes',
  'mind',
  'minded',
  'avoid',
  'avoided',
  'practice',
  'practiced',
  'keep',
  'kept',
  'quit',
  'suggest',
  'suggested',
  'miss',
  'missed',
  'imagine',
])
const STATIVE_VERBS_NO_BE: ReadonlySet<string> = new Set([
  'agree',
  'like',
  'want',
  'know',
  'think',
  'live',
  'work',
  'go',
  'have',
  'need',
  'love',
  'hope',
  'understand',
  'remember',
  'believe',
])
const WH: ReadonlySet<string> = new Set(['what', 'where', 'when', 'why', 'who', 'how', 'which'])
const CASUAL: ReadonlySet<string> = new Set([
  'yeah',
  'yep',
  'yup',
  'nope',
  'nah',
  'oh',
  'wow',
  'um',
  'uh',
  'hmm',
  'ok',
  'okay',
  'cool',
  'lol',
])
const MONTHS: ReadonlySet<string> = new Set([
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
])
const DAYS: ReadonlySet<string> = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
])

/** 不規則動詞: [原形, 過去形, 過去分詞]。 */
const IRREGULAR: readonly (readonly [string, string, string])[] = [
  ['be', 'was', 'been'],
  ['be', 'were', 'been'],
  ['go', 'went', 'gone'],
  ['do', 'did', 'done'],
  ['have', 'had', 'had'],
  ['buy', 'bought', 'bought'],
  ['eat', 'ate', 'eaten'],
  ['see', 'saw', 'seen'],
  ['come', 'came', 'come'],
  ['take', 'took', 'taken'],
  ['get', 'got', 'gotten'],
  ['make', 'made', 'made'],
  ['write', 'wrote', 'written'],
  ['drink', 'drank', 'drunk'],
  ['run', 'ran', 'run'],
  ['give', 'gave', 'given'],
  ['know', 'knew', 'known'],
  ['think', 'thought', 'thought'],
  ['meet', 'met', 'met'],
  ['feel', 'felt', 'felt'],
  ['leave', 'left', 'left'],
  ['tell', 'told', 'told'],
  ['say', 'said', 'said'],
  ['read', 'read', 'read'],
  ['swim', 'swam', 'swum'],
  ['sing', 'sang', 'sung'],
  ['begin', 'began', 'begun'],
  ['speak', 'spoke', 'spoken'],
  ['wake', 'woke', 'woken'],
  ['sleep', 'slept', 'slept'],
  ['teach', 'taught', 'taught'],
  ['bring', 'brought', 'brought'],
  ['catch', 'caught', 'caught'],
  ['forget', 'forgot', 'forgotten'],
  ['lose', 'lost', 'lost'],
  ['pay', 'paid', 'paid'],
  ['send', 'sent', 'sent'],
  ['spend', 'spent', 'spent'],
  ['stand', 'stood', 'stood'],
  ['understand', 'understood', 'understood'],
  ['win', 'won', 'won'],
  ['break', 'broke', 'broken'],
  ['choose', 'chose', 'chosen'],
  ['drive', 'drove', 'driven'],
  ['fly', 'flew', 'flown'],
  ['grow', 'grew', 'grown'],
  ['hear', 'heard', 'heard'],
  ['hold', 'held', 'held'],
  ['keep', 'kept', 'kept'],
  ['ride', 'rode', 'ridden'],
  ['sell', 'sold', 'sold'],
  ['sit', 'sat', 'sat'],
  ['wear', 'wore', 'worn'],
  ['find', 'found', 'found'],
  ['fall', 'fell', 'fallen'],
  ['throw', 'threw', 'thrown'],
  ['put', 'put', 'put'],
  ['cut', 'cut', 'cut'],
  ['let', 'let', 'let'],
  ['cost', 'cost', 'cost'],
  ['hurt', 'hurt', 'hurt'],
  ['build', 'built', 'built'],
  ['lend', 'lent', 'lent'],
  ['feed', 'fed', 'fed'],
  ['become', 'became', 'become'],
  ['draw', 'drew', 'drawn'],
  ['show', 'showed', 'shown'],
  ['wear', 'wore', 'worn'],
]

type FormKind = 'base' | 'past' | 'participle' | 'present'
interface VerbForm {
  base: string
  kind: FormKind
}

const FORM_OF: ReadonlyMap<string, VerbForm> = (() => {
  const m = new Map<string, VerbForm>()
  for (const [b, p, pp] of IRREGULAR) {
    m.set(b, { base: b, kind: 'base' })
    if (!m.has(p) || m.get(p)!.kind === 'base') m.set(p, { base: b, kind: 'past' })
    if (!m.has(pp)) m.set(pp, { base: b, kind: 'participle' })
  }
  for (const f of ['am', 'is', 'are']) m.set(f, { base: 'be', kind: 'present' })
  m.set('has', { base: 'have', kind: 'present' })
  m.set('does', { base: 'do', kind: 'present' })
  m.set('goes', { base: 'go', kind: 'present' })
  return m
})()

const STEM_RULES: readonly (readonly [RegExp, string])[] = [
  [/ies$/, 'y'],
  [/ied$/, 'y'],
  [/ier$/, 'y'],
  [/iest$/, 'y'],
  [/es$/, ''],
  [/s$/, ''],
  [/ed$/, ''],
  [/ed$/, 'e'],
  [/d$/, ''],
  [/ing$/, ''],
  [/ing$/, 'e'],
  [/er$/, ''],
  [/er$/, 'e'],
  [/est$/, ''],
  [/est$/, 'e'],
]

/** 粗い見出し語化: 不規則動詞表 → 接尾辞の剥がし。候補の集合を返す。 */
function stems(w: string): Set<string> {
  const out = new Set([w])
  const f = FORM_OF.get(w)
  if (f) out.add(f.base)
  for (const [re, rep] of STEM_RULES) if (re.test(w) && w.length > 3) out.add(w.replace(re, rep))
  // 子音の重複: stopped -> stop, bigger -> big
  for (const s of [...out]) if (/([bdgmnprt])\1$/.test(s)) out.add(s.slice(0, -1))
  return out
}

function sameLemma(a: string, b: string): boolean {
  if (a === b) return true
  const sa = stems(a)
  const sb = stems(b)
  for (const x of sa) if (sb.has(x) && x.length >= 2) return true
  return false
}

const isNumber = (w: string): boolean => /^\d/.test(w) || NUMBER_WORDS.has(w)

// ---------------------------------------------------------------- tokenizer
const CONTRACTIONS: readonly (readonly [RegExp, string])[] = [
  [/\bcan't\b/g, 'can not'],
  [/\bcannot\b/g, 'can not'],
  [/\bwon't\b/g, 'will not'],
  [/\bshan't\b/g, 'shall not'],
  [/\b(\w+)n't\b/g, '$1 not'],
  [/\b(it|he|she|that|there|what|who|where)'s been\b/g, '$1 has been'],
  [/\b(it|he|she|that|there|what|who|where|how)'s\b/g, '$1 is'],
  [/\bi'm\b/g, 'i am'],
  [/\b(\w+)'re\b/g, '$1 are'],
  [/\b(\w+)'ve\b/g, '$1 have'],
  [/\b(\w+)'ll\b/g, '$1 will'],
  [/\b(i|you|he|she|we|they)'d\b/g, '$1 would'],
  [/\bgonna\b/g, 'going to'],
  [/\bwanna\b/g, 'want to'],
  [/\bgotta\b/g, 'got to'],
  [/\bkinda\b/g, 'kind of'],
  [/\bsorta\b/g, 'sort of'],
  [/\ba lot of\b/g, 'a_lot_of'],
  [/\blots of\b/g, 'lots_of'],
]

/** 小文字化・短縮形の展開・記号の除去をした単語列。 */
export function tokenize(s: string): string[] {
  let t = ` ${s} `.replace(/[’‘`]/g, "'").toLowerCase()
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep)
  t = t.replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
  return t
    .replace(/[^a-z0-9_' ]+/g, ' ')
    .replace(/(^|\s)'|'(\s|$)/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** 文頭以外で大文字始まりの語(固有名詞の目印)。 */
function surfaceCapitalized(s: string): Set<string> {
  const words = s
    .replace(/[^A-Za-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const caps = new Set<string>()
  words.forEach((w, i) => {
    if (i > 0 && /^[A-Z][a-z]/.test(w) && w !== 'I') caps.add(w.toLowerCase().replace(/'s$/, ''))
  })
  return caps
}

// ---------------------------------------------------------------- word diff
export type EditOp =
  | { op: 'sub'; a: string; b: string; i: number; j: number; paired?: boolean }
  | { op: 'del'; a: string; i: number; j: number; paired?: boolean }
  | { op: 'ins'; b: string; i: number; j: number; paired?: boolean }
  | { op: 'move'; a: string; i: number; j: number; swapWith?: string; paired?: boolean }

type SubOp = Extract<EditOp, { op: 'sub' }>
type DelOp = Extract<EditOp, { op: 'del' }>
type InsOp = Extract<EditOp, { op: 'ins' }>

/** 単語単位の編集距離と、編集操作の列(削除 + 挿入の同じ語は move にまとめる)。 */
export function wordDiff(
  a: readonly string[],
  b: readonly string[],
): { ops: EditOp[]; distance: number } {
  const n = a.length
  const m = b.length
  const d = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 0; i <= n; i++) d[i]![0] = i
  for (let j = 0; j <= m; j++) d[0]![j] = j
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
      )
  const ops: EditOp[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && d[i]![j] === d[i - 1]![j - 1]) {
      i--
      j--
      continue
    }
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + 1) {
      ops.push({ op: 'sub', a: a[i - 1]!, b: b[j - 1]!, i: i - 1, j: j - 1 })
      i--
      j--
      continue
    }
    if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      ops.push({ op: 'del', a: a[i - 1]!, i: i - 1, j })
      i--
      continue
    }
    ops.push({ op: 'ins', b: b[j - 1]!, i, j: j - 1 })
    j--
  }
  ops.reverse()
  // 同じ語の del + ins は move(語順の入れ替え)にまとめる
  const moves: EditOp[] = []
  for (const del of ops.filter((o): o is DelOp => o.op === 'del')) {
    const ins = ops.find((o): o is InsOp => o.op === 'ins' && o.b === del.a && !o.paired)
    if (ins) {
      ins.paired = true
      del.paired = true
      moves.push({ op: 'move', a: del.a, i: del.i, j: ins.j })
    }
  }
  // 隣り合う 2 語の入れ替え(what is this -> what this is)も move
  const rest = ops.filter((o) => !o.paired)
  for (let k = 0; k + 1 < rest.length; k++) {
    const x = rest[k]!
    const y = rest[k + 1]!
    if (x.op === 'sub' && y.op === 'sub' && y.i === x.i + 1 && x.a === y.b && x.b === y.a) {
      x.paired = y.paired = true
      moves.push({ op: 'move', a: x.a, i: x.i, j: x.j + 1, swapWith: x.b })
    }
  }
  return { ops: [...ops.filter((o) => !o.paired), ...moves], distance: d[n]![m]! }
}

// ---------------------------------------------------------------- extraction of the model output
export type CorrectionOutputStyle = 'echo' | 'sentinel' | 'category' | 'json'

export interface ExtractedCorrection {
  /** 「直すところは無い」を表す出力(OK / correct / 空の JSON 判定)。 */
  sentinel: boolean
  text: string
  label: string[] | null
  malformed?: boolean
}

/** モデルの生出力から「直した文」を 1 行だけ取り出す。 */
export function extractCorrection(
  raw: unknown,
  style: CorrectionOutputStyle = 'echo',
): ExtractedCorrection {
  let s = String(raw ?? '')
  let label: string[] | null = null
  if (style === 'json') {
    try {
      const o = JSON.parse(s) as { has_error?: unknown; corrected?: unknown }
      if (o.has_error !== true) return { sentinel: true, text: '', label }
      s = typeof o.corrected === 'string' ? o.corrected : ''
    } catch {
      return { sentinel: true, text: '', label, malformed: true }
    }
  }
  s = s.replace(/<\/?said>/gi, '').trim()
  s =
    s
      .split(/\r?\n/)
      .map((x) => x.trim())
      .find((x) => x) ?? ''
  s = s.replace(/^(corrected( sentence)?|correction|output|answer)\s*[:：]\s*/i, '')
  if (style === 'category') {
    const m = s.match(/^([a-z][a-z\- ,]*?)\s*:\s*(.+)$/i)
    if (m && !/^(ok)$/i.test(s)) {
      label = m[1]!.toLowerCase().split(/\s*,\s*/)
      s = m[2]!
    }
  }
  s = s.replace(/^["'「『]\s*|\s*["'」』]$/g, '').trim()
  if (/^(ok|correct|no (mistakes?|errors?))[.!]?$/i.test(s))
    return { sentinel: true, text: '', label }
  return { sentinel: false, text: s, label }
}

// ---------------------------------------------------------------- the filter
export interface GuardOptions {
  /** これより短い発話は判定しない(= 表示しない)。 */
  minWords: number
  /** 編集操作がこれより多い書き直しは「直しすぎ」として捨てる。 */
  maxOps: number
  rules: boolean
}

export const FILTER_DEFAULTS: GuardOptions = { minWords: 3, maxOps: 3, rules: true }

export type GuardVerdict = 'nochange' | 'accept' | 'reject' | 'skip'

export interface GuardResult {
  verdict: GuardVerdict
  corrected?: string
  reasons: string[]
  ops: EditOp[]
}

/**
 * 許してよいのは **閉じた語類の変更**(冠詞・前置詞・助動詞・be 動詞・代名詞主語の補い)と
 * **同じ語の語形変化**(go → went, friend → friends)と **語順の入れ替え** だけ。
 * 内容語の差し替え・数字・固有名詞・カジュアルな言い方への手出しは捨てる。
 */
export function guard(
  original: string,
  candidate: string,
  opts: Partial<GuardOptions> = {},
): GuardResult {
  const o: GuardOptions = { ...FILTER_DEFAULTS, ...opts }
  const reasons: string[] = []
  const A = tokenize(original)
  if (A.length < o.minWords) return { verdict: 'skip', reasons: ['too-short'], ops: [] }
  if (!candidate) return { verdict: 'nochange', reasons: [], ops: [] }
  // ラテン文字(〜U+024F)と曲がった引用符・三点リーダ以外が 1 文字でもあれば英文ではない
  if (/[^ -ɏ‘-”…]/.test(candidate)) {
    return { verdict: 'reject', reasons: ['non-latin'], ops: [] }
  }
  const B = tokenize(candidate)
  if (B.length === 0) return { verdict: 'nochange', reasons: [], ops: [] }
  const { ops } = wordDiff(A, B)
  if (ops.length === 0) return { verdict: 'nochange', reasons: [], ops }
  if (!o.rules) return { verdict: 'accept', corrected: candidate, reasons, ops }

  if (ops.length > o.maxOps) reasons.push(`too-many-edits:${ops.length}`)
  const caps = surfaceCapitalized(original)

  for (const op of ops) {
    const touched = op.op === 'ins' ? [] : [op.a]
    for (const w of touched) {
      if (isNumber(w) && op.op !== 'move') reasons.push(`number:${w}`)
      if (caps.has(w) && op.op !== 'move') reasons.push(`proper-noun:${w}`)
      if (CASUAL.has(w)) reasons.push(`casual:${w}`)
    }
    if (op.op === 'sub') {
      const { a, b } = op
      const bothIn = (set: ReadonlySet<string>): boolean => set.has(a) && set.has(b)
      if (PRONOUNS.has(a) || PRONOUNS.has(b)) {
        reasons.push(`pronoun-sub:${a}->${b}`)
        continue
      }
      if (isNumber(b)) {
        reasons.push(`number:${b}`)
        continue
      }
      if (sameLemma(a, b)) continue
      if (a === 'been' && (b === 'went' || b === 'gone')) continue // have been to -> went to
      if (bothIn(DETERMINERS) || bothIn(PREPOSITIONS) || bothIn(AUX) || bothIn(INTENSIFIERS))
        continue
      reasons.push(`content-sub:${a}->${b}`)
    } else if (op.op === 'ins') {
      const { b } = op
      const next = B[op.j + 1]
      if (PREPOSITIONS.has(b) && next === 'home') {
        reasons.push('prep-before-home')
        continue
      }
      if (isNumber(b)) {
        reasons.push(`number:${b}`)
        continue
      }
      if (ARTICLES.has(b) || DETERMINERS.has(b) || PREPOSITIONS.has(b) || AUX.has(b)) continue
      if (SUBJECT_PRONOUNS.has(b)) {
        // "Is very hot" -> "Is it very hot?" は平叙文を疑問文に変えてしまう
        if (AUX.has(B[op.j - 1] ?? '') && !/\?\s*$/.test(original))
          reasons.push('statement-to-question')
        continue
      }
      reasons.push(`content-ins:${b}`)
    } else if (op.op === 'del') {
      const { a } = op
      if (ARTICLES.has(a) || PREPOSITIONS.has(a) || AUX.has(a) || a === 'more' || a === 'most')
        continue
      if (DETERMINERS.has(a) && a !== 'no') continue
      reasons.push(`content-del:${a}`)
    }
    // move: 語をすべて保つ並べ替えなので許す
  }
  // move に付いてよいのは閉じた語類 1 つの挿入(like ... very much)と語形変化だけ
  if (
    ops.some((x) => x.op === 'move') &&
    ops
      .filter((x) => x.op !== 'move')
      .some(
        (x) =>
          !(x.op === 'ins' && (x.b === 'much' || AUX.has(x.b))) &&
          !(x.op === 'sub' && sameLemma(x.a, x.b)),
      )
  ) {
    reasons.push('move-with-other-edits')
  }
  // カジュアルな短い発話(yeah sounds good 等)は直さない
  if (A.some((w) => CASUAL.has(w)) && A.length <= 4) reasons.push('casual-short')
  // 数える量詞 + 不可算名詞が残る半端な直し("many furniture")はまだ間違い
  const countQuantifiers = ['many', 'few', 'several', ...NUMBER_WORDS]
  B.forEach((w, k) => {
    const prev = B[k - 1]
    if (
      UNCOUNTABLE.has(w) &&
      prev !== undefined &&
      countQuantifiers.includes(prev) &&
      prev !== 'one'
    ) {
      reasons.push(`count-quantifier+uncountable:${prev} ${w}`)
    }
  })
  // 文の種類を変えない(音声認識の文は句読点が無いことが多いので、両方にあるときだけ比べる)
  if (/\?\s*$/.test(candidate) && /[.!]\s*$/.test(original)) reasons.push('statement-to-question')
  if (/[.!]\s*$/.test(candidate) && /\?\s*$/.test(original)) reasons.push('question-to-statement')
  return reasons.length
    ? { verdict: 'reject', reasons, ops }
    : { verdict: 'accept', corrected: candidate, reasons, ops }
}

// ---------------------------------------------------------------- category classifier + explanations
export type CorrectionCategory =
  | 'question'
  | 'tense'
  | 'verb-form'
  | 'adjective-form'
  | 'word-order'
  | 'article'
  | 'preposition'
  | 'third-person-s'
  | 'countable'
  | 'plural'
  | 'missing-subject'
  | 'missing-be'
  | 'unknown'

export interface Classification {
  categories: CorrectionCategory[]
  /** 1 つでも説明できない変更があれば null(= 表示しない)。複数行は '\n' 区切り。 */
  explanation: string | null
}

/** テンプレートの差し込み位置に入る語が無い(= 説明できない)ことを表す内部の合図。 */
class MissingSlotError extends Error {}

const STOP_NP: ReadonlySet<string> = new Set([
  ...PREPOSITIONS,
  ...ARTICLES,
  ...AUX,
  'and',
  'or',
  'but',
  'so',
  'because',
  'to',
  'every',
  'today',
  'yesterday',
  'tomorrow',
])
const PAST_TIME_RE =
  /\b(yesterday|last (night|week|weekend|month|year|summer|winter|spring|fall|time|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|\d+ (days?|weeks?|months?|years?) ago|ago|this morning)\b/i

const SUBJECT_DETERMINERS = ['my', 'his', 'her', 'your', 'our', 'their', 'the']

/**
 * 各編集操作を分類し、固定の日本語テンプレートで説明を組み立てる。
 * 1 つでも説明できない操作があれば `explanation: null`(カテゴリには 'unknown' が入る)。
 */
export function classify(
  original: string,
  corrected: string,
  ops: readonly EditOp[],
): Classification {
  const cats: CorrectionCategory[] = []
  try {
    return classifyInner(original, corrected, ops, cats)
  } catch (e) {
    if (e instanceof MissingSlotError)
      return { categories: [...cats, 'unknown'], explanation: null }
    throw e
  }
}

function classifyInner(
  original: string,
  corrected: string,
  ops: readonly EditOp[],
  cats: CorrectionCategory[],
): Classification {
  const A = tokenize(original)
  const B = tokenize(corrected)
  const surface = `${corrected} ${original}`
  const lines: string[] = []
  const used = new Set<EditOp>()

  /** 差し込む語を、学習者 / モデルの書いた大文字小文字で表示する("i" -> "I", "kenji" -> "Kenji")。 */
  function disp(slot: string | undefined): string {
    if (slot === undefined) throw new MissingSlotError()
    if (!/^[a-z0-9_' ]+$/i.test(slot)) return slot
    const plain = slot.replace(/_/g, ' ')
    if (plain === 'i') return 'I'
    const m = surface.match(
      new RegExp(`\\b${plain.replace(/'/g, "['’]").replace(/ /g, '\\s+')}\\b`, 'i'),
    )
    if (m && /^[A-Z][a-z]/.test(m[0]) && !/^[A-Z][a-z]/.test(plain)) {
      // 文頭だから大文字、というだけなら小文字のまま出す
      const idx = surface.search(new RegExp(`\\b${plain.replace(/ /g, '\\s+')}\\b`, 'i'))
      const sentenceInitial = idx === 0 || /[.!?]\s*$/.test(surface.slice(0, idx))
      if (
        !sentenceInitial ||
        (/^[A-Z][a-z]+$/.test(m[0]) &&
          !/^(The|My|This|That|There|It|He|She|We|They|You|Yesterday|Last|What|Where|How|When|Why|Who|Do|Does|Did|Is|Are|Can|Could|I)$/.test(
            m[0].split(/\s+/)[0]!,
          ))
      ) {
        return m[0]
      }
    }
    return plain
  }
  const q = (s: string | undefined): string => `「${disp(s)}」`
  /** 2 語を並べた差し込み。片方が無ければ説明できない。 */
  const pair = (x: string | undefined, y: string | undefined, tail = ''): string => {
    if (x === undefined || y === undefined) throw new MissingSlotError()
    return `${x} ${y}${tail}`
  }

  const isQuestionOut =
    /\?\s*$/.test(corrected) ||
    /\?\s*$/.test(original) ||
    WH.has(B[0] ?? '') ||
    (AUX.has(B[0] ?? '') && B.length > 2)
  const take = (op: EditOp): void => {
    used.add(op)
  }
  const prevB = (op: EditOp): string | undefined => B[op.j - 1]
  const nextB = (op: EditOp): string | undefined => B[op.j + 1]
  const prevA = (op: EditOp): string | undefined => A[op.i - 1]
  const nextA = (op: EditOp): string | undefined => A[op.i + 1]
  const unknown = (): Classification => ({ categories: [...cats, 'unknown'], explanation: null })

  // --- 疑問文の do の補い(ins do/does/did [+ 動詞を原形へ])
  const insDo = ops.find((o): o is InsOp => o.op === 'ins' && DO.has(o.b))
  if (insDo && isQuestionOut) {
    take(insDo)
    const verbSub = ops.find(
      (o): o is SubOp => o.op === 'sub' && sameLemma(o.a, o.b) && !used.has(o),
    )
    if (verbSub) take(verbSub)
    cats.push('question')
    lines.push(
      `疑問文では${q(insDo.b)}を主語の前に置き、動詞は原形${verbSub ? q(verbSub.b) : ''}にします。`,
    )
  }
  // --- 過去の時点 + 現在完了(del have/has [+ 過去分詞 -> 過去形])
  const delHave = ops.find(
    (o): o is DelOp => o.op === 'del' && (o.a === 'have' || o.a === 'has') && !used.has(o),
  )
  const timeM = original.match(PAST_TIME_RE)
  if (delHave && timeM) {
    take(delHave)
    const pSub = ops.find(
      (o): o is SubOp => o.op === 'sub' && !used.has(o) && (sameLemma(o.a, o.b) || o.a === 'been'),
    )
    if (pSub) take(pSub)
    cats.push('tense')
    lines.push(
      `${q(timeM[0])}のように過去の時点をはっきり言うときは、現在完了（have + 過去分詞）ではなく過去形を使います。`,
    )
  }
  // --- enjoy などの後の -ing(del to + 動詞 -> 動詞-ing)
  const delTo = ops.find((o): o is DelOp => o.op === 'del' && o.a === 'to' && !used.has(o))
  if (delTo && GERUND_VERBS.has(prevA(delTo) ?? '')) {
    const ing = ops.find(
      (o): o is SubOp =>
        o.op === 'sub' && !used.has(o) && o.b.endsWith('ing') && sameLemma(o.a, o.b),
    )
    if (ing) {
      take(delTo)
      take(ing)
      cats.push('verb-form')
      lines.push(`${q(prevA(delTo))}の後は「to + 動詞」ではなく、-ing の形${q(ing.b)}を続けます。`)
    }
  }
  // --- 比較級(del more + 形容詞 -> 形容詞-er)
  const delMore = ops.find((o): o is DelOp => o.op === 'del' && o.a === 'more' && !used.has(o))
  if (delMore) {
    const er = ops.find(
      (o): o is SubOp => o.op === 'sub' && !used.has(o) && /er$/.test(o.b) && sameLemma(o.a, o.b),
    )
    if (er) {
      take(delMore)
      take(er)
      cats.push('adjective-form')
      lines.push(
        `${q(er.a)}のような短い形容詞の比較級は「more ${er.a}」ではなく${q(er.b)}にします。`,
      )
    }
  }
  // --- very + 動詞(sub very->really / move very ... + ins much)
  const veryFix = ops.find(
    (o) =>
      (o.op === 'sub' && o.a === 'very' && o.b === 'really') ||
      (o.op === 'move' && o.a === 'very') ||
      (o.op === 'ins' && o.b === 'much' && B[o.j - 1] === 'very'),
  )
  if (veryFix && !used.has(veryFix)) {
    take(veryFix)
    const much = ops.find((o) => o.op === 'ins' && o.b === 'much')
    if (much) take(much)
    const verb = veryFix.op === 'ins' ? B[veryFix.j + 1] : A[veryFix.i + 1]
    cats.push('word-order')
    if (veryFix.op === 'ins') {
      lines.push(`「very」だけでは動詞${q(verb)}を強められないので、「very much」の形にします。`)
    } else {
      if (verb === undefined) throw new MissingSlotError()
      lines.push(
        `「very」は動詞${q(verb)}を直接強められないので、「really ${verb}」や「${verb} ～ very much」の形にします。`,
      )
    }
  }

  // 限定詞の入れ替え(many -> a lot of)は名詞と一緒に説明するので最後に回す
  const isDetSwap = (o: EditOp): boolean =>
    o.op === 'sub' &&
    DETERMINERS.has(o.a) &&
    DETERMINERS.has(o.b) &&
    !(ARTICLES.has(o.a) && ARTICLES.has(o.b))
  const ordered = [...ops.filter((o) => !isDetSwap(o)), ...ops.filter(isDetSwap)]
  for (const op of ordered) {
    if (used.has(op)) continue
    if (op.op === 'move') {
      take(op)
      if (
        op.swapWith &&
        BE.has(op.a) &&
        A.slice(0, op.i).some((w) => WH.has(w)) &&
        !WH.has(A[0] ?? '')
      ) {
        cats.push('word-order')
        lines.push(
          `文の途中に入った疑問詞のあとは、疑問文の語順ではなく「主語 + 動詞」の順（${q(`${op.swapWith} ${op.a}`)}）にします。`,
        )
      } else {
        return unknown()
      }
      continue
    }
    if (op.op === 'sub') {
      const { a, b } = op
      if (ARTICLES.has(a) && ARTICLES.has(b)) {
        take(op)
        cats.push('article')
        if (a === 'a' && b === 'an')
          lines.push(`${q(nextB(op))}は母音の音で始まるので、「a」ではなく「an」を使います。`)
        else if (a === 'an' && b === 'a')
          lines.push(`${q(nextB(op))}は子音の音で始まるので、「an」ではなく「a」を使います。`)
        else return unknown()
        continue
      }
      if (PREPOSITIONS.has(a) && PREPOSITIONS.has(b)) {
        take(op)
        cats.push('preposition')
        const nb = nextB(op) ?? ''
        if (b === 'on' && (MONTHS.has(nb) || DAYS.has(nb)))
          lines.push(`日付や曜日の前には「${a}」ではなく「on」を使います。`)
        else lines.push(`${q(pair(prevA(op), a))}ではなく${q(pair(prevB(op), b))}と言います。`)
        continue
      }
      if ((DO.has(a) && DO.has(b)) || (a === 'have' && b === 'has')) {
        take(op)
        cats.push('third-person-s')
        const after = A[op.i + 1]
        const subj = after && ['he', 'she', 'it'].includes(after) ? after : prevA(op)
        lines.push(`主語が${q(subj)}（三人称単数）なので、${q(a)}ではなく${q(b)}を使います。`)
        continue
      }
      if (sameLemma(a, b) || (a === 'been' && (b === 'went' || b === 'gone'))) {
        const fa = FORM_OF.get(a)
        const fb = FORM_OF.get(b)
        const bPast = (fb && fb.kind === 'past') || (!fb && /ed$/.test(b) && !/ed$/.test(a))
        // 形容詞の -ing / -ed
        if ((/ing$/.test(a) && /ed$/.test(b)) || (/ed$/.test(a) && /ing$/.test(b))) {
          if (/ed$/.test(b)) {
            take(op)
            cats.push('adjective-form')
            lines.push(
              `人の気持ちを表すときは -ed の形${q(b)}を使います（${q(a)}は「人をそう感じさせる」という意味です）。`,
            )
            continue
          }
          if ((/ing$/.test(b) && BE.has(prevA(op) ?? '')) || INTENSIFIERS.has(prevA(op) ?? '')) {
            take(op)
            cats.push('adjective-form')
            lines.push(
              `物や出来事の性質を表すときは -ing の形${q(b)}を使います（${q(a)}は「人がそう感じている」という意味です）。`,
            )
            continue
          }
        }
        if (bPast && !(fa && fa.kind === 'past')) {
          take(op)
          cats.push('tense')
          const pastTime = original.match(PAST_TIME_RE)
          lines.push(
            pastTime
              ? `${q(pastTime[0])}と過去のことを話しているので、${q(a)}を過去形の${q(b)}にします。`
              : `過去のことなので、${q(a)}を過去形の${q(b)}にします。`,
          )
          continue
        }
        const plusS =
          b === a + 's' || b === a + 'es' || (a.endsWith('y') && b === a.slice(0, -1) + 'ies')
        const minusS =
          a === b + 's' || a === b + 'es' || (b.endsWith('y') && a === b.slice(0, -1) + 'ies')
        const before = A.slice(Math.max(0, op.i - 2), op.i)
        if (minusS && UNCOUNTABLE.has(b)) {
          take(op)
          cats.push('countable')
          const quant = ops.find(
            (o): o is SubOp =>
              o.op === 'sub' && !used.has(o) && DETERMINERS.has(o.a) && DETERMINERS.has(o.b),
          )
          if (quant) {
            take(quant)
            lines.push(
              `${q(b)}は数えられない名詞なので複数形にせず、「${quant.a}」ではなく「${quant.b.replace(/_/g, ' ')}」を使います。`,
            )
          } else {
            lines.push(`${q(b)}は数えられない名詞なので、複数形にしません。`)
          }
          continue
        }
        if (minusS && before.some((w) => SINGULAR_CUES.has(w))) {
          take(op)
          cats.push('plural')
          const cue = before.find((w) => SINGULAR_CUES.has(w))
          lines.push(`${q(cue)}の後の名詞は単数形なので、${q(b)}にします。`)
          continue
        }
        if (plusS && before.some((w) => PLURAL_CUES.has(w))) {
          take(op)
          cats.push('plural')
          const cue = before.find((w) => PLURAL_CUES.has(w))!
          lines.push(`${q(cue.replace(/_/g, ' '))}の後なので、名詞は複数形の${q(b)}にします。`)
          continue
        }
        const p = prevA(op)
        const nxt = A[op.i + 1]
        const firstWord = original.trim().split(/\s+/)[0] ?? ''
        const subjectIsName =
          op.i === 1 &&
          /^[A-Z][a-z]+$/.test(firstWord) &&
          !/^(The|My|This|That|There|It|He|She|We|They|You|I|Yesterday|Today|Last|What|Where|How|When|Why|Who|Do|Does|Did|Is|Are|Can|Could)$/.test(
            firstWord,
          )
        const looksVerb =
          nxt !== undefined &&
          (ARTICLES.has(nxt) ||
            DETERMINERS.has(nxt) ||
            PREPOSITIONS.has(nxt) ||
            PRONOUNS.has(nxt) ||
            nxt === 'to' ||
            /ing$/.test(nxt))
        const pIsPronoun = p !== undefined && PRONOUNS.has(p)
        const npSubject = op.i === 2 && SUBJECT_DETERMINERS.includes(A[0] ?? '') && !pIsPronoun
        const pIsHeSheIt = p !== undefined && ['he', 'she', 'it'].includes(p)
        const pIsCapitalized = p !== undefined && surfaceCapitalized(original).has(p)
        const twoBack = A[op.i - 2]
        const thirdSubj =
          pIsHeSheIt ||
          pIsCapitalized ||
          subjectIsName ||
          npSubject ||
          (twoBack !== undefined && SUBJECT_DETERMINERS.includes(twoBack) && !pIsPronoun)
        // 文頭の "my sister" / "Kenji" / "she" の直後の語はその主語の動詞
        if (
          plusS &&
          thirdSubj &&
          (looksVerb || nxt === undefined || pIsHeSheIt || npSubject || subjectIsName)
        ) {
          take(op)
          cats.push('third-person-s')
          if (p === undefined) throw new MissingSlotError()
          const subj = pIsHeSheIt || pIsCapitalized || subjectIsName ? p : `${twoBack} ${p}`
          const orig = original.match(new RegExp(`\\b${subj.replace(/ /g, '\\s+')}\\b`, 'i'))
          lines.push(
            `主語が${q(orig ? orig[0] : subj)}（三人称単数）なので、動詞は${q(b)}になります。`,
          )
          continue
        }
        if (
          plusS &&
          !thirdSubj &&
          !looksVerb &&
          op.i >= 2 &&
          !AUX.has(p ?? '') &&
          !pIsPronoun &&
          !DETERMINERS.has(p ?? '')
        ) {
          // "like cat -> like cats": 数えられる名詞を一般的に言う
          take(op)
          cats.push('plural')
          lines.push(
            `数えられる名詞を「～というもの」全般の意味で言うときは、複数形の${q(b)}にします。`,
          )
          continue
        }
      }
      return unknown()
    }
    if (op.op === 'ins') {
      const { b } = op
      const nb = nextB(op)
      if (ARTICLES.has(b)) {
        take(op)
        cats.push('article')
        if (b === 'the' && nb === 'future')
          lines.push('「将来」は「in the future」と、the を付けて言います。')
        else if (b === 'a' || b === 'an') {
          const np = [b]
          for (const w of B.slice(op.j + 1)) {
            if (STOP_NP.has(w) || np.length >= 4) break
            np.push(w)
          }
          if (np.length < 2) return unknown()
          lines.push(
            `数えられる名詞が 1 つのときは、${q(np.join(' '))}のように前に「${b}」を付けます。`,
          )
        } else return unknown()
        continue
      }
      if (PREPOSITIONS.has(b)) {
        take(op)
        cats.push('preposition')
        lines.push(`${q(prevB(op))}の後には${q(b)}が必要です（${q(pair(prevB(op), b, ' ～'))}）。`)
        continue
      }
      if (SUBJECT_PRONOUNS.has(b)) {
        take(op)
        cats.push('missing-subject')
        if (b === 'it' && BE.has(nb ?? '')) {
          lines.push(
            '英語では主語を省略できません。天気・気温・時間などを言うときは「it」を主語にします。',
          )
        } else lines.push(`英語では主語を省略できないので、${q(b)}を補います。`)
        continue
      }
      if (BE.has(b)) {
        take(op)
        cats.push('missing-be')
        const adj = B.slice(op.j + 1).find((w) => !INTENSIFIERS.has(w))
        lines.push(`${q(adj)}は動詞ではないので、be 動詞${q(b)}が必要です。`)
        continue
      }
      return unknown()
    }
    if (op.op === 'del') {
      const { a } = op
      const na = nextA(op)
      if (ARTICLES.has(a) && na !== undefined && surfaceCapitalized(original).has(na)) {
        take(op)
        cats.push('article')
        const name = original.match(new RegExp(`\\b${na}\\b`, 'i'))
        if (!name) throw new MissingSlotError()
        lines.push(`${q(name[0])}のような地名や人の名前には、「${a}」を付けません。`)
        continue
      }
      if (PREPOSITIONS.has(a)) {
        take(op)
        cats.push('preposition')
        lines.push(
          `${q(prevA(op))}の後に${q(a)}は要りません（${q(pair(prevA(op), '～'))}の形で使います）。`,
        )
        continue
      }
      if (BE.has(a) && na !== undefined && STATIVE_VERBS_NO_BE.has(na)) {
        take(op)
        cats.push('verb-form')
        lines.push(`${q(na)}は動詞なので、be 動詞${q(a)}は要りません。`)
        continue
      }
      return unknown()
    }
  }
  const uniq = [...new Set(lines)]
  return { categories: [...new Set(cats)], explanation: uniq.length ? uniq.join('\n') : null }
}

// ---------------------------------------------------------------- one pair, end to end
/** これより短い発話("sounds good" 等)は見ない。 */
export const CORRECTION_MIN_WORDS = 3
/**
 * これより長い発話は見ない。研究の発話は最長でも 1〜2 文で、長い発話の書き直しは
 * 測っていない(編集の数も増え、フィルタが「直しすぎ」として捨てる側に寄る)。
 */
export const CORRECTION_MAX_WORDS = 25
/** 編集操作がこれより多い書き直しは「直しすぎ」として捨てる(研究時と同じ)。 */
export const CORRECTION_MAX_OPS = 3

export type CorrectionSkipReason = 'empty' | 'non-latin' | 'too-short' | 'too-long'

/**
 * 「そもそも添削しない」発話を決める。null = 見る。
 * 日本語 / 英日混在の入力は翻訳の経路なので添削しない。
 */
export function correctionSkipReason(
  userText: string | null | undefined,
): CorrectionSkipReason | null {
  const text = (userText ?? '').trim()
  if (!text) return 'empty'
  if (containsNonLatinScript(text)) return 'non-latin'
  const words = tokenize(text).length
  if (words < CORRECTION_MIN_WORDS) return 'too-short'
  if (words > CORRECTION_MAX_WORDS) return 'too-long'
  return null
}

/** 表示してよい添削(backend の Feedback と同じ形)。説明は必ず固定テンプレートの文面。 */
export interface CheckedCorrection {
  user_said: string
  corrected: string
  explanation: string
}

export interface CorrectionPairEvaluation {
  /** 表示してよい添削。null = 何も表示しない。 */
  feedback: CheckedCorrection | null
  verdict: GuardVerdict
  reasons: string[]
  categories: CorrectionCategory[] | null
}

/**
 * 元の発話と直した文の組を判定し、表示してよい添削を組み立てる。
 * 表示するのは **フィルタが受け入れ、かつ全部の変更にテンプレートがある** ときだけ。
 * (発話の足切り = correctionSkipReason は呼び出し側で済ませる。)
 */
export function evaluateCorrectionPair(
  original: string,
  candidate: string,
): CorrectionPairEvaluation {
  const g = guard(original, candidate, {
    minWords: CORRECTION_MIN_WORDS,
    maxOps: CORRECTION_MAX_OPS,
  })
  if (g.verdict !== 'accept') {
    return { feedback: null, verdict: g.verdict, reasons: g.reasons, categories: null }
  }
  const c = classify(original, candidate, g.ops)
  return {
    feedback: c.explanation
      ? { user_said: original, corrected: candidate, explanation: c.explanation }
      : null,
    verdict: g.verdict,
    reasons: g.reasons,
    categories: c.categories,
  }
}

/**
 * **保存済みの添削**(発話と直した文)を今のルールで検証し直し、今のテンプレートで
 * 説明を作り直す。通らなければ null(= 表示しない)。
 *
 * 保存された説明文は **一切使わない**。以前のバージョンはモデルが書いた添削
 * (説明が英語 / 崩れた日本語 / 中国語)を検証せずに保存していて、インポートした
 * バックアップからも戻ってくる。判定は決定的なので、grammar-check が当時表示した
 * 添削はテンプレートが変わらない限り同じ説明で必ず通る。
 */
export function recheckCorrection(userSaid: unknown, corrected: unknown): CheckedCorrection | null {
  if (typeof userSaid !== 'string' || typeof corrected !== 'string') return null
  const original = userSaid.trim()
  const candidate = corrected.trim()
  if (!candidate || correctionSkipReason(original) !== null) return null
  return evaluateCorrectionPair(original, candidate).feedback
}

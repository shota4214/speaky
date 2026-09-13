/**
 * 会話 LLM の JSON 返答を検証・正規化・救出するための純粋関数群。
 *
 * 非ストリーミング経路(`POST /api/chat` / `POST /api/chat/opening`)と
 * ストリーミング経路の enrich(日本語訳 / 添削 / 単語の後追い生成)の
 * 両方から使うため routes から services へ切り出した。
 * **中身は routes/chat.ts にあった時点から一切変えていない**
 * (非ストリーミング経路はフォールバックとして挙動を固定する必要があるため)。
 */
import type { Mode } from './conversation-prompt.js'
import { extractJsonObjectSlice, matchJsonStringField } from './json-salvage.js'

export interface Feedback {
  user_said: string
  corrected: string
  explanation: string
}

export interface VocabItem {
  word: string
  meaning: string
  example?: string | null
}

export interface ChatReply {
  reply_en: string
  reply_ja: string
  feedback: Feedback | null
  vocabulary: VocabItem[]
  mode: Mode
}

export function isFeedback(x: unknown): x is Feedback {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  return (
    typeof r.user_said === 'string' &&
    typeof r.corrected === 'string' &&
    typeof r.explanation === 'string'
  )
}

// ひらがな / カタカナ / 漢字。explanation は設計上日本語なので判定対象に含めない。
const JP_CHAR_REGEX = /[぀-ゟ゠-ヿ一-龯]/

/**
 * normal モード(英語入力)の添削が妥当かを判定する。
 * 小型モデル(Llama 3.2 3B 等)は英語入力なのに「私の名前はショータです →
 * 私の名前はShotaです」のような日本語の添削を幻覚することがある。
 * 添削対象の英文(corrected)に日本語が混ざっていたらデタラメ添削とみなして破棄する。
 * (explanation は日本語が正常なので見ない。user_said も補助的にチェックする)
 */
export function isValidEnglishFeedback(fb: Feedback): boolean {
  if (JP_CHAR_REGEX.test(fb.corrected)) return false
  if (JP_CHAR_REGEX.test(fb.user_said)) return false
  return true
}

export function isVocabItem(x: unknown): x is VocabItem {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  return typeof r.word === 'string' && typeof r.meaning === 'string'
}

/**
 * 出力契約に書いてある **例示の文言** をそのまま返したか。
 *
 * small の JSON 契約は `{"reply_en":"your 1-2 sentence English reply", ...}` という
 * 1 行の例を見せている。llama3.2:1b は会話ターン 12 件中 6 件でこれを一字一句
 * 返した。例示を契約から消す案は評価で複数モデルを悪化させたので、契約はそのまま
 * にして **返ってきたら失敗として扱う**(次の attempt に回る)。
 */
const CONTRACT_PLACEHOLDER_RE =
  /^(?:string\s*-\s*)?your\s+(?:\d+(?:\s*-\s*\d+)?\s+sentences?\s+)?english\s+(?:reply|response)[.!]?$/i

export function isContractPlaceholder(replyEn: string): boolean {
  return CONTRACT_PLACEHOLDER_RE.test(replyEn.trim())
}

/**
 * JSON のキーの前後の空白を取り除く。llama3.2:1b は `" reply_ja"` のように
 * 先頭に空白の入ったキーを書く(挨拶 12 件中 9 件)。完全一致で読むと
 * モデルが書いた日本語訳が捨てられ、ローマ字を出しがちな補完経路に落ちていた。
 * 同じキーが空白違いで 2 つあるときは、空白の無い方(正規の書き方)を優先する。
 */
function trimKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const trimmed = key.trim()
    if (trimmed !== key && Object.prototype.hasOwnProperty.call(obj, trimmed)) continue
    out[trimmed] = value
  }
  return out
}

export function parseChatReply(content: string, fallbackMode: Mode): ChatReply | null {
  try {
    const json: unknown = JSON.parse(content)
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
    const parsed = trimKeys(json as Record<string, unknown>)
    // reply_en は必須。reply_ja は欠落/非文字列でも parse 失敗にせず空文字に正規化する。
    // (小型モデルが reply_ja を省略するケースを救い、後段の en→ja 補完に回すため)
    if (typeof parsed.reply_en !== 'string') {
      return null
    }
    if (isContractPlaceholder(parsed.reply_en)) {
      console.warn('[chat] reply_en is the contract placeholder; treating as a failed attempt')
      return null
    }
    const replyJa = typeof parsed.reply_ja === 'string' ? parsed.reply_ja : ''

    let feedback = isFeedback(parsed.feedback) ? parsed.feedback : null
    // 英語入力なのに日本語の添削が返ってきたら(小型モデルの幻覚)破棄する。
    if (feedback && !isValidEnglishFeedback(feedback)) {
      console.warn('[chat] dropping feedback with Japanese in corrected/user_said:', {
        user_said: feedback.user_said,
        corrected: feedback.corrected,
      })
      feedback = null
    }
    const vocabulary: VocabItem[] = Array.isArray(parsed.vocabulary)
      ? parsed.vocabulary
          .filter(isVocabItem)
          .slice(0, 3)
          .map((v) => ({
            word: v.word,
            meaning: v.meaning,
            example: v.example ?? null,
          }))
      : []

    const mode: Mode =
      parsed.mode === 'japanese_help' || parsed.mode === 'mixed' || parsed.mode === 'normal'
        ? parsed.mode
        : fallbackMode

    return {
      reply_en: parsed.reply_en,
      reply_ja: replyJa,
      feedback,
      vocabulary,
      mode,
    }
  } catch {
    return null
  }
}

/** salvage で受け入れる reply_en の最大長(これを超えるものは暴走出力とみなす)。 */
const MAX_SALVAGED_REPLY_LENGTH = 1200

/**
 * salvage した英文が「返答として出して恥ずかしくないか」を判定する。
 * ラテン文字を 1 つも含まない / 極端に短い / 極端に長いものは弾く。
 */
function isSaneSalvagedReplyEn(text: string): boolean {
  const t = text.trim()
  if (t.length < 2 || t.length > MAX_SALVAGED_REPLY_LENGTH) return false
  return /[A-Za-z]/.test(t)
}

/**
 * 厳密 parse に失敗した出力から、使える返答を救出する。
 *
 * リトライ(= もう一度フル生成を待たせる)より圧倒的に安い。小型モデルの失敗の
 * 大半は「返答自体は出来ているが包装が壊れている」ケースなので、まずここで拾う。
 *
 *  1) コードフェンス / 前置き付き → `{...}` を切り出して厳密 parse し直す
 *     (この経路なら feedback / vocabulary も含めて完全に復元できる)
 *  2) num_predict 上限で途中切断 → reply_en / reply_ja を正規表現で拾う
 *     (閉じ引用符まで揃っているものだけ。文の途中で切れた英文は採らない)
 *
 * 2) の経路では feedback / vocabulary は捨てて null / [] にする。
 * これらは JSON の後半に出るため切断時は信用できず、欠けても会話は成立するため。
 * レスポンスの形(ChatReply)は常に維持する。
 */
export function salvageChatReply(content: string, fallbackMode: Mode): ChatReply | null {
  if (!content) return null

  // 1) 包装を剥がして厳密 parse
  const slice = extractJsonObjectSlice(content)
  if (slice) {
    const parsed = parseChatReply(slice, fallbackMode)
    if (parsed) return parsed
  }

  // 2) 切断された JSON から本文だけ拾う
  const replyEn = matchJsonStringField(content, 'reply_en')
  if (!replyEn || !isSaneSalvagedReplyEn(replyEn) || isContractPlaceholder(replyEn)) return null

  const replyJa = matchJsonStringField(content, 'reply_ja') ?? ''
  return {
    reply_en: replyEn.trim(),
    // reply_ja が切断されていれば空になる。呼び出し側の en→ja 補完が埋める。
    reply_ja: replyJa.trim().slice(0, MAX_SALVAGED_REPLY_LENGTH),
    feedback: null,
    vocabulary: [],
    mode: fallbackMode,
  }
}

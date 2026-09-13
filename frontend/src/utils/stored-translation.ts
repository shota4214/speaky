import {
  judgeJapaneseTranslation,
  type JapaneseTranslationVerdict,
} from '../../../backend/src/shared/text-guards'
import type { Message } from '../db/types'

/**
 * 保存済みの訳を「無いもの」として隠す判定(= v1.2.0 が保存した壊れ方)。
 *
 * v1.2.0 の症状は **ローマ字や英語の訳**(かなが無い)と、**他の文字体系・記号の混入**
 * だった。それを示す判定だけで隠す。
 *
 * それ以外の判定(latin-heavy / too-long / json-remnant / multi-paragraph)は
 * **保存済みの行では隠さない**。「Netflix で Stranger Things を見たの？」のような
 * 正しい訳が latin-heavy になるなど、新しく生成する訳を締めるための規則であって、
 * 既に見えていた訳を消すほどの確かさは無い。しかも再取得しても同じ規則で弾かれる
 * 見込みが高く、**消したら二度と戻らない**。
 */
export const HIDDEN_STORED_TRANSLATION_VERDICTS: ReadonlySet<JapaneseTranslationVerdict> =
  new Set<JapaneseTranslationVerdict>(['empty', 'disallowed-char', 'no-kana', 'kana-share'])

/**
 * 保存済みの行について「日本語訳の欄に何を出すか」を決める(会話画面と履歴画面で共通)。
 *
 * ── なぜ保存済みの訳をもう一度検証するのか ──
 * v1.2.0 は日本語訳を検証せずに保存していたので、DB には **ローマ字や英語の訳**
 * (「Konnichiwa, watashi wa ...」)がそのまま残っている。空でない訳を「ある」と
 * 扱うと、その行は「参考訳」の札付きで表示され、再取得ボタンも出ない —
 * M1 実機のテスト機はまさにその行を抱えている。
 * v1.2.0 の症状を示す訳だけを **無いものとして扱い**、再取得できるようにする
 * (HIDDEN_STORED_TRANSLATION_VERDICTS)。
 *
 * 日本語入力のターン(japanese_help / mixed)の reply_ja は訳ではなく定型の案内文
 * なので検証しない(表示は従来どおり)。**履歴画面では mode を withEffectiveAiModes で
 * 導き直してから渡すこと**(古い行の AI の mode はモデルが書いたもので信用できない)。
 *
 * @returns 表示してよい訳。無ければ空文字(= 訳が無い行として再取得の対象)。
 */
export function storedJapaneseTranslation(
  message: Pick<Message, 'mode' | 'replyEn' | 'replyJa'>,
): string {
  if (!message.replyJa) return ''
  if (message.mode === 'japanese_help' || message.mode === 'mixed') return message.replyJa
  const verdict = judgeJapaneseTranslation(message.replyJa, message.replyEn ?? '')
  return HIDDEN_STORED_TRANSLATION_VERDICTS.has(verdict) ? '' : message.replyJa
}

/**
 * 保存済みの会話で、AI の行の mode を **直前のユーザーの行の mode** に置き換える。
 *
 * ── なぜ要るのか ──
 * v1.0.0 と v1.2.0 の非ストリーミング経路は、AI の行に **モデルが JSON に書いた mode**
 * をそのまま保存していた。英語のターンをモデルが `mixed` と書くと、その行は
 * 日本語入力のターン扱いになり、ローマ字の訳が検証されずに残り、「言ってみて」の
 * バッジが付き、「参考訳」の札も再取得ボタンも出ない。
 * ユーザーの行の mode は昔からずっと **こちらで判定した入力モード** なので、それを使う。
 *
 * 直前にユーザーの行が無い AI の行(会話の最初のあいさつ)は `normal`。
 * 会話画面は今のセッションで作った行(mode は判定した入力モード)しか出さないので要らない。
 */
export function withEffectiveAiModes(messages: readonly Message[]): Message[] {
  let precedingUser: Message | null = null
  return messages.map((m) => {
    if (m.role === 'user') {
      precedingUser = m
      return m
    }
    const mode: Message['mode'] = precedingUser ? precedingUser.mode : 'normal'
    return m.mode === mode ? m : { ...m, mode }
  })
}

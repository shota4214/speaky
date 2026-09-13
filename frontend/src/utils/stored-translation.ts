import { acceptJapaneseTranslation } from '../../../backend/src/shared/text-guards'
import type { Message } from '../db/types'

/**
 * 保存済みの行について「日本語訳の欄に何を出すか」を決める(会話画面と履歴画面で共通)。
 *
 * ── なぜ保存済みの訳をもう一度検証するのか ──
 * v1.2.0 は日本語訳を検証せずに保存していたので、DB には **ローマ字や英語の訳**
 * (「Konnichiwa, watashi wa ...」)がそのまま残っている。空でない訳を「ある」と
 * 扱うと、その行は「参考訳」の札付きで表示され、再取得ボタンも出ない —
 * M1 実機のテスト機はまさにその行を抱えている。
 * 今の検証を通らない訳は **無いものとして扱い**、再取得できるようにする。
 *
 * 日本語入力のターン(japanese_help / mixed)の reply_ja は訳ではなく定型の案内文
 * なので検証しない(表示は従来どおり)。
 *
 * @returns 表示してよい訳。無ければ空文字(= 訳が無い行として再取得の対象)。
 */
export function storedJapaneseTranslation(
  message: Pick<Message, 'mode' | 'replyEn' | 'replyJa'>,
): string {
  if (!message.replyJa) return ''
  if (message.mode === 'japanese_help' || message.mode === 'mixed') return message.replyJa
  return acceptJapaneseTranslation(message.replyJa, message.replyEn ?? '')
}

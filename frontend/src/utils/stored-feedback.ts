import {
  recheckCorrection,
  type CheckedCorrection,
} from '../../../backend/src/shared/correction-guard'
import type { Feedback, Message } from '../db/types'

/**
 * 保存済みの行について「添削の欄に何を出すか」を決める(履歴画面)。
 *
 * ── なぜ保存済みの添削をもう一度検証するのか ──
 * 以前のバージョンは **モデルが JSON に書いた添削** を検証せずに保存していた
 * (説明が英語 / 崩れた日本語 / 中国語、言い換えを「間違い」扱い)。
 * とくに標準モードの人の DB にはそれが残っているし、インポートしたバックアップからも
 * 戻ってくる。一度きりの削除では、インポートで元に戻ってしまう。
 *
 * そこで **表示のたびに**、保存されている発話と直した文の組を
 * 今の添削フィルタ(shared/correction-guard.ts。backend と同じ実装)に通し、
 * - 受け入れられ、全部の変更にテンプレートがある → **今のテンプレートで作り直した説明** を出す
 *   (保存された説明文は使わない。表示される文面は常に今のテンプレート)
 * - それ以外 → 添削は無いものとして扱う(何も出さない)
 *
 * 会話画面はこのセッションで作った行(grammar-check を申告した backend の添削だけを
 * 保存している)しか出さないので要らない。
 *
 * @returns 表示してよい添削。無ければ null。
 */
export function storedFeedback(message: Pick<Message, 'feedback'>): Feedback | null {
  const f = message.feedback as Partial<Feedback> | null | undefined
  if (!f || typeof f !== 'object') return null
  const checked = recheckCorrection(f.userSaid, f.corrected)
  return checked ? toFeedback(checked) : null
}

/**
 * 履歴画面の「日本語訳の再取得」で、添削をどう書き込むか。
 *
 * 既に **検証を通る** 添削が入っている行は書き換えない(ユーザーが頼んだのは日本語訳)。
 * 検証を通らない保存済みの添削(モデルが書いたもの)は **無いものとして扱い**、
 * 検証済みの添削が返ってきたらそれで置き換える。返ってこなければ何も書かない
 * (repo の更新はフィールドを消せないが、表示は storedFeedback が隠す)。
 *
 * @param checked grammar-check を申告した backend が返した添削(申告が無ければ null を渡すこと)
 */
export function retryFeedbackPatch(
  message: Pick<Message, 'feedback'>,
  checked: CheckedCorrection | null | undefined,
): { feedback?: Feedback } {
  if (!checked || storedFeedback(message)) return {}
  return { feedback: toFeedback(checked) }
}

function toFeedback(c: CheckedCorrection): Feedback {
  return { userSaid: c.user_said, corrected: c.corrected, explanation: c.explanation }
}

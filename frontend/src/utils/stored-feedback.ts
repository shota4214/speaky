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
 * そこで **表示のたびに**、**直前のユーザー発話(実際に言ったこと)** と直した文の組を
 * 今の添削フィルタ(shared/correction-guard.ts。backend と同じ実装)に通し、
 * - 保存された引用(userSaid)が直前のユーザー発話と(前後の空白を除いて)一致し、
 * - 受け入れられ、全部の変更にテンプレートがある
 * → **今のテンプレートで作り直した説明** を出す
 *   (保存された説明文は使わない。「言ったこと」の欄も保存された引用ではなく実際の発話を出す)
 * それ以外 → 添削は無いものとして扱う(何も出さない)
 *
 * ── なぜ保存された引用(userSaid)で判定しないのか ──
 * 以前のバージョンの `user_said` もモデルが自由に書いたもので、実際の発話と照合されていない。
 * 正しく「My sister is a nurse.」と言ったのに、モデルが「My sister is nurse.」と
 * 引用を作り、直した文を「My sister is a nurse.」にすると、その組はフィルタを通って
 * 冠詞の説明まで付く。引用で判定すると、**言ってもいない間違いを消し線付きで出す** ことになる。
 * 長い発話の一部だけを引用した場合も同じ(backend なら長すぎて添削しない発話が通ってしまう)。
 * grammar-check の経路が保存する `user_said` は発話を trim したものなので、この一致条件で落ちない。
 *
 * 会話画面はこのセッションで作った行(grammar-check を申告した backend の添削だけを
 * 保存している)しか出さないので要らない。
 *
 * @param userText 直前のユーザー行の発話。無ければ(null / undefined)添削は出さない。
 * @returns 表示してよい添削。無ければ null。
 */
export function storedFeedback(
  message: Pick<Message, 'feedback'>,
  userText: string | null | undefined,
): Feedback | null {
  const f = message.feedback as Partial<Feedback> | null | undefined
  if (!f || typeof f !== 'object') return null
  if (typeof userText !== 'string' || typeof f.userSaid !== 'string') return null
  if (f.userSaid.trim() !== userText.trim()) return null
  const checked = recheckCorrection(userText, f.corrected)
  return checked ? toFeedback(checked) : null
}

/**
 * 履歴画面で表示する添削(メッセージ ID → 添削)を **1 回の走査で** 作る。
 * 各行の添削は、その行より前で最後に出てきたユーザー行の発話で検証する(storedFeedback)。
 * ユーザー行より前の行(挨拶など)には添削を出さない。
 */
export function displayFeedbackMap(
  messages: readonly Pick<Message, 'id' | 'role' | 'userText' | 'feedback'>[],
): Map<string, Feedback | null> {
  const result = new Map<string, Feedback | null>()
  let lastUserText: string | null = null
  for (const m of messages) {
    result.set(m.id, storedFeedback(m, lastUserText))
    if (m.role === 'user') lastUserText = m.userText
  }
  return result
}

/**
 * 履歴画面の「日本語訳の再取得」で、添削をどう書き込むか。
 *
 * 既に **検証を通る** 添削が入っている行は書き換えない(ユーザーが頼んだのは日本語訳)。
 * 検証を通らない保存済みの添削(モデルが書いたもの / 引用が実際の発話と一致しないもの)は
 * **無いものとして扱い**、検証済みの添削が返ってきたらそれで置き換える。返ってこなければ
 * 何も書かない(repo の更新はフィールドを消せないが、表示は storedFeedback が隠す)。
 *
 * @param userText 直前のユーザー行の発話(表示と同じ判定に使う)
 * @param checked grammar-check を申告した backend が返した添削(申告が無ければ null を渡すこと)
 */
export function retryFeedbackPatch(
  message: Pick<Message, 'feedback'>,
  userText: string | null | undefined,
  checked: CheckedCorrection | null | undefined,
): { feedback?: Feedback } {
  if (!checked || storedFeedback(message, userText)) return {}
  return { feedback: toFeedback(checked) }
}

function toFeedback(c: CheckedCorrection): Feedback {
  return { userSaid: c.user_said, corrected: c.corrected, explanation: c.explanation }
}

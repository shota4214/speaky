import type { Feedback } from './chat-reply.js'
import {
  CORRECTION_MAX_WORDS,
  CORRECTION_MIN_WORDS,
  correctionSkipReason,
  evaluateCorrectionPair,
  extractCorrection,
  type CorrectionCategory,
  type CorrectionSkipReason,
  type GuardVerdict,
} from '../shared/correction-guard.js'
import { isClientAbort } from './client-abort.js'
import { chatWithOllama, type ChatWithOllamaOptions, type OllamaChatMessage } from './ollama.js'
import { OLLAMA_BUDGET_MS } from '../shared/request-budget.js'

/**
 * 添削(文法チェック)の LLM 呼び出し。
 *
 * ── 設計(実モデルで測ってから決めた。数字は CLAUDE.md の「添削」節)──
 *  1) モデルにやらせるのは **「文を最小限に直す。正しければそのまま繰り返す」だけ**。
 *     説明・カテゴリ・JSON は書かせない。1.5B〜3B の説明文は英語 / 崩れた日本語 /
 *     中国語になり、「正しい文を間違いと言う」判定も JSON で書かせると増えた。
 *  2) 返ってきた文と元の発話の差分を `correction-guard.ts` が単語単位で判定し、
 *     **全部の変更が固定テンプレートで説明できたときだけ**表示する。
 *  3) 失敗(タイムアウト・中断・空・弾かれた・説明できない)は **何も表示しない**。
 *     エラーイベントにもユーザーに見えるエラーにもしない(会話はもう成立している)。
 *
 * ── いつ走るか ──
 * 返答の英文が確定し、日本語訳を届けた **後**。マイクは読み上げが終わった時点で
 * 開くので、この呼び出しを待たない。次のターンが始まるとクライアントがストリームを
 * 切り、その signal がこの呼び出しも Ollama まで止める(1 枠しかないため)。
 */

/** 研究で選んだ V6 のシステムプロンプト。**一字一句変えないこと**(測った数字が前提を失う)。 */
export const GRAMMAR_CHECK_SYSTEM_PROMPT =
  'Fix the grammar of the English sentence inside <said></said>, spoken by a Japanese learner. Change as few words as possible. If it is already correct, repeat it unchanged. Output only the sentence.'

/**
 * 研究の SHOTS8_ECHO(8 往復の例示)。
 * 間違いを直す例 3 つと、**正しい文をそのまま繰り返す例 5 つ**(小文字の音声認識の文・
 * 短縮形・固有名詞入りの疑問文・カジュアルな相づち)。後者が「正しい文を書き換えない」
 * 性質の大半を担っている。**一字一句変えないこと**。
 */
export const GRAMMAR_CHECK_SHOTS: readonly (readonly [said: string, answer: string])[] = [
  ['My mother like cooking.', 'My mother likes cooking.'],
  ["i'm gonna play soccer tomorrow", "i'm gonna play soccer tomorrow"],
  ['i watched tv with my son last night', 'i watched tv with my son last night'],
  ['He have a lot of friend.', 'He has a lot of friends.'],
  ["We've known each other since high school.", "We've known each other since high school."],
  ['i went to shopping in shinjuku yesterday', 'i went shopping in shinjuku yesterday'],
  ['Where did you stay in Nagoya?', 'Where did you stay in Nagoya?'],
  ['sounds good', 'sounds good'],
]

/** 生成を止める文字列。例示の区切りタグと改行(= 1 文だけ)。 */
export const GRAMMAR_CHECK_STOP: readonly string[] = ['<said>', '</said>', '\n']

/** 1 文を書き直すのに十分な上限(研究時と同じ)。 */
export const GRAMMAR_CHECK_NUM_PREDICT = 60

/** これより短い発話("sounds good" 等)は見ない(値は shared/correction-guard.ts)。 */
export const GRAMMAR_CHECK_MIN_WORDS = CORRECTION_MIN_WORDS
/** これより長い発話は見ない(値と理由は shared/correction-guard.ts)。 */
export const GRAMMAR_CHECK_MAX_WORDS = CORRECTION_MAX_WORDS

/**
 * 1 回の呼び出しのサンプリング。**温度 0 / seed 0 で決定的**。
 *
 * ⚠️ `repeatPenalty: 1.0` を **明示すること**。backend の既定(1.1)は「既に出た語を
 * 繰り返す」ことを罰するが、このプロンプトは **正しい文を一字一句写す** ことに
 * 依存している。既定のままだと正しい文を言い換え始める。
 *
 * ⚠️ 配列の **本数** は `shared/request-budget.ts` の OLLAMA_ATTEMPTS.grammarCheck と
 * 一致していなければならない(クライアント締め切りがそこから計算される)。
 * リトライは足さない: 温度 0 では同じ出力が返るだけで、待ち時間だけが増える。
 */
export const GRAMMAR_CHECK_ATTEMPTS: readonly Pick<
  ChatWithOllamaOptions,
  'temperature' | 'seed' | 'topP' | 'topK' | 'repeatPenalty'
>[] = [{ temperature: 0, seed: 0, topP: 0.9, topK: 40, repeatPenalty: 1.0 }]

export function buildGrammarCheckMessages(userText: string): OllamaChatMessage[] {
  const tag = (t: string) => `<said>${t}</said>`
  return [
    { role: 'system', content: GRAMMAR_CHECK_SYSTEM_PROMPT },
    ...GRAMMAR_CHECK_SHOTS.flatMap(([said, answer]): OllamaChatMessage[] => [
      { role: 'user', content: tag(said) },
      { role: 'assistant', content: answer },
    ]),
    { role: 'user', content: tag(userText) },
  ]
}

export type GrammarCheckSkipReason = CorrectionSkipReason

/**
 * LLM を呼ぶ前に「そもそも見ない」発話を決める。null = 見る。
 * 日本語 / 英日混在の入力は翻訳の経路なので添削しない(ここは直接の入口ではないが、
 * enrich の再取得は mode を知らないので文字で判定する)。
 * 実装は shared(履歴画面の再検証も同じ足切りを使う)。
 */
export function grammarCheckSkipReason(
  userText: string | null | undefined,
): GrammarCheckSkipReason | null {
  return correctionSkipReason(userText)
}

export interface GrammarCheckEvaluation {
  /** 表示してよい添削。null = 何も表示しない。 */
  feedback: Feedback | null
  /** モデル出力から取り出した文(「そのまま」なら元と同じ文)。 */
  candidate: string
  verdict: GuardVerdict
  reasons: string[]
  categories: CorrectionCategory[] | null
}

/**
 * モデルの生出力を判定して、表示してよい添削を組み立てる(純粋関数)。
 * 表示するのは **フィルタが受け入れ、かつ全部の変更にテンプレートがある** ときだけ。
 */
export function evaluateGrammarCheckOutput(userText: string, raw: string): GrammarCheckEvaluation {
  const extracted = extractCorrection(raw, 'echo')
  const candidate = extracted.sentinel ? '' : extracted.text
  return { candidate, ...evaluateCorrectionPair(userText.trim(), candidate) }
}

export interface GrammarCheckInput {
  userText: string | null | undefined
  model?: string
  numCtx?: number
  signal?: AbortSignal
  /** ログの接頭辞。 */
  tag?: string
}

/**
 * 発話 1 つを添削する。**例外を投げない**(失敗はすべて null + 警告ログ。中断はログも出さない)。
 */
export async function checkGrammar(input: GrammarCheckInput): Promise<Feedback | null> {
  const tag = input.tag ?? '[grammar-check]'
  const skip = grammarCheckSkipReason(input.userText)
  if (skip) return null
  const userText = (input.userText ?? '').trim()
  const messages = buildGrammarCheckMessages(userText)

  for (const sampling of GRAMMAR_CHECK_ATTEMPTS) {
    if (input.signal?.aborted) return null
    let raw: string
    try {
      const res = await chatWithOllama(messages, {
        model: input.model,
        numCtx: input.numCtx,
        numPredict: GRAMMAR_CHECK_NUM_PREDICT,
        stop: [...GRAMMAR_CHECK_STOP],
        jsonFormat: false,
        firstTokenTimeoutMs: OLLAMA_BUDGET_MS.grammarCheck,
        signal: input.signal,
        ...sampling,
      })
      raw = res.message?.content ?? ''
    } catch (e) {
      // 中断はユーザーが次のターンを始めた / 会話を終えただけ。失敗ではない。
      if (input.signal && isClientAbort(e, input.signal)) return null
      console.warn(`${tag} grammar check failed (no correction shown):`, e)
      return null
    }
    if (input.signal?.aborted) return null
    if (!raw.trim()) {
      console.warn(`${tag} grammar check returned empty output (no correction shown)`)
      return null
    }
    const result = evaluateGrammarCheckOutput(userText, raw)
    if (process.env.SPEAKY_DEBUG_GRAMMAR_CHECK === '1') {
      console.info(
        `${tag} ${JSON.stringify({ userText, raw, verdict: result.verdict, reasons: result.reasons, categories: result.categories, shown: result.feedback !== null })}`,
      )
    }
    return result.feedback
  }
  return null
}

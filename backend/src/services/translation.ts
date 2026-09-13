/**
 * 翻訳系の LLM 呼び出し(日本語/混在 → 英語、英語 → 日本語)。
 *
 * 非ストリーミング経路とストリーミング経路の両方から使うため routes から
 * services へ切り出した。**中身は routes/chat.ts にあった時点から変えていない。**
 */
import type { Level } from './conversation-prompt.js'
import { looksLikeJsonScaffold, matchJsonStringField } from './json-salvage.js'
import { chatWithOllama, OllamaError, RETRY_SEED, type OllamaChatMessage } from './ollama.js'
import { OLLAMA_BUDGET_MS } from '../shared/request-budget.js'
import {
  acceptJapaneseTranslation,
  containsNonLatinScript,
  stripEmoji,
  stripLoneSurrogates,
} from '../shared/text-guards.js'

/**
 * japanese_help / mixed モードは LLM のシステムプロンプトに「翻訳して」と書くだけでは
 * 小型モデル(Llama 3.2 3B 等)が会話継続に流れてしまうため、
 * バックエンドで専用の翻訳プロンプトに完全分離する。
 *
 * - 会話の system prompt と履歴は一切渡さない(会話継続の引力を断つ)
 * - 単一タスク「日本語/混在文を自然な英語に翻訳する」だけを LLM に依頼
 * - 出力 string をそのまま reply_en として返し、reply_ja はサーバー側で組み立てる
 */
/**
 * モデルが返す自然文の前置き(「Sure! Here's the translation: ...」「Translation: ...」
 * 「"..."」 等)を剥がして純粋な英文だけを残す。
 *
 * 順序が重要:
 *  1) 前置きを先に剥がす(同行 / 直後改行 どちらにも対応)
 *  2) 残りが複数行なら「最初の英語っぽい行」だけ採用する。
 *     ※ 末尾を拾うと "This is a natural way to say it." のような
 *     モデルの補足説明が翻訳結果として返ってしまうため、必ず先頭側を拾う。
 *  3) 全体を囲う引用符を剥がす
 */
export function stripTranslationPreamble(raw: string): string {
  let out = raw.trim()

  // 1) 典型的な前置きパターン(同行末コロン + オプションの直後改行)を順に剥がす。
  //    "Sure" / "Of course" / "OK" 等の interjection は単独では削らない:
  //    「もちろん行くよ」→ "Sure, I'll go." の "Sure," まで削ってしまうため。
  //    後続に "Here's the translation" / "I'd translate that as" / "Translation:"
  //    などの明確な前置きが続く場合だけ、合わせて剥がす。
  const INTERJECTION_PREFIX = '(?:(?:Sure|Of course|Certainly|Got it|Okay|OK)[!.,]?\\s+)?'
  // 前置きと本文を分ける区切り文字を「必須」にする:
  //   - ASCII コロン `:` (U+003A) / 全角コロン `:` (U+FF1A)
  //   - 改行
  //   - 直後に引用符(本文を囲っているケース。引用符は step 3 で剥がす)
  //
  // optional にすると `Here's my sentence.` のような正しい翻訳本文を
  // `Here's my sentence` までマッチして `.` だけ残してしまうリスクがある。
  const SEPARATOR = '(?:\\s*[:：]\\s*|\\s*\\n|\\s+(?=["\'「『]))'
  const PREAMBLE_PATTERNS: RegExp[] = [
    new RegExp(
      `^\\s*${INTERJECTION_PREFIX}Here\\s*(?:'s|is|are|you go)\\s+(?:the\\s+|my\\s+|a\\s+)?(?:suggested\\s+|natural\\s+)?(?:translation|English(?:\\s+version)?|version|sentence)${SEPARATOR}`,
      'i',
    ),
    new RegExp(
      `^\\s*${INTERJECTION_PREFIX}I\\s*(?:'d|would)\\s+(?:translate\\s+(?:that|it)\\s+as|say|put\\s+(?:that|it))${SEPARATOR}`,
      'i',
    ),
    new RegExp(
      `^\\s*${INTERJECTION_PREFIX}(?:The\\s+)?(?:Output|Translation|English|Answer|Result|In\\s+English)${SEPARATOR}`,
      'i',
    ),
  ]
  for (const pat of PREAMBLE_PATTERNS) {
    out = out.replace(pat, '').trim()
  }

  // 2) 残りが複数行なら、明らかにメタ説明と分かる行(Note:, This sentence...,
  //    括弧書き 等)を除外したうえで先頭の行を採用する。
  //    ASCII 比率では "I'm 30." のような短く数字を含む正しい翻訳を弾いて
  //    後続の説明文を拾うリスクがあるため、比率は使わない。
  //    一方 "This is ..." / "It means ..." / "That means ..." は翻訳本文として
  //    自然に出るため META 判定から外す(`This sentence`/`This phrase` 等の
  //    明確に説明と分かる表現のみを除外する)。
  if (out.includes('\n')) {
    const META_LINE_PATTERN =
      /^(Note|Notice|Tip|Explanation|Translation note|This (?:sentence|phrase|expression|translation|wording)|In other words|\(|\*|—|–)/i
    const lines = out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const line of lines) {
      if (!META_LINE_PATTERN.test(line)) {
        out = line
        break
      }
    }
  }

  // 3) 全体を囲う引用符/括弧を剥がす
  out = out.replace(/^["'「『]\s*|\s*["'」』]\s*$/g, '').trim()
  return out
}

/**
 * 翻訳出力の **最初の段落** だけを返す(空行で区切られた 2 段落目以降は捨てる)。
 *
 * v1.2.0 直後の実装は stop に `'\n\n'` を入れて 2 段落目を生成させなかったが、
 * それだと **出力が空行で始まるモデルは 1 文字も出さずに止まる**。温度 0 では
 * 引き直しても同じなので、訳が永久に空になる。stop からは外し、ここで切る。
 *
 *  - 先頭の空行は読み飛ばす(これが直したい症状)
 *  - 前置きだけの段落(「Here's the translation:」)は訳ではないので読み飛ばす
 *  - それ以外は **最初の段落で必ず打ち切る**。訳の後ろに続けて書かれた
 *    「返事の続き」や補足説明を検証(と画面)へ渡さない
 */
export function firstTranslationParagraph(raw: string): string {
  const paragraphs = raw
    .split(/\r?\n[^\S\r\n]*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  for (const p of paragraphs) {
    if (stripTranslationPreamble(p)) return p
  }
  return ''
}

/**
 * ja→en(日本語 / 英日混在の学習者発話 → 言うべき英文)のプロンプト。
 *
 * v1.2.0 は「Input: … / Output: …」の例を 5 本並べた長い system prompt に
 * 学習者の発話を **素の user メッセージ** として渡していた。実モデル評価では
 *  - 例文をそのまま返す(llama3.2:1b 12 件中 3 件)
 *  - 質問の形の入力(「あなたの趣味は何ですか？」)に **答えてしまう**(全モデル)
 * が起きていた。区切りタグで「これは訳す対象であって話しかけられた文ではない」と
 * 明示し、例は **過去の会話ターン** として 2 往復だけ見せる(うち 1 つは質問)。
 *
 * 評価で検証した文面そのもの。レベル指示(CEFR)は載せていない — 載せない形で
 * 検証しており、1 行指示を太らせると小型モデルが守らなくなるため。
 */
const JA_TO_EN_INSTRUCTION =
  "Rewrite the learner's sentence inside <ja></ja> as one natural, simple English sentence that they could say. It may mix Japanese and English. Do not answer it. Output only the English sentence."

const JA_TO_EN_FEW_SHOT: readonly OllamaChatMessage[] = [
  { role: 'user', content: '<ja>明日は meeting があるんだ</ja>' },
  { role: 'assistant', content: 'I have a meeting tomorrow.' },
  { role: 'user', content: '<ja>好きな食べ物は何？</ja>' },
  { role: 'assistant', content: 'What is your favorite food?' },
]

/**
 * ja→en 翻訳の試行設定。
 * ⚠️ **本数は shared/request-budget.ts の OLLAMA_ATTEMPTS.translation と一致させること。**
 * /api/chat の日本語入力経路はこの梯子だけを通るので、クライアント側の締め切りが
 * 「本数 × first-token 予算」から計算されている(v1.1.0 は 120 秒 対 120 秒の同値で、
 * どちらが先に諦めるかが運になっていた)。
 *
 * 1 回目は温度 0(決定的な 1 本)。温度 0 の出力を検証で弾いたときに同じ設定で
 * 引き直しても同じ出力が返るだけなので、2 回目は温度を少し上げ seed を固定する
 * (再現可能な別の 1 本)。
 */
export const TRANSLATION_ATTEMPTS: readonly { temperature: number; seed?: number }[] = [
  { temperature: 0 },
  { temperature: 0.3, seed: RETRY_SEED },
]

/** 区切りタグの残骸を取り除く(stop で止めきれずに閉じタグだけ出ることがある)。 */
function stripTags(text: string, tag: 'en' | 'ja'): string {
  return text.replace(new RegExp(`</?${tag}>`, 'gi'), '')
}

/**
 * ja→en の出力として使ってよいか。英字を含み、日本語や他の文字体系が残っていないこと。
 * 残っている = 訳しきれていない / 日本語で答えてしまった出力。
 */
export function isAcceptableEnglishRendering(text: string): boolean {
  return /[A-Za-z]/.test(text) && !containsNonLatinScript(text)
}

export async function translateToNaturalEnglish(
  userText: string,
  options: { model?: string; level?: Level; numCtx?: number; signal?: AbortSignal },
): Promise<string> {
  const source = stripTags(stripEmoji(userText), 'ja').trim()
  const messages: OllamaChatMessage[] = [
    { role: 'system', content: JA_TO_EN_INSTRUCTION },
    ...JA_TO_EN_FEW_SHOT,
    { role: 'user', content: `<ja>${source}</ja>` },
  ]
  for (const a of TRANSLATION_ATTEMPTS) {
    const ollamaRes = await chatWithOllama(messages, {
      model: options.model,
      numCtx: options.numCtx,
      // 予算は shared/request-budget.ts が出典。**attempts の本数**(2)も
      // OLLAMA_ATTEMPTS.translation と一致させること: /api/chat の日本語入力経路は
      // この梯子だけを通るので、クライアント締め切りがここから計算されている。
      firstTokenTimeoutMs: OLLAMA_BUDGET_MS.translation,
      temperature: a.temperature,
      ...(a.seed !== undefined && { seed: a.seed }),
      topP: 0.9,
      numPredict: 120,
      // '\n\n' は stop に入れない(firstTranslationParagraph の注記)。2 段落目は後処理で捨てる。
      stop: ['<ja>'],
      // 自然文を返してほしいので Ollama の JSON モードを必ず OFF にする。
      // ここを忘れると format:'json' が送られてモデルが {"sentence":"..."}
      // のような JSON を返し、reply_en にそのまま入って UI 表示が壊れる。
      jsonFormat: false,
      signal: options.signal,
    })
    const raw = ollamaRes.message?.content ?? ''
    const candidate = stripLoneSurrogates(
      stripTags(stripTranslationPreamble(firstTranslationParagraph(raw)), 'ja'),
    ).trim()
    if (candidate && isAcceptableEnglishRendering(candidate)) return candidate
    console.warn(
      `[chat:translate] rejected ja→en output at temperature=${a.temperature}:`,
      candidate.slice(0, 120),
    )
  }
  return ''
}

/**
 * 英文 → 日本語訳のプロンプト(「日本語訳」の欄に出るもの)。
 *
 * v1.2.0 は 2 行の system prompt の下に **英文をそのまま user メッセージとして**
 * 渡していた。小型モデルにとってそれは「話しかけられた」のと同じで、訳さずに
 * **返事を書く**(英語やローマ字で)。M1 実機のスクリーンショットはこれだった。
 * 区切りタグ + 1 行指示 + 過去ターンとしての例 2 往復 + 温度 0 + stop にし、
 * 出力を検証して、弾いたら 1 回だけ引き直す。評価で検証した文面そのもの。
 */
const EN_TO_JA_INSTRUCTION =
  'Translate the English text inside <en></en> into natural Japanese. Output only the Japanese translation.'

const EN_TO_JA_FEW_SHOT: readonly OllamaChatMessage[] = [
  { role: 'user', content: '<en>Hi! How are you today?</en>' },
  { role: 'assistant', content: 'こんにちは！今日の調子はどう？' },
  { role: 'user', content: '<en>I like cooking. What do you usually eat for dinner?</en>' },
  { role: 'assistant', content: '料理が好きなんだ。夕ごはんはいつも何を食べるの？' },
]

/**
 * en→ja 翻訳の試行設定。
 * ⚠️ **本数は shared/request-budget.ts の OLLAMA_ATTEMPTS.translationEnToJa と一致させること。**
 */
export const EN_TO_JA_ATTEMPTS: readonly { temperature: number; seed?: number }[] = [
  { temperature: 0 },
  { temperature: 0.3, seed: RETRY_SEED },
]

/**
 * ユーザーが「↻ 再取得」を押したとき(と会話終了後の一括 enrich)の試行設定。
 * 上の梯子は 2 本とも決定的なので、それで弾かれた訳は **何度押しても同じ結果** になる。
 * 再取得では seed を固定せず温度も少し上げて、別の出力を引く。
 * ⚠️ 本数は EN_TO_JA_ATTEMPTS と同じにすること(予算は同じ宣言から計算している)。
 */
export const EN_TO_JA_FRESH_ATTEMPTS: readonly { temperature: number; seed?: number }[] = [
  { temperature: 0.3 },
  { temperature: 0.5 },
]

/**
 * 日本語訳として使ってよい文字列か確かめる。
 *
 * このプロンプトはプレーンテキストを求めているが、小型モデルは JSON
 * エンベロープ(`{"reply_ja": "..."}`)で返すことがある。そのまま通すと
 * **その JSON が日本語訳として画面に出て DB にも保存される**。
 * 中の reply_ja を拾えれば拾い、拾えなければ空にする(空 = 取得失敗として
 * 扱われ、UI に再取得ボタンが出る。JSON を見せるよりはるかにまし)。
 */
export function sanitizeJapaneseTranslation(raw: string): string {
  const stripped = stripTranslationPreamble(raw)
  if (!looksLikeJsonScaffold(stripped)) return stripped
  const inner = matchJsonStringField(stripped, 'reply_ja')
  if (inner?.trim()) return inner.trim()
  console.warn('[chat] en→ja 翻訳が JSON で返ってきたので破棄した')
  return ''
}

export async function translateEnglishToJapanese(
  englishText: string,
  options: {
    model?: string
    numCtx?: number
    signal?: AbortSignal
    /** ユーザー操作による再取得。決定的な梯子ではなく、毎回違う出力を引く梯子を使う。 */
    fresh?: boolean
  },
): Promise<string> {
  // 絵文字は訳させない(訳に絵文字や「笑顔」が混ざる / 検証の長さ判定が狂う)。
  const source = stripTags(stripEmoji(englishText), 'en').trim()
  if (!source) return ''
  const messages: OllamaChatMessage[] = [
    { role: 'system', content: EN_TO_JA_INSTRUCTION },
    ...EN_TO_JA_FEW_SHOT,
    { role: 'user', content: `<en>${source}</en>` },
  ]
  try {
    for (const a of options.fresh ? EN_TO_JA_FRESH_ATTEMPTS : EN_TO_JA_ATTEMPTS) {
      const ollamaRes = await chatWithOllama(messages, {
        model: options.model,
        numCtx: options.numCtx,
        firstTokenTimeoutMs: OLLAMA_BUDGET_MS.translation,
        temperature: a.temperature,
        ...(a.seed !== undefined && { seed: a.seed }),
        topP: 0.9,
        numPredict: 200,
        // '\n\n' は stop に入れない(firstTranslationParagraph の注記)。2 段落目は後処理で捨てる。
        stop: ['<en>', '</en>'],
        jsonFormat: false,
        signal: options.signal,
      })
      const raw = sanitizeJapaneseTranslation(
        firstTranslationParagraph(ollamaRes.message?.content ?? ''),
      )
      const ja = acceptJapaneseTranslation(stripTags(raw, 'en'), source)
      if (ja) return ja
      console.warn(
        `[chat] rejected en→ja translation at temperature=${a.temperature}:`,
        raw.slice(0, 120),
      )
    }
    return ''
  } catch (e) {
    // 中断は「失敗」ではない。空文字を返して先へ進むと、切れたソケットへ
    // レスポンスを組み立てる無駄な処理が続くので、呼び出し元へ投げ返す。
    if (e instanceof OllamaError && e.code === 'ABORTED') throw e
    console.warn('[chat] en→ja fallback translation failed:', e)
    return ''
  }
}

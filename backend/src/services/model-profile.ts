import {
  resolveProfileLevel,
  type ModelProfileLevel,
  type ModelProfilePref,
} from '../shared/llm-models.js'
import { resolveLlmModel } from './ollama.js'

/**
 * 会話プロファイル。**「どのモデルでも同じ設定で回す」のをやめるための束**。
 *
 * v1.1.0 までは 3B を前提にした 1 セットしか無かった。プロンプトは約 900 トークン・
 * 7 セクションあり、1B / 1.5B クラスは
 *   - 「Conversation style」の 6 行(バリエーションを出せ)を **そもそも守れない**
 *   - 3 レベルぶんの説明を読まされて、そのうち 2 つは今のターンに無関係
 * という状態で、指示に埋もれて JSON も英文も崩れていた。
 * small は「短く・少なく・冷たく」の 1 点張りで組み直したもの。
 *
 * 値の出どころ:
 *  - standard = v1.1.0 の実効値そのまま(挙動を変えない)
 *  - small    = standard から生成予算と履歴を削り、温度を下げ、
 *               繰り返しペナルティを少し上げたもの
 */
export interface ModelProfile {
  level: ModelProfileLevel
  /** system prompt の作り分け。conversation-prompt.ts が読む。 */
  promptVariant: ModelProfileLevel
  /** プロンプトに載せる会話履歴の往復数(user + ai で 2 倍のメッセージ数)。 */
  maxHistoryTurns: number
  /**
   * コンテキスト長。
   *
   * ⚠️ **small でも 4096 のまま**。CLAUDE.md は「計測せずに num_ctx を下げるな」と
   * 書いており、計測できる実機(M1 MacBook Air)がまだ手元に無い。
   * プロファイル駆動にしたのは後で測って下げられるようにするためで、
   * 今回は下げていない。small はプロンプトが短くなるぶん、同じ 4096 でも
   * 履歴とプロフィールに回せる余裕が増える。
   */
  numCtx: number
  /** /chat(JSON エンベロープ)の生成上限。 */
  chatNumPredict: number
  /** /chat/opening の生成上限。 */
  openingNumPredict: number
  /** ストリーミング(プレーンテキスト)の生成上限。 */
  streamNumPredict: number
  /** enrich(日本語訳 + 添削 + 単語)の生成上限。 */
  enrichNumPredict: number
  /** 1 回目の試行の温度。 */
  temperature: number
  /** opening は挨拶のバリエーションが欲しいので少し高め。 */
  openingTemperature: number
  /** 1 回目の試行の top_p。 */
  topP: number
  /** 1 回目の試行の繰り返しペナルティ。 */
  repeatPenalty: number
  /**
   * enrich でどこまで作らせるか。
   * - 'full'             : 日本語訳 + 添削 + 単語(JSON 1 回)
   * - 'translation-only' : 日本語訳だけ(en→ja の単発翻訳)
   *
   * small が translation-only なのは品質の問題。1B クラスの添削は
   * 「間違っていない文を間違いだと言う」誤添削が実際に出るうえ、
   * 単語抽出も trivial な語を並べるだけになりがちで、どちらも
   * **学習者を積極的に間違った方向へ引っ張る**。日本語訳は製品の約束なので残す。
   */
  enrichment: 'full' | 'translation-only'
}

const STANDARD_PROFILE: ModelProfile = {
  level: 'standard',
  promptVariant: 'standard',
  maxHistoryTurns: 10,
  numCtx: 4096,
  chatNumPredict: 640,
  openingNumPredict: 400,
  streamNumPredict: 320,
  enrichNumPredict: 360,
  temperature: 0.85,
  openingTemperature: 0.95,
  topP: 0.92,
  repeatPenalty: 1.15,
  enrichment: 'full',
}

const SMALL_PROFILE: ModelProfile = {
  level: 'small',
  promptVariant: 'small',
  // 10 往復(20 メッセージ)は 1B には長すぎる。直近 4 往復あれば
  // 「今なんの話をしているか」は保てるし、そこから先は小型モデルが
  // どのみち参照できていない。
  maxHistoryTurns: 4,
  numCtx: 4096,
  // 小型モデルは「1〜2 文で返せ」と言えば守る(守らないのは長い指示のとき)。
  // 予算を半分にすると、指示を無視して長文を書き始めたときの最悪待ち時間も半分になる。
  chatNumPredict: 320,
  openingNumPredict: 220,
  streamNumPredict: 160,
  // 日本語訳だけなので 360 も要らない。
  enrichNumPredict: 240,
  temperature: 0.7,
  openingTemperature: 0.8,
  topP: 0.9,
  // 小型モデルは同じ言い回し("That sounds great!")に張り付きやすい。
  repeatPenalty: 1.2,
  enrichment: 'translation-only',
}

export const MODEL_PROFILES: Record<ModelProfileLevel, ModelProfile> = {
  standard: STANDARD_PROFILE,
  small: SMALL_PROFILE,
}

/**
 * 設定値(auto/standard/small)とモデル名からプロファイルを 1 つ決める。
 * 推定ロジックは shared/llm-models.ts にあり、frontend も同じ関数を読む
 * (設定画面で「今どちらで動くか」を表示するため)。
 *
 * ⚠️ ここに渡す `model` は **allowlist を通した後の名前**でなければならない。
 * 会話ルートから直接呼ばず、{@link resolveTurnModelAndProfile} を使うこと。
 */
export function resolveModelProfile(
  pref: ModelProfilePref | undefined,
  model: string | undefined,
): ModelProfile {
  return MODEL_PROFILES[resolveProfileLevel(pref, model)]
}

/** 1 ターンで実際に使うモデル名とプロファイルの組。 */
export interface ResolvedTurnModel {
  /** 実際に Ollama へ投げる名前(allowlist で落ちたら既定モデル)。 */
  model: string
  /** その **解決後の名前** から決めたプロファイル。 */
  profile: ModelProfile
}

/**
 * リクエストされたモデル名から「実際に使う名前」と「そのプロファイル」を同時に決める。
 *
 * ⚠️ **プロファイルは必ず解決後の名前から導く**。
 * v1.2.0 の途中まで、会話ルート(`/api/chat`, `/api/chat/stream`, enrich)は
 * **リクエストされた名前**からプロファイルを決めていて、プレビュー
 * (`/api/model-profile/preview`)だけが解決後の名前から決めていた。
 * 両者が一致するのは「リクエストされた名前が allowlist を通るとき」だけで、
 * 通らないとき — たとえば設定に古い `mistral:7b` が残っている人 — は
 *   - プレビュー: 差し替え先(同梱 1B)のプロファイル = 軽量
 *   - 会話:       同梱 1B を **7B 用の長いプロンプト** で回す = 標準
 * という食い違いが出る。**バッジが嘘になるのは、まさにこのバッジが
 * 暴くために存在する状況**(黙ってモデルが差し替わったとき)だった。
 * 解決とプロファイル決定を 1 つの関数に閉じ込めて、呼び分けの余地を無くす。
 */
export function resolveTurnModelAndProfile(
  pref: ModelProfilePref | undefined,
  requestedModel: string | undefined,
): ResolvedTurnModel {
  const model = resolveLlmModel(requestedModel)
  return { model, profile: resolveModelProfile(pref, model) }
}

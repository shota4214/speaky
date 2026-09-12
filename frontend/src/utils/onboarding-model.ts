import {
  BUNDLED_LLM_MODEL,
  isAllowedLlmModel,
  LLM_CATALOG,
  RECOMMENDED_DOWNLOAD_LLM_MODEL,
  type LlmCatalogEntry,
} from '../storage/settings'

/**
 * オンボーディングの LLM 選択。**「実在しないモデルを選んだ状態にしない」**ための純関数。
 *
 * ── なぜこれが独立したモジュールなのか ──
 * v1.1.0 のオンボーディングは、メモリが 12GB 未満なら `llama3.2:1b` を
 * **あらかじめ選んで**いたのに、DMG に同梱していたのは `llama3.2:3b` だけだった。
 * ネットの無い 8GB 機では「選ばれているモデルが取得できない」→
 * モデル DL ステップの「次へ」が永久に押せない = 初回起動が行き止まり。
 * 完全ローカルという製品の一番の売りが、いちばん想定すべき機械で嘘になっていた。
 *
 * v1.2.0 では同梱物を 1B に変えたが、それだけでは同じ形の穴がまた開く
 * (例: メモリに余裕がある機械に 3B を薦めたいが、3B は同梱していない)。
 * そこで選択は **インストール済み一覧を必ず見て**決める。ロジックを
 * コンポーネントから引き剥がしてあるのは、この不変条件をテストで固定するため。
 */

/** オンボーディングの選択肢に出すモデル(取得フォームと同じカタログから作る)。 */
export const ONBOARDING_LLM_CHOICES: readonly LlmCatalogEntry[] = LLM_CATALOG.filter(
  (e) => e.offerForDownload,
)

export interface OnboardingLlmInput {
  /** `/api/models/ollama` で見えたモデル名。プローブ失敗時は空配列。 */
  installed: readonly string[]
  /** 12GB 未満か。メモリが分からないときは false + memoryKnown=false。 */
  lowMemory: boolean
  /** backend からメモリを取れたか。取れないときは推測せず同梱モデルに寄せる。 */
  memoryKnown: boolean
}

export interface OnboardingLlmSelection {
  /** 実際に選択状態にするモデル。 */
  model: string
  /** それが本当にインストール済みか。false = 何も入っていない異常時のみ。 */
  installed: boolean
  /**
   * 「メモリに余裕があるので薦めたいが、まだ入っていない」モデル。
   * null なら案内しない。**これがあっても選択は installed 側のまま**にする
   * (薦めるのと、取得できないものを選ばせるのは別の話)。
   */
  recommendedDownload: string | null
}

/**
 * 好みの順に候補を並べる。**同梱モデルは常に候補に入れる**(最後の砦)。
 *
 * - メモリが少ない / 分からない: 軽いものから。同梱の 1B が先頭。
 * - メモリに余裕がある: 3B を先頭にして、無ければ同梱の 1B に落ちる。
 *   ここで 9B / 14B を先頭にしないのは、オンボーディングの時点では
 *   どれも入っていないのが普通で、「入っている中で一番ましなもの」を
 *   選ぶのがこの関数の仕事だから(取得の案内は別の行で出す)。
 */
function preferenceOrder(lowMemory: boolean, memoryKnown: boolean): string[] {
  const lightweightFirst = [
    BUNDLED_LLM_MODEL,
    ...ONBOARDING_LLM_CHOICES.filter((e) => e.lightweight).map((e) => e.tag),
  ]
  if (lowMemory || !memoryKnown) return lightweightFirst
  return [RECOMMENDED_DOWNLOAD_LLM_MODEL, ...lightweightFirst]
}

/**
 * インストール済み一覧を見て、選択状態にするモデルを決める。
 *
 * 契約:
 *  1. **インストール済みのモデルが 1 つでもあれば、必ずその中から選ぶ。**
 *     ここが崩れると「次へ」が押せない初回起動に戻る。
 *  2. 1 つも無い異常時だけ、同梱モデルを選ぶ(DL ステップがそれを提示する)。
 *  3. メモリに余裕があって 3B が未取得なら `recommendedDownload` に入れる。
 *     選択は入っているものから動かさない。**オフラインでも先へ進めること**が
 *     案内より優先される。
 */
export function chooseOnboardingLlm(input: OnboardingLlmInput): OnboardingLlmSelection {
  const usable = input.installed.filter((name) => isAllowedLlmModel(name))
  const order = preferenceOrder(input.lowMemory, input.memoryKnown)

  const highMemory = input.memoryKnown && !input.lowMemory
  const recommendedDownload =
    highMemory && !usable.includes(RECOMMENDED_DOWNLOAD_LLM_MODEL)
      ? RECOMMENDED_DOWNLOAD_LLM_MODEL
      : null

  const preferred = order.find((tag) => usable.includes(tag))
  if (preferred) return { model: preferred, installed: true, recommendedDownload }

  // 好みの順には無いが何かは入っている(自分で pull した量子化タグ等)。
  // 「実在するものを選ぶ」方が「薦めたい名前を選ぶ」より強い。
  if (usable.length > 0) {
    return { model: usable[0]!, installed: true, recommendedDownload }
  }

  // 何も入っていない = 同梱物の展開に失敗しているか、dev 環境。
  // 同梱モデルを選んで DL ステップに取得させる(そこが唯一の出口)。
  return { model: BUNDLED_LLM_MODEL, installed: false, recommendedDownload }
}

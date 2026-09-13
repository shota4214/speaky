/**
 * 会話に使う LLM のカタログと名前解決。**backend と frontend の唯一の出典**。
 *
 * ── なぜ backend/src の下にあるのに frontend から import しているのか ──
 * v1.1.0 まで、この一覧は `backend/src/services/ollama.ts` と
 * `frontend/src/storage/settings.ts` に手書きで二重化されていて、
 * CLAUDE.md にも「手動同期が必要」と危険物として書いてあった。
 * 実際に片側だけ足した状態は「設定画面には出るのに backend が既定へ落とす」
 * (またはその逆)という、ユーザーからは原因の見えない不整合になる。
 *
 * 置き場所を backend 側にしたのは **強制する側が出典であるべき** だから。
 * frontend は相対 import でこのモジュールを直接読む。
 *   - backend: tsc(NodeNext)/ esbuild bundle の両方が素の .ts として扱える
 *   - frontend: Vite / vue-tsc が同じファイルを bundle する
 * JSON にしなかったのは backend が `module: NodeNext` で、JSON import に
 * import attributes(`with { type: 'json' }`)が要るため。属性の扱いは
 * tsc / esbuild / Vite(rollup)で微妙に食い違うので、3 つのツールチェーンが
 * 確実に一致する「依存ゼロの .ts」を出典にしてある。
 * **このファイルは node/DOM の API を一切使わないこと**(両方から読むため)。
 */

/**
 * 会話に使ってよいモデルの「ファミリー」。
 *
 * ⚠️ **これはセキュリティ境界ではない。**
 * backend は 127.0.0.1 にしか bind しておらず、モデル名は Ollama への
 * JSON ボディに入るだけで、シェルにもファイルパスにも渡らない。
 * ここにあるのは「Ollama にゴミを投げない」ための入口ガードであって、
 * 攻撃者を止めるための壁ではない。将来ここを緩めた人が
 * 「セキュリティを弱めた」と誤読しないよう明記しておく。
 *
 * ファミリー単位で判定するのは、量子化タグを弾かないため。
 * v1.1.0 までは完全一致だったので、`llama3.2:3b-instruct-q4_K_M` のような
 * 自分で pull した派生を選んでも静かに既定モデルへ落とされ、
 * 設定画面の一覧からも消えていた(= 選べないしその理由も出ない)。
 */
export const ALLOWED_LLM_FAMILIES: readonly string[] = ['llama3.2', 'llama3.1', 'gemma2', 'qwen2.5']

/** 会話プロファイル。small = 1B〜2B クラス向けの切り詰めた設定。 */
export type ModelProfileLevel = 'standard' | 'small'

/** 設定画面での選択肢。auto はモデルのパラメータ数から推定する。 */
export type ModelProfilePref = 'auto' | ModelProfileLevel

export const MODEL_PROFILE_PREFS: readonly ModelProfilePref[] = ['auto', 'standard', 'small']

export function isModelProfilePref(value: unknown): value is ModelProfilePref {
  return typeof value === 'string' && (MODEL_PROFILE_PREFS as readonly string[]).includes(value)
}

/**
 * small プロファイルに落とすパラメータ数の閾値(これ以下なら small)。
 * 2B を含むので、既に gemma2:2b を使っていた人は挙動が変わる
 * (設定スキーマ v3 の移行で明示的に standard を書き込んで据え置く)。
 */
export const SMALL_MODEL_MAX_BILLIONS = 2

export interface LlmCatalogEntry {
  /** Ollama のモデル参照(`ollama pull` にそのまま渡せる形)。 */
  tag: string
  /** 人間向けの名前。 */
  label: string
  /** 概算ダウンロードサイズ。 */
  sizeLabel: string
  /** 一覧で頭に付けるアイコン。 */
  icon: string
  /** インストール済み一覧に出す一言。**正直に**(精度が低いなら低いと書く)。 */
  note: string
  /** 8GB 機に薦めてよいモデルか(オンボーディングの自動選択に使う)。 */
  lightweight: boolean
  /** 取得フォーム / オンボーディングの選択肢に出すか。 */
  offerForDownload: boolean
  /**
   * DMG に同梱していて、**オフラインの初回起動でも必ず存在する**モデルか。
   *
   * ⚠️ true にしてよいのは {@link BUNDLED_LLM_MODEL} ただ 1 つ。
   * ここが実際の同梱物とずれると、オンボーディングが
   * 「同梱」と表示したモデルをオフラインのユーザーが取得できず、
   * 初回起動が行き止まりになる(v1.1.0 直前に実際に踏んだ穴)。
   * 同梱物を変えるときは scripts/prep-llama-model.mjs の MODEL と
   * この定数を必ず同時に変えること(両者の一致は
   * shared/llm-models.test.ts が prep スクリプトを読んで検証している)。
   */
  bundled: boolean
}

/**
 * 選択肢として提示するモデル。
 * allowlist は **ファミリー** で判定するので、ここに無いタグ
 * (例: 自分で pull した `qwen2.5:3b-instruct-q5_K_M`)も選べる。
 * この配列は「こちらから薦める型番」の一覧であって、許可の一覧ではない。
 */
export const LLM_CATALOG: readonly LlmCatalogEntry[] = [
  {
    tag: 'qwen2.5:1.5b',
    label: 'Qwen 2.5 1.5B',
    sizeLabel: '~1GB',
    icon: '⚡⚡',
    note: '同梱・既定 / 8GB 機向け・日本語訳が安定(軽量モード: 添削と単語は出ません)',
    lightweight: true,
    offerForDownload: true,
    bundled: true,
  },
  {
    // v1.2.0 の同梱物。**取得の選択肢からは外した**(offerForDownload: false)。
    // 実モデル評価(各シナリオ 12 試行)で、日本語訳の欄が日本語にならなかったのが
    // 60 回中 28 回、英→日の意味が正しかったのが 12 回中 0 回だった。
    // Llama 3.2 は日本語を公式にサポートしておらず、プロンプト調整でも改善しなかった。
    // 「日本語訳を必ず表示」がこのアプリの約束なので、それを守れないモデルを
    // こちらから薦めることはしない。
    // カタログに残してあるのは、既に入っている人の一覧に正直な説明を出すため
    // (許可はファミリー判定なので、ここから消しても選べなくなるわけではない)。
    tag: 'llama3.2:1b',
    label: 'Llama 3.2 1B',
    sizeLabel: '~1.3GB',
    icon: '⚡⚡',
    note: '非推奨 / 日本語訳が崩れやすい(日本語は公式に非対応)・同梱の Qwen 2.5 1.5B へ切り替えを推奨',
    lightweight: true,
    offerForDownload: false,
    bundled: false,
  },
  {
    tag: 'gemma2:2b',
    label: 'Gemma 2 2B',
    sizeLabel: '~1.6GB',
    icon: '⚡',
    note: '要ダウンロード / 会話は成立するが添削は粗い',
    lightweight: true,
    offerForDownload: false,
    bundled: false,
  },
  {
    tag: 'llama3.2:3b',
    label: 'Llama 3.2 3B',
    sizeLabel: '~2GB',
    icon: '⚡',
    note: '要ダウンロード / 標準モード(添削・単語あり)に戻せる最小のモデル',
    lightweight: true,
    offerForDownload: true,
    bundled: false,
  },
  {
    tag: 'qwen2.5:7b',
    label: 'Qwen 2.5 7B',
    sizeLabel: '~4.7GB',
    icon: '⚖️',
    note: '要ダウンロード / バランス型・16GB 以上向け',
    lightweight: false,
    offerForDownload: false,
    bundled: false,
  },
  {
    tag: 'llama3.1:8b',
    label: 'Llama 3.1 8B',
    sizeLabel: '~4.9GB',
    icon: '⚖️',
    note: '要ダウンロード / バランス型・16GB 以上向け',
    lightweight: false,
    offerForDownload: false,
    bundled: false,
  },
  {
    tag: 'gemma2:9b',
    label: 'Gemma 2 9B',
    sizeLabel: '~5.5GB',
    icon: '⚖️',
    note: '要ダウンロード / バランス型・16GB 以上向け・精度重視のおすすめ',
    lightweight: false,
    offerForDownload: true,
    bundled: false,
  },
  {
    tag: 'qwen2.5:14b',
    label: 'Qwen 2.5 14B',
    sizeLabel: '~9GB',
    icon: '💎',
    note: '要ダウンロード / 高品質・低速・16GB 以上向け',
    lightweight: false,
    offerForDownload: true,
    bundled: false,
  },
]

/**
 * **DMG に同梱している唯一の会話モデル**。
 *
 * 変遷: v1.1.0 まで `llama3.2:3b` → v1.2.0 で `llama3.2:1b` → 次のリリースで
 * `qwen2.5:1.5b`。
 *
 * 3B → 軽量モデルにした理由: オンボーディングは 12GB 未満の Mac に軽量モデルを
 * **あらかじめ選ぶ**のに、同梱していたのは 3B だけだった。ネットの無い 8GB 機では
 * 「選ばれているモデルが取得できず、モデル DL ステップの『次へ』が
 * 永久に押せない」= 初回起動が行き止まりになる。
 * 完全ローカルを売りにしている以上、**既定は必ず同梱物でなければならない**。
 *
 * 1B → Qwen 2.5 1.5B にした理由: M1 MacBook Air の実機で、1B の日本語訳の欄に
 * 英語・ローマ字・崩れた文字列が出た。実 backend + 実 Ollama で各シナリオ 12 試行の
 * 評価をしたところ、
 *   - 日本語訳の欄が日本語でない: llama3.2:1b 28/60、qwen2.5:1.5b 0/60
 *   - 英→日の意味が正しい:         0/12 → 8/12
 *   - 日本語入力を正しく英語にした: 1/12 → 10/12
 *   - 取得サイズ 1.32GB → 0.99GB、生成速度 91 → 106 tok/s(ビルド機)
 * Llama 3.2 は日本語を公式にサポートしておらず、プロンプト調整でも 1B は改善しなかった。
 * 日本語訳を必ず出すこのアプリには、小さく速く、日本語が安定する Qwen の方が合う。
 *
 * 副作用として、素の初回インストールは自動判定で `small` プロファイル
 * (短い返答 / 添削・単語なし)になる。これは意図した結果であり、
 * 設定画面とオンボーディングで明示し、メモリに余裕のある人には
 * {@link RECOMMENDED_DOWNLOAD_LLM_MODEL} の取得を案内する。
 *
 * ⚠️ 変更するときは `scripts/prep-llama-model.mjs` の MODEL / MANIFEST_REL、
 * README / CLAUDE.md の同梱物の記述も同時に直すこと。
 * prep スクリプトとの一致は `shared/llm-models.test.ts` が検証している。
 */
export const BUNDLED_LLM_MODEL = 'qwen2.5:1.5b'

/** 既定の会話モデル。**同梱物と一致していること**(オフライン初回起動の前提)。 */
export const DEFAULT_LLM_MODEL: string = BUNDLED_LLM_MODEL

/**
 * メモリに余裕のある Mac(12GB 以上)に薦める追加ダウンロード。
 * 同梱の軽量モデル(1.5B)は自動判定で軽量モード(添削・単語なし)になるため、
 * 「フルの体験に戻すには何を落とせばいいか」を 1 箇所で持つ。
 * オンボーディングと設定画面の両方がここを読む。
 */
export const RECOMMENDED_DOWNLOAD_LLM_MODEL = 'llama3.2:3b'

/**
 * モデル参照の書式チェック。**allowlist より前に通す門番**。
 *
 * 許すのは Ollama が実際に受け付ける形のうち、**名前空間の無いもの** だけ:
 *   `name[:tag]`
 *   - name: 英小数字で始まり、`a-z 0-9 . _ -`
 *   - tag : 量子化タグに大文字とアンダースコアが出る(`q4_K_M`, `Q8_0`)
 * 空白・制御文字・`..`・スキーマ・クエリの類はここで落ちる。
 *
 * ⚠️ `library/llama3.2:3b` のような **名前空間付きは意図的に弾く**。
 * ファミリー判定は `:` の手前を丸ごと見るので、通してしまうと
 * ファミリーが `library/llama3.2` になって allowlist に当たらず、
 * 「名前としては正しいのに黙って既定へ落ちる」— このステージで潰したはずの
 * 穴がそのまま残る。`ollama list` は名前空間を落とした形(`llama3.2:3b`)を
 * 返すので、実運用でこの形が出てくることはまず無い。
 * 将来 `hf.co/...` 等を扱うなら、判定と一緒に足すこと。
 *
 * 繰り返すが **これはセキュリティ境界ではない**(モデル名は JSON ボディに
 * 入るだけでシェルには渡らない)。目的は「Ollama に投げても意味のない文字列を
 * 投げない」ことと、設定画面に壊れた名前を並べないこと。
 */
const MODEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,62})?$/

/** モデル参照として形が正しいか。長さ上限も兼ねる。 */
export function isValidModelName(name: unknown): name is string {
  if (typeof name !== 'string') return false
  if (name.length === 0 || name.length > 128) return false
  // `..` はパスの体を成す名前を弾くため(Ollama 側でも無効)。
  if (name.includes('..')) return false
  return MODEL_NAME_PATTERN.test(name)
}

/** `llama3.2:3b-instruct-q4_K_M` → `llama3.2`。形が不正なら null。 */
export function llmFamilyOf(name: unknown): string | null {
  if (!isValidModelName(name)) return null
  const colon = name.indexOf(':')
  return colon === -1 ? name : name.slice(0, colon)
}

/** 会話に使ってよいモデルか(書式 OK かつファミリーが allowlist 内)。 */
export function isAllowedLlmModel(name: unknown): boolean {
  const family = llmFamilyOf(name)
  return family !== null && ALLOWED_LLM_FAMILIES.includes(family)
}

/**
 * タグからパラメータ数(B 単位)を読む。判らなければ null。
 *
 * **ファミリー部分は見ない**。`llama3.2` の "3.2" をパラメータ数と
 * 読み違えるとすべての Llama 3.2 が 3.2B 扱いになり、1B を選んでも
 * small プロファイルに落ちなくなる。
 */
const PARAM_SIZE_PATTERN = /(?:^|[-_.])(\d+(?:\.\d+)?)b(?![a-z0-9])/i

export function llmParameterBillions(name: unknown): number | null {
  if (!isValidModelName(name)) return null
  const colon = name.indexOf(':')
  if (colon === -1) return null
  const tag = name.slice(colon + 1)
  const m = PARAM_SIZE_PATTERN.exec(tag)
  if (!m?.[1]) return null
  const value = Number(m[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * モデル名から会話プロファイルを推定する(`modelProfile: 'auto'` のとき)。
 * パラメータ数が読めないものは **standard に倒す**。
 * 大きいモデルを勝手に切り詰めるより、小さいモデルが標準設定で
 * 少し賢くない方が事故が小さい(ユーザーは設定で明示できる)。
 */
export function inferProfileLevel(name: unknown): ModelProfileLevel {
  const billions = llmParameterBillions(name)
  if (billions === null) return 'standard'
  return billions <= SMALL_MODEL_MAX_BILLIONS ? 'small' : 'standard'
}

/** 設定値(auto/standard/small)とモデル名から実際に使うプロファイルを決める。 */
export function resolveProfileLevel(
  pref: ModelProfilePref | undefined,
  model: string | undefined,
): ModelProfileLevel {
  if (pref === 'standard' || pref === 'small') return pref
  return inferProfileLevel(model)
}

/** カタログから型番の説明を引く(無ければ null)。 */
export function findCatalogEntry(name: string): LlmCatalogEntry | null {
  return LLM_CATALOG.find((e) => e.tag === name) ?? null
}

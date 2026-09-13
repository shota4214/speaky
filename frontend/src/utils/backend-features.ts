/**
 * バックエンドの機能検出。
 *
 * ⚠️ 前提(ここを間違えると前リリースと同じ事故になる):
 * Electron は **frontend を app bundle から、backend を userData から** 読み込み、
 * backend の同期は app version の gate で走る。つまり
 * **frontend だけが新しい** 組み合わせが普通に起こりうる。
 * したがって新経路は「**機能があることを肯定的に確認できたときだけ**」使う。
 * 古いバックエンドは features キー自体を返さないので、その場合は
 * 「ストリーミング無し」と解釈される(キーの欠落 = 無効)。
 */

export interface BackendFeatures {
  apiVersion: number
  features: string[]
  /**
   * この Mac の搭載メモリ(バイト)。分からなければ null。
   *
   * ブラウザからは積んでいる RAM を知る手段が無い(`navigator.deviceMemory` は
   * Chromium でも最大 8 に丸められる値で、Electron では当てにならない)。
   * backend は Node なので `os.totalmem()` で正確に取れる。
   * オンボーディングが「このマシンは 8GB なので軽いモデルを薦めます」と
   * 言えるかどうかがこの 1 個に懸かっている。古いバックエンドは返さない = null。
   */
  totalMemoryBytes: number | null
}

/** 機能が 1 つも無い状態。プローブ失敗・タイムアウト・壊れた応答はすべてこれになる。 */
export const NO_FEATURES: BackendFeatures = {
  apiVersion: 0,
  features: [],
  totalMemoryBytes: null,
}

/**
 * /api/health のレスポンスを機能一覧に変換する純粋関数。
 * 少しでも想定と違えば「機能なし」に倒す。
 */
export function parseHealthFeatures(payload: unknown): BackendFeatures {
  if (typeof payload !== 'object' || payload === null) return NO_FEATURES
  const r = payload as Record<string, unknown>
  if (!Array.isArray(r.features)) return NO_FEATURES
  const features = r.features.filter((f): f is string => typeof f === 'string' && f.length > 0)
  const apiVersion = typeof r.apiVersion === 'number' && r.apiVersion > 0 ? r.apiVersion : 0
  const totalMemoryBytes =
    typeof r.totalMemoryBytes === 'number' &&
    Number.isFinite(r.totalMemoryBytes) &&
    r.totalMemoryBytes > 0
      ? r.totalMemoryBytes
      : null
  return { apiVersion, features, totalMemoryBytes }
}

/**
 * 「軽量モデルを薦める」閾値(バイト)。
 *
 * 8GB 機を拾って 16GB 機を拾わない値。実機は 8GB ちょうどではなく
 * 8,589,934,592 バイト前後を返すが、OS が一部を予約して申告する構成もあるため、
 * 8GB ぴったりではなく「12GB 未満」で切る。
 */
export const LOW_MEMORY_THRESHOLD_BYTES = 12 * 1024 * 1024 * 1024

/** このマシンが「軽量モデル向き」か。メモリが分からないときは false(推測しない)。 */
export function isLowMemoryMachine(features: BackendFeatures): boolean {
  return (
    features.totalMemoryBytes !== null && features.totalMemoryBytes < LOW_MEMORY_THRESHOLD_BYTES
  )
}

/** 搭載メモリを "8GB" のような表示用文字列にする。分からなければ null。 */
export function formatMemoryGb(features: BackendFeatures): string | null {
  if (features.totalMemoryBytes === null) return null
  const gb = features.totalMemoryBytes / (1024 * 1024 * 1024)
  // 8.00GB → "8GB"、24.0GB → "24GB"。端数が出る構成だけ小数第 1 位まで出す。
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10}GB`
}

export function hasFeature(features: BackendFeatures, name: string): boolean {
  return features.features.includes(name)
}

/** 会話ターンのストリーミング。 */
export const FEATURE_CHAT_STREAM = 'chat-stream'
/** 会話開始の挨拶のストリーミング。 */
export const FEATURE_CHAT_OPENING_STREAM = 'chat-opening-stream'
/** 日本語訳 / 添削 / 単語の後追い生成(単体リトライ用)。 */
export const FEATURE_CHAT_ENRICH = 'chat-enrich'
/**
 * 会話プロファイル(standard / small)。
 * これがあるバックエンドにだけ `context.modelProfile` を送る。
 * 古いバックエンドは知らないキーとして無視するので害は無いが、
 * 「効いていると思わせて効いていない」表示をしないために機能検出で揃える。
 */
export const FEATURE_MODEL_PROFILE = 'model-profile'
/**
 * `POST /api/model-profile/preview`。設定画面が「この設定で backend は実際に
 * どのモデル・どのモードで動くのか」を backend に問い合わせられるか。
 * **これが無いバックエンドに対して設定画面はモードを言い切ってはいけない**
 * (旧 backend はプロファイルを知らず、allowlist も完全一致なので
 * `llama3.2:1b` を黙って既定モデルへ差し替える)。
 */
export const FEATURE_MODEL_PROFILE_PREVIEW = 'model-profile-preview'
/**
 * 添削を backend の grammar-check(検証済みの直し + 固定テンプレートの日本語の説明)だけが作る。
 * ストリーミングでは `feedback` イベント、`/api/chat` と `/api/chat/enrich` では
 * レスポンスの `feedback` に入る。
 * **これを申告していない backend の `feedback` はモデルが書いたもの**(説明が英語 /
 * 崩れた日本語 / 中国語になりうる)なので、フロントは表示しない。
 */
export const FEATURE_GRAMMAR_CHECK = 'grammar-check'

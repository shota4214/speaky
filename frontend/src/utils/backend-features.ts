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
}

/** 機能が 1 つも無い状態。プローブ失敗・タイムアウト・壊れた応答はすべてこれになる。 */
export const NO_FEATURES: BackendFeatures = { apiVersion: 0, features: [] }

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
  return { apiVersion, features }
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

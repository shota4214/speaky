import { FEATURE_GRAMMAR_CHECK, hasFeature, type BackendFeatures } from './backend-features'

/**
 * 「添削が出る」と画面に書いてよいか。
 *
 * 添削を表示するのは **grammar-check を申告した backend の添削だけ**
 * (useConversationLoop の checkedFeedback)。申告の無い backend では添削は 1 件も出ないので、
 * そこで「添削は出ます」と書くと嘘になる。Electron では「frontend だけ新しい」組み合わせが
 * 普通に起こるため、文言も機能検出に揃える。まだ確認できていない(NO_FEATURES)ときも言わない。
 */
export function correctionsAvailable(features: BackendFeatures): boolean {
  return hasFeature(features, FEATURE_GRAMMAR_CHECK)
}

/** 軽量モードでも出るものの呼び名(「◯◯は出ますが、単語カードは出ません」の ◯◯)。 */
export function lightModeOutputsLabel(features: BackendFeatures): string {
  return correctionsAvailable(features) ? '日本語訳と添削' : '日本語訳'
}

/** 会話画面の「🪶 軽量モード」バッジのツールチップ。 */
export function lightModeBadgeTitle(features: BackendFeatures): string {
  return `小さいモデル向けの設定で動いています(返答は短め・${lightModeOutputsLabel(features)}は出ます・単語カードは出ません)`
}

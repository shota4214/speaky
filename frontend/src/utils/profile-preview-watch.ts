import { watch, type WatchStopHandle } from 'vue'
import type { AppSettings } from '../storage/settings'

/**
 * 設定画面の「会話モード」バッジを問い合わせ直すきっかけ。
 *
 * バッジは backend が確認した内容を名乗るので、入力(llmModel / modelProfile)が
 * **誰に変えられても** 問い合わせ直す必要がある。設定画面の操作だけを見ていると、
 * 画面を開いている間に旧既定 LLM からの移行(utils/bundled-llm-migration.ts)が
 * モデルを切り替えたとき、バッジが切り替え前のモデルの話をし続ける。
 *
 * ⚠️ 監視元は **値ごとの配列** にする。`() => [a, b]` の 1 つの getter にすると、
 * ストアは update() のたびに settings オブジェクトを丸ごと差し替えるので、
 * 無音間隔を動かしただけでも毎回新しい配列が返り、無関係な変更で問い合わせてしまう。
 *
 * コンポーネントの setup 内で呼べば、画面を離れたときに監視も止まる。
 */
export function watchProfilePreviewInputs(
  store: { readonly settings: AppSettings },
  refresh: () => void,
): WatchStopHandle {
  return watch([() => store.settings.llmModel, () => store.settings.modelProfile], () => {
    refresh()
  })
}

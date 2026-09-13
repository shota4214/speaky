import { listOllamaModels, type OllamaModelsResponse } from '../services/api'
import {
  BUNDLED_LLM_MODEL,
  LEGACY_DEFAULT_LLM_MODEL,
  saveSettings,
  type AppSettings,
} from '../storage/settings'
import type { SettingsPatch } from '../stores/settings'

/**
 * v1.1.0 の既定 LLM(`llama3.2:3b`)のまま使っている人を、同梱モデルへ **一度だけ**
 * 切り替える(設定スキーマ v4 の後半)。
 *
 * ── なぜローダーで切り替えないのか ──
 * 設定は localStorage から同期で読むが、同梱モデルが **本当にインストール済みか** は
 * backend に聞くまで分からない。ユーザーが自前の Ollama を起動していると Speaky は
 * それを再利用し、同梱モデルの救済(electron の ensureBundledOllamaModel)より前に
 * 戻るので、同梱モデルはその Ollama に届かない。そこへ切り替えると
 * **毎ターン MODEL_NOT_FOUND** になる。なのでローダーは 'pending' を付けるだけにして、
 * ここでインストール済み一覧を確認してから切り替える。
 *
 * 状態遷移(すべて永続化される):
 *   pending --(同梱モデルあり)--> notice --(通知を閉じる)--> idle
 *   pending --(同梱モデルなし)--> idle(切り替えない・通知も出さない)
 *   pending --(API 失敗 / 古い backend)--> pending のまま(次回起動で再試行)
 *   pending --(設定画面 / オンボーディングでモデルを選んだ)--> idle(stores/settings.ts)
 */

export type BundledLlmMigrationDecision = 'switch' | 'skip' | 'retry'

export interface BundledLlmMigrationInput {
  /** いまの設定の llmModel。 */
  currentModel: string
  /** `/api/models/ollama` の応答。取れなかったら null。 */
  listing: OllamaModelsResponse | null
}

/**
 * 切り替えるか・やめるか・次回に回すかを決める純関数。
 *
 * - **retry**: 一覧が取れない / 壊れている / **backend の既定が同梱モデルでない**。
 *   最後の条件は「frontend だけ新しい」組み合わせ(backend は userData から読むので
 *   version gate の再同期前は旧コードのまま)への備え。旧 backend は同梱モデル名を
 *   allowlist で黙って既定へ差し替えることがあり、そうなると
 *   「切り替えました」という通知が嘘になる。backend の既定 = 同梱モデルなら、
 *   その backend は同梱モデルを確実に受け付ける版である。
 *   (dev で OLLAMA_MODEL を別名にしていると毎起動 retry になるが、害は無い)
 * - **skip**: 一覧は取れたが同梱モデルが入っていない。これは「確認が済んだ」結果であって
 *   一時的な失敗ではないので、pending を残さず終える。理由は
 *   bundled-llm-migration.test.ts の該当ケースと CLAUDE.md を参照
 *   (自前の Ollama を使っている人に、後から勝手に切り替えないため)。
 */
export function decideBundledLlmMigration(
  input: BundledLlmMigrationInput,
): BundledLlmMigrationDecision {
  if (input.currentModel !== LEGACY_DEFAULT_LLM_MODEL) return 'skip'
  const listing = input.listing
  if (!listing || !Array.isArray(listing.models)) return 'retry'
  if (listing.defaultModel !== BUNDLED_LLM_MODEL) return 'retry'
  const installed = listing.models.some((m) => m?.name === BUNDLED_LLM_MODEL)
  return installed ? 'switch' : 'skip'
}

/** 移行が触る設定ストアの形(テストで本物のストアをそのまま渡せるよう最小限にする)。 */
export interface BundledLlmMigrationStore {
  readonly settings: AppSettings
  update(patch: SettingsPatch): void
}

export interface BundledLlmMigrationDeps {
  listOllamaModels: () => Promise<OllamaModelsResponse>
}

export type BundledLlmMigrationResult = 'not-pending' | 'switched' | 'skipped' | 'retry-later'

const defaultDeps: BundledLlmMigrationDeps = { listOllamaModels }

let inFlight: Promise<BundledLlmMigrationResult> | null = null

/**
 * 移行待ちなら backend に確認して移行を進める。何度呼んでもよい(冪等)。
 * 同時に呼ばれたら最初の確認を共有する。
 */
export function runBundledLlmMigration(
  store: BundledLlmMigrationStore,
  deps: BundledLlmMigrationDeps = defaultDeps,
): Promise<BundledLlmMigrationResult> {
  if (store.settings.bundledLlmMigration !== 'pending') return Promise.resolve('not-pending')
  if (inFlight) return inFlight

  inFlight = (async (): Promise<BundledLlmMigrationResult> => {
    let listing: OllamaModelsResponse | null = null
    try {
      listing = await deps.listOllamaModels()
    } catch (e) {
      // backend がまだ起きていない / ルートが無い旧 backend / Ollama が落ちている。
      // どれも「確認できなかった」だけなので pending のまま次回に回す。
      console.warn('[llm-migration] installed models unavailable; will retry next launch:', e)
    }

    // 確認を待つ間にユーザーがモデルを選び直していれば、ストアが pending を消している。
    if (store.settings.bundledLlmMigration !== 'pending') return 'not-pending'

    const decision = decideBundledLlmMigration({
      currentModel: store.settings.llmModel,
      listing,
    })
    if (decision === 'retry') return 'retry-later'

    if (decision === 'switch') {
      // モデルを変える = 前のモデルのための会話モード固定は捨てる(設定画面と同じ規則)。
      store.update({
        llmModel: BUNDLED_LLM_MODEL,
        modelProfile: 'auto',
        bundledLlmMigration: 'notice',
      })
    } else {
      store.update({ bundledLlmMigration: 'idle' })
    }
    // ストアの watch も保存するが非同期なので、一度きりの移行の結果はここで即書く。
    saveSettings(store.settings)
    return decision === 'switch' ? 'switched' : 'skipped'
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}

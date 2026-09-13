import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OllamaModelsResponse } from '../services/api'
import {
  BUNDLED_LLM_MODEL,
  findCatalogEntry,
  LEGACY_DEFAULT_LLM_MODEL,
  SETTINGS_SCHEMA_VERSION,
} from '../storage/settings'
import { useSettingsStore } from '../stores/settings'
import { decideBundledLlmMigration, runBundledLlmMigration } from './bundled-llm-migration'
import { BUNDLED_LLM_NOTICE } from './bundled-llm-migration-notice'

/**
 * 旧既定 LLM(llama3.2:3b)→ 同梱モデルの一度きりの移行。
 *
 * いちばん大事な契約は「**インストールを確認できていないモデルへは切り替えない**」。
 * 確認できなかった(API 失敗 / 古い backend)なら pending を残して次回再試行し、
 * 確認できて入っていなければ切り替えも通知もせずに終える。
 */

const KEY = 'speaky:settings'

function persisted(): Record<string, unknown> {
  const raw = localStorage.getItem(KEY)
  expect(raw).toBeTruthy()
  return JSON.parse(raw!) as Record<string, unknown>
}

/**
 * スキーマ v3 で `llama3.2:3b` を保存していた設定(v1.2.0 のテストビルドで 3B を選んだ人)。
 * ⚠️ **v1.1.0 の利用者ではない**。v1.1.0 が出荷したのはスキーマ 2(v3 はその後に入った)。
 * v1.1.0 の実際の形は seedV110() を使う。
 */
function seedV3(extra: Record<string, unknown> = {}): void {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      schemaVersion: 3,
      llmModel: LEGACY_DEFAULT_LLM_MODEL,
      modelProfile: 'standard',
      silenceDurationMs: 2000,
      ...extra,
    }),
  )
}

/**
 * v1.1.0(5d7374b)の DEFAULT_SETTINGS をそのまま保存した形。スキーマ **2**。
 * modelProfile / streaming / bundledLlmMigration はまだ存在しない。
 */
function seedV110(): void {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      aiCharacter: { name: 'Emma', gender: 'female', voiceName: null, personality: 'friendly' },
      silenceDurationMs: 1500,
      llmModel: 'llama3.2:3b',
      whisperModel: 'small',
      darkMode: 'system',
      ttsRateConnectedToLevel: true,
      ttsRate: 1.0,
      ttsPitch: 1.0,
      showJapanese: true,
      lastCleanupAt: null,
      defaultLevel: 'intermediate',
      schemaVersion: 2,
    }),
  )
}

/** アプリの再起動を模す(Pinia を作り直してストレージから読み直す)。 */
function launch() {
  setActivePinia(createPinia())
  return useSettingsStore()
}

function listing(names: string[], defaultModel = BUNDLED_LLM_MODEL): OllamaModelsResponse {
  return {
    models: names.map((name) => ({ name, sizeBytes: 1, sizeMB: 1, modifiedAt: '' })),
    defaultModel,
  }
}

function depsReturning(response: OllamaModelsResponse) {
  return { listOllamaModels: vi.fn().mockResolvedValue(response) }
}

describe('旧既定 LLM から同梱モデルへの移行', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('3B のままの人は、同梱モデルが入っていれば切り替わり通知待ちになる(即永続化)', async () => {
    seedV3()
    const store = launch()
    expect(store.settings.bundledLlmMigration).toBe('pending')
    // ローダーの時点ではまだ切り替えていない
    expect(store.settings.llmModel).toBe(LEGACY_DEFAULT_LLM_MODEL)

    const deps = depsReturning(listing([LEGACY_DEFAULT_LLM_MODEL, BUNDLED_LLM_MODEL]))
    await expect(runBundledLlmMigration(store, deps)).resolves.toBe('switched')

    expect(store.settings.llmModel).toBe(BUNDLED_LLM_MODEL)
    expect(store.settings.bundledLlmMigration).toBe('notice')
    // watch を待たずに保存されている
    const stored = persisted()
    expect(stored.llmModel).toBe(BUNDLED_LLM_MODEL)
    expect(stored.bundledLlmMigration).toBe('notice')
    expect(stored.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    // 他の設定は触らない
    expect(stored.silenceDurationMs).toBe(2000)
  })

  it('v1.1.0 の実際の保存値(スキーマ 2)は 1 回の load で v2→v3→v4 を通り、切り替えまで進む', async () => {
    seedV110()
    const store = launch()
    // v3: 3B は 2B 以下ではないので auto / v4: 旧既定なので pending
    expect(store.settings.modelProfile).toBe('auto')
    expect(store.settings.bundledLlmMigration).toBe('pending')
    expect(store.settings.llmModel).toBe(LEGACY_DEFAULT_LLM_MODEL)
    expect(store.settings.streaming).toBe(true)
    // 移行結果はその場で書き戻されている(次の load で v2 からやり直さない)
    const stored = persisted()
    expect(stored.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(stored.modelProfile).toBe('auto')
    expect(stored.bundledLlmMigration).toBe('pending')
    expect(stored.silenceDurationMs).toBe(1500)

    const deps = depsReturning(listing([LEGACY_DEFAULT_LLM_MODEL, BUNDLED_LLM_MODEL]))
    await expect(runBundledLlmMigration(store, deps)).resolves.toBe('switched')
    expect(persisted().llmModel).toBe(BUNDLED_LLM_MODEL)
    expect(persisted().bundledLlmMigration).toBe('notice')
  })

  it('切り替えたら会話モードの固定を自動に戻す', async () => {
    seedV3({ modelProfile: 'small' })
    const store = launch()
    await runBundledLlmMigration(store, depsReturning(listing([BUNDLED_LLM_MODEL])))
    expect(store.settings.modelProfile).toBe('auto')
    expect(persisted().modelProfile).toBe('auto')
  })

  it.each(['llama3.2:1b', 'gemma2:2b', 'qwen2.5:7b'])(
    '%s を保存している人は対象外(backend にも聞かない)',
    async (model) => {
      seedV3({ llmModel: model })
      const store = launch()
      expect(store.settings.bundledLlmMigration).toBe('idle')

      const deps = depsReturning(listing([model, BUNDLED_LLM_MODEL]))
      await expect(runBundledLlmMigration(store, deps)).resolves.toBe('not-pending')
      expect(deps.listOllamaModels).not.toHaveBeenCalled()
      expect(store.settings.llmModel).toBe(model)
    },
  )

  // 自前の Ollama を再利用している人には同梱モデルが届かない。そこへ切り替えると
  // 毎ターン MODEL_NOT_FOUND になる。確認は済んだので pending も残さない
  // (後から qwen を pull したときに、黙って 3B から切り替えないため)。
  it('同梱モデルが入っていなければ切り替えず、通知も出さず、再確認もしない', async () => {
    seedV3()
    const store = launch()
    const deps = depsReturning(listing([LEGACY_DEFAULT_LLM_MODEL]))
    await expect(runBundledLlmMigration(store, deps)).resolves.toBe('skipped')

    expect(store.settings.llmModel).toBe(LEGACY_DEFAULT_LLM_MODEL)
    expect(store.settings.modelProfile).toBe('standard')
    expect(store.settings.bundledLlmMigration).toBe('idle')
    expect(persisted().bundledLlmMigration).toBe('idle')
    expect(persisted().llmModel).toBe(LEGACY_DEFAULT_LLM_MODEL)

    const relaunched = launch()
    const later = depsReturning(listing([LEGACY_DEFAULT_LLM_MODEL, BUNDLED_LLM_MODEL]))
    await expect(runBundledLlmMigration(relaunched, later)).resolves.toBe('not-pending')
    expect(later.listOllamaModels).not.toHaveBeenCalled()
    expect(relaunched.settings.llmModel).toBe(LEGACY_DEFAULT_LLM_MODEL)
  })

  it('API が失敗したら何も変えず pending のまま残り、次回起動で完了する', async () => {
    seedV3()
    const store = launch()
    const failing = { listOllamaModels: vi.fn().mockRejectedValue(new Error('HTTP 404')) }
    await expect(runBundledLlmMigration(store, failing)).resolves.toBe('retry-later')

    expect(store.settings.llmModel).toBe(LEGACY_DEFAULT_LLM_MODEL)
    expect(store.settings.bundledLlmMigration).toBe('pending')
    expect(persisted().bundledLlmMigration).toBe('pending')
    expect(persisted().schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)

    const relaunched = launch()
    expect(relaunched.settings.bundledLlmMigration).toBe('pending')
    await expect(
      runBundledLlmMigration(relaunched, depsReturning(listing([BUNDLED_LLM_MODEL]))),
    ).resolves.toBe('switched')
    expect(relaunched.settings.llmModel).toBe(BUNDLED_LLM_MODEL)
  })

  it('backend の既定が同梱モデルでない(frontend だけ新しい)なら次回に回す', async () => {
    seedV3()
    const store = launch()
    const oldBackend = depsReturning(
      listing([LEGACY_DEFAULT_LLM_MODEL, BUNDLED_LLM_MODEL], LEGACY_DEFAULT_LLM_MODEL),
    )
    await expect(runBundledLlmMigration(store, oldBackend)).resolves.toBe('retry-later')
    expect(store.settings.llmModel).toBe(LEGACY_DEFAULT_LLM_MODEL)
    expect(persisted().bundledLlmMigration).toBe('pending')
  })

  // backend は Ollama が `models` を返さないと空配列にする。空の一覧で
  // 「同梱モデルなし」と結論すると、移行が永久に終わってしまう。
  it('空の一覧では結論を出さない(pending のまま、次回起動で完了できる)', async () => {
    seedV3()
    const store = launch()
    await expect(runBundledLlmMigration(store, depsReturning(listing([])))).resolves.toBe(
      'retry-later',
    )
    expect(store.settings.llmModel).toBe(LEGACY_DEFAULT_LLM_MODEL)
    expect(persisted().bundledLlmMigration).toBe('pending')

    const relaunched = launch()
    await expect(
      runBundledLlmMigration(
        relaunched,
        depsReturning(listing([LEGACY_DEFAULT_LLM_MODEL, BUNDLED_LLM_MODEL])),
      ),
    ).resolves.toBe('switched')
  })

  // 3B すら載っていない一覧は、このユーザーが会話に使っている Ollama のものか分からない。
  it('今の 3B が載っていない一覧でも結論を出さない', async () => {
    seedV3()
    const store = launch()
    const other = depsReturning(listing(['gemma2:2b']))
    await expect(runBundledLlmMigration(store, other)).resolves.toBe('retry-later')
    expect(store.settings.llmModel).toBe(LEGACY_DEFAULT_LLM_MODEL)
    expect(persisted().bundledLlmMigration).toBe('pending')
  })

  it('一覧はあるが defaultModel が無い(旧 backend)なら次回に回す', async () => {
    seedV3()
    const store = launch()
    const noDefault = depsReturning({
      models: listing([LEGACY_DEFAULT_LLM_MODEL, BUNDLED_LLM_MODEL]).models,
    } as unknown as OllamaModelsResponse)
    await expect(runBundledLlmMigration(store, noDefault)).resolves.toBe('retry-later')
    expect(store.settings.llmModel).toBe(LEGACY_DEFAULT_LLM_MODEL)
    expect(persisted().bundledLlmMigration).toBe('pending')
  })

  it('壊れた応答は失敗と同じ扱い(pending のまま)', async () => {
    seedV3()
    const store = launch()
    const broken = {
      listOllamaModels: vi
        .fn()
        .mockResolvedValue({ error: 'x' } as unknown as OllamaModelsResponse),
    }
    await expect(runBundledLlmMigration(store, broken)).resolves.toBe('retry-later')
    expect(store.settings.bundledLlmMigration).toBe('pending')
  })

  it('一度きり: 切り替え後は再起動しても backend に聞かず、何も変えない', async () => {
    seedV3()
    const store = launch()
    await runBundledLlmMigration(store, depsReturning(listing([BUNDLED_LLM_MODEL])))
    store.dismissBundledLlmNotice()
    // 切り替え後にユーザーが自分で 3B へ戻した
    store.update({ llmModel: LEGACY_DEFAULT_LLM_MODEL })
    await nextTick()

    const relaunched = launch()
    expect(relaunched.settings.bundledLlmMigration).toBe('idle')
    const deps = depsReturning(listing([BUNDLED_LLM_MODEL]))
    await expect(runBundledLlmMigration(relaunched, deps)).resolves.toBe('not-pending')
    expect(deps.listOllamaModels).not.toHaveBeenCalled()
    expect(relaunched.settings.llmModel).toBe(LEGACY_DEFAULT_LLM_MODEL)
  })

  it('同時に呼ばれても確認は 1 回だけ', async () => {
    seedV3()
    const store = launch()
    const deps = depsReturning(listing([BUNDLED_LLM_MODEL]))
    const results = await Promise.all([
      runBundledLlmMigration(store, deps),
      runBundledLlmMigration(store, deps),
    ])
    expect(results).toEqual(['switched', 'switched'])
    expect(deps.listOllamaModels).toHaveBeenCalledTimes(1)
  })

  it('確認を待つ間にユーザーがモデルを選んだら、その選択を上書きしない', async () => {
    seedV3()
    const store = launch()
    let resolve!: (r: OllamaModelsResponse) => void
    const deps = {
      listOllamaModels: vi.fn(() => new Promise<OllamaModelsResponse>((r) => (resolve = r))),
    }
    const running = runBundledLlmMigration(store, deps)
    store.update({ llmModel: 'gemma2:9b' })
    resolve(listing([BUNDLED_LLM_MODEL]))

    await expect(running).resolves.toBe('not-pending')
    expect(store.settings.llmModel).toBe('gemma2:9b')
    expect(store.settings.bundledLlmMigration).toBe('idle')
  })

  it('設定画面 / オンボーディングでモデルを選んだら移行待ちは取り消される(同じ 3B でも)', async () => {
    seedV3()
    const store = launch()
    store.update({ llmModel: LEGACY_DEFAULT_LLM_MODEL, modelProfile: 'auto' })
    expect(store.settings.bundledLlmMigration).toBe('idle')
    await nextTick()
    expect(persisted().bundledLlmMigration).toBe('idle')
  })

  it('モデル以外の設定を変えても移行待ちは残る', async () => {
    seedV3()
    const store = launch()
    store.update({ silenceDurationMs: 3000 })
    expect(store.settings.bundledLlmMigration).toBe('pending')
  })

  it('通知を閉じると永続化され、再起動しても出ない(切り替えたモデルは残る)', async () => {
    seedV3()
    const store = launch()
    await runBundledLlmMigration(store, depsReturning(listing([BUNDLED_LLM_MODEL])))
    expect(store.settings.bundledLlmMigration).toBe('notice')

    store.dismissBundledLlmNotice()
    expect(store.settings.bundledLlmMigration).toBe('idle')
    await nextTick()
    expect(persisted().bundledLlmMigration).toBe('idle')

    const relaunched = launch()
    expect(relaunched.settings.bundledLlmMigration).toBe('idle')
    expect(relaunched.settings.llmModel).toBe(BUNDLED_LLM_MODEL)
  })

  // 通知を開いたまま設定画面で別のモデルを選ぶと、「切り替えました」が嘘になる。
  it('通知中に設定画面でモデルを選んだら通知は消え、再起動しても出ない', async () => {
    seedV3()
    const store = launch()
    await runBundledLlmMigration(store, depsReturning(listing([BUNDLED_LLM_MODEL])))
    expect(store.settings.bundledLlmMigration).toBe('notice')

    store.update({ llmModel: 'gemma2:9b', modelProfile: 'auto' })
    expect(store.settings.bundledLlmMigration).toBe('idle')
    expect(store.settings.llmModel).toBe('gemma2:9b')
    await nextTick()
    expect(persisted().bundledLlmMigration).toBe('idle')
    expect(launch().settings.bundledLlmMigration).toBe('idle')
  })

  it('通知中にモデル以外の設定を変えても通知は残る', async () => {
    seedV3()
    const store = launch()
    await runBundledLlmMigration(store, depsReturning(listing([BUNDLED_LLM_MODEL])))
    store.update({ silenceDurationMs: 3000 })
    expect(store.settings.bundledLlmMigration).toBe('notice')
  })

  it('閉じていない通知は再起動後も出る', async () => {
    seedV3()
    const store = launch()
    await runBundledLlmMigration(store, depsReturning(listing([BUNDLED_LLM_MODEL])))
    expect(launch().settings.bundledLlmMigration).toBe('notice')
  })

  it('通知を閉じる操作は pending を消さない(切り替え前に誤って呼ばれても移行を失わない)', () => {
    seedV3()
    const store = launch()
    store.dismissBundledLlmNotice()
    expect(store.settings.bundledLlmMigration).toBe('pending')
  })
})

describe('decideBundledLlmMigration', () => {
  it('旧既定以外のモデルなら skip', () => {
    expect(
      decideBundledLlmMigration({
        currentModel: 'gemma2:2b',
        listing: listing([BUNDLED_LLM_MODEL]),
      }),
    ).toBe('skip')
  })

  it('一覧が無ければ retry', () => {
    expect(
      decideBundledLlmMigration({ currentModel: LEGACY_DEFAULT_LLM_MODEL, listing: null }),
    ).toBe('retry')
  })

  it('同梱モデルは完全一致で探す(量子化タグ違いは同梱物ではない)', () => {
    expect(
      decideBundledLlmMigration({
        currentModel: LEGACY_DEFAULT_LLM_MODEL,
        listing: listing([LEGACY_DEFAULT_LLM_MODEL, `${BUNDLED_LLM_MODEL}-instruct-q8_0`]),
      }),
    ).toBe('skip')
  })

  it('空の一覧は retry(「無い」と結論しない)', () => {
    expect(
      decideBundledLlmMigration({ currentModel: LEGACY_DEFAULT_LLM_MODEL, listing: listing([]) }),
    ).toBe('retry')
  })

  it('「無い」と結論するのは、今の 3B が一覧に載っているときだけ', () => {
    const decide = (names: string[]) =>
      decideBundledLlmMigration({ currentModel: LEGACY_DEFAULT_LLM_MODEL, listing: listing(names) })
    expect(decide([LEGACY_DEFAULT_LLM_MODEL])).toBe('skip')
    expect(decide(['gemma2:2b'])).toBe('retry')
    // 3B の量子化タグ違いは、今の llmModel(完全一致の名前)を会話に使える証拠にならない
    expect(decide([`${LEGACY_DEFAULT_LLM_MODEL}-instruct-q4_K_M`])).toBe('retry')
    // 同梱モデルがあれば 3B の有無に関係なく切り替えてよい(入っていると確認できている)
    expect(decide([BUNDLED_LLM_MODEL])).toBe('switch')
  })

  it('defaultModel が無い一覧は retry', () => {
    expect(
      decideBundledLlmMigration({
        currentModel: LEGACY_DEFAULT_LLM_MODEL,
        listing: {
          models: listing([LEGACY_DEFAULT_LLM_MODEL, BUNDLED_LLM_MODEL]).models,
        } as unknown as OllamaModelsResponse,
      }),
    ).toBe('retry')
  })
})

describe('移行通知の文言', () => {
  // 同梱モデルを差し替えたのに文言だけ古いまま、を防ぐ。
  it('同梱モデルの表示名と、戻し先の旧既定タグを含む', () => {
    const label = findCatalogEntry(BUNDLED_LLM_MODEL)?.label
    expect(label).toBeTruthy()
    expect(BUNDLED_LLM_NOTICE.title).toContain(label!)
    expect(BUNDLED_LLM_NOTICE.howToRevert).toContain(LEGACY_DEFAULT_LLM_MODEL)
  })

  // 添削機能は評価中。暫定の文言で約束しない。
  it('添削・単語カードについて何も約束しない', () => {
    const all = Object.values(BUNDLED_LLM_NOTICE).join('\n')
    expect(all).not.toMatch(/添削|単語/)
  })
})

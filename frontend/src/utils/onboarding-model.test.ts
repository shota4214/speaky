import { describe, expect, it } from 'vitest'
import {
  BUNDLED_LLM_MODEL,
  RECOMMENDED_DOWNLOAD_LLM_MODEL,
  isAllowedLlmModel,
} from '../storage/settings'
import {
  buildOnboardingLlmOptions,
  chooseOnboardingLlm,
  ONBOARDING_LLM_CHOICES,
} from './onboarding-model'

/**
 * オンボーディングの LLM 自動選択。
 *
 * **落としたいのはただ 1 つの不具合**: 「インストールされていないモデルを
 * あらかじめ選んだ状態にする」こと。v1.1.0 直前がまさにそれで、
 * 12GB 未満の Mac に `llama3.2:1b` を選ぶのに同梱は `llama3.2:3b` だけだったため、
 * ネットの無い 8GB 機は「モデル DL ステップの次へが押せない」= 初回起動が
 * 行き止まりになっていた。完全ローカルという売りが一番想定すべき機械で嘘になる。
 */

describe('chooseOnboardingLlm', () => {
  it('8GB / オフライン(同梱の軽量モデルだけ入っている)= 同梱モデルを選ぶ', () => {
    const r = chooseOnboardingLlm({
      installed: [BUNDLED_LLM_MODEL],
      lowMemory: true,
      memoryKnown: true,
    })
    expect(r.model).toBe(BUNDLED_LLM_MODEL)
    expect(r.installed).toBe(true)
    // メモリが少ない機械に 3B は薦めない。
    expect(r.recommendedDownload).toBeNull()
  })

  it('8GB / 3B も取得済み = それでも軽い同梱モデルを選ぶ', () => {
    const r = chooseOnboardingLlm({
      installed: [BUNDLED_LLM_MODEL, RECOMMENDED_DOWNLOAD_LLM_MODEL],
      lowMemory: true,
      memoryKnown: true,
    })
    expect(r.model).toBe(BUNDLED_LLM_MODEL)
  })

  it('16GB / オンライン(3B 取得済み)= 3B を選び、案内は出さない', () => {
    const r = chooseOnboardingLlm({
      installed: [BUNDLED_LLM_MODEL, RECOMMENDED_DOWNLOAD_LLM_MODEL],
      lowMemory: false,
      memoryKnown: true,
    })
    expect(r.model).toBe(RECOMMENDED_DOWNLOAD_LLM_MODEL)
    expect(r.recommendedDownload).toBeNull()
  })

  it('16GB / オフライン(同梱の軽量モデルだけ)= 選択は同梱のまま、3B は案内だけ', () => {
    // ここが今回の核心。メモリに余裕があっても、入っていない 3B を
    // 選択状態にしてはいけない(オフラインだと先へ進めなくなる)。
    const r = chooseOnboardingLlm({
      installed: [BUNDLED_LLM_MODEL],
      lowMemory: false,
      memoryKnown: true,
    })
    expect(r.model).toBe(BUNDLED_LLM_MODEL)
    expect(r.installed).toBe(true)
    expect(r.recommendedDownload).toBe(RECOMMENDED_DOWNLOAD_LLM_MODEL)
  })

  it('メモリが分からない(古い backend / プローブ失敗)= 推測せず同梱モデル', () => {
    const r = chooseOnboardingLlm({
      installed: [BUNDLED_LLM_MODEL, RECOMMENDED_DOWNLOAD_LLM_MODEL],
      lowMemory: false,
      memoryKnown: false,
    })
    expect(r.model).toBe(BUNDLED_LLM_MODEL)
    expect(r.recommendedDownload).toBeNull()
  })

  it('カタログに無いが allowlist は通るモデルしか入っていない場合はそれを選ぶ', () => {
    // 自分で pull した量子化タグだけがある環境。「薦めたい名前」より
    // 「実在する名前」が強い。
    const r = chooseOnboardingLlm({
      installed: ['llama3.2:3b-instruct-q4_K_M'],
      lowMemory: true,
      memoryKnown: true,
    })
    expect(r.model).toBe('llama3.2:3b-instruct-q4_K_M')
    expect(r.installed).toBe(true)
  })

  it('会話に使えない名前(mistral 等)しか無い場合は同梱モデルに落ちる', () => {
    // 選べば backend が黙って既定へ差し替えるモデルを選択状態にはしない。
    const r = chooseOnboardingLlm({
      installed: ['mistral:7b'],
      lowMemory: true,
      memoryKnown: true,
    })
    expect(r.model).toBe(BUNDLED_LLM_MODEL)
    expect(r.installed).toBe(false)
  })

  it('1 つも入っていない異常時は同梱モデルを選び installed=false を返す', () => {
    // DL ステップがそれを提示する。ここだけが「未インストールを選ぶ」唯一の場面。
    const r = chooseOnboardingLlm({ installed: [], lowMemory: true, memoryKnown: true })
    expect(r.model).toBe(BUNDLED_LLM_MODEL)
    expect(r.installed).toBe(false)
  })

  it('同梱モデルは qwen2.5:1.5b(このテストの前提を固定する)', () => {
    // 下の fixture は「同梱物 = qwen2.5:1.5b、旧同梱物 = llama3.2:1b」を前提に
    // 組んである。同梱物が変わったら fixture の意味も見直すこと。
    expect(BUNDLED_LLM_MODEL).toBe('qwen2.5:1.5b')
  })

  it('v1.2.0 のテスト機(旧同梱の llama3.2:1b と新同梱が両方ある)= 新しい同梱モデルを選ぶ', () => {
    // llama3.2:1b は日本語訳が崩れるので取得の選択肢から外した。
    // 両方入っているなら、どのメモリ量でも薦めない方を選んではいけない。
    for (const lowMemory of [true, false]) {
      for (const memoryKnown of [true, false]) {
        const r = chooseOnboardingLlm({
          installed: ['llama3.2:1b', BUNDLED_LLM_MODEL],
          lowMemory,
          memoryKnown,
        })
        expect(r.model, JSON.stringify({ lowMemory, memoryKnown })).toBe(BUNDLED_LLM_MODEL)
      }
    }
  })

  it('旧同梱の llama3.2:1b しか入っていない = 実在するのでそれを選ぶ(行き止まりにしない)', () => {
    // 薦めないモデルでも、入っているのがそれだけなら「実在する」方が強い。
    const r = chooseOnboardingLlm({
      installed: ['llama3.2:1b'],
      lowMemory: true,
      memoryKnown: true,
    })
    expect(r.model).toBe('llama3.2:1b')
    expect(r.installed).toBe(true)
  })

  it('何か入っている限り、選ぶモデルは必ずその中にある(不変条件)', () => {
    const installedSets = [
      [BUNDLED_LLM_MODEL],
      [RECOMMENDED_DOWNLOAD_LLM_MODEL],
      ['llama3.2:1b'],
      ['gemma2:9b'],
      ['qwen2.5:14b', 'qwen2.5:1.5b'],
      [BUNDLED_LLM_MODEL, 'gemma2:9b'],
    ]
    for (const installed of installedSets) {
      for (const lowMemory of [true, false]) {
        for (const memoryKnown of [true, false]) {
          const r = chooseOnboardingLlm({ installed, lowMemory, memoryKnown })
          expect(installed, JSON.stringify({ installed, lowMemory, memoryKnown })).toContain(
            r.model,
          )
          expect(r.installed).toBe(true)
        }
      }
    }
  })
})

describe('ONBOARDING_LLM_CHOICES', () => {
  it('設定画面の取得フォームと同じカタログから作られている', () => {
    // オンボーディングだけ選択肢を手書きしていると、カタログを直したときに
    // 片側だけ古くなる(v1.1.0 は実際にそうなっていた)。
    expect(ONBOARDING_LLM_CHOICES.length).toBeGreaterThan(0)
    for (const e of ONBOARDING_LLM_CHOICES) {
      expect(e.offerForDownload).toBe(true)
      expect(isAllowedLlmModel(e.tag), e.tag).toBe(true)
    }
  })

  it('同梱モデルは必ず選択肢に含まれる(オフラインの唯一の出口)', () => {
    expect(ONBOARDING_LLM_CHOICES.some((e) => e.tag === BUNDLED_LLM_MODEL)).toBe(true)
  })

  it('日本語訳が崩れる llama3.2:1b は選択肢に出さない', () => {
    expect(ONBOARDING_LLM_CHOICES.some((e) => e.tag === 'llama3.2:1b')).toBe(false)
  })

  it('「同梱」と表示されるのは同梱モデルだけ', () => {
    const options = buildOnboardingLlmOptions({ selected: BUNDLED_LLM_MODEL, installed: [] })
    const bundledLabels = options.filter((o) => o.label.includes('同梱'))
    expect(bundledLabels.map((o) => o.value)).toEqual([BUNDLED_LLM_MODEL])
  })

  // v1.2.0 の試験機は llama3.2:1b が選択済みのまま残る。選択肢に出ない型番は
  // カタログの note がラベルに入るので、note に「同梱」が入っていると
  // 「同梱と書かれたものを選べばオフラインで進める」という案内と矛盾する。
  it('llama3.2:1b が選択済みでも「同梱」とは表示しない', () => {
    const options = buildOnboardingLlmOptions({
      selected: 'llama3.2:1b',
      installed: ['llama3.2:1b', BUNDLED_LLM_MODEL],
    })
    const bundledLabels = options.filter((o) => o.label.includes('同梱'))
    expect(bundledLabels.map((o) => o.value)).toEqual([BUNDLED_LLM_MODEL])
    expect(options.some((o) => o.value === 'llama3.2:1b')).toBe(true)
  })
})

/**
 * 選択肢と選択の範囲がズレると、**select が空白で描画される**。
 * 自動選択は「インストール済みなら何でも選ぶ」(オフラインで先へ進める唯一の道)
 * のに、選択肢はカタログ(offerForDownload)だけから作っていた。
 * 自分で pull した型番しか入っていない Mac がそれに当たる。
 */
describe('buildOnboardingLlmOptions', () => {
  it('カタログのモデルを選んでいるときは選択肢を増やさない', () => {
    const options = buildOnboardingLlmOptions({
      selected: BUNDLED_LLM_MODEL,
      installed: [BUNDLED_LLM_MODEL],
    })
    expect(options).toHaveLength(ONBOARDING_LLM_CHOICES.length)
    expect(options.map((o) => o.value)).toContain(BUNDLED_LLM_MODEL)
  })

  it('⭐ カタログに無いモデルが選ばれていても、必ず選択肢に出る', () => {
    const selected = 'qwen2.5:3b-instruct-q5_K_M'
    const options = buildOnboardingLlmOptions({ selected, installed: [selected] })
    expect(options[0]?.value).toBe(selected)
    expect(options[0]?.installed).toBe(true)
    expect(options[0]?.label).toContain(selected)
  })

  it('自動選択が返す model は、どんなインストール状況でも必ず選択肢にある(不変条件)', () => {
    const installedSets = [
      [],
      [BUNDLED_LLM_MODEL],
      ['qwen2.5:3b-instruct-q5_K_M'],
      ['gemma2:2b'],
      ['llama3.1:8b-instruct-q8_0', 'qwen2.5:1.5b'],
      [RECOMMENDED_DOWNLOAD_LLM_MODEL],
      // 取得の選択肢から外した旧同梱物だけが入っている(v1.2.0 のテスト機)
      ['llama3.2:1b'],
    ]
    for (const installed of installedSets) {
      for (const lowMemory of [true, false]) {
        for (const memoryKnown of [true, false]) {
          const selection = chooseOnboardingLlm({ installed, lowMemory, memoryKnown })
          const options = buildOnboardingLlmOptions({
            selected: selection.model,
            installed,
          })
          expect(
            options.map((o) => o.value),
            JSON.stringify({ installed, lowMemory, memoryKnown }),
          ).toContain(selection.model)
        }
      }
    }
  })

  it('取得済みかどうかを正直に出す(未取得を「取得済み」と書かない)', () => {
    const options = buildOnboardingLlmOptions({
      selected: BUNDLED_LLM_MODEL,
      installed: [],
    })
    for (const o of options) {
      expect(o.installed).toBe(false)
      expect(o.label).not.toContain('取得済み')
    }
  })
})

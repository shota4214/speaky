import { describe, expect, it } from 'vitest'
import {
  BUNDLED_LLM_MODEL,
  RECOMMENDED_DOWNLOAD_LLM_MODEL,
  isAllowedLlmModel,
} from '../storage/settings'
import { chooseOnboardingLlm, ONBOARDING_LLM_CHOICES } from './onboarding-model'

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
  it('8GB / オフライン(同梱の 1B だけ入っている)= 同梱モデルを選ぶ', () => {
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

  it('16GB / オフライン(同梱の 1B だけ)= 選択は 1B のまま、3B は案内だけ', () => {
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

  it('何か入っている限り、選ぶモデルは必ずその中にある(不変条件)', () => {
    const installedSets = [
      [BUNDLED_LLM_MODEL],
      [RECOMMENDED_DOWNLOAD_LLM_MODEL],
      ['qwen2.5:1.5b'],
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
})

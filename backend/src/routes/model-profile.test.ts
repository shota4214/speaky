import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { modelProfileRouter } from './model-profile.js'
import { BUNDLED_LLM_MODEL, DEFAULT_LLM_MODEL } from '../shared/llm-models.js'

/**
 * 設定画面の「会話モード」バッジが信じてよい唯一の出典。
 *
 * バッジは v1.1.0 まで **ローカルの設定から推測**していた。会話画面のバッジが
 * backend の申告だけを信じているのと作りが違い、そこに実害があった:
 * 旧 backend(プロファイル未対応 / allowlist が完全一致)と新しい frontend の
 * 組み合わせでは、ユーザーは「選んだモデル」も「表示されたモード」も両方
 * 間違った画面を見る。このルートは frontend に推測をやめさせるためにある。
 */
describe('POST /api/model-profile/preview', () => {
  let server: Server
  let base = ''

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', modelProfileRouter)
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function preview(body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}/api/model-profile/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(200)
    return (await res.json()) as Record<string, unknown>
  }

  it('同梱モデル + auto は軽量モードを返し、モデルをそのまま受け入れる', async () => {
    const body = await preview({ model: BUNDLED_LLM_MODEL, modelProfile: 'auto' })
    expect(body.model).toBe(BUNDLED_LLM_MODEL)
    expect(body.modelAccepted).toBe(true)
    expect(body.profile).toBe('small')
    // 軽量モードでは添削も単語も出ない。UI がそれを言い切れるように返している。
    expect(body.enrichment).toBe('translation-only')
  })

  it('3B + auto は標準モード(添削・単語あり)を返す', async () => {
    const body = await preview({ model: 'llama3.2:3b', modelProfile: 'auto' })
    expect(body.profile).toBe('standard')
    expect(body.enrichment).toBe('full')
  })

  it('固定指定(standard)はモデルの大きさより優先される', async () => {
    const body = await preview({ model: BUNDLED_LLM_MODEL, modelProfile: 'standard' })
    expect(body.profile).toBe('standard')
  })

  it('allowlist を通らないモデルは「差し替える」と正直に申告する', async () => {
    // ここが本題。旧 backend は黙って既定へ落としていて、設定画面は
    // 「選んだモデルで動いている」と表示していた。
    const body = await preview({ model: 'mistral:7b', modelProfile: 'auto' })
    expect(body.requestedModel).toBe('mistral:7b')
    expect(body.modelAccepted).toBe(false)
    expect(body.model).toBe(DEFAULT_LLM_MODEL)
  })

  it('壊れた pref は auto として扱う(400 にしない)', async () => {
    const body = await preview({ model: BUNDLED_LLM_MODEL, modelProfile: 'ばぐ' })
    expect(body.pref).toBe('auto')
    expect(body.profile).toBe('small')
  })

  it('量子化タグ付きの自前 pull も受け入れる(ファミリー一致)', async () => {
    const body = await preview({ model: 'llama3.2:3b-instruct-q4_K_M', modelProfile: 'auto' })
    expect(body.modelAccepted).toBe(true)
    expect(body.profile).toBe('standard')
  })
})

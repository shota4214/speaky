import { describe, expect, it } from 'vitest'
import { modelsInUse } from './models.js'
import { BUNDLED_LLM_MODEL, DEFAULT_LLM_MODEL, isValidModelName } from '../shared/llm-models.js'

/**
 * 「使用中のモデルを消せない」というサーバー側の保護。
 *
 * v1.1.0 までは `ollamaConfig.model`(backend の既定)だけを守っていて、
 * 既定 = ユーザーが使うモデル だったので実質それで足りていた。
 * v1.2.0 で同梱を 1B に落とした結果、**3B へ乗り換えたアップグレード組は
 * サーバー側では誰にも守られていない**状態になった(画面の disabled だけ)。
 * backend は設定を持たないので、クライアントの申告を受けて守る。
 */
describe('modelsInUse', () => {
  it('申告が無ければ backend の既定モデルだけを守る(従来の挙動)', () => {
    expect(modelsInUse(undefined)).toEqual([DEFAULT_LLM_MODEL])
    expect(modelsInUse('')).toEqual([DEFAULT_LLM_MODEL])
    expect(modelsInUse(123)).toEqual([DEFAULT_LLM_MODEL])
  })

  it('⭐ 3B を使っている人の 3B を守る(既定は 1B のまま)', () => {
    const inUse = modelsInUse('llama3.2:3b')
    expect(inUse).toContain('llama3.2:3b')
    // 既定(= 同梱 1B)の保護は残る。
    expect(inUse).toContain(BUNDLED_LLM_MODEL)
  })

  it('自前 pull の量子化タグも守る(会話で実際に使える名前なので)', () => {
    expect(modelsInUse('llama3.2:3b-instruct-q4_K_M')).toContain('llama3.2:3b-instruct-q4_K_M')
  })

  it('allowlist を通らない申告は既定へ解決される(会話でも使われない名前だから)', () => {
    // `mistral:7b` を選んだつもりでも会話は既定モデルで走る。
    // 守るべきは「実際に使われるモデル」であって申告そのものではない。
    const inUse = modelsInUse('mistral:7b')
    expect(inUse).not.toContain('mistral:7b')
    expect(inUse).toEqual([DEFAULT_LLM_MODEL, DEFAULT_LLM_MODEL])
  })

  it('壊れた申告でクラッシュしない', () => {
    expect(() => modelsInUse('../../etc/passwd')).not.toThrow()
    expect(modelsInUse('../../etc/passwd')).not.toContain('../../etc/passwd')
  })
})

/**
 * 取得(pull)の入口チェックは **ファミリー allowlist を掛けない**が、
 * `isValidModelName` の制限はそのまま効く。コメントと実装が食い違わないよう、
 * 「名前空間付きは意図的に弾く」ことをテストで固定しておく。
 */
describe('pull の入口チェック(isValidModelName)が実際に許す形', () => {
  it('一覧に無い型番でも取得はできる(allowlist は掛けない)', () => {
    expect(isValidModelName('gemma2:2b')).toBe(true)
    expect(isValidModelName('mistral:7b')).toBe(true)
  })

  it('名前空間付きは意図的に弾く(取得できても会話の allowlist に当たらないため)', () => {
    expect(isValidModelName('library/llama3.2:3b')).toBe(false)
    expect(isValidModelName('hf.co/user/model:q4')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { isClientAbort } from './client-abort.js'
import { OllamaError } from './ollama.js'

/**
 * 「クライアントが切った」と「タイムアウト/障害」の区別。
 *
 * 中断を失敗として扱うと、**会話を終えただけ**でエラー表示が出て、
 * 会話ループの連続失敗カウンタまで積み上がる。逆に失敗を中断として扱うと、
 * **ユーザーには何も出ず、ログにも何も残らない** 499 になる。後者の方が悪い。
 *
 * 名前が `AbortError` というだけで中断に倒す作りは、
 * 「この経路の abort は必ず OllamaError に詰め替わっている」という
 * 実装の偶然に支えられていた。ルートが自前の締め切りや abort で畳む
 * 子プロセスを持った瞬間に静かに壊れるので、**その request の
 * client signal が立っていること**を判定の条件に入れてある。
 */
describe('isClientAbort', () => {
  function abortedSignal(): AbortSignal {
    const ctrl = new AbortController()
    ctrl.abort()
    return ctrl.signal
  }
  function liveSignal(): AbortSignal {
    return new AbortController().signal
  }

  it('クライアントが切っていれば OllamaError(ABORTED) は中断', () => {
    expect(isClientAbort(new OllamaError('ABORTED', 'aborted'), abortedSignal())).toBe(true)
  })

  it('クライアントが切っていれば素の AbortError も中断(転写経路)', () => {
    const e = new DOMException('Aborted', 'AbortError')
    expect(isClientAbort(e, abortedSignal())).toBe(true)
  })

  it('⭐ クライアントが切っていない AbortError は中断ではない(将来の締め切り対策)', () => {
    // このルートが将来「自前の AbortController で締め切る」処理を持ったとき、
    // その AbortError を中断と誤認すると 499 になり、ユーザーにもログにも
    // 何も残らない。client signal が立っていないなら内部由来 = 障害。
    const e = new DOMException('Aborted', 'AbortError')
    expect(isClientAbort(e, liveSignal())).toBe(false)
  })

  it('クライアントが切っていない ABORTED も中断ではない', () => {
    expect(isClientAbort(new OllamaError('ABORTED', 'aborted'), liveSignal())).toBe(false)
  })

  it('タイムアウトは(クライアントが切っていても)中断として飲み込まない', () => {
    // 中断と締め切りが同時に起きることはあるが、詰め替えの時点で
    // どちらなのかは確定している。TIMEOUT はここを通り抜けて 503/504 になる。
    expect(isClientAbort(new OllamaError('TIMEOUT', 'timed out'), abortedSignal())).toBe(false)
  })

  it('普通のエラーは中断ではない', () => {
    expect(isClientAbort(new Error('boom'), abortedSignal())).toBe(false)
    expect(isClientAbort(null, abortedSignal())).toBe(false)
    expect(isClientAbort(undefined, abortedSignal())).toBe(false)
  })
})

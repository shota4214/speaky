import { describe, expect, it } from 'vitest'
import {
  BACKEND_WORST_CASE_MS,
  CHAT_ROUTE_WORST_CASE_MS,
  CLIENT_DEADLINE_MARGIN_MS,
  CLIENT_DEADLINE_MS,
  OLLAMA_ATTEMPTS,
  OLLAMA_BUDGET_MS,
  TRANSCRIBE_BUDGET_MS,
} from './request-budget.js'
import { chatAttempts, openingAttempts } from '../routes/chat.js'
import { EXTRACT_FACTS_ATTEMPTS } from '../routes/extract-facts.js'
import {
  EN_TO_JA_ATTEMPTS,
  EN_TO_JA_FRESH_ATTEMPTS,
  TRANSLATION_ATTEMPTS,
} from '../services/translation.js'
import { MODEL_PROFILES } from '../services/model-profile.js'

/**
 * **クライアント締め切りと backend のリトライ梯子の結び付き**を固定するテスト。
 *
 * v1.1.0 はここが結ばれておらず、クライアントの締め切り(手置きの 120 / 90 秒)が
 * backend の最悪値(240 / 120 秒)より短かった。その状態だと
 * 「遅いだけで健全なターン」がクライアント側で打ち切られて通信エラーになり、
 * 会話ループの連続失敗カウンタ(3 回で会話停止)を積み上げる。
 * 8GB 機のコールドロードが重なる日は「3 ターンで勝手に会話が終わる」。
 *
 * ここで落としたいのは「**片方だけ**を触った変更」。リトライを 3 回に増やす、
 * first-token 予算を伸ばす、といった変更はどれも最悪値を押し上げるので、
 * 締め切りを計算し直さない限りこのテストが赤くなる。
 */
describe('リトライ梯子とクライアント締め切りの結合', () => {
  it('宣言した attempt 数が実際の梯子の長さと一致する', () => {
    // 宣言だけ直して実装を直し忘れる(逆も)と最悪値の計算が嘘になる。
    expect(chatAttempts(MODEL_PROFILES.standard)).toHaveLength(OLLAMA_ATTEMPTS.chat)
    expect(chatAttempts(MODEL_PROFILES.small)).toHaveLength(OLLAMA_ATTEMPTS.chat)
    expect(openingAttempts(MODEL_PROFILES.standard)).toHaveLength(OLLAMA_ATTEMPTS.opening)
    expect(TRANSLATION_ATTEMPTS).toHaveLength(OLLAMA_ATTEMPTS.translation)
    expect(EN_TO_JA_ATTEMPTS).toHaveLength(OLLAMA_ATTEMPTS.translationEnToJa)
    expect(EN_TO_JA_FRESH_ATTEMPTS).toHaveLength(OLLAMA_ATTEMPTS.translationEnToJa)
    expect(EXTRACT_FACTS_ATTEMPTS).toHaveLength(OLLAMA_ATTEMPTS.extractFacts)
  })

  it('各ルートの最悪値が「予算 × 試行回数 + 後追いの補完」になっている', () => {
    // /api/chat: 会話 LLM 2 回 + reply_ja が空 / 検証落ちのときの en→ja 補完(最大 2 回)
    expect(BACKEND_WORST_CASE_MS.chat).toBe(90_000 * 2 + 60_000 * 2)
    expect(BACKEND_WORST_CASE_MS.opening).toBe(90_000 * 2 + 60_000 * 2)
    // /api/chat の日本語入力(japanese_help / mixed)は翻訳経路だけを通る
    expect(BACKEND_WORST_CASE_MS.chatTranslate).toBe(60_000 * 2)
    // /api/chat/enrich: JSON 生成 1 回 + 日本語訳が空 / 検証落ちのときの補完(最大 2 回)
    expect(BACKEND_WORST_CASE_MS.enrich).toBe(60_000 + 60_000 * 2)
    expect(BACKEND_WORST_CASE_MS.summarize).toBe(60_000)
    expect(BACKEND_WORST_CASE_MS.extractFacts).toBe(60_000 * 2)
  })

  it('クライアント締め切りは必ず backend の最悪値より長い', () => {
    const pairs: [string, number, number][] = [
      ['/api/chat', CLIENT_DEADLINE_MS.chat, CHAT_ROUTE_WORST_CASE_MS],
      ['/api/chat/opening', CLIENT_DEADLINE_MS.opening, BACKEND_WORST_CASE_MS.opening],
      ['/api/chat/enrich', CLIENT_DEADLINE_MS.enrich, BACKEND_WORST_CASE_MS.enrich],
      ['/api/summarize', CLIENT_DEADLINE_MS.summarize, BACKEND_WORST_CASE_MS.summarize],
      ['/api/extract-facts', CLIENT_DEADLINE_MS.extractFacts, BACKEND_WORST_CASE_MS.extractFacts],
      ['/api/transcribe', CLIENT_DEADLINE_MS.transcribe, TRANSCRIBE_BUDGET_MS],
    ]
    for (const [route, client, backend] of pairs) {
      // 「同値」は通さない。同値だとどちらが先に諦めるかが運になり、
      // 半分の確率で健全なターンが通信エラーとして表示される
      // (日本語入力経路が実際にその状態だった: 120 秒 対 120 秒)。
      expect(client, `${route} のクライアント締め切りが backend の最悪値以下`).toBeGreaterThan(
        backend,
      )
      expect(client - backend, `${route} の余裕が足りない`).toBeGreaterThanOrEqual(
        CLIENT_DEADLINE_MARGIN_MS,
      )
    }
  })

  it('/api/chat の締め切りは通常ターンと日本語入力ターンの両方を覆う', () => {
    // クライアントは URL からモードを区別できない(同じ /api/chat)。
    // 片方だけを見て締め切りを決めると、もう片方が競走になる。
    expect(CLIENT_DEADLINE_MS.chat).toBeGreaterThan(BACKEND_WORST_CASE_MS.chat)
    expect(CLIENT_DEADLINE_MS.chat).toBeGreaterThan(BACKEND_WORST_CASE_MS.chatTranslate)
  })

  it('ストリーミングの first-token 予算は非ストリーミングを超えない', () => {
    // ストリーミングは first-token と生成完了が分離するので短くできる。
    // 逆転したら「ストリーミングの方が先に諦める」= フォールバックが常態化する。
    expect(OLLAMA_BUDGET_MS.chatStream).toBeLessThanOrEqual(OLLAMA_BUDGET_MS.chat)
    expect(OLLAMA_BUDGET_MS.openingStream).toBeLessThanOrEqual(OLLAMA_BUDGET_MS.opening)
  })

  it('転写の予算は寛容side(会話 1 ターンの LLM 予算以上)である', () => {
    // 転写は毎ターン必ず通る唯一の経路。低速機では本当に時間がかかるので、
    // ここを削って「健全な発話を殺す」ことがいちばん避けたい失敗。
    expect(TRANSCRIBE_BUDGET_MS).toBeGreaterThanOrEqual(OLLAMA_BUDGET_MS.chat)
  })
})

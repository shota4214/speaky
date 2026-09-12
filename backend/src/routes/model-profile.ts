import { Router, type Request, type Response } from 'express'
import { resolveLlmModel } from '../services/ollama.js'
import { resolveModelProfile } from '../services/model-profile.js'
import { isModelProfilePref, type ModelProfilePref } from '../shared/llm-models.js'

/**
 * 「この設定で会話を始めたら、backend は実際に何をするのか」を**backend に聞く**ための
 * 読み取り専用エンドポイント。LLM は一切呼ばない(即答)。
 *
 * ── なぜ要るのか ──
 * 設定画面の「会話モード」バッジは、v1.1.0 まで **ローカルの設定だけ**から
 * 計算していた。会話画面のバッジ(backend が申告した値だけを信じる)とは
 * 作りが違い、そこに実際の穴があった:
 *
 *   前リリースの backend + 新しい frontend という組み合わせは Electron では普通に
 *   起こる(frontend は app bundle から、backend は userData から読まれ、backend の
 *   同期は app version の gate で走る)。その backend は
 *     - プロファイルという概念を知らない(常に長いプロンプトで動く)
 *     - allowlist が完全一致で `llama3.2:1b` を含まない → 黙って既定モデルへ落とす
 *   ので、ユーザーは **選んだモデルも表示されたモードも両方間違っている**画面を見る。
 *
 * このエンドポイントは frontend の推測ではなく backend 自身の解決結果を返す:
 *  - `model`         : 実際に Ollama へ投げる名前(allowlist で落ちたなら既定名)
 *  - `modelAccepted` : リクエストされた名前がそのまま採用されたか
 *  - `profile`       : 実際に使う会話プロファイル
 *
 * 古い backend はこのルート自体を持たないので、frontend は `/api/health` の
 * features に `model-profile-preview` があることを **肯定的に確認**してからしか
 * 呼ばない。無ければ「このバックエンドでは確認できない」と正直に表示する。
 */
export const modelProfileRouter = Router()

interface PreviewBody {
  model?: unknown
  modelProfile?: unknown
}

modelProfileRouter.post('/model-profile/preview', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as PreviewBody
  const requestedModel = typeof body.model === 'string' ? body.model : null
  const pref: ModelProfilePref = isModelProfilePref(body.modelProfile) ? body.modelProfile : 'auto'

  // 会話ルートとまったく同じ 2 つの解決関数を通す。ここで別の判定を書くと
  // 「プレビューは正しいのに本番が違う」という、いちばん質の悪いズレになる。
  const model = resolveLlmModel(requestedModel ?? undefined)
  const profile = resolveModelProfile(pref, model)

  return res.json({
    requestedModel,
    model,
    modelAccepted: requestedModel === null ? false : model === requestedModel,
    pref,
    profile: profile.level,
    /** 軽量モードで添削・単語が出ないことを UI が言い切れるようにする。 */
    enrichment: profile.enrichment,
  })
})

# Speaky — プロジェクトガイド / 引き継ぎ

> このファイルは新しいセッションで自動読込される。作業の前に必ず目を通すこと。
> 状態が変わったら（マージ・リリース・大きな機能追加）このファイルも更新する。

## プロジェクト概要

- **正体**: Mac (Apple Silicon / arm64) 専用の**ローカル完結型 英会話練習アプリ**
- **構成**: Electron + Vue 3 (frontend) + Node/Express (backend) + Ollama (LLM) + whisper.cpp / nodejs-whisper (STT) + Web Speech API (TTS)
- **配布形態**: 未署名の `.dmg`（Google Drive / iCloud 等で配布。GitHub Releases は 2GB 上限で不可）
- **GitHub**: `shota4214/speaky`
- **完全ローカル動作が売り**（外部 API 課金ゼロ、データ外部送信なし）

## ⚠️ 開発時の必須ルール

1. **Node 22 必須**。コマンド前に必ず `. ~/.nvm/nvm.sh && nvm use 22`
   （Node 16/18 だと Vite build が壊れる。`.nvmrc` = 22）
2. **PM ロールで動く**（`memory/MEMORY.md` 参照）: 重い作業はサブエージェントにバックグラウンド委譲。
   コード変更は **read-only レビューサブエージェントを通してからコミット**する運用。
3. **コミット前に必ず全 pass させる検証セット**:
   ```bash
   . ~/.nvm/nvm.sh && nvm use 22
   npm run lint && npm run format:check && npm run build && npm run build:bundle -w backend && npm test -w frontend
   ```
   （現在テストは frontend 55 件）
4. **main へ直接コミット禁止**。必ずブランチ → PR → マージ。コミットは日本語 `[add]/[fix]/[chore]` プレフィクス。

## 🔴 次にやるべき最優先タスク（このセッションからの引き継ぎ）

### 1. ブランチ `feat/bundle-ollama-binary` を PR マージ

- 内容: **Ollama ランタイムバイナリ (~150MB) を DMG 同梱し、完全オフライン初回起動を実現**
- 2 コミット: `[add] Ollama ランタイムバイナリを同梱…` + `[fix] Ollama 同梱のオフライン保証を強化(P2/P3)`
- レビュー済み（ブロッカーなし、指摘 P2/P3 も解消済み）。push 済み・未マージ。
- PR: https://github.com/shota4214/speaky/pull/new/feat/bundle-ollama-binary

### 2. v0.0.6 リリースビルド + 実機オフライン検証（**未完了の核心**）

コードは完成しているが **実際にオフラインで起動するかの実機検証が未実施**。マージ後:

```bash
. ~/.nvm/nvm.sh && nvm use 22
# electron/package.json と root package.json の version を 0.0.6 に bump
#   ※ リリースごとに app version を上げないと runtime sync が走らない（重要）
npm run dist   # Ollama 込みで DMG ~3.45GB、5〜10分
```

検証（最重要）:

```bash
# Speaky を Cmd+Q → userData 削除で初回起動を再現
rm -rf "$HOME/Library/Application Support/electron"
# Wi-Fi を切る（機内モード）→ /Applications/Speaky.app を起動
# → ネット無しで Ollama 起動 → 会話開始まで到達するか確認
```

確認点: `isDownloaded('v0.30.4')=true` で serve がネットを叩かず起動 / Ollama 11434 が立つ / 会話できる。
prep は実行済み（`electron/build-resources/ollama-bin/` に vendor 済み、symlink 実ファイル化・AppleDouble 除去済み）。

## 同梱物の事実（実機ビルドで確認済み）

DMG 内 `Speaky.app/Contents/Resources/backend-template/` に以下が**すべて同梱**（初回 DL 不要）:

- LLM: Llama 3.2 3B（`ollama-data/blobs/` + manifest）
- Whisper medium（`ggml-medium.bin` 1.4GB）
- whisper-cli / ffmpeg-static
- **Ollama ランタイム本体**（`ollama-bin/electron-ollama/v0.30.4/darwin/arm64/`）← feat/bundle-ollama-binary で追加

## 配布の既知の問題

- **未署名のため macOS Sequoia で「壊れている」エラー**が出る（AirDrop/USB でも回避不可）。
  回避: 受け取り手が `xattr -cr /Applications/Speaky.app` を実行、または **Apple Developer Program($99/年)で署名・公証**。
- **Apple Developer Program 個人登録済み (Team ID: `DQ7HKL3WWX`)**。`feat/codesign-notarize` で署名・公証フロー実装。実機ビルドでの検証が次の必須タスク。

## 署名・公証（Developer ID）の構成

- **署名 ID**: `Developer ID Application: SHOTA SUZUKI (DQ7HKL3WWX)` (login keychain)
- **公証認証**: keychain profile 名 `speaky-notarize` に保存済み (notarytool store-credentials)
- **build hooks** (`electron/scripts/`):
  - `afterPack-sign-binaries.cjs` … `backend-template/` 配下の同梱 Mach-O を個別署名 (chmod +x 復活 + 既知の実行ファイル名 fallback あり)
  - `afterSign-notarize.cjs` … `.app` を zip→notarytool submit→stapler staple。失敗時は notarytool log を自動取得
  - `afterAllArtifactBuild-staple-dmg.cjs` … DMG も notarize→staple (オフライン環境での Gatekeeper 対策)
- **entitlements** (`electron/build/entitlements.mac.plist`): audio-input / allow-jit / allow-unsigned-executable-memory / allow-dyld-environment-variables / disable-library-validation。同梱の llama.cpp / whisper.cpp / ollama 系を hardened runtime 下で動かすために必要。
- **環境変数で挙動を上書き可**:
  - `SPEAKY_SKIP_NOTARIZE=1` … 署名はするが公証をスキップ (ローカル動作確認用。初回起動時 Gatekeeper で弾かれる)
  - `SPEAKY_NOTARY_PROFILE=xxx` … keychain profile 名を上書き
- **完全未署名 DMG** (旧来挙動) でビルドしたい場合は:
  ```bash
  npm run dist -w electron -- --config.mac.identity=null \
    --config.mac.hardenedRuntime=false --config.mac.entitlements=null
  ```
- **ビルド時間の目安**: 通常の `npm run dist` (5〜10分) に加え、公証申請が `.app` と `.dmg` で **各 5〜15 分** 走るため、**合計で 15〜40 分程度**かかる。「ビルドが固まった？」ではなく公証待ち。`afterSign-notarize.cjs` / `afterAllArtifactBuild-staple-dmg.cjs` のログを見れば進行状況がわかる。

## アーキテクチャの要点（ハマりどころ）

- **electron/src/main.ts**: 起動フロー = planRuntime（needsSync 判定）→ スプラッシュ → runRuntimeSync（同梱物を userData にコピー）→ startOllama（Ollama sidecar）→ startBackend → メインウィンドウ。
- **userData は `~/Library/Application Support/electron/`** 配下（productName が "electron" のため。`Speaky/` ではない）。
- **runtime sync は `version.json`（app version）で gate**。リリースごとに version を上げないと同梱物が再同期されない。
- **Ollama バイナリ同期は version gate と独立**（startOllama 内で isDownloaded 確認 → 無ければコピー。既存 userData 対策）。
- **OLLAMA_VERSION pin** = `v0.30.4`（main.ts と scripts/prep-ollama-binary.mjs の両方。必ず一致させる）。`getMetadata('latest')` は使わない（ネット回避）。
- **会話の翻訳ロジック**（backend/src/routes/chat.ts）: 日本語/英日混在は専用翻訳経路に分離。日本語訳が空なら en→ja 補完（「日本語訳を必ず表示」設定の保証）。
- **モデル選択**は「インストール済み AND backend allowlist 内」のみ。allowlist は frontend(`storage/settings.ts` の `ALLOWED_LLM_MODELS` / `VALID_WHISPER_MODELS`)と backend(`services/ollama.ts` の `ALLOWED_LLM_MODELS`)の両方にあり**手動同期が必要**。
- **巨大バイナリ/モデルは `.gitignore` 済み**（`electron/build-resources/`、`backend/vendor/node_modules/`、`dist-app/`）。prep スクリプトでビルド時に用意する。

## prep スクリプト（ビルド時にモデル/バイナリを vendor）

`npm run dist`（root）のチェーンで以下が走る（すべて冪等）:

- `prep:vendor` / `prep:vendor:whisper-cli`（backend）= node_modules / whisper-cli
- `prep:vendor:whisper-model`（backend）= ggml-medium.bin を HF から DL
- `prep:vendor:llama-model`（electron）= Llama 3.2 3B を ollama pull して vendor
- `prep:vendor:ollama-binary`（electron）= Ollama v0.30.4 バイナリを vendor（symlink 実ファイル化込み）
- `verify:arm64`（backend）= arm64 バイナリ検証

## 完了済みの主な機能（〜v0.0.5）

配布版 DMG（Ollama/LLM/Whisper 同梱、初回スプラッシュ）/ ふんわりパステル UI リデザイン + アプリアイコン + マスコット（ヘッドホンキャラ）/ ライト・ダーク明示切替 + 3テーマ（mint/lavender/peach）/ AI 音声選択・速度/ピッチ・性格プリセット5種 / 日本語訳トグル（必ず表示保証）/ 無音間隔（初期5秒・最大15秒）/ カスタムトピック / 特徴アイコン / 使用中バッジ整合 / 録音テスト修正（ffmpeg 事前変換）/ 会話 UI 修正 / Dev tools 非表示 / 離脱時の会話終了。

## バックログ（任意・未着手）

- 署名・公証ビルドの**実機検証**（`feat/codesign-notarize` ブランチ）: `npm run dist` で署名・公証付き DMG が生成され、別 Mac で `xattr -cr` 無しで起動できることを確認
- **同梱 dylib/.so の Developer ID 再署名 → `disable-library-validation` を外す**（entitlements 緩和の解消。今は llama.cpp/whisper.cpp/ollama 由来の他チーム署名 dylib があるため許容）
- 応答速度の高速化（ストリーミング TTS 等。検討のみ）
- Web アプリ化（検討したが完全ローカルの売りが消えるため見送り）

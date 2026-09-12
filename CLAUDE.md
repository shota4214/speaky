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
   （現在テストは frontend 102 件）
4. **main へ直接コミット禁止**。必ずブランチ → PR → マージ。コミットは日本語 `[add]/[fix]/[chore]` プレフィクス。

## 🔴 次にやるべき最優先タスク（このセッションからの引き継ぎ）

現在地: **v1.1.0（低スペック機向けパフォーマンス対応）をブランチ `perf/low-spec-tier1` で作業中**。
v1.0.0 は一般公開済み（DMG 配布済み・Ollama バイナリ同梱も v0.0.6 でマージ完了）。

v1.1.0 の中身（Tier1）:

- Whisper デフォルト `medium` → `small`（多言語のまま。日本語入力があるので `.en` 不可）
- 無音検出 5000ms → 1500ms（設定スキーマ v1 → v2 で一度だけ移行、保存も即時）
- whisper.cpp を `-DGGML_NATIVE=OFF` でビルド（M1/M2 での SIGILL 回避）
- Ollama の `keep_alive` / `num_ctx` 調整、プロフィール事実の送信上限
- `verify:arm64` を拡張して i8mm/bf16/SME 命令混入を検出（`scripts/verify-arm64.mjs`）

### 1. whisper-cli の再ビルド（**verify:arm64 が現状 FAIL する**）

vendor 済みの `whisper-cli` は M5 上で native ビルドされた古い成果物で、
**M1 に存在しない `smmla`（i8mm）命令を 108 個含む** = M1 実機で SIGILL。
`npm run dist` はこの検証で止まるので、先に作り直すこと（数分かかる）:

```bash
. ~/.nvm/nvm.sh && nvm use 22
npm run prep:vendor:whisper-cli -w backend   # -DGGML_NATIVE=OFF 付きで build/ を作り直す
npm run verify:arm64 -w backend              # ここが OK になってから dist
```

### 2. v1.1.0 リリースビルド + **非 M5 実機での検証**（未完了の核心）

```bash
. ~/.nvm/nvm.sh && nvm use 22
# version は既に 1.1.0 に bump 済み（root / electron/package.json）
#   ※ リリースごとに app version を上げないと runtime sync が走らない（重要）
npm run dist   # DMG ~2.7GB（Whisper small 化で約 1GB 減）、5〜10分 + 公証
```

検証（最重要・**M1/M2 など古い Apple Silicon の実機で**）:

```bash
# Speaky を Cmd+Q → userData 削除で初回起動を再現
rm -rf "$HOME/Library/Application Support/electron"
# Wi-Fi を切る（機内モード）→ /Applications/Speaky.app を起動
```

確認点:

- whisper-cli が SIGILL せずに転写できる（← Tier1 の一番の目的。M5 では絶対に再現しない）
- 8GB 機で会話が成立する速度か（Whisper small + Llama 3.2 3B + num_ctx 4096）
- 無音 1.5 秒の自動送信が早すぎないか（既存ユーザーは v1→v2 移行で 1500 に変わる）
- ネット無しで Ollama 起動 → 会話開始まで到達する（`isDownloaded('v0.30.4')=true`）

## 同梱物の事実（実機ビルドで確認済み）

DMG 内 `Speaky.app/Contents/Resources/backend-template/` に以下が**すべて同梱**（初回 DL 不要）:

- LLM: Llama 3.2 3B（`ollama-data/blobs/` + manifest）
- Whisper small（`ggml-small.bin` 約488MB。低スペック機対策で medium から変更）
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
- **Whisper モデルは実行前に存在チェック**（`backend/src/services/whisper-paths.ts`）。
  フォールバック順は「リクエスト値 → 同梱 `small` → インストール済みの**多言語**モデル（小さい順）→ 503」。
  `.en` 系には絶対に落とさない（日本語入力が壊れる）。
  `whisper-paths.ts` は **モジュールロード時の cwd を固定**して解決する。
  nodejs-whisper が転写中だけ `shelljs.cd()` でプロセスの cwd を変えるため、
  実行時に `process.cwd()` を読むと並行リクエストが誤判定して 503 になる。
  `autoDownloadModelName` は**渡さない**（渡すと HTTP リクエスト内で HF DL + cmake ビルドが走り固まる）。
  明示 DL は `POST /api/models/whisper/download` のみ。
- **Ollama のチューニング**は 2 箇所: `electron/src/main.ts` startOllama の env
  （KEEP_ALIVE=30m / NUM_PARALLEL=1 / MAX_LOADED_MODELS=1 / FLASH_ATTENTION=1）と
  `backend/src/services/ollama.ts` のリクエスト（`keep_alive` / `options.num_ctx`= DEFAULT_NUM_CTX 4096）。
  リクエスト側の指定が実効値。
- **設定スキーマ版** `SETTINGS_SCHEMA_VERSION`（`frontend/src/storage/settings.ts`）。
  デフォルト値を変えて既存ユーザーにも適用したいときは版を上げて移行処理を足す。
- **モデル選択**は「インストール済み AND backend allowlist 内」のみ。allowlist は frontend(`storage/settings.ts` の `ALLOWED_LLM_MODELS` / `VALID_WHISPER_MODELS`)と backend(`services/ollama.ts` の `ALLOWED_LLM_MODELS`)の両方にあり**手動同期が必要**。
- **巨大バイナリ/モデルは `.gitignore` 済み**（`electron/build-resources/`、`backend/vendor/node_modules/`、`dist-app/`）。prep スクリプトでビルド時に用意する。

## prep スクリプト（ビルド時にモデル/バイナリを vendor）

`npm run dist`（root）のチェーンで以下が走る（すべて冪等）:

- `prep:vendor` / `prep:vendor:whisper-cli`（backend）= node_modules / whisper-cli
  - **`-DGGML_NATIVE=OFF` 必須**（JSON にコメントが書けないのでここに記録）。
    付けないと ggml が `-mcpu=native+dotprod+i8mm+nosve+sme` でビルドされ、
    ビルド機（M5）にしか無い命令が入る。i8mm は M1 に、SME は M1/M2/M3 に無いため
    配布先の低スペック Mac で **SIGILL クラッシュ**する。
    OFF にすると clang の既定 `-target-cpu apple-m1`（= 全 Apple Silicon の共通基盤）になる。
    `-DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod` は指定可能だが apple-m1 より基盤が古く
    fp16 ベクタ演算等を落として遅くなるため**付けない**。
- `prep:vendor:whisper-model`（backend）= ggml-small.bin を HF から DL
- `prep:vendor:llama-model`（electron）= Llama 3.2 3B を ollama pull して vendor
- `prep:vendor:ollama-binary`（electron）= Ollama v0.30.4 バイナリを vendor（symlink 実ファイル化込み）
- `verify:arm64`（backend / 実体は `scripts/verify-arm64.mjs`）= 同梱バイナリ検証
  - arm64 Mach-O であること（`file`）に加え、**whisper-cli に i8mm / bf16 / SME 命令が
    含まれないこと**を `otool -tV` で検証する（M1 で SIGILL するビルドの唯一の防波堤。
    署名・公証・staple は素通りするので実機まで誰も気づけない）。
    FAIL したら `npm run prep:vendor:whisper-cli -w backend` で作り直す。

## 完了済みの主な機能（〜v0.0.5）

配布版 DMG（Ollama/LLM/Whisper 同梱、初回スプラッシュ）/ ふんわりパステル UI リデザイン + アプリアイコン + マスコット（ヘッドホンキャラ）/ ライト・ダーク明示切替 + 3テーマ（mint/lavender/peach）/ AI 音声選択・速度/ピッチ・性格プリセット5種 / 日本語訳トグル（必ず表示保証）/ 無音間隔（初期1.5秒・最大15秒）/ カスタムトピック / 特徴アイコン / 使用中バッジ整合 / 録音テスト修正（ffmpeg 事前変換）/ 会話 UI 修正 / Dev tools 非表示 / 離脱時の会話終了。

## バックログ（任意・未着手）

- 署名・公証ビルドの**実機検証**（`feat/codesign-notarize` ブランチ）: `npm run dist` で署名・公証付き DMG が生成され、別 Mac で `xattr -cr` 無しで起動できることを確認
- **同梱 dylib/.so の Developer ID 再署名 → `disable-library-validation` を外す**（entitlements 緩和の解消。今は llama.cpp/whisper.cpp/ollama 由来の他チーム署名 dylib があるため許容）
- 応答速度の高速化（ストリーミング TTS 等。検討のみ）
- Web アプリ化（検討したが完全ローカルの売りが消えるため見送り）

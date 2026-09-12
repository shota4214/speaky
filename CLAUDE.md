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
   npm run lint && npm run format:check && npm run build && npm run build:bundle -w backend && npm test
   ```
   （`npm test` = frontend → backend の順に vitest。**frontend 232 件 / backend 189 件**）
   backend のテストは `backend/src/**/*.test.ts`（vitest、frontend と同じ構成）。
   LLM の壊れた出力から何を拾い何を捨てるか（`services/json-salvage.ts` /
   `chat-reply.ts` / extract-facts の salvage）と、中断とタイムアウトの区別
   （`services/ollama.ts`）、モデル名の許可判定とプロファイル推定
   （`shared/llm-models.ts` / `services/model-profile.ts`）がここで固定されている。
4. **main へ直接コミット禁止**。必ずブランチ → PR → マージ。コミットは日本語 `[add]/[fix]/[chore]` プレフィクス。

## 🔴 次にやるべき最優先タスク（このセッションからの引き継ぎ）

現在地: **v1.1.0（低スペック機向けパフォーマンス対応）をブランチ `perf/low-spec-tier2` で作業中**。
v1.0.0 は一般公開済み。Tier1（Whisper 既定の縮小・無音検出短縮・whisper.cpp の
`-DGGML_NATIVE=OFF` ビルド・`verify:arm64` 拡張）は `perf/low-spec-tier1` でマージ済み。

Tier2 で入ったもの（すべてこのブランチ内）:

- Whisper 既定の縮小／録音・描画コストの削減
- LLM 失敗ターンの高速フェイル（リトライ 2 回・フラット予算・salvage）
- 文単位の発話キュー + ウォッチドッグ
- **英語返答の SSE ストリーミング**（最初の 1 文が出来た時点で読み上げ開始）
- **日本語訳 / 添削 / 単語の後追い生成（enrich）** — マイクは enrich を待たない
- クライアントの中断を Ollama まで伝播
- **小型モデル（1B / 1.5B）を実用にする会話プロファイル**（下記）
- 履歴詳細画面の日本語訳の再取得、非ストリーミング経路のクライアント締め切り

### 残っているのは 1 つだけ: リリースビルド + **M1 MacBook Air 実機検証**

コードは完成していて全検証が pass しているが、**実機で確かめていない**。

```bash
. ~/.nvm/nvm.sh && nvm use 22
npm run prep:vendor:whisper-cli -w backend   # -DGGML_NATIVE=OFF で作り直す
npm run verify:arm64 -w backend              # ここが OK になってから dist
npm run dist                                 # DMG ~2.7GB、5〜10分 + 公証で計 15〜40分
```

検証は **M1（8GB）実機で**。M5 では絶対に再現しない項目が混ざっている:

1. whisper-cli が SIGILL せずに転写できる（Tier1 の一番の目的）
2. ネット無しで Ollama が起動し会話開始まで到達する（`isDownloaded('v0.30.4')=true`）
3. オンボーディングが「この Mac のメモリは 8GB です」と表示し、
   LLM が `llama3.2:1b` に**あらかじめ選ばれている**
4. `llama3.2:1b` / `qwen2.5:1.5b` で会話が成立する（軽量モード）:
   返答が 1〜2 文に収まる / 日本語訳が必ず出る / 添削と単語は出ない
5. 最初の音が出るまでの時間（ストリーミングの効き）と、ターン間の待ち時間
6. 設定画面の「会話モード」バッジが実際の動作と一致する
7. 既存ユーザー（`gemma2:2b` を選んで保存済み）が **標準モードのまま**である
   （設定スキーマ v3 の移行。`~/Library/Application Support/electron` を消さずに上書き起動して確認）
8. スリープ復帰直後のターンが固まらない（クライアント締め切り 120 秒で必ず畳まれる）

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
- **設定スキーマ版** `SETTINGS_SCHEMA_VERSION`（`frontend/src/storage/settings.ts`）= **3**。
  デフォルト値を変えて既存ユーザーにも適用したいときは版を上げて移行処理を足す。
  キーが増えるだけなら版は上げない（merge が欠落を埋める）。上げるのは
  「既存の保存値を書き換える必要がある」ときだけ。移行が走ったら**その場で保存する**
  （`needsMigration → saveSettings`）。これが無いと冪等でない移行が毎起動走る。
  - v1→v2: 無音間隔 5000→1500 / Whisper medium→small（旧デフォルトのままの人だけ）
  - v2→v3: `modelProfile` の新設。**`gemma2:2b` を選んでいた人だけ** `'standard'` を
    明示的に書き込んで据え置く（'auto' だと small に落ちて挙動が変わるため）。
- **会話プロファイル**（`backend/src/services/model-profile.ts`）= `standard` / `small` の 2 段。
  - `small` は 1B〜2B 向け: system prompt を **約 900 → 約 200〜250 トークン**に圧縮
    （会話スタイル節を削除 / レベル説明は該当 1 行だけ / 人格は 1 行 / プロフィール事実は 6 件まで）、
    履歴 10 往復→4 往復、生成予算を約半分、温度を下げ repeat_penalty を上げ、
    **enrich は日本語訳だけ**（1B の添削は誤りが多く、学習者を間違った方へ引っ張るため）。
  - **`num_ctx` は small でも 4096 のまま**。計測できる実機が無いうちは下げない
    （プロファイル駆動にはしたので、M1 で測ってから下げること）。
  - 選択は設定の `modelProfile`（`auto` / `standard` / `small`、既定 `auto`）。
    `auto` は **タグのパラメータ数**から推定（2B 以下 = small）。ファミリー部分は見ない
    （`llama3.2` の "3.2" を拾うと 1B が small にならない）。
  - 推定は backend が出典。解決結果は `/api/chat` のレスポンスと SSE の `meta` に
    `profile` として載る（フロントの「軽量モードで動作中」バッジの根拠）。
- **モデル選択**は「インストール済み AND backend が受け付ける名前」のみ。
  判定は **`backend/src/shared/llm-models.ts` が唯一の出典**で、frontend は
  `storage/settings.ts` からこのファイルを直接 import している（相対パスで backend 側を読む）。
  v1.1.0 までは同じ一覧を両側に手書きしていて「手動同期が必要」と書いてあったが、
  二重化そのものを消した。**JSON ではなく .ts** にしてあるのは、backend が
  `module: NodeNext` で JSON import に import attributes が要り、
  tsc / esbuild / Vite で扱いが食い違うため（依存ゼロの .ts なら 3 つとも同じ）。
  - 判定は **ファミリー一致**（`llama3.2` / `llama3.1` / `gemma2` / `qwen2.5`）+ 書式チェック。
    完全一致だった頃は `llama3.2:3b-instruct-q4_K_M` のような量子化タグが
    静かに既定へ落とされ、設定画面の一覧からも消えていた。
  - ⚠️ **ここはセキュリティ境界ではない**。backend は 127.0.0.1 にしか bind せず、
    モデル名は Ollama への JSON ボディに入るだけでシェルにもパスにも渡らない。
    「Ollama にゴミを投げない」ための入口ガードである（緩めても退行ではない）。
  - Whisper 側の allowlist（`VALID_WHISPER_MODELS`）は frontend にのみある（変更なし）。
- **ストリーミング**（`backend/src/routes/chat-stream.ts` / `frontend/src/services/api.ts`）:
  英語の返答は SSE で流れ、**最初の 1 文が出来た時点で読み上げが始まる**。
  日本語訳 / 添削 / 単語は `done` の後に `enrich` イベントで後追いする（マイクは待たない）。
  フロントは `/api/health` の `features` を**肯定的に確認**したときだけ新経路を使う
  （Electron は frontend を app bundle から、backend を userData から読むため
  「frontend だけが新しい」組み合わせが普通に起こる）。
  非ストリーミング経路は**フォールバックとして残してある**ので削らないこと。
- **クライアント側の締め切り**は 2 系統ある。どちらも「半開きソケット（スリープ復帰）」
  対策で、backend が死んでいると backend の予算は効かないために要る。
  - ストリーミング: ヘッダーまで 180 秒 / ヘッダー後は無通信 45 秒（keepalive が 10 秒間隔）
  - 非ストリーミング: `/api/chat` `/api/chat/opening` が 120 秒、
    `/api/chat/enrich` `/api/summarize` `/api/extract-facts` が 90 秒
  - ⚠️ **締め切り切れとユーザーの中断はどちらも AbortError**。区別せずに変換すると
    「会話を終えただけ」がエラー表示になる（`fetchWithDeadline` が区別している）。
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

## 動作要件（README と揃える）

- Apple Silicon / メモリ **8GB 以上**（16GB 以上推奨）
- 8GB 機では `llama3.2:1b` または `qwen2.5:1.5b` +「軽量モード」が現実的な組み合わせ。
  オンボーディングは `/api/health` の `totalMemoryBytes` を見て
  **12GB 未満なら軽量モデルを最初から選んでおく**（`os.totalmem()` は backend でしか取れない。
  ブラウザの `navigator.deviceMemory` は最大 8 に丸められるので使えない）。

## 完了済みの主な機能（〜v0.0.5）

配布版 DMG（Ollama/LLM/Whisper 同梱、初回スプラッシュ）/ ふんわりパステル UI リデザイン + アプリアイコン + マスコット（ヘッドホンキャラ）/ ライト・ダーク明示切替 + 3テーマ（mint/lavender/peach）/ AI 音声選択・速度/ピッチ・性格プリセット5種 / 日本語訳トグル（必ず表示保証）/ 無音間隔（初期1.5秒・最大15秒）/ カスタムトピック / 特徴アイコン / 使用中バッジ整合 / 録音テスト修正（ffmpeg 事前変換）/ 会話 UI 修正 / Dev tools 非表示 / 離脱時の会話終了。

## バックログ（任意・未着手）

- 署名・公証ビルドの**実機検証**（`feat/codesign-notarize` ブランチ）: `npm run dist` で署名・公証付き DMG が生成され、別 Mac で `xattr -cr` 無しで起動できることを確認
- **同梱 dylib/.so の Developer ID 再署名 → `disable-library-validation` を外す**（entitlements 緩和の解消。今は llama.cpp/whisper.cpp/ollama 由来の他チーム署名 dylib があるため許容）
- 応答速度の高速化（ストリーミング TTS 等。検討のみ）
- Web アプリ化（検討したが完全ローカルの売りが消えるため見送り）

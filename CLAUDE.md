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
   （`npm test` = frontend → backend の順に vitest。**frontend 359 件 / backend 819 件**）
   backend のテストは `backend/src/**/*.test.ts`（vitest、frontend と同じ構成）。
   LLM の壊れた出力から何を拾い何を捨てるか（`services/json-salvage.ts` /
   `chat-reply.ts` / extract-facts の salvage）と、中断とタイムアウトの区別
   （`services/ollama.ts`）、モデル名の許可判定とプロファイル推定
   （`shared/llm-models.ts` / `services/model-profile.ts`）がここで固定されている。
4. **main へ直接コミット禁止**。必ずブランチ → PR → マージ。コミットは日本語 `[add]/[fix]/[chore]` プレフィクス。

## 🔴 次にやるべき最優先タスク（このセッションからの引き継ぎ）

現在地: **v1.2.1 をリリースビルド済み（2026-09-13）。残りは M1 MacBook Air での実機検証だけ**。
v1.0.0 は一般公開済み。v1.2.0 は M1 での検証で日本語訳の崩れが見つかり、公開していない。
低スペック機向けの作業は Tier1（#23）・Tier2（#24）、その後の修正は #26〜#30 ですべて main にマージ済み。
検証が通ったら DMG を配布し、`update-channel/latest.json` を更新する（この時点で既存ユーザーに通知が出る）。

Tier2 で入ったもの（すべてこのブランチ内）:

- Whisper 既定の縮小／録音・描画コストの削減
- LLM 失敗ターンの高速フェイル（リトライ 2 回・フラット予算・salvage）
- 文単位の発話キュー + ウォッチドッグ
- **英語返答の SSE ストリーミング**（最初の 1 文が出来た時点で読み上げ開始）
- **日本語訳 / 添削 / 単語の後追い生成（enrich）** — マイクは enrich を待たない
- クライアントの中断を Ollama まで伝播
- **小型モデル（1B / 1.5B）を実用にする会話プロファイル**（下記）
- 履歴詳細画面の日本語訳の再取得、**全ての HTTP 呼び出しにクライアント締め切り**
  （転写を含む。予算は `backend/src/shared/request-budget.ts` が唯一の出典）
- **同梱 LLM を Llama 3.2 3B → 1B に変更**（DMG 約 2.67GB → 約 1.9GB(v1.2.0 実測)）
- **同梱 LLM を `llama3.2:1b` → `qwen2.5:1.5b` に変更**（`feat/bundle-qwen2.5-1.5b`。
  M1 実機で 1B の日本語訳が崩れたため。理由と数字は下の「同梱 LLM」節。
  DMG は **1.71GB（1,714,488,337 バイト、v1.2.1 実測）**)
- 設定画面の「会話モード」バッジを backend への問い合わせ結果に変更

### 残っているのは 1 つだけ: **M1 MacBook Air 実機検証**（v1.2.1 はビルド済み）

v1.2.1 の DMG は `electron/dist-app/Speaky-v1.2.1.dmg`。ビルド後に次を確認済み:
署名（Developer ID）・公証・staple（アプリと DMG の両方）/ Gatekeeper accepted /
同梱 LLM は `qwen2.5/1.5b` だけ（`ollama-data` 940MB）/ Whisper は small だけ /
whisper-cli の M5 専用命令 0 / バージョン 1.2.1。**実機で確かめていない**のは下の項目。
再ビルドする場合の手順も下に残す。

```bash
. ~/.nvm/nvm.sh && nvm use 22
# ⚠️ v1.2.1 には bump 済み（#30）。次にリリースするときも、必ず root と electron の package.json の version を上げること。
#    このリリースも **version bump が必須**。同梱 LLM を llama3.2:1b → qwen2.5:1.5b に
#    差し替えた。同梱モデルの blob / manifest 自体は ensureBundledOllamaModel が
#    version gate と独立に足すが、既定モデル（= BUNDLED_LLM_MODEL）とカタログは
#    **backend コード**に入っていて、backend の再同期は version.json の app version で
#    gate されている。据え置くと v1.2.0 のテスト機では backend が旧コードのまま
#    （既定 = llama3.2:1b）で動く。
npm run prep:vendor:whisper-cli -w backend   # -DGGML_NATIVE=OFF で作り直す
npm run prep:vendor:llama-model -w electron  # qwen2.5:1.5b を vendor + 旧 llama3.2 ファミリーの残骸を掃除
npm run verify:arm64 -w backend              # ここが OK になってから dist
npm run dist                                 # DMG 1.71GB(v1.2.1 実測)、prep + ビルド + 公証で計 20 分前後(v1.2.1 実績)

# vendor 後に「旧同梱の llama3.2 が残っていないこと」を目で確認する（DMG が太る）
ls electron/build-resources/ollama-data/manifests/registry.ollama.ai/library/
#   → qwen2.5 だけが出ること（llama3.2 が出たら掃除が効いていない）
ls electron/build-resources/ollama-data/manifests/registry.ollama.ai/library/qwen2.5/
#   → 1.5b だけが出ること
du -sh electron/build-resources/ollama-data/
#   → 1GB 前後（1.3GB を超えていたら旧 blob が残っている疑い）
```

検証は **M1（8GB）実機で**。M5 では絶対に再現しない項目が混ざっている。
**⑵〜⑷ は必ず Wi-Fi を切って（機内モードで）行うこと**。
⚠️ **v1.2.0 のテストビルドを動かした Mac は、先に ⑿ を済ませること**
（`llama3.2:1b` が選ばれたままなので、そのまま日本語訳の品質を見ても意味がない）。

1. whisper-cli が SIGILL せずに転写できる（Tier1 の一番の目的）
2. ネット無しで Ollama が起動し会話開始まで到達する（`isDownloaded('v0.30.4')=true`）
3. **オフラインで初回起動を最後まで通せる**（今回の一番の変更点）:
   `rm -rf "$HOME/Library/Application Support/electron"` → 機内モードで起動 →
   オンボーディングが「この Mac のメモリは 8GB です」と表示し、
   LLM が **同梱の `qwen2.5:1.5b`**（選択肢に「同梱」と出る。`llama3.2:1b` は選択肢に出ない）に
   **あらかじめ選ばれていて**、
   ステップ 4 の「次へ」が**最初から押せる**（DL ボタンが出ない = 取得済み）。
   ⚠️ ここが v1.1.0 直前の release blocker だった（1B が選ばれるのに 3B しか同梱が無く、
   オフラインだと「次へ」が永久に押せなかった）。
4. **オフラインの 16GB 機でも初回起動を最後まで通せる**（16GB 機があれば）:
   **追加ダウンロードの案内は出ない**（`RECOMMENDED_DOWNLOAD_LLM_MODEL` は廃止）。
   選択は同梱の `qwen2.5:1.5b` のままで、「次へ」が最初から押せる。
5. `qwen2.5:1.5b` で会話が成立する（軽量モード）:
   返答が 1〜2 文に収まる（最初の挨拶だけは 3 文まで。トピックの質問が入っていること）/ 日本語訳が必ず出る /
   **間違いを含む発話の多くに添削が出る（評価で 62 件中 49 件。3 語未満や説明を用意していない直しは出ない）/
   正しい発話には出ない / 単語カードは出ない**。
   添削は日本語訳の後に届き、マイクはそれを待たない。
   「単語カードが出ないのは壊れているからではない」ことが会話画面の 🪶 バッジ（ツールチップ）で分かる。
   **日本語訳の欄が日本語である**（英語・ローマ字・崩れた文字列が出ない。v1.2.0 の 1B で実際に出た）。
   日本語で話しかけたときに、それが英語に直って会話が続く。
6. 最初の音が出るまでの時間（ストリーミングの効き）と、ターン間の待ち時間
7. 設定画面の「会話モード」バッジが **`(backend 確認済み)` 付き**で表示され、
   会話画面のバッジと一致する（推測ではなく `/api/model-profile/preview` の結果）
8. **アップグレードで既存ユーザーの 3B が消えない**（`~/Library/Application Support/electron`
   を **消さずに** 上書き起動）:
   - `llama3.2:3b` を選んで保存していた人は ⒀ の移行で同梱の `qwen2.5:1.5b` に切り替わるが、
     **3B のモデル本体は消えていない**。設定画面の LLM に `llama3.2:3b` が残っていて、
     選び直せばそのまま 3B で会話できる（切り替わらない構成は ⒀ / ⒁ を参照）
   - `ls "$HOME/Library/Application Support/electron/ollama-data/models/manifests/registry.ollama.ai/library/"`
     に `qwen2.5`（中身は `1.5b`）と `llama3.2`（中身は既存の `3b`。v1.2.0 のテスト機なら `1b` も）の
     両方がある（同期は足すだけで、旧同梱物もユーザーの 3B も消さない）
   - `gemma2:2b` を選んでいた人が **標準モードのまま**である（設定スキーマ v3 の移行）
   - 設定画面で LLM を選び直すと、会話モードの固定が「自動」に戻る
9. **オンラインで 3B を取得すると標準モードに戻る**: 設定画面 →「+ 取得」→ `llama3.2:3b` →
   選択 → バッジが「標準モードで動作します（backend 確認済み）」になる（単語カードはほとんど出ないのが正常）
   （添削は軽量モードでも出る。取得を薦める画面はもう無いので、手で「+ 取得」から選ぶ）
10. スリープ復帰直後のターンが固まらない:
    - 会話ターン（`/api/chat`）はクライアント締め切り **350 秒**で必ず畳まれる
    - **転写（`/api/transcribe`）も 210 秒で畳まれる**（v1.1.0 までここだけ締め切りが無く、
      「認識中」のままマイクが閉じて二度と戻らなかった）
    - 畳まれた後、同じ会話のまま次のターンが始められる（3 回連続で失敗すると録音を止める）
11. 遅いターンが**通信エラーにされない**: 8GB 機でモデルのコールドロードが乗った重いターンが、
    エラー表示ではなくちゃんと返答になる（クライアント締め切りは backend の梯子より必ず長い）
12. **v1.2.0 のテストビルドを動かした Mac は、日本語訳の品質を見る前に同梱モデルへ戻す**:
    v1.2.0 は `llama3.2:1b` を同梱・既定にしていて、その選択は設定に保存されている。
    **設定の移行は入れていない**（v1.2.0 は一般公開していない = テスト機にしか無いため）ので、
    上書きインストールしても `llama3.2:1b` が選ばれたままになる。どちらかを必ずやること:
    - ユーザーデータを消す: `rm -rf "$HOME/Library/Application Support/electron"`
      （オンボーディングからやり直し。⑶ の確認も兼ねられる）
    - または設定画面の LLM で **`qwen2.5:1.5b`** を選び直す（選び直すと会話モードの固定も「自動」に戻る）
    - どちらの場合も、設定画面の LLM が `qwen2.5:1.5b` になっていることを確認してから ⑸ を見る。
      `llama3.2:1b` はインストール済み一覧に「非推奨」の説明付きで残る（消えないのが正しい）。
13. **v1.1.0 で `llama3.2:3b` を選んでいた人が、同梱モデルへ一度だけ切り替わる**（設定スキーマ v4）:
    v1.1.0 の DMG を入れて（既定の 3B のまま）一度起動 → userData を**消さずに**新しい DMG を上書き起動。
    - **同梱モデルあり**（通常の上書き。同梱 Ollama なら `ensureBundledOllamaModel` が入れる）:
      起動後 1〜2 秒で**左下（サイドバーの上）**に「Qwen 2.5 1.5B に切り替えました」の通知が出る /
      会話は塞がない（会話画面で「⏹ 会話を終わる」が押せる。ウィンドウを最小の 1024×700 に縮めても通知がメイン領域と
      サイドバーのナビ項目に重ならない。アップデート通知が出ていても右下のそれと重ならない）/
      設定画面の LLM が `qwen2.5:1.5b`、会話モードの固定が「自動」/ 「閉じる」→ 再起動しても通知は出ない /
      設定で `llama3.2:3b` に戻したら、以後の起動で勝手に戻されない
    - 通知を閉じずに設定画面で別の LLM を選ぶと、**通知が消える**（「切り替えました」が嘘にならない）
    - 設定画面を開いたまま切り替わった場合も、会話モードのバッジが `qwen2.5:1.5b` の内容（軽量モード）に更新される
    - **同梱モデルなし**（下の ⒁ の自前 Ollama で確かめる）: LLM は `llama3.2:3b` のまま・通知は出ない
    - `gemma2:2b` や `llama3.2:1b` を保存していた人は何も起きない
14. **自前の Ollama を起動している Mac**（Speaky は再利用し、同梱モデルはそこへ届かない）:
    `~/.ollama` に `llama3.2:3b` だけがある状態で `ollama serve` を先に起動 → ⒀ と同じ上書き起動。
    **LLM が `llama3.2:3b` のまま会話でき（MODEL_NOT_FOUND にならない）、通知は出ない**。
    その後 `ollama pull qwen2.5:1.5b` して再起動しても**切り替わらない**（確認済みとして終わっている）。
15. **切り替わった後で、自前の Ollama が先に起動している**（既知の制限・対策なし）:
    ⒀ の「同梱モデルあり」で切り替わった Mac で、`~/.ollama` に `qwen2.5:1.5b` が **無い** まま
    `ollama serve` を先に起動 → Speaky を起動。Speaky はその Ollama を再利用するので同梱モデルは届かず、
    移行は完了済みなので確認も戻しもしない。**これは直していない。壊れ方が下のとおりであることを確かめる**:
    - 会話を始めると、会話画面の下にエラー
      「モデル 'qwen2.5:1.5b' が見つかりません。'ollama pull qwen2.5:1.5b' で取得してください。」が出る。
      ユーザーに見えるのはこのエラーだけ（通知は出ない）。画面が固まったりアプリが落ちたりしない
    - 設定画面の LLM が「⚠️ qwen2.5:1.5b — 未インストール」と表示される（別のモデルを選んでいるように見えない）
    - 次のどれかで会話が戻る: 設定で `llama3.2:3b` を選び直す / `ollama pull qwen2.5:1.5b` /
      自前の Ollama を止めて Speaky を再起動する（同梱の Ollama が起動し、同梱モデルが使われる）

## 同梱物の事実（v1.2.1 の実機ビルドで確認済み）

DMG 内 `Speaky.app/Contents/Resources/backend-template/` に以下が**すべて同梱**（初回 DL 不要）:

- LLM: **Qwen 2.5 1.5B**（`qwen2.5:1.5b`。`ollama-data/blobs/` + manifest）。
  v1.2.1 のビルドで、同梱が `qwen2.5/1.5b` だけ（`ollama-data` 940MB）であることを確認済み（v1.1.0 までは `llama3.2:3b`、v1.2.0 は `llama3.2:1b`）。
  同梱を差し替えた理由と、既存ユーザーのモデルが消えない理由は下の「同梱 LLM」節を参照。
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
- **同梱 LLM モデルの同期も version gate と独立**（startOllama 内 `ensureBundledOllamaModel`。
  template の blob / manifest が userData に揃っているかを stat で確認し、欠けていれば
  `syncOllamaModels`（**足すだけで消さない**）を呼ぶ）。オフライン起動の保証を
  「リリースのたびに人間が version を上げること」に依存させないため。
  version bump は引き続き必要（backend コード / Whisper の再同期はそちらが唯一の入口）。
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
- **設定スキーマ版** `SETTINGS_SCHEMA_VERSION`（`frontend/src/storage/settings.ts`）= **4**。
  デフォルト値を変えて既存ユーザーにも適用したいときは版を上げて移行処理を足す。
  キーが増えるだけなら版は上げない（merge が欠落を埋める）。上げるのは
  「既存の保存値を書き換える必要がある」ときだけ。移行が走ったら**その場で保存する**
  （`needsMigration → saveSettings`）。これが無いと冪等でない移行が毎起動走る。
  - v1→v2: 無音間隔 5000→1500 / Whisper medium→small（旧デフォルトのままの人だけ）
  - v2→v3: `modelProfile` の新設。**`gemma2:2b` を選んでいた人だけ** `'standard'` を
    明示的に書き込んで据え置く（'auto' だと small に落ちて挙動が変わるため）。
  - v3→v4: **`llama3.2:3b`（v1.1.0 の既定）を保存している人だけ**を同梱の `qwen2.5:1.5b` へ
    一度だけ切り替え、通知を 1 回出す（3B は日本語訳が不安定だったため。自分で選んだ 3B とは
    区別できないが、メンテナ判断で対象にした）。**ローダーでは切り替えない**:
    同梱モデルが入っているかは backend に聞くまで分からない（自前の Ollama を再利用すると
    `ensureBundledOllamaModel` が走らず同梱モデルが届かない = 切り替えると毎ターン MODEL_NOT_FOUND）。
    ローダーは `bundledLlmMigration = 'pending'` を付けて版を上げるだけで、
    `utils/bundled-llm-migration.ts` が起動後に `/api/models/ollama` を見て決める
    （起動は `components/BundledLlmMigrationNotice.vue`、文言は `utils/bundled-llm-migration-notice.ts`。日本語訳が安定し速くなる / 返答が短くなり単語カードは出ない /
    戻し方を伝え、**添削には触れない**（3B でも実質出ておらず、出るかは backend 次第のため。テストが固定）:
    - 同梱モデルあり かつ backend の既定 = 同梱モデル → 切り替え + `modelProfile='auto'` + 通知（`'notice'`）。閉じたら `'idle'`
    - 一覧に `llama3.2:3b` は載っているが同梱モデルなし → **切り替えない・通知も出さない・再確認もしない**（`'idle'`。
      自前 Ollama の人が後で qwen を pull したときに黙って 3B から切り替えないため）
    - API 失敗 / 壊れた応答 / backend の既定が違う（frontend だけ新しい）/ **一覧が空、または `llama3.2:3b` も
      同梱モデルも載っていない** → `'pending'` のまま次回起動で再試行。
      「無い」と言い切って永久に終えてよいのは、一覧がユーザーの使っている Ollama のものだと
      分かる（= 今の 3B が載っている）ときだけ。backend は Ollama が `models` を返さないと空配列にする
    - 設定画面・オンボーディングでモデルを選んだら `'pending'` も `'notice'` も `'idle'` にする（`stores/settings.ts` の `update`）
    - バックアップの取り込みでは `'notice'` を `'idle'` にする（書き出した Mac の出来事なので）。`'pending'` は残す
    - 通知は**左下・サイドバーの幅の内側**に出す（右上は会話画面の「⏹ 会話を終わる」に重なった。右下はアップデート通知）
    - 設定画面の会話モードのバッジは `llmModel` / `modelProfile` の変化を監視して問い合わせ直す
      （`utils/profile-preview-watch.ts`。画面を開いたまま移行で切り替わっても古くならない）
- **会話プロファイル**（`backend/src/services/model-profile.ts`）= `standard` / `small` の 2 段。
  - `small` は 1B〜2B 向け: system prompt を **約 900 → 約 200〜250 トークン**に圧縮
    （会話スタイル節を削除 / レベル説明は該当 1 行だけ / 人格は 1 行 / プロフィール事実は 6 件まで）、
    履歴 10 往復→4 往復、生成予算を約半分、温度を下げ repeat_penalty を上げ、
    **enrich は日本語訳だけ**（単語カードは出さない）。
    **添削はプロファイルに依らず出る**（下の「添削（grammar-check）」節。以前は small だけ添削なしだった）。
  - **`num_ctx` は small でも 4096 のまま**。計測できる実機が無いうちは下げない
    （プロファイル駆動にはしたので、M1 で測ってから下げること）。
  - **small の英語の返答は 2 文で打ち切る**が、**最初の挨拶だけは 3 文まで**
    （`maxOpeningSentences`）。2 文で切ると「Hello! How are you today?」だけが残り、
    選んだトピックの質問が落ちる。「挨拶 + トピックの質問の 2 文ちょうど」を
    プロンプトで指示する案は実モデル（qwen2.5:1.5b）でかえって悪化したので採らない。
  - 翻訳（ja→en / en→ja）の stop に **`'\n\n'` を入れない**。出力が空行で始まるモデルは
    1 文字も出さずに止まり、温度 0 では引き直しても訳が空のままになる。2 段落目以降は
    `firstTranslationParagraph` が捨てる（検証に続きを渡さない）。
  - **翻訳出力の取り出しは「曖昧なら弾いて引き直す。曖昧なものは決して通さない」**
    （`services/translation.ts`）。正しい訳を弾いた損は引き直し 1 回ぶんの待ちだけだが、
    間違ったものを通すと学習者は **訳ではないもの（モデルの返事・半分だけの訳）を訳として読む**。
    段落をつなげる / 原文の繰り返しを読み飛ばす / 先頭の段落の文の数で足りるとみなす、
    といった推測はレビューのたびに新しい誤採用が見つかったので全部やめた。推測は足すより消す。
    - en→ja は英文の改行・空行を空白にして **1 段落にしてから** 頼み、その形で検証する
      （`normalizeTranslationSource`）。だから検証の「空行を含む訳は落とす」に例外は無い
      （会話 JSON の `reply_ja` に空行があれば、`reply_en` に空行があっても落として en→ja に回す）。
    - 段落は 1 つだけ選ぶ（前置き・相づち・見出しの段落だけ読み飛ばす。en→ja で日本語を含む
      コロン終わりの段落は、決まった見出しの言い回しに当たらなければ訳の本文として選ぶ）。
      **選んだ段落の後ろに日本語（後ろの段落 / 2 行目）が残れば、文の数によらず必ず弾く**。
      例外は補足の行（行全体が括弧書き / Note: などのメタ説明）だけで、その判定は表示前に
      補足を落とす `sanitizeJapaneseTranslation` と同じ `isTranslationNoteLine` 1 つに揃えてある。
      以前の「訳の文末の数が英文の文の数に足りれば通す」は、数が偶然そろう半分の訳を通していた。
    - `done_reason === 'length'`（生成上限で切れた）なら、どこで切れていても弾く
      （切れた先に訳の続きがあったかもしれない）。
  - 日本語訳の検証（`shared/text-guards.ts`）の長さ上限は **max(18, 英文 × 0.9)**。
    下限 12 は「Wow.」→「わあ、それはすごいですね！」を落としていた。20 にすると
    較正ケース（ちょうど 20 文字の崩れた訳）が通るので 18。
  - 検証の latin-heavy（ラテン文字 > かな漢字の半分）は、**英文で名前らしく書かれた語を数えない**
    （`sourceProperNouns`: 2 文字目以降に大文字がある iPhone / NBA、または文頭でない大文字始まりの語。
    I / OK / 間投詞 / 曜日・月・言語名はストップリストで除く）。これが無いと「Netflixは好き？」のような
    短い英文の訳は長さ上限と両立せず決して通らなかった。除外は英文に語全体で現れる語だけなので、
    英文が分からない呼び出し（en が空）や原文の繰り返し・ローマ字は従来どおり落ちる。
    文頭の固有名詞（「Netflix is fun.」の Netflix）は除外されない（厳しい側に倒している）。
  - 選択は設定の `modelProfile`（`auto` / `standard` / `small`、既定 `auto`）。
    `auto` は **タグのパラメータ数**から推定（2B 以下 = small）。ファミリー部分は見ない
    （`llama3.2` の "3.2" を拾うと 1B が small にならない）。
  - 推定は backend が出典。解決結果は `/api/chat` のレスポンスと SSE の `meta` に
    `profile` として載る（会話画面の「🪶 軽量モード」バッジの根拠）。
  - **設定画面のバッジも backend に聞く**（`POST /api/model-profile/preview`、
    機能名 `model-profile-preview`）。v1.1.0 はここだけ frontend が
    `resolveProfileLevel()` を自分で呼んで推測していた。Electron は
    「frontend だけ新しい」組み合わせが普通に起こるので、プロファイル未対応かつ
    allowlist が完全一致の旧 backend に対して「軽量モードで動作中」と表示し、
    しかもその backend は `llama3.2:1b` を黙って既定モデルへ差し替えていた
    （= モデルもモードも両方嘘）。機能申告が無い / 応答しない場合は
    **何も言い切らず「確認できません」と出す**こと。
    プレビューは `modelAccepted: false` で「差し替える」ことも申告する。
  - 設定画面で **LLM を選び直したら `modelProfile` を `'auto'` に戻す**。
    v3 移行が `gemma2:2b` の人に書き込んだ `'standard'` が残り続けると、
    その人が 1B に乗り換えたときに「小さいモデルに長いプロンプト」という、
    この一連の作業がまさに潰そうとしている組み合わせに静かに戻る。
- **同梱 LLM は `qwen2.5:1.5b` ただ 1 つ**（v1.1.0 までは `llama3.2:3b`、v1.2.0 は `llama3.2:1b`）。
  - **1B → Qwen 2.5 1.5B にした理由**: M1 MacBook Air の実機で、1B の日本語訳の欄に
    英語・ローマ字・崩れた文字列が出た。実 backend + 実 Ollama で各シナリオ 12 試行の評価
    （左が `llama3.2:1b`、右が `qwen2.5:1.5b`）:
    - 取得サイズ: 1.32GB → 0.99GB
    - 日本語訳の欄が日本語でない（60 回中）: 28 → **0**
    - 英→日の意味が正しい（12 回中）: 0 → **8**
    - 日本語入力を正しく英語にした（12 回中）: 1 → **10**
    - 生成速度（ビルド機）: 91 → 106 tok/s

    **Llama 3.2 は日本語を公式にサポートしていない**。プロンプト調整でも 1B は改善しなかった。
    小さく・速く・日本語が安定するので、日本語訳を必ず出すこのアプリには Qwen が合う。
    ライセンスも Meta Llama Community License → Apache-2.0 になった（README の表を参照）。

  - **`llama3.2:1b` は取得の選択肢から外した**（カタログの `offerForDownload: false`）。
    日本語訳を約束できないモデルをこちらから薦めないため。ただし **allowlist には残る**
    （ファミリー判定）ので、入っている人はそのまま選べるし既定へ黙って落とされない。
    カタログにも残してあり、インストール済み一覧に「非推奨」の説明が出る。
  - **`llama3.2:1b` の人向けの設定移行は入れていない**。v1.2.0 は一般公開していない
    （テスト機にしか無い）ため。テスト機は検証チェックリストの ⑿ で手動で戻す。
  - **`RECOMMENDED_DOWNLOAD_LLM_MODEL` は廃止した**（`feat/grammar-correction`）。
    評価で `llama3.2:3b` の日本語訳は同梱の `qwen2.5:1.5b` より良くならず（Llama 3.2 は日本語非対応）、
    添削もプロファイルに依らず出るようになったので、取得を薦める根拠が残っていない。
    別のモデルを薦め直すのではなく **薦めること自体をやめた**（オンボーディングの案内と設定画面の
    バナーも削除。取得フォームの初期値は同梱モデル）。何かを薦め直すなら先に計測すること。
    カタログの説明からも「精度重視のおすすめ」「高品質」を外し、9B / 14B は「精度は未計測」と書いた。
  - 出典は `backend/src/shared/llm-models.ts` の `BUNDLED_LLM_MODEL`。
    `DEFAULT_LLM_MODEL` も frontend の `DEFAULT_SETTINGS.llmModel` もここを読む。
    `scripts/prep-llama-model.mjs` だけは .mjs なので import できず二重化しているが、
    **ズレたら `shared/llm-models.test.ts` が落とす**（prep スクリプトを読んで照合している）。
  - **既定は必ず同梱物であること**。v1.1.0 直前は「12GB 未満なら 1B を自動選択」なのに
    同梱が 3B だけで、オフラインの 8GB 機は初回起動が行き止まりになっていた
    （選ばれたモデルが取得できず「次へ」が押せない）。完全ローカルが売りである以上、
    ここが崩れると製品の一番の主張が嘘になる。
  - **副作用**: 素の初回インストールは自動判定で `small` プロファイルになり、
    **単語カードが出ない**（日本語訳と添削は出る）。意図した結果で、オンボーディング・設定画面・
    会話画面のバッジで明示する。追加ダウンロードはどの画面も薦めない。
  - **オンボーディングの自動選択は `frontend/src/utils/onboarding-model.ts`**。
    不変条件は「**インストール済みのモデルが 1 つでもあれば必ずその中から選ぶ**」。
    メモリに余裕があっても未取得の 3B は選択状態にしない（オフラインで先へ進めなくなるため）し、
    取得の案内もしない（入っていれば選ぶだけ）。選択肢もカタログから作る（手書きしない）。
  - ⚠️ **アップグレードで既存ユーザーの 3B を消さないこと**（v1.2.0 のテスト機に入っている
    旧同梱の `llama3.2:1b` も同じ扱いで、消さない）。
    `electron/src/main.ts` の `syncOllamaModels` は **追加のみで削除しない**設計
    （blob は content-addressed なので「無ければコピー / サイズ違いなら上書き」、
    manifest は template 側のものだけ上書き）。ここに「template に無いものを消す」
    掃除を足すと、アップグレードした瞬間に使用中の 3B が消えて MODEL_NOT_FOUND になる。
    Whisper 側（`syncRuntime`）がユーザー DL 分を退避 → 復元しているのと同じ意図を、
    こちらは「そもそも消さない」形で満たしている。`ollama-data` は毎回 rmSync する
    `backend-runtime` の**外**（`userData/ollama-data`）にあるので巻き込まれない。
  - ビルド機の `electron/build-resources/ollama-data/` に前のモデルが残ると DMG が太る。
    prep スクリプトが毎回 `pruneStaleVendored()` で今回の同梱物以外を消す（冪等）。

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
  日本語訳 / 単語は `done` の後に `enrich` イベントで、添削はその後の `feedback` イベントで
  後追いする（マイクはどちらも待たない。`enrich` の `feedback` は常に null）。
  フロントは `/api/health` の `features` を**肯定的に確認**したときだけ新経路を使う
  （Electron は frontend を app bundle から、backend を userData から読むため
  「frontend だけが新しい」組み合わせが普通に起こる）。
  非ストリーミング経路は**フォールバックとして残してある**ので削らないこと。
- **クライアント側の締め切り**は 2 系統ある。どちらも「半開きソケット（スリープ復帰）」
  対策で、backend が死んでいると backend の予算は効かないために要る。
  - ストリーミング: ヘッダーまで 180 秒 / ヘッダー後は無通信 45 秒（keepalive が 10 秒間隔）
  - 非ストリーミング: **値は `backend/src/shared/request-budget.ts` が唯一の出典**。
    手で置かず、backend のリトライ梯子から**計算**する（frontend もこのファイルを import する）。
    現在値: `/api/chat` **350 秒** / `/api/chat/opening` **330 秒** / `/api/chat/enrich` **230 秒** /
    `/api/extract-facts` **150 秒** / `/api/summarize` **90 秒** / `/api/transcribe` **210 秒**。
    （en→ja 翻訳が「検証 → 弾いたら 1 回だけ引き直す」の 2 回、添削が 20 秒 × 1 回なので、
    `/api/chat` は 90×2 + 翻訳 60×2 + 添削 20 = 320 秒、enrich は 60 + 60×2 + 20 = 200 秒、
    opening は添削が無いので 90×2 + 60×2 = 300 秒が backend の最悪値）
  - ⚠️ **クライアントの締め切りは backend の最悪値より必ず長いこと**。v1.1.0 は
    手置きの 120 / 90 秒で、backend の梯子（`/api/chat` は 90×2 + 翻訳 60 = **240 秒**、
    enrich と extract-facts は **120 秒**、日本語入力経路は **120 秒でクライアントと同値**）
    より短かった。そうなると「遅いだけで健全なターン」がクライアント側で打ち切られて
    通信エラーになり、会話ループの連続失敗カウンタ（3 回で会話停止）を積み上げる。
    リトライ回数や first-token 予算を触ったら request-budget.ts も直すこと。
    ズレは `shared/request-budget.test.ts` が落とす（実際の attempts 配列の長さも見ている）。
  - ⚠️ **締め切り切れとユーザーの中断はどちらも AbortError**。区別せずに変換すると
    「会話を終えただけ」がエラー表示になる（`fetchWithDeadline` が区別している）。
  - **転写にも締め切りがある**（v1.1.0 まで唯一存在しなかった）。backend 側は
    `TRANSCRIBE_BUDGET_MS`（180 秒。ffmpeg + 最大 3 パス分）で、超えたら 504 + `TIMEOUT`。
    クライアント側は 210 秒 + `beginTranscribe()` の signal（会話終了で切れる）。
    ⚠️ **whisper の子プロセス自体は kill できない**（nodejs-whisper が `shelljs.exec` の
    ChildProcess を外に出さない）。畳めるのは「待つのをやめる」ところまで。
    子まで確実に殺すには whisper-cli を自前で spawn する必要があり、実機検証込みの別作業。
- **巨大バイナリ/モデルは `.gitignore` 済み**（`electron/build-resources/`、`backend/vendor/node_modules/`、`dist-app/`）。prep スクリプトでビルド時に用意する。

## 添削（grammar-check）

`feat/grammar-correction` で入った。**両プロファイルで出る**。実モデル評価で、以前の添削
（会話 JSON / enrich の JSON にモデルが書く feedback）はどのプロファイルでも実質出ず、
説明文は英語・崩れた日本語・中国語だった。そこで「モデルに書かせる」のをやめ、
**モデルには文を直させるだけ、説明はこちらの固定テンプレート**にした。

- **呼び出し**（`backend/src/services/grammar-check.ts`）: 研究で選んだ V6 そのまま。
  system「Fix the grammar of the English sentence inside <said></said>, spoken by a Japanese learner.
  Change as few words as possible. If it is already correct, repeat it unchanged. Output only the sentence.」
  に続けて 8 往復の例示（`SHOTS8_ECHO`。正しい文をそのまま繰り返す例が 5 つ）と `<said>発話</said>`。
  温度 0 / seed 0 / `num_predict` 60 / `num_ctx` はプロファイル / プレーンテキスト /
  stop = `<said>` `</said>` 改行。**`repeat_penalty: 1.0` を明示**（既定の 1.1 は「正しい文を写す」ことを罰する）。
  プロンプト・例示・デコード設定は `grammar-check.test.ts` が一字一句固定している。
- **フィルタと説明**（`backend/src/shared/correction-guard.ts`）: 研究のプロトタイプ `filter.mjs` の忠実な移植。
  backend と frontend（履歴画面の再検証）が **同じ 1 つの実装**を import するので `shared/` に置いてある
  （node/DOM の API を使わない純粋関数だけ。frontend の HistoryDetail チャンクが 6.2 → 25.4 kB（+19 kB / gzip +7 kB）になった。他のチャンクは変わらない）。
  `guard()` が差分を単語単位で見て、閉じた語類の変更・同じ語の語形変化・語順の入れ替え以外
  （言い換え・数字・固有名詞・カジュアルな言い方への手出し・直しすぎ・文の種類の変更）を捨てる。
  `classify()` が変更を分類し、**全部の変更に日本語テンプレートがあるときだけ**説明を返す。
  表示するのは「フィルタが受け入れ、かつ全変更がテンプレートで説明できた」ときだけ。
  - 移植の正しさは `services/correction-guard.test.ts` が固定: 140 件のラベル付き発話 × 2 モデルの記録済み出力
    （`services/fixtures/grammar-correction-research.json`。研究の `filter.mjs` で生成）に対して、
    判定・理由・カテゴリ・説明文が研究時と **1 件残らず一致**すること。**ルールを変えたらここが落ちる**ので、
    落ちたら数字を測り直すこと。
  - 移植で変えたのは 1 点だけ: テンプレートの差し込み位置に入る語が無い（プロトタイプでは例外か
    「undefined」表示）場合は説明できない変更として扱う。記録済みの 280 件はこの経路を通らない。
- **何も出さない条件**: 3 語未満 / 25 語超 / 日本語や英日混在（非ラテン文字）/ 呼び出しの失敗・
  タイムアウト（20 秒）・中断・空 / フィルタが拒否 / 説明できない変更がある。
  失敗は **error イベントにもユーザーに見えるエラーにもしない**（警告ログだけ。中断はログも出さない）。
- **どこで走るか**:
  - ストリーミング（`routes/chat-stream.ts`）: `done` の後、**日本語訳 → `enrich` イベント → 添削 →
    `feedback` イベント**（`{type:'feedback', feedback:{user_said, corrected, explanation}}`）。
    マイクは読み上げ終わりで開くので待たない。次のターンを始めるとクライアントがストリームを切り、
    その signal が実行中の添削も Ollama まで止める（1 枠を次のターンに譲る）。
  - `POST /api/chat/enrich`（再取得）も同じ順で添削を返す。
  - 非ストリーミング `/api/chat`: **添削の結果か null だけ**を返す（モデルが JSON に書いた feedback は
    両プロファイルで捨てる）。こちらは応答の前に走るので、フォールバック経路だけ添削 1 回ぶん遅れる。
  - opening（挨拶）と日本語入力の翻訳ターンは添削しない。
- **フロント**: `/api/health` の features に **`grammar-check`** があるときだけ添削を表示する
  （無い backend の feedback はモデルが書いたもの）。ストリームの `feedback` はリデューサの `feedback`
  効果 → `applyFeedback` で AI メッセージの `feedback` に保存（永続化前に届いたら保存後に反映）。
  `applyEnrichment` は添削を **null で上書きしない**（別イベントで先に保存された添削を消さないため）。
  - **履歴画面は保存済みの添削を表示のたびに検証し直す**（`frontend/src/utils/stored-feedback.ts`）。
    以前のバージョンはモデルが書いた添削（説明が英語 / 崩れた日本語 / 中国語）を検証せずに保存していて、
    インポートしたバックアップからも戻ってくるので、一度きりの削除ではなく表示時に判定する。
    **直前のユーザー行の発話**（保存された引用 `userSaid` ではない）と直した文を `recheckCorrection` に通し、
    さらに保存された `userSaid` が発話と（trim して）一致することを求める。通れば **今のテンプレートで作り直した説明**を出す
    （保存された説明文も引用も使わない。「言ったこと」の欄は実際の発話）。通らなければ出さない。直前のユーザー行が無い行も出さない。
    ⚠️ 引用で判定してはいけない: 以前の `user_said` もモデルが自由に書いていて、正しく「My sister is a nurse.」と
    言った人に「My sister is nurse.」という引用を作ると組がフィルタを通り、**言ってもいない間違い**が冠詞の説明付きで出る
    （長い発話の一部だけを引用した場合も同じ）。grammar-check の `user_said` は発話の trim なので一致条件で落ちない。
    表示は `displayFeedbackMap` が 1 回の走査で作る。日本語訳の再取得では、同じ判定で通らない添削を
    「無い」扱いにして検証済みの添削で置き換える（`retryFeedbackPatch`）。判定は決定的なので、
    grammar-check が表示した添削はテンプレートを変えない限り必ず同じ説明で通る（fixture のテストが固定）。
    会話画面はこのセッションで作った行（検証済み）しか出さないので再検証しない。
  - **「添削は出ます」という文言も grammar-check の申告に揃える**（`frontend/src/utils/correction-wording.ts`）。
    会話画面の 🪶 バッジのツールチップ・設定画面・オンボーディングは、申告の無い backend
    （= 添削が 1 件も出ない）では日本語訳にしか触れない。
- **予算**: `request-budget.ts` の `grammarCheck` = 20 秒 × 1 回。`/api/chat` と `/api/chat/enrich` の
  最悪値に足してあり、クライアント締め切りは 330 → **350 秒** / 210 → **230 秒** に再計算された。
- **採用の関門**（研究時に決めたもの）: 正しい文を書き換えて表示 ≤ 3% / 本物の誤りを直して表示 ≥ 50% /
  説明はこちらが管理する文面だけ / マイクの再開を遅らせない。
- **研究の数字**（V6 + 厳格な表示方針。dev 76 件 + held-out 64 件を合算。ビルド機 Apple M5）:

  |                                     | qwen2.5:1.5b | llama3.2:3b |
  | ----------------------------------- | ------------ | ----------- |
  | 正しい文を書き換えて表示（78 件中） | 0            | 0           |
  | 誤りを直して表示（62 件中）         | 49           | 49          |
  | 間違ったカテゴリ / 説明の表示       | 0            | 0           |
  | 追加の呼び出し（中央値）            | 204 ms       | 336 ms      |

  ⚠️ **0/78 は「0%」ではない**。95% 信頼区間の上限は約 3.8%（3/n 則）で、関門の 3% をまだ証明できていない。
  評価したモデルは `qwen2.5:1.5b` と `llama3.2:3b` だけ（gemma2 などは未計測。フィルタは同じく効く）。

- **統合検証の結果**（このブランチの実 backend + 同梱 Ollama v0.30.4 を記録用プロキシ越しに、140 件 × 3 経路 × 2 モデル。
  ビルド機 Apple M5 / 2026-09-13。基底は `fix/small-model-output-quality` の `e988fd3` で、
  `8b0d9e4` / `d713745`（翻訳の取り出し方針の変更）を merge する **前**に計測した。添削の数字はこの変更に
  依存しないが、下の「訳 220 ms」「enrich 1821 ms」など翻訳側の時間は merge 前の値）:

  | モデル / 経路                   | 正しい文の書き換え | 誤りを直して表示 | 間違った説明 | 研究と同一 | 経路の失敗 |
  | ------------------------------- | ------------------ | ---------------- | ------------ | ---------- | ---------- |
  | qwen2.5:1.5b ストリーミング     | 0/78               | 49/62            | 0            | 140/140    | 0          |
  | qwen2.5:1.5b `/api/chat/enrich` | 0/78               | 49/62            | 0            | 140/140    | 0          |
  | qwen2.5:1.5b `/api/chat`        | 0/78               | 43/62            | 0            | 134/140    | 8          |
  | llama3.2:3b ストリーミング      | 0/78               | 49/62            | 0            | 140/140    | 0          |
  | llama3.2:3b `/api/chat/enrich`  | 0/78               | 49/62            | 0            | 140/140    | 0          |
  | llama3.2:3b `/api/chat`         | 0/78               | 49/62            | 0            | 140/140    | 0          |
  - qwen の `/api/chat` の 8 件は **返答そのもの**が 502（small の JSON 契約に `{}` を 2 回返した）で、
    添削までたどり着いていない。返答が返った 132 件は研究と同一。フォールバック経路の既知の弱さで、このブランチの変更ではない。
  - 添削 1 回の実時間（プロキシで計測、中央値 / p90）: qwen **166 / 202 ms**、llama **265 / 333 ms**。
    同じターンの他の LLM 時間に対して qwen は返答 244 + 訳 220 ms に +36%、llama は返答 684 + enrich 1821 ms に +11%
    （**ビルド機での相対値**。M1 では絶対値が数倍になる）。ストリーミングではマイクの再開を遅らせない。
  - `feedback` イベントが `done` から届くまで: qwen 中央値 396 ms（最大 559）、llama **2228 ms**（最大 3653。
    標準プロファイルは先に enrich の JSON を作るため）。
  - **中断**: 添削の実行中にストリームを切ると、backend が Ollama へのリクエストを完了前に閉じることをプロキシで確認
    （届いた添削は qwen 1/49（切る前に終わった）、llama 0/49）。`done` の N ms 後に次のターンを始めた場合に失われる添削:
    qwen 0.5 秒 4/49・1 秒以上 0/49、llama 1 秒以下 49/49・1.5 秒 48/49・2.5 秒 13/49。
    実際の次のターンは「返答の残りの読み上げ（2.5 語/秒で見積もり）+ 発話 1 秒 + 無音 1.5 秒」より前には始まらないので、
    その見積もりでは **両モデルとも 0/49**（余裕の最小 3.3 秒 / 4.0 秒）。標準プロファイルで「ごく短い返答 + 即答」だと失われうる。

- **単語カード**（標準プロファイル）: 意味の検証に加えて **見出し語が英語であること**も求める（`sanitizeVocabulary`）。
  統合検証で llama3.2:3b の単語は大半が落ちた（backend ログで 692 件。英語の言い換え・ローマ字）。20 ターンの生出力を
  目で見ると、意味の規則だけで残った 7 件のうち 6 件は意味が中国語 / 崩れた日本語で、見出し語も「我是」「日本」のように
  英語ではなかった（見出し語の規則で落ち、残るのは `ride-sharing → タクシーサービス` だけ）。
  **標準プロファイルでも単語カードはほとんど出ない**のが実態。
- **正しい直しなのに今は表示していないもの = 次に足すテンプレートの候補**（足したら fixture のテストを
  書き換え、数字を測り直すこと）:
  - `I play the tennis every Sunday.` → `play tennis`（スポーツに the を付けない）
  - `Does he likes baseball?` → `Does he like`（does の後は原形）
  - `Why you are sad?` → `Why are you sad?`（疑問文の語順。文頭の疑問詞の後の be 動詞の倒置）
  - `My friend have two child.` → `has two children`（不規則複数形。今はフィルタが内容語の差し替えとして捨てる）
  - `I don't know where is the station.` → `where the station is`（間接疑問の語順。be 動詞の移動にテンプレートが無い）
  - 5 件とも **両モデルで同じ直しを出していて、どれも正しい**。今は 4 件が「説明できない（unknown）」、
    `children` の 1 件がフィルタの拒否で隠れている

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
- `prep:vendor:llama-model`（electron）= **Qwen 2.5 1.5B**（`qwen2.5:1.5b`）を ollama pull して vendor。
  スクリプト名・ファイル名（`scripts/prep-llama-model.mjs`）はビルドチェーンを触らないために
  据え置いている（中身は Llama 専用ではない）。
  今回の同梱物が参照していない blob / manifest は毎回掃除する（`pruneStaleVendored`）。
  掃除は **タグ違い（`llama3.2/3b`）だけでなくファミリー違い（`llama3.2/` ごと）も消す**。
  ビルド機には `llama3.2/1b` が残っているので、次の vendor で `llama3.2/` と
  その blob が消えることを、関数を抜き出して模擬 vendor ディレクトリで実行して確認済み
  （共有 blob は残る / 2 回目は何もしない）。
  ⚠️ **`BUNDLED_LLM_MODEL` と必ず一致させること**（一致は backend のテストが検証）。
- `prep:vendor:ollama-binary`（electron）= Ollama v0.30.4 バイナリを vendor（symlink 実ファイル化込み）
- `verify:arm64`（backend / 実体は `scripts/verify-arm64.mjs`）= 同梱バイナリ検証
  - arm64 Mach-O であること（`file`）に加え、**whisper-cli に i8mm / bf16 / SME 命令が
    含まれないこと**を `otool -tV` で検証する（M1 で SIGILL するビルドの唯一の防波堤。
    署名・公証・staple は素通りするので実機まで誰も気づけない）。
    FAIL したら `npm run prep:vendor:whisper-cli -w backend` で作り直す。

## 動作要件（README と揃える）

- Apple Silicon / メモリ **8GB 以上**（16GB 以上推奨）
- 同梱の `qwen2.5:1.5b` +「軽量モード」がどの Mac でも最初に動く組み合わせ。
  オンボーディングは `/api/health` の `totalMemoryBytes` を見る（`os.totalmem()` は
  backend でしか取れない。ブラウザの `navigator.deviceMemory` は最大 8 に丸められる）。
  - **12GB 未満**: 同梱の軽量モデルを選んでおく
  - **12GB 以上**: 3B が入っていればそれを選ぶ。入っていなければ
    **選択は同梱の 1.5B のまま**（取得は案内しない）
  - どちらの場合も **インストール済みの中からしか選ばない**

## 完了済みの主な機能（〜v0.0.5）

配布版 DMG（Ollama/LLM/Whisper 同梱、初回スプラッシュ）/ ふんわりパステル UI リデザイン + アプリアイコン + マスコット（ヘッドホンキャラ）/ ライト・ダーク明示切替 + 3テーマ（mint/lavender/peach）/ AI 音声選択・速度/ピッチ・性格プリセット5種 / 日本語訳トグル（必ず表示保証）/ 無音間隔（初期1.5秒・最大15秒）/ カスタムトピック / 特徴アイコン / 使用中バッジ整合 / 録音テスト修正（ffmpeg 事前変換）/ 会話 UI 修正 / Dev tools 非表示 / 離脱時の会話終了。

## バックログ（任意・未着手）

- 署名・公証ビルドの**実機検証**（`feat/codesign-notarize` ブランチ）: `npm run dist` で署名・公証付き DMG が生成され、別 Mac で `xattr -cr` 無しで起動できることを確認
- **同梱 dylib/.so の Developer ID 再署名 → `disable-library-validation` を外す**（entitlements 緩和の解消。今は llama.cpp/whisper.cpp/ollama 由来の他チーム署名 dylib があるため許容）
- 応答速度の高速化（ストリーミング TTS 等。検討のみ）
- Web アプリ化（検討したが完全ローカルの売りが消えるため見送り）

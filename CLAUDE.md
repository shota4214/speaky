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
   （`npm test` = frontend → backend の順に vitest。**frontend 281 件 / backend 484 件**）
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
- 履歴詳細画面の日本語訳の再取得、**全ての HTTP 呼び出しにクライアント締め切り**
  （転写を含む。予算は `backend/src/shared/request-budget.ts` が唯一の出典）
- **同梱 LLM を Llama 3.2 3B → 1B に変更**（DMG 約 2.67GB → 約 1.9GB(v1.2.0 実測)）
- **同梱 LLM を `llama3.2:1b` → `qwen2.5:1.5b` に変更**（`feat/bundle-qwen2.5-1.5b`。
  M1 実機で 1B の日本語訳が崩れたため。理由と数字は下の「同梱 LLM」節。
  DMG は **約 1.6GB の見積もり・未実測**（モデルが約 0.33GB 小さくなった分を引いただけ。
  次のビルド後に実測値へ直すこと）)
- 設定画面の「会話モード」バッジを backend への問い合わせ結果に変更

### 残っているのは 1 つだけ: リリースビルド + **M1 MacBook Air 実機検証**

コードは完成していて全検証が pass しているが、**実機で確かめていない**。

```bash
. ~/.nvm/nvm.sh && nvm use 22
# ⚠️ 最初に root と electron の package.json を **v1.2.0 より上**に bump すること。
#    このリリースも **version bump が必須**。同梱 LLM を llama3.2:1b → qwen2.5:1.5b に
#    差し替えた。同梱モデルの blob / manifest 自体は ensureBundledOllamaModel が
#    version gate と独立に足すが、既定モデル（= BUNDLED_LLM_MODEL）とカタログは
#    **backend コード**に入っていて、backend の再同期は version.json の app version で
#    gate されている。据え置くと v1.2.0 のテスト機では backend が旧コードのまま
#    （既定 = llama3.2:1b）で動く。
npm run prep:vendor:whisper-cli -w backend   # -DGGML_NATIVE=OFF で作り直す
npm run prep:vendor:llama-model -w electron  # qwen2.5:1.5b を vendor + 旧 llama3.2 ファミリーの残骸を掃除
npm run verify:arm64 -w backend              # ここが OK になってから dist
npm run dist                                 # DMG ~1.6GB(見積もり・未実測)、5〜10分 + 公証で計 15〜40分

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
   「3B を取得すると添削が出ます」という案内は出るが、**選択は同梱の `qwen2.5:1.5b` のまま**で、
   案内を無視して「次へ」が押せる（案内が行き止まりを作らない）。
5. `qwen2.5:1.5b` で会話が成立する（軽量モード）:
   返答が 1〜2 文に収まる（最初の挨拶だけは 3 文まで。トピックの質問が入っていること）/ 日本語訳が必ず出る / **添削と単語カードは出ない**。
   「出ないのは壊れているからではない」ことが会話画面の 🪶 バッジで分かる。
   **日本語訳の欄が日本語である**（英語・ローマ字・崩れた文字列が出ない。v1.2.0 の 1B で実際に出た）。
   日本語で話しかけたときに、それが英語に直って会話が続く。
6. 最初の音が出るまでの時間（ストリーミングの効き）と、ターン間の待ち時間
7. 設定画面の「会話モード」バッジが **`(backend 確認済み)` 付き**で表示され、
   会話画面のバッジと一致する（推測ではなく `/api/model-profile/preview` の結果）
8. **アップグレードで既存ユーザーの 3B が消えない**（`~/Library/Application Support/electron`
   を **消さずに** 上書き起動）:
   - `llama3.2:3b` を選んで保存していた人が、そのまま 3B で会話できる
   - `ls "$HOME/Library/Application Support/electron/ollama-data/models/manifests/registry.ollama.ai/library/"`
     に `qwen2.5`（中身は `1.5b`）と `llama3.2`（中身は既存の `3b`。v1.2.0 のテスト機なら `1b` も）の
     両方がある（同期は足すだけで、旧同梱物もユーザーの 3B も消さない）
   - `gemma2:2b` を選んでいた人が **標準モードのまま**である（設定スキーマ v3 の移行）
   - 設定画面で LLM を選び直すと、会話モードの固定が「自動」に戻る
9. **オンラインで 3B を取得すると標準モードに戻る**: 設定画面 →「+ 取得」→ `llama3.2:3b` →
   選択 → バッジが「標準モードで動作します（backend 確認済み）」になり、添削と単語カードが出る
10. スリープ復帰直後のターンが固まらない:
    - 会話ターン（`/api/chat`）はクライアント締め切り **330 秒**で必ず畳まれる
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

## 同梱物の事実（LLM 以外は実機ビルドで確認済み）

DMG 内 `Speaky.app/Contents/Resources/backend-template/` に以下が**すべて同梱**（初回 DL 不要）:

- LLM: **Qwen 2.5 1.5B**（`qwen2.5:1.5b`。`ollama-data/blobs/` + manifest）。
  **次のビルドで実機確認が必要**（v1.1.0 までは `llama3.2:3b`、v1.2.0 は `llama3.2:1b` を同梱して実機確認済み）。
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
  - ⚠️ **`RECOMMENDED_DOWNLOAD_LLM_MODEL`（= `llama3.2:3b`）は据え置いているが要計測**。
    同じ評価で 3B も日本語訳が不安定だった（Llama 3.2 は日本語非対応）。12GB 以上の Mac に
    薦めるモデルとして妥当かは、リリース前に別途計測して決めること。
  - 出典は `backend/src/shared/llm-models.ts` の `BUNDLED_LLM_MODEL`。
    `DEFAULT_LLM_MODEL` も frontend の `DEFAULT_SETTINGS.llmModel` もここを読む。
    `scripts/prep-llama-model.mjs` だけは .mjs なので import できず二重化しているが、
    **ズレたら `shared/llm-models.test.ts` が落とす**（prep スクリプトを読んで照合している）。
  - **既定は必ず同梱物であること**。v1.1.0 直前は「12GB 未満なら 1B を自動選択」なのに
    同梱が 3B だけで、オフラインの 8GB 機は初回起動が行き止まりになっていた
    （選ばれたモデルが取得できず「次へ」が押せない）。完全ローカルが売りである以上、
    ここが崩れると製品の一番の主張が嘘になる。
  - **副作用**: 素の初回インストールは自動判定で `small` プロファイルになり、
    **添削と単語カードが出ない**。意図した結果で、オンボーディングと設定画面の両方で
    明示し、メモリ 12GB 以上には `RECOMMENDED_DOWNLOAD_LLM_MODEL`（= `llama3.2:3b`）の
    取得を案内する。取得すれば標準モードに戻る。
  - **オンボーディングの自動選択は `frontend/src/utils/onboarding-model.ts`**。
    不変条件は「**インストール済みのモデルが 1 つでもあれば必ずその中から選ぶ**」。
    薦めるのと選ぶのは別で、メモリに余裕があっても未取得の 3B は選択状態にしない
    （オフラインで先へ進めなくなるため）。選択肢もカタログから作る（手書きしない）。
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
  日本語訳 / 添削 / 単語は `done` の後に `enrich` イベントで後追いする（マイクは待たない）。
  フロントは `/api/health` の `features` を**肯定的に確認**したときだけ新経路を使う
  （Electron は frontend を app bundle から、backend を userData から読むため
  「frontend だけが新しい」組み合わせが普通に起こる）。
  非ストリーミング経路は**フォールバックとして残してある**ので削らないこと。
- **クライアント側の締め切り**は 2 系統ある。どちらも「半開きソケット（スリープ復帰）」
  対策で、backend が死んでいると backend の予算は効かないために要る。
  - ストリーミング: ヘッダーまで 180 秒 / ヘッダー後は無通信 45 秒（keepalive が 10 秒間隔）
  - 非ストリーミング: **値は `backend/src/shared/request-budget.ts` が唯一の出典**。
    手で置かず、backend のリトライ梯子から**計算**する（frontend もこのファイルを import する）。
    現在値: `/api/chat` `/api/chat/opening` **330 秒** / `/api/chat/enrich` **210 秒** /
    `/api/extract-facts` **150 秒** / `/api/summarize` **90 秒** / `/api/transcribe` **210 秒**。
    （en→ja 翻訳が「検証 → 弾いたら 1 回だけ引き直す」の 2 回になったため、
    `/api/chat` は 90×2 + 翻訳 60×2 = 300 秒、enrich は 60 + 60×2 = 180 秒が backend の最悪値）
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
    **選択は同梱の 1.5B のまま**にして、3B の取得を案内するだけにする
    （案内でオフラインのユーザーを行き止まりにしない）
  - どちらの場合も **インストール済みの中からしか選ばない**

## 完了済みの主な機能（〜v0.0.5）

配布版 DMG（Ollama/LLM/Whisper 同梱、初回スプラッシュ）/ ふんわりパステル UI リデザイン + アプリアイコン + マスコット（ヘッドホンキャラ）/ ライト・ダーク明示切替 + 3テーマ（mint/lavender/peach）/ AI 音声選択・速度/ピッチ・性格プリセット5種 / 日本語訳トグル（必ず表示保証）/ 無音間隔（初期1.5秒・最大15秒）/ カスタムトピック / 特徴アイコン / 使用中バッジ整合 / 録音テスト修正（ffmpeg 事前変換）/ 会話 UI 修正 / Dev tools 非表示 / 離脱時の会話終了。

## バックログ（任意・未着手）

- 署名・公証ビルドの**実機検証**（`feat/codesign-notarize` ブランチ）: `npm run dist` で署名・公証付き DMG が生成され、別 Mac で `xattr -cr` 無しで起動できることを確認
- **同梱 dylib/.so の Developer ID 再署名 → `disable-library-validation` を外す**（entitlements 緩和の解消。今は llama.cpp/whisper.cpp/ollama 由来の他チーム署名 dylib があるため許容）
- 応答速度の高速化（ストリーミング TTS 等。検討のみ）
- Web アプリ化（検討したが完全ローカルの売りが消えるため見送り）

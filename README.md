# speaky

**ローカル完結型の英会話練習アプリ** 🎤

MacBook(Apple Silicon)上で **Whisper(音声認識)/ Ollama(LLM)/ Web Speech API(音声合成)** を組み合わせ、外部API課金ゼロで AI とハンズフリー英会話練習ができます。

## 主な機能

- 🎙 **ハンズフリー会話**: 一度クリックすれば、無音検出で自動的にターンが回ります
- 📝 **添削**: あなたの英語の間違いを自然に指摘
- 📚 **単語学習**: AIが拾った重要単語を「これ覚えたい」ボタンで保存
- 🇯🇵 **日本語サポート**: 言えない時は日本語で話すと英訳を提示してくれる
- ⚡ **文ができた順に読み上げ**: AI の返答全体を待たず、最初の 1 文から喋り始めます
- 🪶 **軽量モード**: 8GB の Mac でも会話が成立するよう、小さいモデル向けに指示と返答を切り詰めます
- 🧠 **プロフィール自動学習**: 会話の中からAIがあなたのことを覚えていく
- ⭐ **復習リスト**: 保存した単語で集中的に会話練習
- 📚 **履歴**: 30日分の会話を保存、いつでも振り返り可能
- 🎨 **テーマ**: Mint / Lavender / Peach の3種類から選択可能
- 🌙 **ダークモード**: システム連動
- 💾 **エクスポート/インポート**: データのバックアップと移行が可能

## 動作要件

- **macOS** (Apple Silicon, M4/M5 推奨。最低 M1 以上)
- **メモリ 8GB 以上**(16GB 以上推奨)
  - **同梱しているのは Qwen 2.5 1.5B だけ**です。どの Mac でも、ネットに繋がずに
    そのまま会話を始められます(初期設定でこれが選ばれています)
  - **既定は自動で「軽量モード」**(後述)になります。返答は 1〜2 文(最初の挨拶だけは 3 文まで)、日本語訳は必ず出ますが、
    **添削と単語カードは出ません**。1〜2B クラスの添削は誤りが多く、間違った学習材料を
    出すより出さない方がよいと判断しているためです
  - **16GB 以上の Mac**: 設定画面(またはオンボーディング)から `llama3.2:3b`(~2GB)を
    ダウンロードして選ぶと**標準モードに戻り、添削と単語カードが出ます**。
    さらに精度が欲しければ Gemma 2 9B / Qwen 2.5 14B も選べます
- **空き容量 6GB 以上推奨**(DMG 約 1.6GB(見積もり・未実測) + アプリ展開 + ランタイム同期分)
- 配布版(Speaky.dmg)を使う場合: 追加の依存ソフトは不要
  (Qwen 2.5 1.5B + Whisper small + ffmpeg + Ollama ランタイムをすべて同梱)
- ソースからビルドする場合: 「開発者向け」セクションを参照

### なぜ同梱 LLM が Qwen 2.5 1.5B なのか

v1.2.0 では `llama3.2:1b` を同梱していましたが、M1 MacBook Air の実機で
**日本語訳の欄に英語やローマ字、崩れた文字列が出ました**。実際のバックエンドと Ollama で
各シナリオ 12 回ずつ試した評価の結果は次のとおりです。

|                                             | `llama3.2:1b` | `qwen2.5:1.5b` |
| ------------------------------------------- | ------------- | -------------- |
| ダウンロードサイズ                          | 1.32GB        | 0.99GB         |
| 日本語訳の欄が日本語にならなかった(60 回中) | 28            | 0              |
| 英語→日本語の意味が正しかった(12 回中)      | 0             | 8              |
| 日本語の入力を正しく英語にできた(12 回中)   | 1             | 10             |
| 生成速度(ビルド機)                          | 91 tok/s      | 106 tok/s      |

Llama 3.2 は日本語を公式にはサポートしておらず、プロンプトの調整でも 1B は改善しませんでした。
日本語訳を必ず表示するこのアプリには、より小さく速く、日本語が安定する Qwen 2.5 1.5B を選んでいます。

## セットアップ(エンドユーザー向け)

> ⚠ 現在は β 段階です。DMG をインストールするだけで使えます(モデル DL 不要)。
> DMG のサイズは**約 1.6GB の見積もり**です(**未実測**。同梱 LLM が約 0.33GB 小さくなった分を
> v1.2.0 の実測 1.9GB から引いた値で、次のビルド後に実測値へ直します。
> v1.1.0 までは 3B を同梱して約 2.7GB ありました)。
> GitHub Releases は 2GB 上限のため、配布先は Google Drive / iCloud Drive / 自前 CDN を想定しています。

1. Speaky.dmg(~1.6GB 見積もり)をダウンロードして開き、Applications にドラッグ
2. 初回起動時に macOS の Gatekeeper 警告が出た場合は許可手順(後述)に従って解除
3. 初回起動時のみ、同梱モデルを書き込み可能な領域に展開するセットアップ画面が
   30〜60 秒ほど表示されます(SSD 性能に依存)
4. メインウィンドウが開いたら、オンボーディング画面で **AI キャラクター(名前 / 性別)**
   だけ設定すれば即会話開始できます
   - LLM(Qwen 2.5 1.5B)・Whisper small・ffmpeg はすべて同梱済みなので追加 DL は不要です
     (**ネットに繋がっていなくても最後まで進めます**)
   - whisper.cpp のビルドも同梱バイナリ(arm64)で済んでいるため即起動できます
   - メモリ 12GB 以上の Mac には、オンボーディングが `llama3.2:3b` の取得を案内します。
     取得すると**標準モード**(添削・単語カードあり)になります。取得しなくても
     同梱の 1.5B でそのまま会話を始められます(案内で先へ進めなくなることはありません)

### Gatekeeper(macOS Sequoia 以降)で許可する手順

未署名の配布版は Gatekeeper にブロックされます。以下の手順で許可してください:

1. Finder で `/Applications/Speaky.app` を右クリック → **開く**
2. 警告ダイアログで **開く** を押す(初回のみ)
   - Sequoia 以降は **開く** ボタンが出ない場合があります。その場合は次の手順:
3. **システム設定 → プライバシーとセキュリティ** を開く
4. 「Speaky.app は開発元を確認できないため使用がブロックされました」の隣の
   **このまま開く** をクリック
5. 再度起動するとパスワード入力後に開きます

## 使い方

### 会話

1. ホーム画面で **レベル**(初心者 / 中級 / 上級)と **トピック**(日常会話/旅行/レストラン等)を選択
2. **「▶ 会話を始める」** をクリック → マイク権限を許可
3. 英語で話す(言えなければ日本語OK)
4. 1.5秒の無音で自動送信(設定で 1〜15 秒に変更可) → AIが応答 → 自動でマイクON
5. AI返答には英文と日本語訳が両方表示される
6. 添削や単語が出てきたら **「♡ これ覚えたい」** で復習リストに保存
7. 終わりたい時は **「⏹ 会話を終わる」** で振り返り画面へ

### 復習リスト

- サイドバー → **復習リスト** で保存した単語を一覧
- 検索、並び替え(追加日 / アルファベット)
- **最大3個**選択して「▶ 選択した単語を使って会話する」 → ホームに戻って会話開始
- AI がその単語を自然に組み込んで話してくれる

### 履歴

- サイドバー → **履歴** で過去30日の会話を確認
- 各会話をクリックすると詳細(全メッセージ + 添削 + 単語 + AIサマリー)
- **🔊 再生** ボタンで AI 返答を Web Speech API で再合成

### プロフィール

- サイドバー → **プロフィール**
- AIが会話で学んだあなたのこと(職業、住んでいる場所、趣味等)が一覧表示
- 不要なものは削除、間違っていれば編集可能
- AI キャラクターの名前と性別もここで変更

### 設定

- サイドバー → **設定**
- 無音検出時間(1〜15秒 / 初期値 1.5秒)
- LLM / Whisper モデル選択
- **会話モード**(自動 / 標準に固定 / 軽量に固定)
- テーマ切替(Mint / Lavender / Peach)
- データのエクスポート / インポート / 全削除

### 会話モード(軽量モード)

小さいモデル(2B 以下)は長い指示を守れません。そのまま使うと返答が延々と続いたり、
JSON が崩れたり、英語で返すはずのところに日本語が混ざったりします。
**軽量モード**は小さいモデル向けに次を切り替えます:

|             | 標準モード             | 軽量モード                                       |
| ----------- | ---------------------- | ------------------------------------------------ |
| AI への指示 | 約 900 トークン        | **約 200〜250 トークン**                         |
| 会話履歴    | 直近 10 往復           | **直近 4 往復**                                  |
| 返答の長さ  | レベルに応じて 1〜5 文 | **1〜2 文に固定**(最初の挨拶だけは 3 文まで)     |
| 添削・単語  | 出す                   | **出さない**(小さいモデルの添削は誤りが多いため) |
| 日本語訳    | 必ず出す               | **必ず出す**(変わりません)                       |

既定は「自動」で、モデル名のパラメータ数から判定します(**2B 以下 = 軽量**)。
判定はバックエンドが行い、設定画面のバッジも**バックエンドに問い合わせた結果**を表示します
(推測は表示しません。問い合わせられないバックエンドのときは「確認できません」と出ます)。

**同梱の Qwen 2.5 1.5B は軽量モードに当たります** — つまり素のインストール直後は
添削と単語カードが出ません。フルの体験に戻すには `llama3.2:3b` 以上を取得してください
(設定画面の「インストール済みモデル」→「+ 取得」。メモリ 12GB 以上推奨)。
LLM を選び直すと、会話モードの固定は「自動」に戻ります
(前のモデル向けの固定を別のモデルに引きずらないため)。

### 選べる LLM

| モデル         | サイズ | 向き                                                              |
| -------------- | ------ | ----------------------------------------------------------------- |
| `qwen2.5:1.5b` | ~1GB   | **同梱・既定**。8GB 機向け。日本語訳が安定(軽量モード = 添削なし) |
| `gemma2:2b`    | ~1.6GB | 要 DL。会話は成立するが添削は粗い(軽量モード)                     |
| `llama3.2:3b`  | ~2GB   | 要 DL。**標準モードに戻せる最小のモデル**(添削・単語カードあり)   |
| `gemma2:9b`    | ~5.5GB | 要 DL。16GB 以上向け。精度重視の標準おすすめ                      |
| `qwen2.5:14b`  | ~9GB   | 要 DL。16GB 以上向け。高品質だが低速                              |

「要 DL」は DMG に入っていないという意味です。設定画面の「インストール済みモデル」
セクションから取得できます(取得中はネット接続が必要)。

上記以外でも、同じファミリー(`llama3.2` / `llama3.1` / `gemma2` / `qwen2.5`)の
量子化版(例: `llama3.2:3b-instruct-q4_K_M`)を自分で `ollama pull` すれば選べます。

`llama3.2:1b`(v1.2.0 の同梱物)は取得の選択肢から外しました。日本語訳が崩れやすいためです
(上の「なぜ同梱 LLM が Qwen 2.5 1.5B なのか」を参照)。既に入っている場合はそのまま選べますが、
同梱の `qwen2.5:1.5b` への切り替えをおすすめします。

## トラブルシューティング

### `Ollamaに接続できませんでした`

配布版(Speaky.dmg)を使っている場合: アプリを完全に終了してから再起動してください。
内部の Ollama sidecar 起動に失敗している可能性があります。

ソースから動かしている場合は、別ターミナルで Ollama を起動してください:

```bash
brew install ollama
brew services start ollama
# または: ollama serve
```

### `モデル 'qwen2.5:1.5b' が見つかりません`

オンボーディング画面または設定画面の「インストール済みモデル」セクションから再取得してください。

CLI から取得する場合(brew Ollama を別途使う構成のとき):

```bash
ollama pull qwen2.5:1.5b  # 同梱している既定モデル
ollama pull llama3.2:3b   # 標準モード(添削・単語カード)に戻したいとき
```

**v1.1.0 以前から使っている場合**: 既に取得済みの `llama3.2:3b` はアップグレードしても
消えません(同梱物の同期は追加のみで、既存のモデルを削除しません)。
`llama3.2:3b` を選んだままの設定もそのまま動きます。

### `Failed to convert audio file: ffmpeg: command not found`

配布版には ffmpeg 同梱済みです。ソースからビルドして使っている場合は:

```bash
brew install ffmpeg
```

### `cmake: command not found`

whisper.cpp をビルドするときに必要です(ソースから動かす場合):

```bash
brew install cmake
```

### マイクの権限ダイアログが出ない / 録音できない

- macOS の **システム設定 → プライバシーとセキュリティ → マイク** で Speaky(またはブラウザ)を許可
- アプリ / ブラウザを再起動

### ターン応答が遅い(15秒以上)

- 初回はモデルロードで時間がかかるのが正常
- 2回目以降が遅い場合: メモリ不足の可能性。設定画面から軽量モデルに切り替えてください
  - 8GB 機なら同梱の `qwen2.5:1.5b`(自動で軽量モードになります)
  - それでも遅い場合は Whisper を `base` に下げてください

### 「Thank you for watching」のような幻覚応答が出る

無音時に Whisper が学習データの影響で幻覚する既知の挙動。Phase 2 で対策済みですが、完全には防げません。マイクの感度を上げるか、明確に発音し直してください。

## プロジェクト構造

npm workspaces によるモノレポ構成:

```
speaky/
├── package.json              # workspaces 定義 / 横断スクリプト
├── frontend/                 # Vue 3 + Vite + TypeScript
│   ├── src/
│   │   ├── components/       # BaseButton, AppShell 等
│   │   ├── composables/      # useAudioRecorder, useConversationLoop, useTextToSpeech
│   │   ├── db/               # Dexie スキーマ + repository
│   │   ├── stores/           # Pinia ストア
│   │   ├── views/            # 各画面
│   │   ├── services/api.ts   # backend API client
│   │   ├── utils/            # data-portability, language-detection
│   │   └── themes/themes.css # CSS変数によるテーマ定義
│   └── tailwind.config.js
└── backend/                  # Node.js + Express + TypeScript
    └── src/
        ├── index.ts          # サーバー起動
        ├── routes/           # chat, chat-stream, transcribe, summarize, extract-facts
        ├── services/         # ollama, conversation-prompt, model-profile
        ├── shared/           # frontend と共有(LLM カタログ / 許可判定 / プロファイル推定)
        └── docs/             # whisper-binding 採用判断ドキュメント
```

## 技術スタック

- **Frontend**: Vue 3 (composition API), Vite, TypeScript, Tailwind CSS v3, Pinia, Dexie 4, Vue Router 4
- **Backend**: Node.js (Express + TypeScript, tsx でホットリロード)
- **Desktop shell**: Electron(Ollama を sidecar として起動)
- **STT**: nodejs-whisper(whisper.cpp バインディング, `small` モデル / 多言語)
- **LLM**: Ollama HTTP API(`qwen2.5:1.5b` 同梱・デフォルト)。
  会話の英文は SSE でストリーミングし、日本語訳・添削・単語は後追いで生成
- **TTS**: Browser Web Speech API(macOS の Samantha/Daniel 音声)
- **DB**: IndexedDB(Dexie 経由)+ LocalStorage(設定)
- **Test**: Vitest + fake-indexeddb

## 開発者向け(ソースからビルドする)

ソースから直接動かす場合は、各依存を手元で揃えます。なお Electron シェルは
既存の Ollama(brew install や Ollama.app など)を検出すれば自動で再利用するため、
ローカル開発で brew Ollama を併用することも可能です。

### 前提環境

- **Node.js 22 LTS**(推奨。20 でも一部動くが Vitest 4 は 22 必須)
- **Homebrew**
- **cmake**(whisper.cpp ビルド用)
- **ffmpeg**(音声フォーマット変換用 / 開発時は brew でも可)
- **Ollama**(任意。Electron シェルから起動する場合は不要)

### 手順

```bash
# Node.js 22 LTS(まだの場合)
nvm install 22 && nvm use 22 && nvm alias default 22

# ビルド/変換ツール
brew install cmake ffmpeg

# (任意)brew 経由で Ollama を併用する場合
brew install ollama
brew services start ollama
ollama pull qwen2.5:1.5b  # 同梱している既定モデル

# リポジトリ取得 & 依存インストール
git clone <repo-url> speaky
cd speaky
npm install

# Whisper モデル + whisper.cpp ビルド(約 500MB / 5〜15分)
cd backend
npx --yes nodejs-whisper download
# 対話プロンプト: モデル名 = small / CUDA = n

# 起動(FE + BE 同時)
cd ..
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3001

初回はオンボーディング画面が表示されます。指示に従って AI キャラクターを設定して開始。

## 開発

```bash
# 開発サーバー(FE+BE同時起動)
npm run dev

# 個別起動
npm run dev:frontend
npm run dev:backend

# Lint
npm run lint

# テスト(frontend 281件 / backend 443件)
npm test

# 個別
npm run test -w frontend
npm run test -w backend

# コミット前の検証セット(すべて pass させること)
npm run lint && npm run format:check && npm run build && npm run build:bundle -w backend && npm test

# プロダクションビルド
npm run build
```

## ライセンス

本リポジトリのソース自体は未定(MVP段階)です。
ただし配布版(Speaky.dmg)には以下の OSS が同梱されており、**再配布する場合は各
ライセンス条件に従う必要があります**:

| 同梱物                          | ライセンス               | 注意点                                                                                      |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| ffmpeg-static (ffmpeg バイナリ) | **GPL-3.0**              | 派生物全体に GPL の伝染性が及ぶ可能性あり。商用配布する場合は LGPL ビルドへの差し替えを検討 |
| Ollama ランタイム               | MIT                      | クレジット表記                                                                              |
| Qwen 2.5 1.5B(GGUF blob)        | Apache-2.0               | クレジット表記(LICENSE / NOTICE の同梱)                                                     |
| whisper.cpp / nodejs-whisper    | MIT                      | クレジット表記                                                                              |
| ggml-small.bin(Whisper モデル)  | MIT(OpenAI Whisper 由来) | クレジット表記                                                                              |
| Electron / electron-ollama      | MIT                      | クレジット表記                                                                              |
| Vue 3 / Vite / Tailwind CSS 等  | MIT                      | クレジット表記                                                                              |

> 個人利用での DMG 配布は問題ありませんが、**第三者への配布前に各 LICENSE を確認**
> してください。特に ffmpeg(GPL-3.0)は商用配布を想定する場合に注意が必要です。

## クレジット

- Whisper: OpenAI / ggerganov/whisper.cpp
- Llama 3.2: Meta
- Ollama: ollama.com
- nodejs-whisper: ChetanXpro
- ffmpeg-static: eugeneware
- Vue 3, Vite, Tailwind CSS のメンテナーの皆様

# speaky

**ローカル完結型の英会話練習アプリ** 🎤

MacBook(Apple Silicon)上で **Whisper(音声認識)/ Ollama(LLM)/ Web Speech API(音声合成)** を組み合わせ、外部API課金ゼロで AI とハンズフリー英会話練習ができます。

## 主な機能

- 🎙 **ハンズフリー会話**: 一度クリックすれば、無音検出で自動的にターンが回ります
- 📝 **添削**: あなたの英語の間違いを自然に指摘
- 📚 **単語学習**: AIが拾った重要単語を「これ覚えたい」ボタンで保存
- 🇯🇵 **日本語サポート**: 言えない時は日本語で話すと英訳を提示してくれる
- 🧠 **プロフィール自動学習**: 会話の中からAIがあなたのことを覚えていく
- ⭐ **復習リスト**: 保存した単語で集中的に会話練習
- 📚 **履歴**: 30日分の会話を保存、いつでも振り返り可能
- 🎨 **テーマ**: Mint / Lavender / Peach の3種類から選択可能
- 🌙 **ダークモード**: システム連動
- 💾 **エクスポート/インポート**: データのバックアップと移行が可能

## 動作要件

- **macOS** (Apple Silicon, M4/M5 推奨。最低 M1 以上)
- **メモリ 8GB 以上**(16GB 以上推奨)
- **空き容量 8GB 以上推奨**(DMG 約 2.7GB + アプリ展開 + ランタイム同期分)
- 配布版(Speaky.dmg)を使う場合: 追加の依存ソフトは不要
  (Llama 3.2 3B + Whisper small + ffmpeg + Ollama ランタイムをすべて同梱)
- ソースからビルドする場合: 「開発者向け」セクションを参照

## セットアップ(エンドユーザー向け)

> ⚠ 現在は β 段階です。DMG をインストールするだけで使えます(モデル DL 不要)。
> DMG はサイズが約 2.7GB あるため GitHub Releases(2GB 上限)では配布できません。
> 配布先は Google Drive / iCloud Drive / 自前 CDN を想定しています。

1. Speaky.dmg(~2.7GB)をダウンロードして開き、Applications にドラッグ
2. 初回起動時に macOS の Gatekeeper 警告が出た場合は許可手順(後述)に従って解除
3. 初回起動時のみ、同梱モデルを書き込み可能な領域に展開するセットアップ画面が
   30〜60 秒ほど表示されます(SSD 性能に依存)
4. メインウィンドウが開いたら、オンボーディング画面で **AI キャラクター(名前 / 性別)**
   だけ設定すれば即会話開始できます
   - LLM(Llama 3.2 3B)・Whisper small・ffmpeg はすべて同梱済みなので追加 DL は不要です
   - whisper.cpp のビルドも同梱バイナリ(arm64)で済んでいるため即起動できます

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
- テーマ切替(Mint / Lavender / Peach)
- データのエクスポート / インポート / 全削除

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

### `モデル 'llama3.2:3b' が見つかりません`

オンボーディング画面または設定画面の「インストール済みモデル」セクションから再取得してください。

CLI から取得する場合(brew Ollama を別途使う構成のとき):

```bash
ollama pull llama3.2:3b
```

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
- 2回目以降が遅い場合: メモリ不足の可能性。設定画面から軽量モデル(`llama3.2:3b`)に切り替えてください

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
        ├── routes/           # chat, transcribe, summarize, extract-facts
        ├── services/         # ollama, conversation-prompt
        └── docs/             # whisper-binding 採用判断ドキュメント
```

## 技術スタック

- **Frontend**: Vue 3 (composition API), Vite, TypeScript, Tailwind CSS v3, Pinia, Dexie 4, Vue Router 4
- **Backend**: Node.js (Express + TypeScript, tsx でホットリロード)
- **Desktop shell**: Electron(Ollama を sidecar として起動)
- **STT**: nodejs-whisper(whisper.cpp バインディング, `small` モデル / 多言語)
- **LLM**: Ollama HTTP API(`llama3.2:3b` 軽量・デフォルト推奨, JSON 出力強制)
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
ollama pull llama3.2:3b  # 軽量推奨モデル

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

# テスト(frontend のみ、52件)
npm run test -w frontend

# プロダクションビルド
npm run build
```

## ライセンス

本リポジトリのソース自体は未定(MVP段階)です。
ただし配布版(Speaky.dmg)には以下の OSS が同梱されており、**再配布する場合は各
ライセンス条件に従う必要があります**:

| 同梱物                          | ライセンス                   | 注意点                                                                                      |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| ffmpeg-static (ffmpeg バイナリ) | **GPL-3.0**                  | 派生物全体に GPL の伝染性が及ぶ可能性あり。商用配布する場合は LGPL ビルドへの差し替えを検討 |
| Ollama ランタイム               | MIT                          | クレジット表記                                                                              |
| Llama 3.2 3B(GGUF blob)         | Meta Llama Community License | 月間 7 億 MAU 超は別途許諾。Llama 3.2 派生物には `Llama` のクレジット必須                   |
| whisper.cpp / nodejs-whisper    | MIT                          | クレジット表記                                                                              |
| ggml-small.bin(Whisper モデル)  | MIT(OpenAI Whisper 由来)     | クレジット表記                                                                              |
| Electron / electron-ollama      | MIT                          | クレジット表記                                                                              |
| Vue 3 / Vite / Tailwind CSS 等  | MIT                          | クレジット表記                                                                              |

> 個人利用での DMG 配布は問題ありませんが、**第三者への配布前に各 LICENSE を確認**
> してください。特に ffmpeg(GPL-3.0)は商用配布を想定する場合に注意が必要です。

## クレジット

- Whisper: OpenAI / ggerganov/whisper.cpp
- Llama 3.2: Meta
- Ollama: ollama.com
- nodejs-whisper: ChetanXpro
- ffmpeg-static: eugeneware
- Vue 3, Vite, Tailwind CSS のメンテナーの皆様

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

## 前提環境

- **macOS** (Apple Silicon, M4/M5 推奨。最低 M1 以上)
- **メモリ 16GB 以上**(32GB推奨)
- **Node.js 22 LTS**(推奨。20でも一部動くが Vitest 4 は 22 必須)
- **Homebrew**

## セットアップ

### 1. 依存ツールをインストール

```bash
# Node.js 22 LTS(まだの場合)
nvm install 22
nvm use 22
nvm alias default 22

# whisper.cpp ビルド用
brew install cmake

# 音声フォーマット変換用
brew install ffmpeg

# LLM ランタイム
brew install ollama
brew services start ollama  # バックグラウンド自動起動
# または: ollama serve(フォアグラウンド)
```

### 2. LLM モデル取得(約 5.5GB / 10〜30分)

```bash
ollama pull gemma2:9b
```

### 3. リポジトリ取得 & 依存関係インストール

```bash
git clone <repo-url> speaky
cd speaky
npm install
```

### 4. Whisper モデル + whisper.cpp ビルド(約 1.5GB / 5〜15分)

```bash
cd backend
npx --yes nodejs-whisper download
```

対話プロンプトで:
- モデル名: `medium` と入力 → Enter
- CUDA使用: `n` → Enter(macOSはMetal自動使用)

### 5. 起動

```bash
cd ..  # プロジェクトルートへ戻る
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3001

初回はオンボーディング画面が表示されます。指示に従って AI キャラクターを設定して開始。

## 使い方

### 会話

1. ホーム画面で **レベル**(初心者 / 中級 / 上級)と **トピック**(日常会話/旅行/レストラン等)を選択
2. **「▶ 会話を始める」** をクリック → マイク権限を許可
3. 英語で話す(言えなければ日本語OK)
4. 2秒の無音で自動送信 → AIが応答 → 自動でマイクON
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
- 無音検出時間(1〜5秒)
- LLM / Whisper モデル選択
- テーマ切替(Mint / Lavender / Peach)
- データのエクスポート / インポート / 全削除

## トラブルシューティング

### `ollama: command not found`

```bash
brew install ollama
brew services start ollama
```

### `Ollamaに接続できませんでした`

Ollama サーバーが起動していません:

```bash
brew services start ollama
# または別ターミナルで
ollama serve
```

### `モデル 'gemma2:9b' が見つかりません`

```bash
ollama pull gemma2:9b
```

### `Failed to convert audio file: ffmpeg: command not found`

```bash
brew install ffmpeg
```

### `cmake: command not found`

```bash
brew install cmake
```

### マイクの権限ダイアログが出ない / 録音できない

- macOS の **システム設定 → プライバシーとセキュリティ → マイク** でブラウザを許可
- ブラウザ(Chrome/Safari)を再起動

### ターン応答が遅い(15秒以上)

- 初回はモデルロードで時間がかかるのが正常
- 2回目以降が遅い場合: メモリ不足の可能性。`gemma2:9b` を `llama3.2:3b`(軽量)に切り替え:
  ```bash
  ollama pull llama3.2:3b
  OLLAMA_MODEL=llama3.2:3b npm run dev:backend
  ```

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
- **STT**: nodejs-whisper(whisper.cpp バインディング, `medium` モデル)
- **LLM**: Ollama HTTP API(`gemma2:9b` デフォルト, JSON 出力強制)
- **TTS**: Browser Web Speech API(macOS の Samantha/Daniel 音声)
- **DB**: IndexedDB(Dexie 経由)+ LocalStorage(設定)
- **Test**: Vitest + fake-indexeddb

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

未定(MVP段階)

## クレジット

- Whisper: OpenAI / ggerganov/whisper.cpp
- Gemma 2: Google DeepMind
- Ollama: ollama.com
- nodejs-whisper: ChetanXpro
- Vue 3, Vite, Tailwind CSS のメンテナーの皆様

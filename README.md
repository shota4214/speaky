# speaky

ローカル完結型の英会話学習アプリ。
MacBook(Apple Silicon)上で Whisper(音声認識) / Ollama(LLM) / Web Speech API(音声合成) を組み合わせ、外部API課金ゼロでAIと英会話練習ができる。

## Prerequisites

- macOS (Apple Silicon, M4/M5想定)
- Node.js >= 20
- Homebrew で以下:
  - `brew install cmake`(whisper.cpp ビルドに必要)
  - `brew install ffmpeg`(音声入力フォーマット変換に必要)
- Ollama (https://ollama.com)
- `ollama pull gemma2:9b` 済み
- `npx --yes nodejs-whisper download`(初回のみ、`medium` モデル取得 + whisper.cpp ビルド)

## Setup

```bash
npm install
```

## Development

ルートで以下を実行するとフロント・バック両方が起動します。

```bash
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## Project Structure

npm workspaces によるモノレポ構成。

```
speaky/
├── package.json       # workspaces 定義 / 横断スクリプト
├── frontend/          # Vue 3 + Vite + TypeScript
└── backend/           # Node.js + Express + TypeScript
```

### なぜモノレポか

- ルートで `npm install` 一回 / `npm run dev` で両方起動
- ESLint / Prettier / TypeScript の設定を共有しやすい
- 将来の Electron 化(Phase 3 以降)でルートから両方をバンドルしやすい
- フロント↔バック間で型定義を共有する余地を残す

## Tech Stack

- Frontend: Vue 3, Vite, TypeScript, Tailwind CSS, Pinia, Dexie, Vue Router
- Backend: Node.js, Express, TypeScript
- STT: whisper.cpp (Node binding を Phase 1 で選定)
- LLM: Ollama (`gemma2:9b` デフォルト)
- TTS: Browser Web Speech API

## License

未定(MVP段階)

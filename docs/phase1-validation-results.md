# Phase 1 検証結果

> 計測日: 2026-05-15
> 環境: MacBook Pro / Apple M5 / Node v20.20.2 / macOS Darwin 25.3.0
> モデル: LLM = `gemma2:9b` (5.4GB) / Whisper = `medium` (1.5GB)

## サマリー

Phase 1 のスタック(Vue 3 + Express + Ollama + nodejs-whisper + Web Speech API)で、英会話学習アプリの **最小エンドツーエンド動作を確認** できた。一部の細かい挙動に既知の課題はあるが、**Phase 2 へ進む判断**とする。

## 1. ターンレイテンシ

- **ウォーム時(2ターン目以降)**: 体感 **5〜7秒**(無音検出 → AI返答の音声開始まで)
- 目標(15秒以内): ✅ クリア
- 内訳の感覚値: Whisper transcribe ~2秒 + Ollama chat ~3〜5秒 + TTS開始ほぼ即時
- 初回(コールド)は Whisper + Ollama のモデルロードで遅い(10〜15秒)が、これは仕様

## 2. JSON出力安定性(Ollama `format: "json"`)

- 試したターン数: 5往復程度
- `reply_en` と `reply_ja` が両方揃って画面表示された率: **100%**
- パースリトライ発動 / 502返却: **なし**
- **評価**: Gemma 2 9B + `format: "json"` は **極めて安定**。Phase 2 で `feedback`, `vocabulary`, `mode` 等のフィールドが増えても十分使えそう。

## 3. Whisper 認識精度

| 入力     | 結果                                             |
| -------- | ------------------------------------------------ |
| 英語     | おおむね正確、たまに固有名詞や微妙な発音で誤認識 |
| 日本語   | Task 1.3 の単体テストで高精度を確認              |
| 日英混在 | Phase 2 で本格テスト予定                         |

medium モデルで十分実用。large-v3 への切り替えは現時点で不要。

## 4. 既知の問題(Phase 2 で対応)

### 問題 1: 沈黙時に Whisper が幻覚テキストを返す / エラー扱い

- **症状**: 会話ループ中に2秒沈黙すると録音が自動停止 → 短すぎる/空の blob を `/api/transcribe` に送信 → Whisper が学習データの影響で「Thank you」「Thanks for watching」などの幻覚テキストを返す、もしくはエラー扱いになりループが止まる
- **推測原因**:
  - 学習データ(YouTube 等)に起因する Whisper の典型的な幻覚挙動
  - ffmpeg が極端に短い音声を変換しきれずに失敗するケース
- **Phase 2 対策案**:
  - フロント: 録音 blob の RMS / 録音長が閾値以下なら送信せずに再録音
  - バック: 認識結果が一定文字数未満、または典型的幻覚フレーズ("Thank you for watching", "Thanks for listening" 等)に一致する場合は破棄
  - 仕様書 3.11(認識結果が短すぎる/完全失敗時の挙動)を実装する

### 問題 2: 英語認識のたまの誤認識

- **症状**: 固有名詞や微妙な発音の単語で誤認識される
- **影響**: 軽微。AIが文脈で吸収してくれることが多い
- **対策**: medium モデルの自然な限界。Phase 3 の設定画面で large-v3 への切り替えオプションを提供して回避できるようにする

## 5. Phase 2 へのGo/No-Go

**判定: ✅ Go(進める)**

理由:

- エンドツーエンドの最小ループが期待通り動く
- JSON 出力が想定以上に安定(リトライ機構が一度も発動しない)
- ハンズフリー会話の基本UXが成立している(一度クリックで複数ターン可能)
- 既知の問題は Phase 2 のスコープで吸収できる軽微なもの

Phase 2 着手時に最初に対応したい改善:

- **沈黙時の Whisper 幻覚対策(問題1)** — 「これ覚えたい」「振り返り」など Phase 2 本機能を作る前に直しておくと、テスト時のストレスが下がる

## 6. 採用技術 振り返り

| 技術                                    | Phase 1 で動いた?                | Phase 2 続投? |
| --------------------------------------- | -------------------------------- | ------------- |
| Vue 3 + Vite + TS                       | ✅                               | ✅            |
| Express + TS                            | ✅                               | ✅            |
| Ollama (`gemma2:9b`) + `format: "json"` | ✅(極めて安定)                   | ✅            |
| nodejs-whisper (`medium`)               | ✅(`cmake` & `ffmpeg` 前提あり)  | ✅            |
| Web Speech API SpeechSynthesis          | ✅(macOS の Samantha 音声で出力) | ✅            |
| MediaRecorder + 無音検出                | △ 動くが沈黙幻覚対策が必要       | 要改善        |
| Tailwind + Pinia + Dexie + Vue Router   | ✅(Dexie は Phase 2 で本格活用)  | ✅            |

## 7. 副次的な学び

- nodejs-whisper は README で「ffmpeg 同梱」と読み取れるが、実際はシステムの `ffmpeg` を呼び出す。`brew install ffmpeg` が必須(README & decision doc に反映済み)
- cmake も必須(`brew install cmake`)、README に反映済み
- Apple M5 / 25 GiB VRAM で `gemma2:9b` + `medium` Whisper を同時稼働しても余裕がある
- npm workspaces は今のところスムーズ、Phase 2 でも継続採用

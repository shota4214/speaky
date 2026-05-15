# Phase 1 検証結果

> 計測日: 2026-05-15
> 環境: MacBook Pro / Apple M5 / メモリ XX GB / Node v20.20.2
> モデル: LLM = `gemma2:9b` (5.4GB) / Whisper = `medium` (1.5GB)

## 1. 応答時間(ターンレイテンシ)

| ターン                  | 無音検出→AI音声開始 | 内訳(transcribe / chat / TTS) |
| ----------------------- | ------------------- | ----------------------------- |
| 1ターン目(コールド)     | [ XX秒 ]            | [ XX / XX / XX 秒 ]           |
| 2ターン目以降(ウォーム) | [ XX秒 ]            | [ XX / XX / XX 秒 ]           |

**評価**: 目標15秒以内 → [ 満たす / 一部満たさず ]

## 2. JSON出力安定性(`format: "json"` の効き具合)

- 試した往復数: [ XX ターン ]
- `reply_en` と `reply_ja` が両方揃った率: [ XX / XX(XX%) ]
- パースリトライ発動: [ 0 / 1 / 複数 ] 回
- 完全失敗(502返却): [ 0 / 1 ] 回

**評価**: Gemma 2 9B の JSON 出力は [ 安定 / 不安定 ]

## 3. Whisper 認識精度

| 入力                 | 認識精度                           |
| -------------------- | ---------------------------------- |
| 純粋な英語(日常会話) | [ 高 / 中 / 低 ]                   |
| 純粋な日本語         | [ 高 / 中 / 低 ]                   |
| 日英混在             | [ ほぼ拾える / 一部欠落 / 厳しい ] |

サンプル文と認識結果:

- "I went to Kyoto last weekend" → `[ 認識結果 ]`
- 「京都に行きました」 → `[ 認識結果 ]`

## 4. 既知の問題(Phase 2 で対応予定)

### 問題 1: 沈黙時のエラー誤検出

- **症状**: 録音中に2秒沈黙すると自動停止 → /api/transcribe に送信 → エラーまたはWhisper幻覚で奇妙な返答
- **推測原因**: 短すぎる/空に近い blob を Whisper に投げると、学習データの影響で「Thank you」「Thanks for watching」等を幻覚する。あるいは ffmpeg が空音声に失敗
- **Phase 2 対策**:
  - フロント側でRMSが閾値以下の無音 blob は送信せずに再録音
  - またはサーバ側で短いテキストや典型的な幻覚を破棄

### 問題 [N]: ...

## 5. ハードウェア利用状況

- Whisper 推論時の CPU/GPU 使用率: [ 観察結果 ]
- Ollama 推論時の VRAM 使用: 25 GiB のうち [ XX GiB ]
- 1ターン中のメモリピーク: [ 観察結果 ]

## 6. Phase 2 へのGo/No-Go

**判定: [ Go / 条件付きGo / No-Go ]**

理由:

- [ ... ]

Phase 2 着手前に必須の改善:

- [ ... ]

## 付録: 採用技術の振り返り

| 採用技術                                | Phase 1 で動いたか          | Phase 2 で続投?   |
| --------------------------------------- | --------------------------- | ----------------- |
| Vue 3 + Vite + TS                       | ✅                          | ✅                |
| Express + TS                            | ✅                          | ✅                |
| Ollama (`gemma2:9b`) + `format: "json"` | [ ... ]                     | [ ... ]           |
| nodejs-whisper (`medium`)               | ✅(ffmpeg & cmake 前提あり) | ✅                |
| Web Speech API SpeechSynthesis          | ✅(macOSのSamantha音声)     | ✅                |
| MediaRecorder + 無音検出(VAD自作)       | ✅(ただし誤検出あり)        | 要改善            |
| Tailwind + Pinia + Dexie + Vue Router   | ✅(Dexie未使用)             | ✅(Dexie本格活用) |

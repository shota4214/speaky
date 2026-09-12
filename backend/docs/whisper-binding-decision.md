# Whisper.cpp Node binding 採用判断

> 作成日: 2026-05-15
> 関連: IMPLEMENTATION_PLAN.md Task 1.3

## 結論

**第一候補: `nodejs-whisper` (v0.3.0)** を採用する。

## 比較表

| ライブラリ         | 最新版 / 直近更新                  | macOS arm64              | API 安定性       | モデル管理 | 入力形式                       |
| ------------------ | ---------------------------------- | ------------------------ | ---------------- | ---------- | ------------------------------ |
| **nodejs-whisper** | 0.3.0 / 2026-04                    | ✅ 最適化済み            | 安定             | 自動DL対応 | mp3/m4a/wav 全部OK(ffmpeg同梱) |
| smart-whisper      | 0.8.1 / 2024-10 (半休眠)           | △ Node 22 不透明         | Float32 PCM 必須 | 自前管理   | PCM 16kHz mono 限定            |
| whisper-node       | 1.1.1 / 2023-11 (作者obsolete宣言) | ❌ ARM 不動 issue 未解決 | 不安定           | 対話DL     | WAV 16kHz 必須                 |

## 採用理由(nodejs-whisper)

1. 2026 年も継続更新されている唯一のバインディング
2. ffmpeg 内蔵で **mp3 / m4a / wav** をそのまま投入可能 — Phase 1 で MediaRecorder の出力(webm/opus)を変換する手間が減る
3. `language: 'auto'` で英語/日本語/混在の判定を whisper.cpp 側に委譲
4. ~~`autoDownloadModelName: 'medium'` で初回呼び出し時にモデル自動取得~~ → **撤回(2026-09-12)**。
   HTTP リクエストの中で HuggingFace DL + cmake ビルドが走って固まるため `autoDownloadModelName` は渡さない。
   モデルの有無は `backend/src/services/whisper-paths.ts` で事前チェックし、明示 DL は `POST /api/models/whisper/download` のみ。
5. Apple Silicon ARM CPU 最適化済み、M5 で動作期待値高

## リスクとフォールバック

- ネイティブ依存(whisper.cpp の cmake ビルド)のため、初回 install で失敗する可能性
- もし install / ビルド / 初回呼び出しが失敗したら → 公式 `whisper-cli` バイナリを `child_process.spawn` で叩く実装に切り替える(Homebrew で `brew install whisper-cpp` 一発)

## モデル

> ⚠ **2026-09-12 更新(v1.1.0 / 低スペック機対応)**: 下記の「デフォルト medium」は撤回済み。

- デフォルト: **small**(多言語・約 488MB)。同梱モデルもこれ。
  - medium(約 1.5GB)は 8GB Mac で毎リクエスト RAM に載せると swap して実用にならないため降格した。
  - 日本語音声入力を扱うので `.en`(英語専用)モデルは選ばないこと。
- 設定画面でインストール済みの他モデル(medium 等)へ切り替え可能。
  実体が無いモデルを指定された場合は backend が「同梱 small → インストール済みの多言語モデル(小さい順)」
  の順でフォールバックする(`backend/src/routes/transcribe.ts` の `ensureWhisperModel`)。
- 旧記述: ~~デフォルト medium(約 1.5GB) / 設定で small・large-v3 を選択可能~~
  (`large-v3` は nodejs-whisper の MODELS_LIST に無く指定できない)

## 実装時に判明した前提

- **`ffmpeg` をシステムにインストールしておく必要がある**(`brew install ffmpeg`)
  - nodejs-whisper は内部で `child_process` 経由で `ffmpeg` を呼び、入力音声を 16kHz mono WAV に変換する
  - 当初の調査で「ffmpeg 同梱」と書かれていたが、実際にはバイナリは同梱されておらず、システムの ffmpeg を呼び出す
  - これがないと `[Nodejs-whisper] Failed to convert audio file: /bin/sh: ffmpeg: command not found` が出る

## 参考

- nodejs-whisper: https://github.com/ChetanXpro/nodejs-whisper
- whisper.cpp: https://github.com/ggerganov/whisper.cpp

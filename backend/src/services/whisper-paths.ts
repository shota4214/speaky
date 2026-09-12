import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * nodejs-whisper パッケージのインストール先(writable な場所)を解決する。
 * 優先順位:
 *  1. SPEAKY_WHISPER_BASE_DIR env(Electron が writable な userData を指定)
 *  2. cwd + './node_modules/nodejs-whisper'   (packaged: backend-runtime cwd)
 *  3. cwd + '../node_modules/nodejs-whisper'  (backend/dist 内 + 隣の node_modules)
 *  4. cwd + '../../node_modules/nodejs-whisper' (workspace dev: backend/dist + root hoist)
 *
 * nodejs-whisper 自身も `require('nodejs-whisper')` の解決先(= 同じディレクトリ)を
 * 基準にモデルを探すため、ここで解決したパスと実際の読み込み先は一致する。
 * routes/models.ts(DL/削除)と routes/transcribe.ts(実行前の存在チェック)で
 * 同じ実装を共有するためにここへ切り出している。
 */
export function getWhisperPackageDir(): string {
  const fromEnv = process.env.SPEAKY_WHISPER_BASE_DIR
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const candidates = [
    path.resolve(process.cwd(), 'node_modules', 'nodejs-whisper'),
    path.resolve(process.cwd(), '..', 'node_modules', 'nodejs-whisper'),
    path.resolve(process.cwd(), '..', '..', 'node_modules', 'nodejs-whisper'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]!
}

export function findWhisperModelsDir(): string {
  return path.join(getWhisperPackageDir(), 'cpp', 'whisper.cpp', 'models')
}

export function findWhisperCppDir(): string {
  return path.join(getWhisperPackageDir(), 'cpp', 'whisper.cpp')
}

/** モデル名 → whisper.cpp の ggml ファイル名(nodejs-whisper の MODEL_OBJECT と同じ規則)。 */
export function whisperModelFileName(modelName: string): string {
  return `ggml-${modelName}.bin`
}

/** モデル名 → models ディレクトリ内の絶対パス。 */
export function whisperModelPath(modelName: string): string {
  return path.join(findWhisperModelsDir(), whisperModelFileName(modelName))
}

/** モデル実体がディスク上にあるか。キャッシュしない(DL 直後の再判定を効かせるため)。 */
export function whisperModelExists(modelName: string): boolean {
  return existsSync(whisperModelPath(modelName))
}

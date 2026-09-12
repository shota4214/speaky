import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * プロセス起動時点の cwd。
 *
 * ⚠ 実行中に process.cwd() を読んではいけない。nodejs-whisper の
 * `executeCppCommand` が転写の間だけ `shelljs.cd(WHISPER_CPP_PATH)` でプロセス全体の
 * cwd を `…/cpp/whisper.cpp` に変えるため、転写と並行して走ったリクエストが
 * cwd 基準で解決すると候補が全部外れ、モデルが「無い」ことになって 503 と
 * 設定画面の空リストを引き起こす(dev の `npm run dev` は
 * SPEAKY_WHISPER_BASE_DIR を設定しないので特に踏みやすい)。
 *
 * モジュールロード時(= サーバー起動時、転写が走る前)の cwd を固定して使う。
 * ※ `createRequire(import.meta.url).resolve()` は使えない。backend は esbuild で
 *    CJS 単一ファイルにバンドルされる(`build:bundle`)ため import.meta が空になる。
 */
const INITIAL_CWD = process.cwd()

/** 候補探索の結果キャッシュ(パッケージの場所は実行中に変わらない)。 */
let cachedPackageDir: string | null = null

/**
 * nodejs-whisper パッケージのインストール先(writable な場所)を解決する。
 * 優先順位:
 *  1. SPEAKY_WHISPER_BASE_DIR env(Electron が writable な userData を指定)
 *  2. INITIAL_CWD + './node_modules/nodejs-whisper'   (packaged: backend-runtime cwd)
 *  3. INITIAL_CWD + '../node_modules/nodejs-whisper'  (backend/dist 内 + 隣の node_modules)
 *  4. INITIAL_CWD + '../../node_modules/nodejs-whisper' (workspace dev: root hoist)
 *
 * nodejs-whisper 自身も `require('nodejs-whisper')` の解決先(= 同じディレクトリ)を
 * 基準にモデルを探すため、ここで解決したパスと実際の読み込み先は一致する。
 * routes/models.ts(DL/削除)と routes/transcribe.ts(実行前の存在チェック)で
 * 同じ実装を共有するためにここへ切り出している。
 */
export function getWhisperPackageDir(): string {
  // env は毎回見る(Electron が起動直後に用意するケースがあるためキャッシュしない)
  const fromEnv = process.env.SPEAKY_WHISPER_BASE_DIR
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  if (cachedPackageDir) return cachedPackageDir

  const candidates = [
    path.resolve(INITIAL_CWD, 'node_modules', 'nodejs-whisper'),
    path.resolve(INITIAL_CWD, '..', 'node_modules', 'nodejs-whisper'),
    path.resolve(INITIAL_CWD, '..', '..', 'node_modules', 'nodejs-whisper'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedPackageDir = c
      return c
    }
  }
  // 見つからなかった場合はキャッシュしない(後から用意される可能性を残す)
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

/**
 * models ディレクトリを走査して、実際に置かれている ggml モデルの短縮名を返す。
 * (例: `ggml-small.bin` → `small`)。存在しない/読めない場合は空配列。
 * 呼び出し側で allowlist と多言語判定を行うこと。
 */
export function listInstalledWhisperModelNames(): string[] {
  try {
    return readdirSync(findWhisperModelsDir())
      .filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
      .map((f) => f.slice('ggml-'.length, -'.bin'.length))
  } catch {
    return []
  }
}

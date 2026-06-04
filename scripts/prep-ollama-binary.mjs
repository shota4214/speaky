#!/usr/bin/env node
/**
 * 配布版を「完全オフライン初回起動」させるために、Ollama ランタイムバイナリ一式を
 * electron/build-resources/ollama-bin/ に同梱可能な形で vendor する。
 *
 * 背景:
 *   electron-ollama の serve(version) は、対象バージョンが isDownloaded() = true なら
 *   GitHub API(getMetadata)も DL も一切呼ばずに、ローカルバイナリを spawn するだけで起動する。
 *   isDownloaded() は <basePath>/electron-ollama/<version>/<os>/<arch>/ollama の存在チェック。
 *   → このディレクトリ一式を DMG に同梱し、初回起動で userData にコピーすればオフライン化できる。
 *
 * 流れ:
 *   1. すでに vendor 済み(ollama 実行ファイルが存在)ならスキップ(冪等)
 *   2. electron-ollama の download(OLLAMA_VERSION) をビルドマシンで実行し、
 *      <tmpBase>/electron-ollama/<OLLAMA_VERSION>/darwin/arm64/ にバイナリ一式を展開
 *   3. 展開された darwin/arm64/ ディレクトリをまるごと
 *      electron/build-resources/ollama-bin/<OLLAMA_VERSION>/darwin/arm64/ にコピー
 *      (electron-ollama が userData 側で getBinPath が返すレイアウトと完全一致させる)
 *
 * 出力先構造(electron-ollama の getBinPath レイアウトと一致):
 *   electron/build-resources/ollama-bin/
 *     <OLLAMA_VERSION>/darwin/arm64/ollama        (実行ファイル, +x)
 *     <OLLAMA_VERSION>/darwin/arm64/*.dylib *.so  (依存ライブラリ・helper 一式)
 *
 * OLLAMA_VERSION は electron/src/main.ts の定数と一致させること(version pin)。
 */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// version pin: electron/src/main.ts の OLLAMA_VERSION と一致させること。
// GitHub tag そのまま("v0.x.y" 形式)。electron-ollama は getMetadata が返す
// tag_name(= "vX.Y.Z")をディレクトリ名に使うので、この形式でなければ
// isDownloaded() / serve() のパス解決と食い違う。
const OLLAMA_VERSION = 'v0.30.4'
const PLATFORM_CONFIG = { os: 'darwin', arch: 'arm64' }

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

assertRepoRoot(repoRoot)

const outRoot = resolve(repoRoot, 'electron', 'build-resources', 'ollama-bin')
// electron-ollama は basePath/electron-ollama/<version>/<os>/<arch> を使う。
// vendor 側も同じ末尾構造を作る(out 側の basePath は outRoot)。
const outBinDir = resolve(
  outRoot,
  'electron-ollama',
  OLLAMA_VERSION,
  PLATFORM_CONFIG.os,
  PLATFORM_CONFIG.arch,
)
const outExecutable = resolve(outBinDir, 'ollama')

function assertRepoRoot(root) {
  const markers = [resolve(root, 'package.json'), resolve(root, 'electron', 'package.json')]
  const missing = markers.filter((p) => !existsSync(p))
  if (missing.length > 0) {
    console.error(
      `[prep-ollama-binary] computed repoRoot looks wrong: ${root}\n` +
        `  missing markers: ${missing.join(', ')}\n` +
        `  prep script は workspace root の \`scripts/\` に置く前提です`,
    )
    process.exit(1)
  }
}

async function main() {
  // 冪等: 実行ファイルが既にあればスキップ
  if (existsSync(outExecutable)) {
    console.log(`[prep-ollama-binary] already vendored at ${outBinDir}; skipping`)
    return
  }

  // electron-ollama を ESM から CJS require で読み込む。
  // basePath を一時ディレクトリにして、そこに download させる。
  const require = createRequire(import.meta.url)
  const { ElectronOllama } = require('electron-ollama')

  const tmpBase = resolve(tmpdir(), 'speaky-prep-ollama-binary')
  mkdirSync(tmpBase, { recursive: true })

  const manager = new ElectronOllama({ basePath: tmpBase })

  // 念のため currentPlatformConfig が darwin/arm64 であることを確認。
  const current = manager.currentPlatformConfig()
  if (current.os !== PLATFORM_CONFIG.os || current.arch !== PLATFORM_CONFIG.arch) {
    throw new Error(
      `this script must run on ${PLATFORM_CONFIG.os}/${PLATFORM_CONFIG.arch}, ` +
        `but current is ${current.os}/${current.arch}`,
    )
  }

  // download() は内部で getMetadata(version) を呼び、tag_name のディレクトリに展開する。
  // OLLAMA_VERSION は tag そのものなので getBinPath(OLLAMA_VERSION) と一致する。
  console.log(`[prep-ollama-binary] downloading Ollama ${OLLAMA_VERSION} into ${tmpBase}`)
  if (!(await manager.isDownloaded(OLLAMA_VERSION))) {
    await manager.download(OLLAMA_VERSION, PLATFORM_CONFIG, {
      log: (percent, message) => {
        console.log(`[prep-ollama-binary:download ${percent}%] ${message}`)
      },
    })
  } else {
    console.log('[prep-ollama-binary] already present in tmp cache; reusing')
  }

  const srcBinDir = manager.getBinPath(OLLAMA_VERSION, PLATFORM_CONFIG)
  const srcExecutable = resolve(srcBinDir, manager.getExecutableName(PLATFORM_CONFIG))
  if (!existsSync(srcExecutable)) {
    throw new Error(`downloaded ollama executable not found at ${srcExecutable}`)
  }

  // バイナリ一式(ollama + 依存 dylib/so/helper)をまるごとコピー。
  // executable の実行権限は cpSync が保持する。
  rmSync(outBinDir, { recursive: true, force: true })
  mkdirSync(dirname(outBinDir), { recursive: true })
  cpSync(srcBinDir, outBinDir, { recursive: true, force: true })

  // ★重要: electron-ollama の展開物には major-version の dylib シンボリックリンク
  // (例 libggml.0.dylib -> libggml.0.13.1.dylib)が含まれ、その target が DL 一時
  // ディレクトリ(/tmp/...)を指す絶対パスになっている。そのまま同梱するとエンド
  // ユーザー機ではリンク切れになり ollama が dylib をロードできず起動失敗する。
  // cpSync の dereference オプションでは解決しきれないため、コピー後に symlink を
  // 実ファイルへ明示的に置き換える(tmp がまだ存在するうちに realpath で解決する)。
  replaceSymlinksWithRealFiles(outBinDir)

  // upstream tarball 由来の AppleDouble ファイル(._*.metallib 等)を除去。
  // 無害だが DMG に混入するので掃除しておく。
  removeAppleDoubleFiles(outBinDir)

  if (!existsSync(outExecutable)) {
    throw new Error(`vendor copy failed: ${outExecutable} missing after copy`)
  }

  const fileCount = readdirSync(outBinDir).length
  console.log(
    `[prep-ollama-binary] done. vendored ${fileCount} file(s) to ${outBinDir}\n` +
      `  basePath layout: build-resources/ollama-bin/electron-ollama/${OLLAMA_VERSION}/${PLATFORM_CONFIG.os}/${PLATFORM_CONFIG.arch}/`,
  )
}

/**
 * dir 配下のシンボリックリンクを、それが指す実ファイルの実体コピーに置き換える(再帰)。
 * realpathSync で最終的な実ファイル(tmp 内)を解決し、symlink を削除して実体をコピー。
 * 実行権限などの mode は statSync(symlink 追従)で取得して保持する。
 */
function replaceSymlinksWithRealFiles(dir) {
  let replaced = 0
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = resolve(d, entry.name)
      if (entry.isSymbolicLink()) {
        const real = realpathSync(full) // 追従して実ファイルへ(tmp 内)
        const mode = statSync(full).mode // statSync は symlink を追従 = target の mode
        rmSync(full)
        copyFileSync(real, full)
        chmodSync(full, mode)
        replaced++
      } else if (entry.isDirectory()) {
        walk(full)
      }
    }
  }
  walk(dir)
  if (replaced > 0) {
    console.log(`[prep-ollama-binary] resolved ${replaced} symlink(s) to real files`)
  }
}

/**
 * macOS の AppleDouble ファイル(`._*`)を再帰的に削除する。
 * upstream tarball 由来で無害だが、DMG に混入させない。
 */
function removeAppleDoubleFiles(dir) {
  let removed = 0
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = resolve(d, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.startsWith('._')) {
        rmSync(full, { force: true })
        removed++
      }
    }
  }
  walk(dir)
  if (removed > 0) {
    console.log(`[prep-ollama-binary] removed ${removed} AppleDouble file(s)`)
  }
}

main().catch((e) => {
  console.error('[prep-ollama-binary] failed:', e)
  process.exit(1)
})

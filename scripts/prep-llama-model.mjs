#!/usr/bin/env node
/**
 * 配布用 Llama 3.2 1B を Ollama 形式で取得して
 * electron/build-resources/ollama-data/ に同梱可能な形で配置する。
 *
 * 流れ:
 *   1. ~/.ollama/models/manifests/registry.ollama.ai/library/llama3.2/1b を確認
 *   2. 無ければ `ollama` バイナリを使って pull する
 *      - `ollama` が serve 動作中でなければ一時的に `ollama serve` を spawn
 *   3. manifest を読み、参照されている全 blob(layers + config)を列挙
 *   4. blobs と manifest を electron/build-resources/ollama-data/ にコピー
 *      - 既に同サイズで存在すればスキップ(冪等)
 *   5. 今回の同梱モデルが参照していない blob / manifest を掃除する
 *      (同梱モデルを差し替えたビルド機に前のモデルが残るのを防ぐ)
 *
 * 出力先構造:
 *   electron/build-resources/ollama-data/
 *     manifests/registry.ollama.ai/library/llama3.2/1b
 *     blobs/sha256-<hash>   (manifest が参照するものだけ)
 */
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 同梱する会話モデル。
 *
 * ⚠️ **`backend/src/shared/llm-models.ts` の BUNDLED_LLM_MODEL と必ず一致させること。**
 * v1.1.0 までは 3B を同梱していたが、オンボーディングは 12GB 未満の Mac に
 * 軽量モデル(1B)を**あらかじめ選ぶ**ので、ネットの無い 8GB 機では
 * 「選ばれているモデルが同梱されていない」= 初回起動が行き止まりになっていた。
 * v1.2.0 で同梱物そのものを 1B に寄せた(DMG も約 2.67GB → 約 1.5GB)。
 * 一致は backend の `shared/llm-models.test.ts` がこのファイルを読んで検証している。
 */
const MODEL = 'llama3.2:1b'
const MODEL_FAMILY = 'llama3.2'
const MODEL_TAG = '1b'
const MANIFEST_REL = `manifests/registry.ollama.ai/library/${MODEL_FAMILY}/${MODEL_TAG}`
const SERVE_READY_TIMEOUT_MS = 15_000
const PULL_TIMEOUT_MS = 10 * 60 * 1000

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

// prep スクリプトは workspace root の scripts/ に置く前提。
// repoRoot の算出が壊れる(scripts/ 外に移動された等)と
// 関係ない場所に大量のファイルを書き込みに行くので早期に止める。
assertRepoRoot(repoRoot)

const outDir = resolve(repoRoot, 'electron', 'build-resources', 'ollama-data')
const srcOllamaDir = resolve(homedir(), '.ollama', 'models')

function assertRepoRoot(root) {
  const markers = [resolve(root, 'package.json'), resolve(root, 'electron', 'package.json')]
  const missing = markers.filter((p) => !existsSync(p))
  if (missing.length > 0) {
    console.error(
      `[prep-llama-model] computed repoRoot looks wrong: ${root}\n` +
        `  missing markers: ${missing.join(', ')}\n` +
        `  prep script は workspace root の \`scripts/\` に置く前提です`,
    )
    process.exit(1)
  }
}

async function main() {
  const srcManifestPath = resolve(srcOllamaDir, MANIFEST_REL)
  const dstManifestPath = resolve(outDir, MANIFEST_REL)

  // 既に out 側に揃っていればスキップ
  if (existsSync(dstManifestPath)) {
    const ok = await verifyOutput(dstManifestPath)
    if (ok) {
      // 「もう揃っている」場合でも掃除だけは毎回する。前のモデルの残骸は
      // verifyOutput には引っかからない(今回のモデルは揃っているため)。
      pruneStaleVendored(dstManifestPath)
      console.log(`[prep-llama-model] already vendored at ${outDir}; skipping`)
      return
    }
    console.warn('[prep-llama-model] vendored copy is incomplete; will re-copy')
  }

  // ローカルに無ければ pull
  if (!existsSync(srcManifestPath)) {
    console.log(`[prep-llama-model] ${MODEL} not found locally; pulling via ollama`)
    await ensureOllamaAndPull(MODEL)
  } else {
    console.log(`[prep-llama-model] found local manifest at ${srcManifestPath}`)
  }

  if (!existsSync(srcManifestPath)) {
    throw new Error(`manifest still missing after pull: ${srcManifestPath}`)
  }

  // manifest を解析して blob ハッシュ一覧を作る
  const blobDigests = collectBlobDigests(srcManifestPath)
  console.log(`[prep-llama-model] manifest references ${blobDigests.length} blobs`)

  // blob をコピー
  const dstBlobsDir = resolve(outDir, 'blobs')
  mkdirSync(dstBlobsDir, { recursive: true })
  for (const digest of blobDigests) {
    const filename = `sha256-${digest}`
    const src = resolve(srcOllamaDir, 'blobs', filename)
    const dst = resolve(dstBlobsDir, filename)
    if (!existsSync(src)) {
      throw new Error(`blob missing: ${src}`)
    }
    if (existsSync(dst) && statSync(dst).size === statSync(src).size) {
      console.log(`[prep-llama-model] blob ${filename.slice(0, 19)}... already copied`)
      continue
    }
    const sz = statSync(src).size
    console.log(`[prep-llama-model] copying ${filename.slice(0, 19)}... (${formatBytes(sz)})`)
    copyFileSync(src, dst)
  }

  // manifest をコピー
  mkdirSync(dirname(dstManifestPath), { recursive: true })
  copyFileSync(srcManifestPath, dstManifestPath)
  console.log(`[prep-llama-model] manifest copied to ${dstManifestPath}`)

  // 同梱物を変えたときに **前のモデルが vendor ディレクトリに残る** のを掃除する。
  // build-resources/ は .gitignore なのでビルド機のローカルにしか無く、
  // 3B を vendor した後に 1B へ切り替えると、掃除しない限り DMG に両方入って
  // 「小さくしたはずが大きくなった」ことに誰も気づけない。
  pruneStaleVendored(dstManifestPath)

  const okFinal = await verifyOutput(dstManifestPath)
  if (!okFinal) {
    throw new Error('post-copy verification failed')
  }

  console.log(`[prep-llama-model] done. vendored to ${outDir}`)
}

/**
 * vendor ディレクトリから「今回の同梱モデルが参照していない」manifest と blob を消す。
 *
 * 冪等。既に綺麗なら何もしない。
 * blob は content-addressed なので、残っていても壊れはしないが DMG が太る
 * (3B の blob は約 2GB ある = 今回の縮小効果がそのまま消える)。
 */
function pruneStaleVendored(manifestPath) {
  const keep = new Set(collectBlobDigests(manifestPath).map((d) => `sha256-${d}`))

  const blobsDir = resolve(outDir, 'blobs')
  if (existsSync(blobsDir)) {
    for (const entry of readdirSync(blobsDir, { withFileTypes: true })) {
      if (!entry.isFile() || keep.has(entry.name)) continue
      const p = resolve(blobsDir, entry.name)
      console.log(`[prep-llama-model] pruning stale blob ${entry.name.slice(0, 19)}...`)
      rmSync(p, { force: true })
    }
  }

  // manifest は `manifests/registry.ollama.ai/library/<family>/<tag>` の形。
  // 今回の <family>/<tag> 以外をすべて消す(他モデル・旧タグの取り残し)。
  const libraryDir = resolve(outDir, 'manifests', 'registry.ollama.ai', 'library')
  if (!existsSync(libraryDir)) return
  for (const familyEntry of readdirSync(libraryDir, { withFileTypes: true })) {
    if (!familyEntry.isDirectory()) continue
    const familyDir = resolve(libraryDir, familyEntry.name)
    if (familyEntry.name !== MODEL_FAMILY) {
      console.log(`[prep-llama-model] pruning stale manifest family ${familyEntry.name}`)
      rmSync(familyDir, { recursive: true, force: true })
      continue
    }
    for (const tagEntry of readdirSync(familyDir, { withFileTypes: true })) {
      if (tagEntry.name === MODEL_TAG) continue
      console.log(`[prep-llama-model] pruning stale manifest ${familyEntry.name}/${tagEntry.name}`)
      rmSync(resolve(familyDir, tagEntry.name), { recursive: true, force: true })
    }
  }
}

/**
 * out 側の manifest を読んで、参照される blob が全部揃っているか確認する。
 */
async function verifyOutput(manifestPath) {
  if (!existsSync(manifestPath)) return false
  let digests
  try {
    digests = collectBlobDigests(manifestPath)
  } catch {
    return false
  }
  const blobsDir = resolve(dirname(manifestPath), '..', '..', '..', '..', 'blobs')
  for (const d of digests) {
    const p = resolve(blobsDir, `sha256-${d}`)
    if (!existsSync(p) || statSync(p).size === 0) {
      return false
    }
  }
  return true
}

function collectBlobDigests(manifestPath) {
  const json = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  const digests = new Set()
  if (json?.config?.digest) {
    digests.add(stripPrefix(json.config.digest))
  }
  if (Array.isArray(json?.layers)) {
    for (const layer of json.layers) {
      if (layer?.digest) digests.add(stripPrefix(layer.digest))
    }
  }
  return [...digests]
}

function stripPrefix(digest) {
  return digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest
}

/**
 * `ollama pull <model>` を実行する。
 * 既に serve 中ならそれを使う。動いていなければ `ollama serve` を spawn して
 * 数秒待ってから pull する。spawn したサーバは pull 完了後に kill する。
 */
async function ensureOllamaAndPull(model) {
  const running = await isOllamaUp()
  let serveProc = null
  if (!running) {
    console.log('[prep-llama-model] starting temporary `ollama serve`')
    serveProc = spawn('ollama', ['serve'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: false,
    })
    // serve が listen するまで polling
    const deadline = Date.now() + SERVE_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await isOllamaUp()) break
      await sleep(500)
    }
    if (!(await isOllamaUp())) {
      try {
        serveProc.kill('SIGTERM')
      } catch {
        // ignore
      }
      throw new Error('ollama serve did not become ready in time')
    }
  }

  try {
    await runOllamaPull(model)
  } finally {
    if (serveProc) {
      try {
        serveProc.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
  }
}

async function isOllamaUp() {
  try {
    const res = await fetch('http://localhost:11434/api/tags', { method: 'GET' })
    return res.ok
  } catch {
    return false
  }
}

function runOllamaPull(model) {
  return new Promise((resolveP, rejectP) => {
    console.log(`[prep-llama-model] ollama pull ${model}`)
    const proc = spawn('ollama', ['pull', model], { stdio: 'inherit' })
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      rejectP(new Error(`ollama pull timed out after ${PULL_TIMEOUT_MS}ms`))
    }, PULL_TIMEOUT_MS)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveP()
      else rejectP(new Error(`ollama pull exited with code ${code}`))
    })
    proc.on('error', (e) => {
      clearTimeout(timer)
      rejectP(e)
    })
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${bytes} B`
}

main().catch((e) => {
  console.error('[prep-llama-model] failed:', e)
  process.exit(1)
})

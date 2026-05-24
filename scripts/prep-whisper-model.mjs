#!/usr/bin/env node
/**
 * 配布用 Whisper モデル(ggml-medium.bin)を取得して
 * backend/vendor/node_modules/nodejs-whisper/cpp/whisper.cpp/models/ に配置する。
 *
 * - 既にファイルが存在し、サイズが妥当なら何もしない(冪等)
 * - 一時ファイル + リネームでアトミックに書き込み、中断しても壊れない
 * - 失敗時は exit code 1
 *
 * 実行は `npm run prep:vendor:whisper-model -w backend` から呼ばれる前提だが、
 * スクリプト自体は repo root からの相対パスを自力で算出するのでどこから叩いてもよい。
 */
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const MODEL_NAME = 'ggml-medium.bin'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`
// HF 上の medium は 1.5GB 程度。極端に小さいと壊れていると見なす。
const MIN_BYTES = 1_000_000_000 // 1GB

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

// prep スクリプトは workspace root の scripts/ に置く前提。
// repoRoot の算出が壊れる(scripts/ 外に移動された等)と
// 関係ない場所に巨大ファイルを書き込みに行くので早期に止める。
assertRepoRoot(repoRoot)

const modelsDir = resolve(
  repoRoot,
  'backend',
  'vendor',
  'node_modules',
  'nodejs-whisper',
  'cpp',
  'whisper.cpp',
  'models',
)
const modelPath = resolve(modelsDir, MODEL_NAME)
const tmpPath = `${modelPath}.partial`

function assertRepoRoot(root) {
  const markers = [resolve(root, 'package.json'), resolve(root, 'electron', 'package.json')]
  const missing = markers.filter((p) => !existsSync(p))
  if (missing.length > 0) {
    console.error(
      `[prep-whisper-model] computed repoRoot looks wrong: ${root}\n` +
        `  missing markers: ${missing.join(', ')}\n` +
        `  prep script は workspace root の \`scripts/\` に置く前提です`,
    )
    process.exit(1)
  }
}

/**
 * HuggingFace の HEAD は LFS オブジェクトの sha256 を `X-Linked-Etag` ヘッダで返す
 * (値は二重引用符付きの sha256 hex)。取得できない場合は null を返してフォールバックさせる。
 */
async function fetchExpectedSha256(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    if (!res.ok) {
      console.warn(`[prep-whisper-model] HEAD ${url} -> HTTP ${res.status}; falling back to size-only check`)
      return null
    }
    const raw = res.headers.get('x-linked-etag') ?? res.headers.get('etag')
    if (!raw) {
      console.warn('[prep-whisper-model] no X-Linked-Etag/ETag header; falling back to size-only check')
      return null
    }
    // `"<hex>"` 形式が一般的だが、`W/"..."` 等もあり得るのでクリーンアップ
    const cleaned = raw.replace(/^W\//i, '').replace(/^"|"$/g, '')
    // sha256 hex は 64 文字。長さで簡易判定して、それ以外は信頼しない。
    if (!/^[0-9a-f]{64}$/i.test(cleaned)) {
      console.warn(
        `[prep-whisper-model] unexpected etag format (${raw}); falling back to size-only check`,
      )
      return null
    }
    return cleaned.toLowerCase()
  } catch (e) {
    console.warn(`[prep-whisper-model] HEAD failed (${String(e)}); falling back to size-only check`)
    return null
  }
}

async function sha256OfFile(filePath) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

async function main() {
  if (!existsSync(modelsDir)) {
    console.error(
      `[prep-whisper-model] models dir not found: ${modelsDir}\n` +
        `  Did you run "npm run prep:vendor -w backend" first?`,
    )
    process.exit(1)
  }

  if (existsSync(modelPath)) {
    const size = statSync(modelPath).size
    if (size < MIN_BYTES) {
      // サイズが論外なら sha 計算するまでもなく再 DL(計算コストの無駄を避ける)
      console.warn(
        `[prep-whisper-model] existing ${MODEL_NAME} is too small (${formatBytes(size)}); re-downloading`,
      )
      unlinkSync(modelPath)
    } else {
      // サイズが OK でも 1GB 超の破損ファイルがあり得るので sha256 を照合する。
      // HEAD で期待値が取れた場合のみ厳密チェック。取れなければ size-only で skip(冪等性維持)。
      const expectedSha = await fetchExpectedSha256(MODEL_URL)
      if (expectedSha === null) {
        console.log(
          `[prep-whisper-model] ${MODEL_NAME} already exists (${formatBytes(size)}); skipping download (size-only)`,
        )
        return
      }
      console.log(
        `[prep-whisper-model] verifying sha256 of existing ${MODEL_NAME} (${formatBytes(size)})...`,
      )
      const actualSha = await sha256OfFile(modelPath)
      if (actualSha === expectedSha) {
        console.log(`[prep-whisper-model] sha256 matches; skipping download`)
        return
      }
      console.warn(
        `[prep-whisper-model] sha256 mismatch (expected ${expectedSha}, got ${actualSha}); re-downloading`,
      )
      unlinkSync(modelPath)
    }
  }

  console.log(`[prep-whisper-model] downloading ${MODEL_URL}`)
  console.log(`[prep-whisper-model] -> ${modelPath}`)

  // 部分ファイルが残っていれば消す
  if (existsSync(tmpPath)) {
    unlinkSync(tmpPath)
  }

  const res = await fetch(MODEL_URL, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} on ${MODEL_URL}`)
  }

  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  let lastLogPct = -1

  const reportProgress = (chunk) => {
    received += chunk.length
    if (total > 0) {
      const pct = Math.floor((received / total) * 100)
      if (pct !== lastLogPct && pct % 5 === 0) {
        process.stdout.write(`\r[prep-whisper-model] ${pct}% (${formatBytes(received)} / ${formatBytes(total)})`)
        lastLogPct = pct
      }
    }
  }

  const source = Readable.fromWeb(res.body)
  source.on('data', reportProgress)
  await pipeline(source, createWriteStream(tmpPath))
  process.stdout.write('\n')

  const finalSize = statSync(tmpPath).size
  if (finalSize < MIN_BYTES) {
    unlinkSync(tmpPath)
    throw new Error(
      `downloaded file too small (${formatBytes(finalSize)} < ${formatBytes(MIN_BYTES)}); aborting`,
    )
  }

  renameSync(tmpPath, modelPath)
  console.log(`[prep-whisper-model] done: ${formatBytes(finalSize)}`)
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${bytes} B`
}

main().catch((e) => {
  console.error('[prep-whisper-model] failed:', e)
  if (existsSync(tmpPath)) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore
    }
  }
  process.exit(1)
})

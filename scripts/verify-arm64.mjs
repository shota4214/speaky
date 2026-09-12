#!/usr/bin/env node
/**
 * 同梱バイナリの検証。
 *
 * 1. arm64 の Mach-O であること(`file`)
 * 2. whisper-cli に「ビルド機にしか無い」新しい M シリーズ専用命令が含まれないこと
 *    (`otool -tV`)
 *
 * 2 が無いと `-DGGML_NATIVE=OFF` の付け忘れや古いビルド成果物の残留を誰も検知できない。
 * ggml は native ビルドだと `-mcpu=native+dotprod+i8mm+nosve+sme` で最適化され、
 * i8mm(M2 以降)や SME(M4 以降)の命令が入る。これらは M1 に存在しないため
 * 配布先で **SIGILL(不正命令)で即クラッシュ**する。しかも署名・公証・staple は
 * 何事もなく通るので、実機で起動するまで誰も気づけない。
 *
 * 実行は `npm run verify:arm64 -w backend`(= root の `npm run dist` チェーン)から
 * 呼ばれる前提だが、パスはこのファイルの位置から算出するのでどこから叩いてもよい。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const WHISPER_CLI = resolve(
  repoRoot,
  'backend/vendor/node_modules/nodejs-whisper/cpp/whisper.cpp/build/bin/whisper-cli',
)
const FFMPEG = resolve(repoRoot, 'backend/vendor/node_modules/ffmpeg-static/ffmpeg')

/**
 * 「Apple Silicon の共通基盤(apple-m1)には無い」命令ニーモニックの接頭辞。
 * - i8mm (ARMv8.6, M2/A15 以降): smmla / ummla / usmmla / usdot / sudot
 * - bf16 (ARMv8.6, M2/A15 以降): bfmmla / bfdot / bfcvt(n)(2) / bfmlal(b|t)
 * - SME  (M4 以降):              smstart / smstop
 *
 * 末尾は接頭辞一致にする(`bfcvtn2` や `bfmlalb` のような派生を取りこぼさないため)。
 * 先頭の `\b` は残す: otool は分岐先のシンボル名(`_ggml_gemm_..._smmla` 等)も
 * 出力するが、`_` は単語構成文字なので語境界にならず誤検知しない。
 * 16進バイト列(0-9a-f)にはこれらの綴りは現れない。
 */
const FORBIDDEN_MNEMONIC_PREFIXES = [
  'smmla',
  'ummla',
  'usmmla',
  'usdot',
  'sudot',
  'bfmmla',
  'bfdot',
  'bfcvt',
  'bfmlal',
  'smstart',
  'smstop',
]

function fail(message) {
  console.error(`\nFAIL: ${message}\n`)
  process.exit(1)
}

function checkArm64(target) {
  if (!existsSync(target)) {
    fail(
      `${target} が存在しません。先に prep スクリプト(prep:vendor / prep:vendor:whisper-cli)を実行してください。`,
    )
  }
  const info = execFileSync('file', [target]).toString()
  if (!info.includes('arm64')) {
    fail(`${target} is not arm64:\n  ${info.trim()}`)
  }
  console.log(`OK arm64: ${target}`)
}

function checkNoNewerMSeriesInstructions(target) {
  // otool の出力は 15MB 程度。シェルのパイプ(`otool | grep -c`)にすると
  // 終了ステータスが grep のものになり、otool 側の失敗(CLT 未導入など)が
  // 「マッチ 0 件 = OK」に化けてしまうため、Node 側で受けて数える。
  const out = spawnSync('otool', ['-tV', target], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  })
  if (out.error || out.status !== 0) {
    fail(
      `otool -tV の実行に失敗しました (${out.error?.message ?? `exit ${out.status}`})。\n` +
        '  命令セット検証を飛ばすと M1/M2 で SIGILL するバイナリをそのまま配布してしまうため、' +
        'ここで停止します。\n' +
        '  Xcode Command Line Tools を入れてください: xcode-select --install',
    )
  }
  const disassembly = out.stdout ?? ''
  // 逆アセンブルが空/極端に短い = 何かがおかしい(検証できていない)ので信用しない。
  if (disassembly.length < 1024) {
    fail(
      `otool -tV の出力が空です(${disassembly.length} bytes)。命令セットを検証できません: ${target}`,
    )
  }

  const found = FORBIDDEN_MNEMONIC_PREFIXES.map((prefix) => {
    const matches = disassembly.match(new RegExp(`\\b${prefix}[a-z0-9]*\\b`, 'g'))
    return matches && matches.length > 0 ? `${prefix}*=${matches.length}` : null
  }).filter(Boolean)

  if (found.length > 0) {
    fail(
      `${target} にビルド機専用の命令が含まれています (${found.join(' ')})。\n` +
        '  これらは i8mm(M2 以降) / bf16(M2 以降) / SME(M4 以降)の命令で、M1 には存在しません。\n' +
        '  このまま配布すると M1 Mac で起動直後に SIGILL(不正命令)でクラッシュします。\n' +
        '  署名・公証・staple はすべて通ってしまうため、この検証が唯一の防波堤です。\n\n' +
        '  対処: whisper.cpp を -DGGML_NATIVE=OFF 付きで作り直してください。\n' +
        '    npm run prep:vendor:whisper-cli -w backend\n' +
        '  (このスクリプトは build/ を消してから作り直します。数分かかります)',
    )
  }
  console.log(`OK ISA (no i8mm/bf16/SME-only instructions): ${target}`)
}

checkArm64(FFMPEG)
checkArm64(WHISPER_CLI)
checkNoNewerMSeriesInstructions(WHISPER_CLI)
console.log('\nすべての同梱バイナリ検証に成功しました。')

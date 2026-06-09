/* eslint-disable */
// electron-builder の afterPack フックで呼ばれる。
// Speaky.app の中の backend-template 配下にある同梱ネイティブバイナリ・dylib・.so を
// すべて Developer ID で個別に署名し直す。
// (electron-builder の自動署名は .app 内をスキャンするが、extraResources 配下の
//  深い階層は取りこぼすことがあるため、確実性を上げる目的)

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// 署名失敗の許容しきい値。どちらか一方でも超えたら例外を投げて中断する保守側の判定。
// 目的は「サイレントに大量の署名漏れが起きたまま notarize に進んで reject される事故」の防止。
// - 比率: 対象が多いとき (.so/.dylib 多数) でも漏れ率で頭打ち
// - 絶対数: 対象が少ないときに比率ガードが緩すぎる問題を補う (例: 10件中1件は 10% を満たさない)
const SIGN_FAILURE_THRESHOLD_RATIO = 0.1;
const SIGN_FAILURE_THRESHOLD_COUNT = 3;

// 拡張子無しでも署名対象に含めたい既知の実行ファイル名 (chmod +x が落ちていても拾える保険)。
// prep スクリプトで vendor されるバイナリと、ffmpeg-static / nodejs-whisper / electron-ollama の同梱物。
const KNOWN_EXECUTABLE_NAMES = new Set([
  'ffmpeg',
  'ffprobe',
  'whisper-cli',
  'ollama',
  'llama-server',
  'llama-cli',
  'llama-quantize',
  'llama-tokenize',
]);

/**
 * 指定パス配下を再帰的に走査し、Mach-O 形式のファイルを列挙する。
 * - 拡張子で .dylib / .so / .node を拾う
 * - 実行ビット付き or 拡張子なしの場合は `file(1)` で Mach-O 判定
 */
function findMachOFiles(rootDir) {
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue; // symlink は対象本体側で署名される
      if (ent.isDirectory()) {
        // .app は electron-builder 側で署名されるのでスキップ
        if (ent.name.endsWith('.app')) continue;
        walk(full);
        continue;
      }
      if (!ent.isFile()) continue;

      const lower = ent.name.toLowerCase();
      const isLibByExt = lower.endsWith('.dylib') || lower.endsWith('.so') || lower.endsWith('.node');

      if (isLibByExt) {
        results.push(full);
        continue;
      }

      // 既知の実行ファイル名は実行ビットの状態に関わらず Mach-O 判定にかける
      // (prep スクリプトで実行ビットが落ちていても署名漏れしないようにする保険)
      const isKnownExe = KNOWN_EXECUTABLE_NAMES.has(ent.name);

      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      // 既知名でなければ実行ビットでフィルタ (大量のテキストファイル等を file(1) で叩かないため)
      if (!isKnownExe && (stat.mode & 0o111) === 0) continue;

      try {
        const out = execFileSync('/usr/bin/file', ['-b', full], { encoding: 'utf8' });
        if (/Mach-O/.test(out)) results.push(full);
      } catch {
        /* file が無い環境はスキップ */
      }
    }
  }

  walk(rootDir);
  return results;
}

async function afterPack(context) {
  // macOS かつ Developer ID 署名する場合のみ動作
  if (context.electronPlatformName !== 'darwin') return;

  // electron-builder の identity が null の場合 (= 署名しない設定) は何もしない
  const macConfig = context.packager.config.mac || {};
  if (macConfig.identity === null) {
    console.log('[afterPack] mac.identity=null のため同梱バイナリ署名をスキップ');
    return;
  }

  // 署名 ID は package.json の build.mac.identity を真実とする (二重管理を避ける)。
  // electron-builder の規約: identity は "Developer ID Application:" プレフィクスを付けない名前のみ
  // (electron-builder 側で自動付与してキーチェーン検索する)。
  // 一方 codesign コマンドはフルネームを推奨するため、無ければここで付与する。
  const identityRaw = macConfig.identity;
  if (!identityRaw || typeof identityRaw !== 'string') {
    throw new Error(`[afterPack] mac.identity が文字列で設定されていません: ${identityRaw}`);
  }
  const identity = identityRaw.startsWith('Developer ID')
    ? identityRaw
    : `Developer ID Application: ${identityRaw}`;

  const appOutDir = context.appOutDir; // 例: .../dist-app/mac-arm64
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const resourcesDir = path.join(appOutDir, appName, 'Contents', 'Resources');
  const targetRoot = path.join(resourcesDir, 'backend-template');

  if (!fs.existsSync(targetRoot)) {
    console.log(`[afterPack] backend-template が見つからずスキップ: ${targetRoot}`);
    return;
  }

  const entitlements = path.resolve(__dirname, '..', 'build', 'entitlements.mac.plist');
  if (!fs.existsSync(entitlements)) {
    throw new Error(`[afterPack] entitlements が見つかりません: ${entitlements}`);
  }

  const targets = findMachOFiles(targetRoot);
  console.log(`[afterPack] 同梱バイナリ署名対象: ${targets.length} files`);

  // 並び替えの目的: 深いネストにある対象から先に署名する (見た目の整然性のため)。
  // 注意: codesign 自体は依存ライブラリの署名状態を要求しないので、順序は実害には影響しない。
  targets.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);

  const failed = []; // 署名失敗を蓄積。閾値を超えたら最後に例外を投げる。

  for (const f of targets) {
    try {
      // chmod +x を確実に立てる (prep スクリプト経由で実行ビットが落ちている場合の保険)。
      // 実行ファイルでない dylib/so でも害は無いので一律に立てる。
      try {
        fs.chmodSync(f, 0o755);
      } catch {
        /* read-only FS など想定外。続行 */
      }

      // 注: codesign の --entitlements は実行可能 Mach-O にのみ意味があり、
      // dylib / .so / bundle されていない .node には埋め込まれない (codesign 側で無視される)。
      // 簡素化のため一律に渡し、実行ファイルにだけ有効、という前提で運用する。
      execFileSync(
        '/usr/bin/codesign',
        [
          '--force',
          '--timestamp',
          '--options',
          'runtime',
          '--entitlements',
          entitlements,
          '--sign',
          identity,
          f,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (e) {
      // 一部の .so が署名できない場合があるため、エラーは可視化しつつ続行
      console.warn(`[afterPack] 署名失敗 (続行): ${f}`);
      console.warn(`  reason: ${e.message?.split('\n')[0]}`);
      failed.push(f);
    }
  }

  if (failed.length > 0) {
    const ratio = failed.length / Math.max(targets.length, 1);
    console.warn(
      `[afterPack] 署名失敗: ${failed.length}/${targets.length} (${(ratio * 100).toFixed(1)}%)`,
    );
    failed.forEach((f) => console.warn(`  - ${f}`));
    // 閾値超過は notarize 段階での reject を意味するので、ここで止めてビルド時間を浪費しない。
    if (
      failed.length >= SIGN_FAILURE_THRESHOLD_COUNT ||
      ratio >= SIGN_FAILURE_THRESHOLD_RATIO
    ) {
      throw new Error(
        `[afterPack] 署名失敗数が許容範囲を超えました (count=${failed.length}, ratio=${ratio.toFixed(3)})。 ` +
          `notarize が確実に reject されるため、ここで中断します。原因を調査して KNOWN_EXECUTABLE_NAMES または filter を見直してください。`,
      );
    }
  }

  console.log(`[afterPack] 同梱バイナリ署名完了`);
}

module.exports = afterPack;
module.exports.default = afterPack;

/* eslint-disable */
// electron-builder の afterSign フックで呼ばれる。
// .app の署名が終わったあとに notarytool で Apple に公証申請する。
//
// 認証情報は事前に keychain に保存しておく:
//   xcrun notarytool store-credentials "speaky-notarize" \
//     --apple-id "<your-apple-id>" --team-id "DQ7HKL3WWX"
//
// スキップ条件:
//   - SPEAKY_SKIP_NOTARIZE=1 が設定されている (開発時のローカルテストビルド用)
//   - electron-builder の mac.identity が null (= 署名していない)

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const KEYCHAIN_PROFILE = process.env.SPEAKY_NOTARY_PROFILE || 'speaky-notarize';

async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  if (process.env.SPEAKY_SKIP_NOTARIZE === '1') {
    console.log('[afterSign] SPEAKY_SKIP_NOTARIZE=1 のため公証をスキップ');
    return;
  }

  const macConfig = context.packager.config.mac || {};
  if (macConfig.identity === null) {
    console.log('[afterSign] mac.identity=null のため公証をスキップ');
    return;
  }

  const appOutDir = context.appOutDir;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(appOutDir, appName);

  if (!fs.existsSync(appPath)) {
    throw new Error(`[afterSign] .app が見つかりません: ${appPath}`);
  }

  // 公証申請に zip でアップロードするのが Apple 公式の推奨フロー。
  // notarytool は .app ディレクトリも直接受け付けるが、内部的に zip に固める。
  const zipPath = path.join(appOutDir, `${context.packager.appInfo.productFilename}.zip`);
  console.log(`[afterSign] zip 作成: ${zipPath}`);
  // ditto は macOS 標準で、拡張属性とシンボリックリンクを保持して zip 化する。
  // execFileSync で引数を分離してシェル経由を避ける(パスに " や $ を含むケースの保険)。
  execFileSync(
    '/usr/bin/ditto',
    ['-c', '-k', '--keepParent', appPath, zipPath],
    { stdio: 'inherit' },
  );

  console.log(`[afterSign] notarytool submit を実行 (数分〜十数分待つ)...`);
  let submitOutput = '';
  try {
    submitOutput = execFileSync(
      '/usr/bin/xcrun',
      [
        'notarytool',
        'submit',
        zipPath,
        '--keychain-profile',
        KEYCHAIN_PROFILE,
        '--wait',
        '--output-format',
        'json',
      ],
      { encoding: 'utf8' },
    );
    console.log(submitOutput);
  } catch (e) {
    // 失敗時は notarytool log で詳細を取得して表示すると原因究明が劇的に楽になる
    console.error(`[afterSign] notarize 失敗。stdout:\n${e.stdout || ''}`);
    const stdout = String(e.stdout || '');
    const idMatch = stdout.match(/"id"\s*:\s*"([0-9a-f-]+)"/i);
    if (idMatch) {
      console.error(`[afterSign] submission id=${idMatch[1]} のログを取得します...`);
      try {
        execFileSync(
          '/usr/bin/xcrun',
          ['notarytool', 'log', idMatch[1], '--keychain-profile', KEYCHAIN_PROFILE],
          { stdio: 'inherit' },
        );
      } catch {
        /* ログ取得自体が失敗しても本体エラーを優先 */
      }
    }
    throw e;
  } finally {
    // zip は中間ファイル。失敗しても残さない
    try {
      fs.unlinkSync(zipPath);
    } catch {
      /* noop */
    }
  }

  console.log(`[afterSign] stapler で .app に公証チケットを焼き込み`);
  execFileSync('/usr/bin/xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });

  // DMG の公証 + staple は afterAllArtifactBuild-staple-dmg.cjs で別途行う。
  // (.app と DMG はそれぞれ別の Apple チケットが必要)
  console.log(`[afterSign] 公証完了`);
}

module.exports = afterSign;
module.exports.default = afterSign;

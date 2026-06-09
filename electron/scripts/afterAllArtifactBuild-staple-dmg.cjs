/* eslint-disable */
// electron-builder の afterAllArtifactBuild フックで呼ばれる。
// 生成された DMG を Apple に公証申請し、成功後に DMG 自体に公証チケットを焼き込む。
//
// 補足: .app 単体には afterSign で既に公証チケットを staple 済みなので、
// DMG を staple しなくても DMG をマウントして起動するパスでは Gatekeeper を通る。
// ただし「DMG をマウントせず Finder 上で右クリック検証」「完全オフラインでの
// 初回 spctl 検証」では DMG 自身が staple されている方が確実なので、ここで行う。

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const KEYCHAIN_PROFILE = process.env.SPEAKY_NOTARY_PROFILE || 'speaky-notarize';

module.exports = async function afterAllArtifactBuild(context) {
  if (process.env.SPEAKY_SKIP_NOTARIZE === '1') {
    console.log('[afterAllArtifactBuild] SPEAKY_SKIP_NOTARIZE=1 のため DMG 公証/staple をスキップ');
    return [];
  }

  // mac.identity=null (= 未署名ビルド) でビルドした場合、未署名 DMG を公証申請しても
  // Apple 側で必ず reject される。他フック (afterPack/afterSign) と挙動を揃えてスキップする。
  // context のシェイプは electron-builder のバージョンで揺れるので、複数経路で identity を探す。
  const macConfig =
    context?.packager?.config?.mac ||
    context?.configuration?.mac ||
    context?.config?.mac ||
    null;
  if (!macConfig) {
    // どの経路でも mac config を取れない = electron-builder のシェイプが想定外。
    // この状態で公証申請に進むと未署名ビルド時に Apple へ無駄な reject 申請を投げる事故になるため、
    // 保守的にスキップする。署名・公証必須のリリースビルドではログを見て調査する想定。
    console.warn(
      '[afterAllArtifactBuild] mac config が context から取得できないため DMG 公証/staple をスキップ ' +
        '(electron-builder のバージョン変更で context のシェイプが変わった可能性)',
    );
    return [];
  }
  if (macConfig.identity === null) {
    console.log('[afterAllArtifactBuild] mac.identity=null のため DMG 公証/staple をスキップ');
    return [];
  }

  // electron-builder の afterAllArtifactBuild は context オブジェクトを受け取り、
  // 生成物パス一覧は context.artifactPaths にある。
  const artifactPaths = (context && context.artifactPaths) || [];
  const dmgs = artifactPaths.filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) {
    console.log('[afterAllArtifactBuild] DMG が見つからずスキップ');
    return [];
  }

  for (const dmg of dmgs) {
    const name = path.basename(dmg);
    console.log(`[afterAllArtifactBuild] DMG を公証申請: ${name} (数分待つ)...`);

    try {
      execFileSync(
        '/usr/bin/xcrun',
        [
          'notarytool',
          'submit',
          dmg,
          '--keychain-profile',
          KEYCHAIN_PROFILE,
          '--wait',
          '--output-format',
          'json',
        ],
        { stdio: 'inherit' },
      );
    } catch (e) {
      console.error(`[afterAllArtifactBuild] DMG の公証申請に失敗: ${name}`);
      throw e;
    }

    console.log(`[afterAllArtifactBuild] stapler で DMG に公証チケットを焼き込み: ${name}`);
    execFileSync('/usr/bin/xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
  }

  // 追加で生成したファイルは無いので空配列
  return [];
};

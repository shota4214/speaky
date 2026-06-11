/**
 * Speaky の version は `0.0.7` のような単純な x.y.z 形式（pre-release は使わない）。
 * フル semver パーサは過剰なので、必要十分の比較関数を自前で用意する。
 * 不正な文字列が来たら 0 として扱う（前方互換）。
 */
function parsePart(raw: string): number {
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function toTriple(version: string): [number, number, number] {
  const parts = version.trim().replace(/^v/, '').split('.')
  return [parsePart(parts[0] ?? '0'), parsePart(parts[1] ?? '0'), parsePart(parts[2] ?? '0')]
}

/**
 * a が b より新しければ正、古ければ負、同じなら 0。
 */
export function compareVersions(a: string, b: string): number {
  const [a1, a2, a3] = toTriple(a)
  const [b1, b2, b3] = toTriple(b)
  if (a1 !== b1) return a1 - b1
  if (a2 !== b2) return a2 - b2
  return a3 - b3
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

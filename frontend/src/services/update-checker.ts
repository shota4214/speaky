import { isNewerVersion } from '../utils/version-compare'

/**
 * 公開している latest.json の URL。リポジトリ同梱のため main ブランチに置く。
 * リリース手順は update-channel/README.md を参照。
 */
const LATEST_JSON_URL =
  'https://raw.githubusercontent.com/shota4214/speaky/main/update-channel/latest.json'

export interface UpdateInfo {
  version: string
  releasedAt?: string
  downloadUrl: string
  releaseNotesUrl?: string
  summary?: string
}

/**
 * latest.json の URL は https のみ許可する。
 * もし悪意ある PR が `javascript:` や custom-scheme を仕込んでも、
 * shell.openExternal に渡る前にここで弾く。
 */
function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isUpdateInfo(x: unknown): x is UpdateInfo {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  if (typeof r.version !== 'string') return false
  if (!isHttpsUrl(r.downloadUrl)) return false
  // releaseNotesUrl は optional だが、ある場合は https でなければ拒否
  if (r.releaseNotesUrl !== undefined && !isHttpsUrl(r.releaseNotesUrl)) return false
  return true
}

/**
 * 公開メタデータを fetch して現在の version と比較する。
 * - ネットワーク失敗や JSON 破損はサイレントに null を返す(オフライン起動を壊さない)
 * - candidate ≤ current の場合も null(ダウングレード方向には通知しない)
 * - skippedVersion と一致した場合も null(ユーザーが明示的にスキップした版)
 */
export async function checkForUpdate(options: {
  currentVersion: string
  skippedVersion: string | null
  signal?: AbortSignal
}): Promise<UpdateInfo | null> {
  let res: Response
  try {
    res = await fetch(LATEST_JSON_URL, {
      cache: 'no-store',
      signal: options.signal,
    })
  } catch (e) {
    console.warn('[update-checker] fetch failed (offline?):', e)
    return null
  }

  if (!res.ok) {
    console.warn(`[update-checker] non-OK status: ${res.status}`)
    return null
  }

  let payload: unknown
  try {
    payload = await res.json()
  } catch (e) {
    console.warn('[update-checker] JSON parse failed:', e)
    return null
  }

  if (!isUpdateInfo(payload)) {
    console.warn('[update-checker] payload shape mismatch:', payload)
    return null
  }

  if (!isNewerVersion(payload.version, options.currentVersion)) return null
  if (options.skippedVersion && payload.version === options.skippedVersion) return null

  return payload
}

/**
 * 「このバージョンをスキップ」の永続化。設定本体(useSettingsStore)に混ぜると
 * マイグレーションが必要になるので、独立した localStorage キーで持つ。
 */
const SKIPPED_VERSION_KEY = 'speaky:update:skippedVersion'

export function getSkippedVersion(): string | null {
  if (typeof globalThis.localStorage === 'undefined') return null
  try {
    return localStorage.getItem(SKIPPED_VERSION_KEY)
  } catch {
    return null
  }
}

export function setSkippedVersion(version: string): void {
  if (typeof globalThis.localStorage === 'undefined') return
  try {
    localStorage.setItem(SKIPPED_VERSION_KEY, version)
  } catch {
    // ignore
  }
}

import { isNewerVersion } from '../utils/version-compare'

/**
 * 公開している latest.json の URL。リポジトリ同梱のため main ブランチに置く。
 * リリース手順は update-channel/README.md を参照。
 */
const LATEST_JSON_URL =
  'https://raw.githubusercontent.com/shota4214/speaky/main/update-channel/latest.json'

/**
 * 起動ごとに無条件で raw.githubusercontent.com を叩かないためのスロットリング窓。
 * Speaky の謳い文句「データ外部送信なし／完全ローカル」との緊張を緩める目的。
 * バージョン通知用の GET なので IP/User-Agent 以上の情報は出ないが、頻度は最小に。
 */
const CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000 // 24h

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
 * - 24h 以内にチェック済みなら通信せず null を返す(force=true でバイパス可能)
 * - ネットワーク失敗や JSON 破損はサイレントに null を返す(オフライン起動を壊さない)
 * - candidate ≤ current の場合も null(ダウングレード方向には通知しない)
 * - skippedVersion / dismissedVersion と一致した場合も null
 *   (skip は永続的、dismiss は同セッション中のみ)
 * - force=true の時は throttle / version 比較 / skip / dismiss を全部バイパスして
 *   常に最新の payload を返す(dev での表示確認用)
 */
export async function checkForUpdate(options: {
  currentVersion: string
  skippedVersion: string | null
  dismissedVersion?: string | null
  signal?: AbortSignal
  force?: boolean
  now?: number
}): Promise<UpdateInfo | null> {
  const now = options.now ?? Date.now()

  if (!options.force) {
    const last = getLastCheckedAt()
    if (last !== null && now - last < CHECK_THROTTLE_MS) return null
  }

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

  // shape 検証まで通過した時点で「直近チェック済み」扱いにする。
  // (HTTP 失敗 / JSON 破損 / shape 不一致は throttle を更新せず、次回起動で再試行する)
  setLastCheckedAt(now)

  if (options.force) return payload

  if (!isNewerVersion(payload.version, options.currentVersion)) return null
  if (options.skippedVersion && payload.version === options.skippedVersion) return null
  if (options.dismissedVersion && payload.version === options.dismissedVersion) return null

  return payload
}

/**
 * 「このバージョンをスキップ」の永続化。設定本体(useSettingsStore)に混ぜると
 * マイグレーションが必要になるので、独立した localStorage キーで持つ。
 */
const SKIPPED_VERSION_KEY = 'speaky:update:skippedVersion'

/**
 * 「あとで」を押した版。skip と違って同セッション中だけ抑制したいので
 * sessionStorage を使う。次回アプリ起動時にはまた通知される。
 */
const DISMISSED_VERSION_KEY = 'speaky:update:dismissedVersion'

/**
 * 直近のチェック時刻(ms epoch)。24h スロットリングの基準。
 */
const LAST_CHECKED_AT_KEY = 'speaky:update:lastCheckedAt'

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

export function getDismissedVersion(): string | null {
  if (typeof globalThis.sessionStorage === 'undefined') return null
  try {
    return sessionStorage.getItem(DISMISSED_VERSION_KEY)
  } catch {
    return null
  }
}

export function setDismissedVersion(version: string): void {
  if (typeof globalThis.sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(DISMISSED_VERSION_KEY, version)
  } catch {
    // ignore
  }
}

function getLastCheckedAt(): number | null {
  if (typeof globalThis.localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(LAST_CHECKED_AT_KEY)
    if (!raw) return null
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function setLastCheckedAt(ms: number): void {
  if (typeof globalThis.localStorage === 'undefined') return
  try {
    localStorage.setItem(LAST_CHECKED_AT_KEY, String(ms))
  } catch {
    // ignore
  }
}

/**
 * dev 環境で `?force-update-check=1` が付いていれば force モードを返す。
 * 本番ビルド(import.meta.env.DEV === false)では常に false。
 */
export function isForceCheckRequested(): boolean {
  if (!import.meta.env.DEV) return false
  if (typeof globalThis.location === 'undefined') return false
  try {
    const params = new URLSearchParams(location.search)
    return params.get('force-update-check') === '1'
  } catch {
    return false
  }
}

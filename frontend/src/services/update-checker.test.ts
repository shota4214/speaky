import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkForUpdate,
  getDismissedVersion,
  getSkippedVersion,
  setDismissedVersion,
  setSkippedVersion,
} from './update-checker'

const VALID_PAYLOAD = {
  version: '0.0.8',
  releasedAt: '2026-06-15',
  downloadUrl: 'https://example.com/speaky.dmg',
  releaseNotesUrl: 'https://github.com/shota4214/speaky/releases/tag/v0.0.8',
  summary: 'test release',
}

function mockFetch(payload: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(payload),
    }),
  )
}

function mockFetchReject(err: Error): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err))
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('checkForUpdate', () => {
  it('returns the payload when a newer version is published', async () => {
    mockFetch(VALID_PAYLOAD)
    const result = await checkForUpdate({
      currentVersion: '0.0.7',
      skippedVersion: null,
      now: 1_000_000,
    })
    expect(result?.version).toBe('0.0.8')
  })

  it('returns null when current is up to date', async () => {
    mockFetch({ ...VALID_PAYLOAD, version: '0.0.7' })
    const result = await checkForUpdate({
      currentVersion: '0.0.7',
      skippedVersion: null,
      now: 1_000_000,
    })
    expect(result).toBeNull()
  })

  it('returns null when the user has skipped the same version', async () => {
    mockFetch(VALID_PAYLOAD)
    const result = await checkForUpdate({
      currentVersion: '0.0.7',
      skippedVersion: '0.0.8',
      now: 1_000_000,
    })
    expect(result).toBeNull()
  })

  it('returns null when the user has dismissed the same version this session', async () => {
    mockFetch(VALID_PAYLOAD)
    const result = await checkForUpdate({
      currentVersion: '0.0.7',
      skippedVersion: null,
      dismissedVersion: '0.0.8',
      now: 1_000_000,
    })
    expect(result).toBeNull()
  })

  it('rejects non-https downloadUrl (security guard)', async () => {
    mockFetch({ ...VALID_PAYLOAD, downloadUrl: 'javascript:alert(1)' })
    const result = await checkForUpdate({
      currentVersion: '0.0.7',
      skippedVersion: null,
      now: 1_000_000,
    })
    expect(result).toBeNull()
  })

  it('rejects http (non-tls) downloadUrl', async () => {
    mockFetch({ ...VALID_PAYLOAD, downloadUrl: 'http://example.com/speaky.dmg' })
    const result = await checkForUpdate({
      currentVersion: '0.0.7',
      skippedVersion: null,
      now: 1_000_000,
    })
    expect(result).toBeNull()
  })

  it('rejects non-https releaseNotesUrl when present', async () => {
    mockFetch({ ...VALID_PAYLOAD, releaseNotesUrl: 'javascript:alert(1)' })
    const result = await checkForUpdate({
      currentVersion: '0.0.7',
      skippedVersion: null,
      now: 1_000_000,
    })
    expect(result).toBeNull()
  })

  it('returns null and stays silent on network failure (offline)', async () => {
    mockFetchReject(new Error('offline'))
    const result = await checkForUpdate({
      currentVersion: '0.0.7',
      skippedVersion: null,
      now: 1_000_000,
    })
    expect(result).toBeNull()
  })

  it('returns null on non-OK HTTP status', async () => {
    mockFetch({}, false, 404)
    const result = await checkForUpdate({
      currentVersion: '0.0.7',
      skippedVersion: null,
      now: 1_000_000,
    })
    expect(result).toBeNull()
  })

  it('skips fetch entirely when checked within the throttle window (24h)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(VALID_PAYLOAD),
    })
    vi.stubGlobal('fetch', fetchSpy)

    // 1 回目: フェッチが走る
    await checkForUpdate({ currentVersion: '0.0.7', skippedVersion: null, now: 1_000_000 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // 23h 後: throttle 内なのでフェッチしない
    const TWENTY_THREE_HOURS = 23 * 60 * 60 * 1000
    await checkForUpdate({
      currentVersion: '0.0.7',
      skippedVersion: null,
      now: 1_000_000 + TWENTY_THREE_HOURS,
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // 24h + 1ms 後: throttle 切れて再フェッチ
    const PAST_THROTTLE = 24 * 60 * 60 * 1000 + 1
    await checkForUpdate({
      currentVersion: '0.0.7',
      skippedVersion: null,
      now: 1_000_000 + PAST_THROTTLE,
    })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('force=true bypasses throttle, version compare, skip, and dismiss', async () => {
    mockFetch(VALID_PAYLOAD)
    // throttle を「ついさっき」に
    localStorage.setItem('speaky:update:lastCheckedAt', '1000000')
    const result = await checkForUpdate({
      currentVersion: '0.0.8', // 同じ版でも通る
      skippedVersion: '0.0.8', // skip されていても通る
      dismissedVersion: '0.0.8', // dismiss されていても通る
      now: 1_000_001, // throttle 内でも通る
      force: true,
    })
    expect(result?.version).toBe('0.0.8')
  })
})

describe('skip / dismiss persistence', () => {
  it('skip is stored in localStorage', () => {
    setSkippedVersion('0.0.8')
    expect(getSkippedVersion()).toBe('0.0.8')
    expect(localStorage.getItem('speaky:update:skippedVersion')).toBe('0.0.8')
  })

  it('dismiss is stored in sessionStorage (not localStorage)', () => {
    setDismissedVersion('0.0.8')
    expect(getDismissedVersion()).toBe('0.0.8')
    expect(sessionStorage.getItem('speaky:update:dismissedVersion')).toBe('0.0.8')
    expect(localStorage.getItem('speaky:update:dismissedVersion')).toBeNull()
  })
})

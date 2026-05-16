import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

// 起動時に生成、または ADMIN_TOKEN env で固定。
// management API(モデル pull/delete/build等)の認可に使う。
// CORS allowlist と組み合わせて、cross-origin/no-origin 両方を防ぐ。
const TOKEN = process.env.ADMIN_TOKEN || randomBytes(32).toString('hex')

export function getAdminToken(): string {
  return TOKEN
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers['x-admin-token']
  if (provided !== TOKEN) {
    res.status(401).json({ error: 'admin token required' })
    return
  }
  next()
}

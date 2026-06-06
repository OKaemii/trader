import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy, config } from './proxy'

// proxy() is the portal's auth gate (Next 16's renamed middleware). The contract this
// card (Task 13) delivers: the ENTIRE authed surface is gated — any route that is not in
// `publicRoutes` requires a session, otherwise 307 → /login; an authed user on a public
// route is bounced to /workspace. Before this fix only a 5-route allow-list was protected,
// so the new workspaces rendered an empty shell to unauthenticated callers instead of
// redirecting. These tests pin the matrix so the gap cannot silently reopen.

const SESSION = { headers: { cookie: 'rt=refresh-token; at=access-token' } }

function reqFor(path: string, init?: { headers: { cookie: string } }) {
  return new NextRequest(`http://trader.local${path}`, init)
}

function locationOf(res: ReturnType<typeof proxy>): string | null {
  const loc = res.headers.get('location')
  return loc ? new URL(loc).pathname : null
}

// Every authed route the proxy must now protect — the old 5-route allow-list PLUS the new
// workspaces (the gap this card closes) PLUS a few nested paths to prove startsWith-style
// coverage is unnecessary (a plain "not public" check covers nesting for free).
const AUTHED_ROUTES = [
  '/dashboard',
  '/signals',
  '/research',
  '/universe',
  '/market-data',
  '/workspace',
  '/discover',
  '/build',
  '/portfolio',
  '/operations',
  '/portfolio?tab=performance',
  '/operations/console',
  '/signals/abc123',
  '/risk/trips',
  '/', // the root is also gated; unauth → /login before app/page.tsx runs
]

describe('proxy auth gating (unauthenticated)', () => {
  it.each(AUTHED_ROUTES)('redirects %s to /login when there is no session', (path) => {
    const res = proxy(reqFor(path))
    expect(res.status).toBe(307)
    expect(locationOf(res)).toBe('/login')
  })

  it('lets the public /login route through (no redirect)', () => {
    const res = proxy(reqFor('/login'))
    // NextResponse.next() carries no Location header.
    expect(locationOf(res)).toBeNull()
  })
})

describe('proxy auth gating (authenticated)', () => {
  it.each(AUTHED_ROUTES.filter((p) => p !== '/'))(
    'lets %s through when a session is present',
    (path) => {
      const res = proxy(reqFor(path, SESSION))
      expect(locationOf(res)).toBeNull()
    },
  )

  it('bounces an authenticated user off /login to /workspace', () => {
    const res = proxy(reqFor('/login', SESSION))
    expect(res.status).toBe(307)
    expect(locationOf(res)).toBe('/workspace')
  })

  it('lets an authenticated user reach the root (app/page.tsx then redirects to /workspace)', () => {
    const res = proxy(reqFor('/', SESSION))
    expect(locationOf(res)).toBeNull()
  })
})

describe('proxy matcher', () => {
  const matcher = config.matcher[0]

  it('excludes portal-api so unauth client fetches get their own 401, not a 307 HTML redirect', () => {
    expect(matcher).toContain('portal-api')
  })

  it('keeps _next/static, _next/image, favicon.ico and api excluded', () => {
    for (const skip of ['_next/static', '_next/image', 'favicon.ico', 'api']) {
      expect(matcher).toContain(skip)
    }
  })
})

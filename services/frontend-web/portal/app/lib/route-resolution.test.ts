import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMMANDS } from './command-registry'

// Route-resolution smoke test (Task 16 of the portal-IA redesign — the epic's
// capstone). There is no e2e net (curl can't drive the App Router's client JS and
// `@/`-alias is unresolvable under vitest), so this is the deterministic, offline
// guard that the *static* routing graph is internally consistent:
//
//   1. every COMMANDS href resolves to a real `app/(authed)/.../page.tsx`;
//   2. every deep-linked `?tab=` key exists in that workspace page's `TABS`;
//   3. every old-route redirect stub points at a real workspace?tab;
//   4. the QA-checklist redirect matrix matches the stubs on disk.
//
// It reads the real files via `node:fs` (no module imports of JSX/`@/` modules),
// so it stays green and network-free while catching href/tab/redirect drift the
// moment a route is renamed or a stub is repointed.

// app/lib/ → portal root is two levels up.
const PORTAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AUTHED = join(PORTAL_ROOT, 'app', '(authed)')

/** `page.tsx` path for an authed route segment (e.g. 'portfolio', 'operations/console'). */
function pagePath(routeSegment: string): string {
  return join(AUTHED, routeSegment, 'page.tsx')
}

/** Split a registry/href string into its pathname and `tab` query value. */
function parseHref(href: string): { pathname: string; tab: string | null } {
  const [pathname, query = ''] = href.split('?')
  const tab = new URLSearchParams(query).get('tab')
  return { pathname, tab }
}

/**
 * Extract the declared `?tab=` keys from a workspace page by reading the literal
 * `key: '<x>'` entries of its `TABS as const` array. Pure text scan — no execution,
 * no JSX import. Workspace pages all declare `const TABS = [{ key: '…' }, …]`.
 */
function tabKeysOf(routeSegment: string): string[] {
  const src = readFileSync(pagePath(routeSegment), 'utf8')
  return [...src.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1])
}

/** Extract the single `redirect('<target>')` target from a redirect-stub page. */
function redirectTargetOf(routeSegment: string): string | null {
  const src = readFileSync(pagePath(routeSegment), 'utf8')
  return src.match(/redirect\('([^']+)'\)/)?.[1] ?? null
}

const WORKSPACES = ['workspace', 'discover', 'research', 'build', 'portfolio', 'operations']

describe('command registry hrefs resolve to real routes', () => {
  const navCommands = COMMANDS.filter((c) => c.href)

  it('every nav command pathname has a real (authed) page.tsx', () => {
    for (const cmd of navCommands) {
      const { pathname } = parseHref(cmd.href!)
      // strip the leading slash to get the route segment under (authed)/
      const segment = pathname.replace(/^\//, '')
      expect(existsSync(pagePath(segment)), `${cmd.id} → ${pathname} has no page.tsx`).toBe(true)
    }
  })

  it('every workspace command points at one of the 6 workspace roots', () => {
    // Workspace-root ids are `ws.<name>` (2 dot-parts); tab ids `ws.<name>.<tab>`
    // (3 parts) and action ids `act.<x>` are excluded.
    const roots = COMMANDS.filter((c) => c.id.startsWith('ws.') && c.id.split('.').length === 2)
      .map((c) => parseHref(c.href!).pathname.replace(/^\//, ''))
    expect(roots.sort()).toEqual([...WORKSPACES].sort())
  })

  it('every deep-linked tab href targets a tab declared in that workspace page', () => {
    const tabCommands = navCommands.filter((c) => parseHref(c.href!).tab != null)
    // sanity: the registry actually carries deep-linked tabs (not silently empty)
    expect(tabCommands.length).toBeGreaterThan(10)
    for (const cmd of tabCommands) {
      const { pathname, tab } = parseHref(cmd.href!)
      const segment = pathname.replace(/^\//, '')
      const declared = tabKeysOf(segment)
      expect(declared, `${cmd.id} → ${segment} declares no TABS`).toContain(tab)
    }
  })
})

describe('redirect stubs resolve to a real workspace?tab', () => {
  // The old flat routes that became redirect stubs (Task 8–12). Each must still
  // exist as a page.tsx whose body is a single redirect() to a real workspace?tab.
  const STUBS = [
    'dashboard',
    'positions',
    'signals',
    'scanner',
    'screener',
    'sectors',
    'calendar',
    'charts',
    'universe',
    'market-data',
    'market-data/calendar',
    'strategy-config',
    'alerts',
    'operations/console',
    'operations/performance',
    'operations/risk-limits',
    'operations/trade-audit',
    'operations/reconciliation',
    'operations/tca',
    'risk/trips',
  ]

  it('each stub file exists and redirects', () => {
    for (const stub of STUBS) {
      expect(existsSync(pagePath(stub)), `stub /${stub} missing`).toBe(true)
      expect(redirectTargetOf(stub), `/${stub} is not a redirect stub`).toBeTruthy()
    }
  })

  it("each stub's redirect target is a real workspace root + a declared tab", () => {
    for (const stub of STUBS) {
      const target = redirectTargetOf(stub)!
      const { pathname, tab } = parseHref(target)
      const segment = pathname.replace(/^\//, '')
      expect(WORKSPACES, `/${stub} → ${pathname} is not a workspace`).toContain(segment)
      if (tab != null) {
        expect(tabKeysOf(segment), `/${stub} → ${target} targets an undeclared tab`).toContain(tab)
      }
    }
  })
})

describe('QA-checklist redirect matrix matches the stubs on disk', () => {
  // The exact mapping the epic QA checklist (agent-docs/plans/portal-ia-redesign.md
  // → ## QA Checklist) asserts authenticated. Pin it here so a stub repoint that
  // breaks an email/bookmark fails locally before QA.
  const MATRIX: Record<string, string> = {
    dashboard: '/workspace',
    positions: '/portfolio?tab=positions',
    signals: '/research?tab=signals',
    'operations/console': '/build?tab=console',
    'risk/trips': '/portfolio?tab=trips',
    scanner: '/discover?tab=universe',
  }

  it.each(Object.entries(MATRIX))('/%s redirects to %s', (stub, target) => {
    expect(redirectTargetOf(stub)).toBe(target)
  })
})

describe('dynamic detail routes stay real pages (not redirected)', () => {
  // The notification-email + bookmark targets. These are dynamic segments and MUST
  // render detail, never redirect — a regression here silently 307s an email link.
  it.each([['signals/[id]'], ['risk/trips/[id]']])('%s is a real page', (route) => {
    expect(existsSync(pagePath(route)), `${route} page.tsx missing`).toBe(true)
    expect(redirectTargetOf(route), `${route} must not be a redirect stub`).toBeNull()
  })
})

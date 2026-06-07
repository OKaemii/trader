import { describe, expect, it } from 'vitest'
import { COMMANDS, filterCommands, type Command } from './command-registry'

// A tiny fixed fixture so match/no-match/keyword assertions don't drift when the
// real COMMANDS list grows (Task 16 fills it out). The COMMANDS-integrity checks
// below run against the live registry.
const FIXTURE: Command[] = [
  { id: 'ws.portfolio', label: 'Portfolio', group: 'Go to', href: '/portfolio', keywords: ['pnl', 'equity'] },
  { id: 'ws.portfolio.performance', label: 'Portfolio · Performance', group: 'Go to', href: '/portfolio?tab=performance', keywords: ['drawdown'] },
  { id: 'act.sign-out', label: 'Sign out', group: 'Actions', keywords: ['logout'] },
]

describe('filterCommands', () => {
  it('matches on the visible label (case-insensitive)', () => {
    const out = filterCommands('portfolio', FIXTURE)
    expect(out.map((c) => c.id)).toEqual(['ws.portfolio', 'ws.portfolio.performance'])
  })

  it('returns nothing when no command matches', () => {
    expect(filterCommands('nonexistent-xyz', FIXTURE)).toEqual([])
  })

  it('matches on a keyword that is not in the label', () => {
    // "logout" appears only in keywords, never in the "Sign out" label.
    expect(filterCommands('logout', FIXTURE).map((c) => c.id)).toEqual(['act.sign-out'])
  })

  it('returns the full list unchanged for an empty or whitespace query', () => {
    expect(filterCommands('', FIXTURE)).toEqual(FIXTURE)
    expect(filterCommands('   ', FIXTURE)).toEqual(FIXTURE)
  })

  it('AND-matches across whitespace-separated terms', () => {
    // "port" matches both, "perf" only the performance tab → intersection of one.
    expect(filterCommands('port perf', FIXTURE).map((c) => c.id)).toEqual([
      'ws.portfolio.performance',
    ])
  })

  it('matches on the group heading', () => {
    expect(filterCommands('actions', FIXTURE).map((c) => c.id)).toEqual(['act.sign-out'])
  })

  it('defaults to the real COMMANDS registry when no list is passed', () => {
    expect(filterCommands('performance').some((c) => c.id === 'ws.portfolio.performance')).toBe(true)
  })
})

describe('COMMANDS registry integrity', () => {
  it('exposes a navigation entry for each of the 6 workspaces', () => {
    for (const id of ['workspace', 'discover', 'research', 'build', 'portfolio', 'operations']) {
      const cmd = COMMANDS.find((c) => c.id === `ws.${id}`)
      expect(cmd, `missing workspace command ws.${id}`).toBeDefined()
      expect(cmd?.href).toBe(`/${id}`)
    }
  })

  // The tab keys below mirror the `TABS` arrays in each workspace's page.tsx (the
  // `?tab=` deep-link is matched against those keys via resolveTab). Task 12 reconciled
  // the registry against the now-real routes; this asserts a palette entry exists for
  // every real tab and catches drift if a future card renames a tab key.
  const WORKSPACE_TABS: Record<string, string[]> = {
    discover: ['universe', 'screener', 'sectors', 'calendar'],
    // Relocation (Task 22): Market Data → Operations, Backtests → Build; charts repurposed as
    // the `history` placeholder (Task 23 grows the per-symbol History tab + the rest).
    research: ['history', 'signals'],
    build: ['strategy', 'console', 'alerts', 'backtests'],
    portfolio: ['positions', 'performance', 'risk-limits', 'trips'],
    operations: ['trade-audit', 'reconciliation', 'tca', 'market-data'],
  }

  it('exposes a deep-linked entry for every workspace tab pointing at the real route', () => {
    for (const [ws, tabs] of Object.entries(WORKSPACE_TABS)) {
      for (const tab of tabs) {
        const cmd = COMMANDS.find((c) => c.id === `ws.${ws}.${tab}`)
        expect(cmd, `missing tab command ws.${ws}.${tab}`).toBeDefined()
        expect(cmd?.href, `tab ws.${ws}.${tab} must deep-link the real route`).toBe(
          `/${ws}?tab=${tab}`,
        )
      }
    }
  })

  it('exposes the global actions (toggle mode + sign out)', () => {
    for (const id of ['act.toggle-mode', 'act.sign-out']) {
      const cmd = COMMANDS.find((c) => c.id === id)
      expect(cmd, `missing action command ${id}`).toBeDefined()
      expect(cmd?.group).toBe('Actions')
    }
  })

  it('the Actions group is exactly {toggle-mode, sign-out}', () => {
    // Lock the action set: catches both a dropped action and an untested new one
    // (a new palette action must land with its call-site wiring + a test).
    const actionIds = COMMANDS.filter((c) => c.group === 'Actions').map((c) => c.id).sort()
    expect(actionIds).toEqual(['act.sign-out', 'act.toggle-mode'])
  })

  it('every one of the 6 workspaces has at least one deep-linked tab command', () => {
    // Beyond "the workspace root exists": each workspace must surface ≥1 `?tab=` entry
    // in the palette so a workspace can never silently lose all its deep links on a
    // refactor. (The home `workspace` is a single page with no tabs, so it is exempt.)
    for (const ws of ['discover', 'research', 'build', 'portfolio', 'operations']) {
      const tabCmds = COMMANDS.filter(
        (c) => c.id.startsWith(`ws.${ws}.`) && c.href?.includes('?tab='),
      )
      expect(tabCmds.length, `workspace ${ws} has no deep-linked tab commands`).toBeGreaterThan(0)
    }
  })

  it('has unique command ids', () => {
    const ids = COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('navigation commands carry an href; action commands do not', () => {
    for (const cmd of COMMANDS) {
      if (cmd.group === 'Actions') expect(cmd.href, `action ${cmd.id} should not navigate`).toBeUndefined()
      else expect(cmd.href, `nav command ${cmd.id} needs an href`).toBeTruthy()
    }
  })
})

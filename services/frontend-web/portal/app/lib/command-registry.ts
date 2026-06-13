// Pure command registry for the ⌘K command palette (Task 4 of the portal-IA
// redesign — agent-docs/plans/portal-ia-redesign.md). No React, no DOM, no
// side effects: just the data + a pure filter, so it is trivially unit-testable
// and importable from both the client palette and (later) any server caller.
//
// ROUTE STATUS — read before relying on these hrefs:
// The hrefs below are the *planned* 6-workspace routes (`/workspace`,
// `/discover?tab=…`, `/research?tab=…`, `/build?tab=…`, `/portfolio?tab=…`,
// `/operations?tab=…`). Those routes are created by later cards (Tasks 6–11)
// and the nav/palette is mounted by Task 12. Until then a `router.push` to one
// of these may 404 — that is expected and not a bug in this card. Task 16
// reconciles this list against the real routes (and adds any tab/action that
// shifted) as the epic's final pass.

/**
 * A single palette entry. `href` is the navigation target (cmdk items without an
 * href are non-navigating actions — e.g. toggle mode — wired at the call site by
 * `id`). `keywords` widen fuzzy matching beyond the visible label (synonyms, the
 * old route name) without cluttering the rendered text.
 */
export type Command = {
  id: string
  label: string
  group: string
  href?: string
  keywords?: string[]
}

// Group headings rendered by cmdk. Kept as named constants so the palette and
// any future grouping logic agree on the exact strings.
const GO_TO = 'Go to'
const ACTIONS = 'Actions'

/**
 * Every workspace, its known tabs, and a couple of global actions.
 *
 * Convention: workspace ids are `ws.<name>`, tab ids `ws.<name>.<tab>`, actions
 * `act.<name>`. The tab hrefs use the `?tab=` deep-link convention shared by the
 * whole redesign (see WorkspaceTabs / WorkspaceShell). Labels for tabs read
 * "<Workspace> · <Tab>" so a fuzzy search like "perf" surfaces an unambiguous,
 * fully-qualified destination.
 */
export const COMMANDS: Command[] = [
  // ── Workspaces (top-level) ───────────────────────────────────────────────
  {
    id: 'ws.workspace',
    label: 'Workspace',
    group: GO_TO,
    href: '/workspace',
    keywords: ['home', 'dashboard', 'overview', 'command center'],
  },
  {
    id: 'ws.discover',
    label: 'Discover',
    group: GO_TO,
    href: '/discover',
    keywords: ['universe', 'screener', 'sectors', 'calendar', 'scanner'],
  },
  {
    id: 'ws.research',
    label: 'Research',
    group: GO_TO,
    href: '/research',
    keywords: ['symbol', 'overview', 'signals', 'strategy impact', 'fundamentals', 'history', 'charts', 'price'],
  },
  {
    id: 'ws.build',
    label: 'Build',
    group: GO_TO,
    href: '/build',
    keywords: ['strategy', 'console', 'operator', 'alerts', 'backtests', 'validation'],
  },
  {
    id: 'ws.portfolio',
    label: 'Portfolio',
    group: GO_TO,
    href: '/portfolio',
    keywords: ['positions', 'performance', 'risk limits', 'circuit trips', 'equity', 'pnl'],
  },
  {
    id: 'ws.operations',
    label: 'Operations',
    group: GO_TO,
    href: '/operations',
    keywords: ['trade audit', 'reconciliation', 'tca', 'market data', 'poll', 'calendar', 'holidays'],
  },

  // ── Discover tabs ─────────────────────────────────────────────────────────
  { id: 'ws.discover.universe', label: 'Discover · Universe', group: GO_TO, href: '/discover?tab=universe', keywords: ['instruments', 'tickers', 'overrides'] },
  { id: 'ws.discover.screener', label: 'Discover · Screener', group: GO_TO, href: '/discover?tab=screener', keywords: ['qmj', 'fundamentals', 'filter'] },
  { id: 'ws.discover.sectors', label: 'Discover · Sectors', group: GO_TO, href: '/discover?tab=sectors', keywords: ['heatmap', 'rotation'] },
  { id: 'ws.discover.calendar', label: 'Discover · Calendar', group: GO_TO, href: '/discover?tab=calendar', keywords: ['earnings', 'events'] },

  // ── Research tabs ─────────────────────────────────────────────────────────
  // The Research workspace is symbol-centric (Task 23): the five question-tabs key off a
  // selected `?symbol=` (the bare `/research?tab=<key>` deep links resolve the tab; with no
  // symbol the page lands on the picker, except `signals`→whole-market feed and `history`→a
  // chart, the /signals + /charts stub targets). Market Data + Backtests relocated to
  // Operations + Build respectively (Task 22).
  { id: 'ws.research.overview', label: 'Research · Overview', group: GO_TO, href: '/research?tab=overview', keywords: ['symbol', 'chart', 'factors', 'summary'] },
  { id: 'ws.research.signals', label: 'Research · Signals', group: GO_TO, href: '/research?tab=signals', keywords: ['feed', 'regime', 'factor exposure', 'betti', 'why'] },
  { id: 'ws.research.strategy-impact', label: 'Research · Strategy Impact', group: GO_TO, href: '/research?tab=strategy-impact', keywords: ['attribution', 'contribution', 'per strategy'] },
  { id: 'ws.research.fundamentals', label: 'Research · Fundamentals', group: GO_TO, href: '/research?tab=fundamentals', keywords: ['financials', 'valuation', 'dividends', 'analyst'] },
  { id: 'ws.research.history', label: 'Research · History', group: GO_TO, href: '/research?tab=history', keywords: ['charts', 'candlestick', 'price', 'ohlc', 'drawdowns', 'corporate actions'] },

  // ── Build tabs ────────────────────────────────────────────────────────────
  { id: 'ws.build.strategy', label: 'Build · Strategy', group: GO_TO, href: '/build?tab=strategy', keywords: ['active strategy', 'params', 'config'] },
  { id: 'ws.build.console', label: 'Build · Console', group: GO_TO, href: '/build?tab=console', keywords: ['operator', 'panic', 'kill switch', 'flatten', 'pause'] },
  { id: 'ws.build.alerts', label: 'Build · Alerts', group: GO_TO, href: '/build?tab=alerts', keywords: ['notifications', 'webhook'] },
  { id: 'ws.build.backtests', label: 'Build · Backtests', group: GO_TO, href: '/build?tab=backtests', keywords: ['validation', 'mcpt', 'pbo', 'walk forward', 'permutation'] },

  // ── Portfolio tabs ────────────────────────────────────────────────────────
  { id: 'ws.portfolio.positions', label: 'Portfolio · Positions', group: GO_TO, href: '/portfolio?tab=positions', keywords: ['holdings', 'open'] },
  { id: 'ws.portfolio.performance', label: 'Portfolio · Performance', group: GO_TO, href: '/portfolio?tab=performance', keywords: ['equity', 'kpis', 'drawdown', 'return'] },
  { id: 'ws.portfolio.risk-limits', label: 'Portfolio · Risk Limits', group: GO_TO, href: '/portfolio?tab=risk-limits', keywords: ['caps', 'concentration', 'turnover', 'thresholds'] },
  { id: 'ws.portfolio.trips', label: 'Portfolio · Circuit Trips', group: GO_TO, href: '/portfolio?tab=trips', keywords: ['circuit breaker', 'halt', 'post-mortem'] },

  // ── Operations tabs ───────────────────────────────────────────────────────
  { id: 'ws.operations.trade-audit', label: 'Operations · Trade Audit', group: GO_TO, href: '/operations?tab=trade-audit', keywords: ['fills', 'executions'] },
  { id: 'ws.operations.reconciliation', label: 'Operations · Reconciliation', group: GO_TO, href: '/operations?tab=reconciliation', keywords: ['recon', 'drift', 'mismatch'] },
  { id: 'ws.operations.tca', label: 'Operations · TCA', group: GO_TO, href: '/operations?tab=tca', keywords: ['transaction cost', 'slippage'] },
  { id: 'ws.operations.market-data', label: 'Operations · Market Data', group: GO_TO, href: '/operations?tab=market-data', keywords: ['bars', 'poll', 'sessions', 'holidays', 'calendar', 'eodhd'] },
  { id: 'ws.operations.fundamentals', label: 'Operations · PIT Fundamentals', group: GO_TO, href: '/operations?tab=fundamentals', keywords: ['fundamentals', 'edgar', 'sec', 'harvester', 'sweep', 'lake', 'pit', 'coverage'] },

  // ── Global actions (no href — handled by id at the call site) ─────────────
  { id: 'act.toggle-mode', label: 'Toggle Beginner / Quant mode', group: ACTIONS, keywords: ['beginner', 'quant', 'complexity', 'simple', 'advanced'] },
  { id: 'act.sign-out', label: 'Sign out', group: ACTIONS, keywords: ['logout', 'log out', 'exit'] },
]

/**
 * Pure, allocation-light substring filter over a command list.
 *
 * - Empty / whitespace-only query → the full list unchanged (the palette's
 *   resting state shows everything).
 * - Otherwise case-insensitive match against the label, the group, and any
 *   keyword. AND-matches across whitespace-separated terms so "port perf"
 *   narrows to "Portfolio · Performance".
 *
 * Note: the live palette also gets cmdk's own fuzzy scoring on the rendered
 * items; this helper is the deterministic, unit-tested contract for callers
 * (and a fallback for any non-cmdk consumer) — not a second ranking engine.
 */
export function filterCommands(query: string, commands: Command[] = COMMANDS): Command[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return commands
  return commands.filter((cmd) => {
    const haystack = [cmd.label, cmd.group, ...(cmd.keywords ?? [])].join(' ').toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

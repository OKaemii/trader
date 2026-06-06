// Pure formatter for the Workspace command-center "Recent Research" snapshot.
// The full validation-reports table lives in components/ResearchView.tsx (the /research
// workspace); the command center only needs a compact at-a-glance row per recent run, so
// this distils a raw `/admin/api/backtest/results` row (shape mirrored from
// components/ValidationReports.tsx's `Report`) into the few display fields the snapshot shows.
// Kept as a pure module so it is unit-testable by relative import (vitest does not resolve the
// `@/` alias — see Task-2/#43 notes).

// Subset of a backtest/validation result row we render in the snapshot. Extra fields on the
// wire are ignored; every field here is optional because historical rows vary by engine.
export interface ResearchResultRow {
  strategy_id?: string
  passed?: boolean
  oos_sharpe?: number | null
  run_at?: string
  engine?: string
  benchmark?: { beats_market?: boolean } | null
}

export interface ResearchSummaryRow {
  strategy: string
  passed: boolean
  verdict: 'PASS' | 'FAIL'
  sharpe: string // formatted to 3dp, or '—' when absent
  beatsMarket: boolean | null // null = no benchmark recorded
  ranAt: string // ISO string passed straight through (formatted at the view boundary)
  engine: string
}

function formatSharpe(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(3) : '—'
}

// Map one raw result row to its snapshot shape. Defensive about missing fields so a partial
// historical row never throws in the server component.
export function summariseResearchRow(row: ResearchResultRow): ResearchSummaryRow {
  const passed = row.passed === true
  return {
    strategy: row.strategy_id?.trim() || 'unknown',
    passed,
    verdict: passed ? 'PASS' : 'FAIL',
    sharpe: formatSharpe(row.oos_sharpe),
    beatsMarket: row.benchmark ? row.benchmark.beats_market === true : null,
    ranAt: row.run_at ?? '',
    engine: row.engine?.trim() || 'replay',
  }
}

// Take the freshest `limit` rows (results come newest-first from the endpoint; we keep that
// order and just cap) and map each. Tolerates a null/missing list.
export function summariseRecentResearch(
  results: ReadonlyArray<ResearchResultRow> | null | undefined,
  limit = 5,
): ResearchSummaryRow[] {
  if (!results || results.length === 0) return []
  return results.slice(0, limit).map(summariseResearchRow)
}

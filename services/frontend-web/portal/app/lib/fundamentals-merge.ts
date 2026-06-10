// Pure merge of the two PIT-fundamentals provenance reads, keyed by T212 ticker, for the Operations
// per-ticker state table (card 149, plan §J). No React / DOM — unit-tested in the node env.
//
// The honesty story is per-ticker, from data that already exists (no new store). Two endpoints both
// key on the T212 ticker (e.g. "AAPL_US_EQ"):
//   - freshness.names[] (fundamentals-ingestion /freshness): the WAREHOUSE side — covered, the fiscal
//     period-end observed, the availability (knowledge) instant, our last-stored-at (the ingest
//     wall-clock), staleness.
//   - source.by_ticker  (strategy-engine /fundamentals-source): the CONSUME side — which source the
//     live cycle read (pit-edgar / yahoo-snapshot / null) and built_at = when it read+built this name.
//
// The two sets can diverge: a name can be in the warehouse but not yet read by a cycle (freshness-only),
// or read by the strategy but absent from the warehouse audit window (source-only). We keep BOTH so the
// operator sees the gap honestly, rather than dropping either side. The merge is a full outer join.

// ── Upstream shapes (snake_case, ms timestamps) — minimal mirrors of the live payloads. ──────────
export interface FreshnessName {
  symbol: string
  ticker: string
  instrument_id: number
  covered: boolean
  newest_period_end: number | null // fiscal period-end (observation_ts)
  newest_knowledge_ts: number | null // availability (knowledge_ts)
  last_stored_at: number | null // MAX(revisions_log.logged_at) — our ingest store clock
  staleness_days: number | null
  stale: boolean
}

// A curated US name that files NOTHING with the SEC (an unsponsored ADR like TCEHY) — excluded from the
// EDGAR-eligible denominator (so never counted `missing`) and surfaced as a documented degrade-to-Yahoo
// exception, mirroring how an LSE/foreign name with no US CIK is already accepted (epic Task A4).
export interface NoEdgarName {
  symbol: string
  reason: string
}

export interface FreshnessAudit {
  // `universe`/`covered`/`missing`/`stale`/`coverage_pct`/`retirable` are over the EDGAR-eligible
  // denominator (curated universe − the no_edgar set); `names[]` carries only the eligible names.
  universe: number
  covered: number
  missing: number
  stale: number
  coverage_pct: number
  retirable: boolean
  // The excluded no-EDGAR exception set (epic Task A4). Optional so an older payload (pre-A4) still
  // parses — absent ⇒ no exceptions surfaced, the panel simply omits the line.
  no_edgar_count?: number
  no_edgar?: NoEdgarName[]
  last_ingest_run: { state?: string; finished_at_ms?: number | null } | null
  names: FreshnessName[]
}

export interface SourceEntry {
  source: string | null // 'pit-edgar' | 'yahoo-snapshot' | null
  built_at: number | null // factor_scores.observation_ts — the strategy read+build instant
}

export interface FundamentalsSource {
  provider: string // effective seam mode: 'pit' | 'yahoo'
  sources: Record<string, number> // raw source → count (a null source is the literal "null" key)
  by_ticker: Record<string, SourceEntry>
  pit_served: number
  last_cycle_ts: number | null
}

// ── The merged per-ticker row (one per ticker present on EITHER side). ────────────────────────────
export interface MergedRow {
  ticker: string
  symbol: string | null // bare symbol from freshness; null when source-only (strategy read it, audit didn't)
  // warehouse / ingest side (freshness)
  inFreshness: boolean
  covered: boolean | null
  fiscalPeriodMs: number | null // observation_ts
  availabilityMs: number | null // knowledge_ts
  lastStoredMs: number | null // ingest store clock
  stalenessDays: number | null
  stale: boolean | null
  // consume side (strategy by_ticker)
  inSource: boolean
  source: string | null // raw source; null source kept distinct from "no source row"
  lastReadBuiltMs: number | null // built_at
}

// Normalise the raw `source` string to the provenance bucket the UI tags by.
// 'pit-edgar*' → PIT (ours); 'yahoo*' → Yahoo (third-party); null / unknown → none.
export type ProvenanceKind = 'pit' | 'yahoo' | 'none'
export function provenanceKind(source: string | null | undefined): ProvenanceKind {
  if (!source) return 'none'
  const s = source.toLowerCase()
  if (s.startsWith('pit')) return 'pit'
  if (s.startsWith('yahoo')) return 'yahoo'
  return 'none'
}

// Full outer join freshness.names ⋈ source.by_ticker on the T212 ticker. Either side may be absent.
export function mergeFundamentalsRows(
  freshness: FreshnessAudit | null,
  source: FundamentalsSource | null,
): MergedRow[] {
  const byTicker = new Map<string, MergedRow>()

  for (const n of freshness?.names ?? []) {
    byTicker.set(n.ticker, {
      ticker: n.ticker,
      symbol: n.symbol,
      inFreshness: true,
      covered: n.covered,
      fiscalPeriodMs: n.newest_period_end,
      availabilityMs: n.newest_knowledge_ts,
      lastStoredMs: n.last_stored_at,
      stalenessDays: n.staleness_days,
      stale: n.stale,
      inSource: false,
      source: null,
      lastReadBuiltMs: null,
    })
  }

  for (const [ticker, entry] of Object.entries(source?.by_ticker ?? {})) {
    const existing = byTicker.get(ticker)
    if (existing) {
      existing.inSource = true
      existing.source = entry.source
      existing.lastReadBuiltMs = entry.built_at
    } else {
      byTicker.set(ticker, {
        ticker,
        symbol: null, // source-only: no warehouse audit row to read the bare symbol from
        inFreshness: false,
        covered: null,
        fiscalPeriodMs: null,
        availabilityMs: null,
        lastStoredMs: null,
        stalenessDays: null,
        stale: null,
        inSource: true,
        source: entry.source,
        lastReadBuiltMs: entry.built_at,
      })
    }
  }

  return [...byTicker.values()]
}

// ── Sorting ───────────────────────────────────────────────────────────────────────────────────────
export type SortKey =
  | 'ticker'
  | 'source'
  | 'covered'
  | 'fiscal'
  | 'availability'
  | 'lastStored'
  | 'lastReadBuilt'
  | 'stale'
export type SortDir = 'asc' | 'desc'

// Comparator value for a row under a sort key. Nulls always sort last (stable across asc/desc by
// pushing them to the high end before the direction flip is applied at the call site).
function sortValue(r: MergedRow, key: SortKey): number | string {
  switch (key) {
    case 'ticker':
      return r.ticker
    case 'source':
      return r.source ?? '￿' // unknown source sorts after named ones
    case 'covered':
      return r.covered ? 1 : 0
    case 'fiscal':
      return r.fiscalPeriodMs ?? -Infinity
    case 'availability':
      return r.availabilityMs ?? -Infinity
    case 'lastStored':
      return r.lastStoredMs ?? -Infinity
    case 'lastReadBuilt':
      return r.lastReadBuiltMs ?? -Infinity
    case 'stale':
      return r.stale ? 1 : 0
  }
}

export function sortRows(rows: MergedRow[], key: SortKey, dir: SortDir): MergedRow[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key)
    const bv = sortValue(b, key)
    let cmp: number
    if (typeof av === 'string' || typeof bv === 'string') {
      cmp = String(av).localeCompare(String(bv))
    } else {
      cmp = av < bv ? -1 : av > bv ? 1 : 0
    }
    // Tie-break on ticker so the order is deterministic (a flicker-free, reproducible table).
    if (cmp === 0 && key !== 'ticker') cmp = a.ticker.localeCompare(b.ticker)
    return cmp * sign
  })
}

// ── Filtering ─────────────────────────────────────────────────────────────────────────────────────
export type RowFilter = 'all' | 'stale' | 'missing' | 'pit' | 'yahoo'

export function filterRows(rows: MergedRow[], filter: RowFilter, query: string): MergedRow[] {
  const q = query.trim().toLowerCase()
  return rows.filter((r) => {
    if (q && !r.ticker.toLowerCase().includes(q) && !(r.symbol ?? '').toLowerCase().includes(q)) {
      return false
    }
    switch (filter) {
      case 'stale':
        return r.stale === true
      case 'missing':
        // "missing" = curated/read but NOT covered in the warehouse (the self-heal target).
        return r.covered === false || (r.inSource && !r.inFreshness)
      case 'pit':
        return provenanceKind(r.source) === 'pit'
      case 'yahoo':
        return provenanceKind(r.source) === 'yahoo'
      case 'all':
      default:
        return true
    }
  })
}

// ── Summary ─────────────────────────────────────────────────────────────────────────────────────
// Always-visible operator summary derived from the live source counts + the freshness aggregate.
export interface FundamentalsSummary {
  // live strategy source
  provider: string | null
  pitServed: number | null
  yahooServed: number | null
  nullServed: number | null
  lastCycleMs: number | null
  // warehouse coverage (over the EDGAR-eligible denominator — see FreshnessAudit)
  covered: number | null
  universe: number | null
  stale: number | null
  retirable: boolean | null
  lastIngestRunMs: number | null
  lastIngestRunState: string | null
  // The no-EDGAR exception set (epic Task A4): names excluded from the eligible denominator because they
  // file nothing with the SEC, so they degrade to Yahoo. Always an array (empty when none / freshness cold)
  // so the panel can render "N names degrade to Yahoo (no SEC filings): …" without a null guard.
  noEdgar: NoEdgarName[]
}

export function buildSummary(
  freshness: FreshnessAudit | null,
  source: FundamentalsSource | null,
): FundamentalsSummary {
  const srcCounts = source?.sources ?? {}
  // Sum every pit-* / yahoo-* bucket so a future per-form source key still rolls up correctly.
  let pit = 0
  let yahoo = 0
  for (const [k, v] of Object.entries(srcCounts)) {
    const kind = provenanceKind(k)
    if (kind === 'pit') pit += v
    else if (kind === 'yahoo') yahoo += v
  }
  // The literal "null" source bucket (a name the cycle built with no fundamentals source).
  const nullServed = srcCounts['null'] ?? null

  return {
    provider: source?.provider ?? null,
    pitServed: source ? pit : null,
    yahooServed: source ? yahoo : null,
    nullServed,
    lastCycleMs: source?.last_cycle_ts ?? null,
    covered: freshness?.covered ?? null,
    universe: freshness?.universe ?? null,
    stale: freshness?.stale ?? null,
    retirable: freshness?.retirable ?? null,
    lastIngestRunMs: freshness?.last_ingest_run?.finished_at_ms ?? null,
    lastIngestRunState: freshness?.last_ingest_run?.state ?? null,
    // Pass the exception list straight through (empty when absent/cold); the count is derivable from
    // its length, so we keep the single source of truth here rather than trusting a separate scalar.
    noEdgar: freshness?.no_edgar ?? [],
  }
}

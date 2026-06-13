// Pure merge of the two PIT-fundamentals provenance reads for the Operations per-ticker state table,
// keyed by BARE symbol (the platform source of truth since the bare-ticker flag-day). No React / DOM —
// unit-tested in the node env.
//
// The honesty story is per-name, from data that already exists (no new store). Two endpoints:
//   - freshness.names[] (fundamentals-HARVESTER /freshness): the LAKE / ingest side — covered, the
//     fiscal period-end observed, the availability (knowledge) instant, the last SEC filing date, the
//     filing cadence, staleness. Keyed by BARE symbol (`AAPL`) — the harvester has no Mongo and speaks
//     the bare lake alphabet.
//   - source.by_ticker (strategy-engine /fundamentals-source): the CONSUME side — which source the live
//     cycle read (pit-edgar / null) and built_at = when it read+built this name. Keyed by the T212
//     ticker (`AAPL_US_EQ`) the strategy re-derives from factor_scores.
//
// The two key alphabets differ, so the merge maps each T212 source key → its bare symbol and joins on
// the bare symbol. Either side may be absent (a name harvested but not yet read by a cycle, or read but
// outside the audit window) — we keep BOTH so the operator sees the gap honestly (a full outer join).

import { fromT212 } from '@/app/lib/ticker-identity'

// ── Upstream shapes (snake_case, ms timestamps) — minimal mirrors of the live payloads. ──────────
// The harvester /freshness per-name shape (services/fundamentals-harvester/src/freshness.py). Keyed by
// BARE symbol; carries the CIK + the last filing date + the filing cadence the harvester classifies.
export interface FreshnessName {
  symbol: string // bare US symbol (e.g. AAPL)
  cik: number | null
  covered: boolean
  newest_period_end: number | null // fiscal period-end (observation_ts)
  newest_knowledge_ts: number | null // availability (knowledge_ts)
  last_filed: number | null // most recent SEC filing date (UTC ms)
  filing_cadence: string // 'annual' | 'quarterly' — which staleness window applied
  staleness_days: number | null
  stale: boolean
}

// A curated US name that files NOTHING with the SEC (an unsponsored ADR like TCEHY) — excluded from the
// EDGAR-eligible denominator (so never counted `missing`) and surfaced as a documented fail-closed
// exception (the harvester's no_edgar set).
export interface NoEdgarName {
  symbol: string
  reason: string
}

// The harvester /freshness aggregate (services/fundamentals-harvester/src/freshness.py). All counts are
// over the EDGAR-eligible denominator (universe − no_edgar); `names[]` carries only the eligible names.
export interface FreshnessAudit {
  universe: number
  covered: number
  missing: number
  stale: number
  coverage_pct: number
  retirable: boolean
  no_edgar_count?: number
  no_edgar?: NoEdgarName[]
  names: FreshnessName[]
}

export interface SourceEntry {
  source: string | null // 'pit-edgar' | null (a retired 'yahoo-snapshot' may persist in historical rows)
  built_at: number | null // factor_scores.observation_ts — the strategy read+build instant
}

export interface FundamentalsSource {
  provider: string // effective seam mode: 'pit' (the only live option post Yahoo-removal)
  sources: Record<string, number> // raw source → count (a null source is the literal "null" key)
  by_ticker: Record<string, SourceEntry> // keyed by T212 ticker
  pit_served: number
  last_cycle_ts: number | null
}

// ── The merged per-name row (one per BARE symbol present on EITHER side). ──────────────────────────
export interface MergedRow {
  symbol: string // bare symbol — the row key + the displayed label
  // lake / ingest side (freshness)
  inFreshness: boolean
  covered: boolean | null
  fiscalPeriodMs: number | null // observation_ts
  availabilityMs: number | null // knowledge_ts
  lastFiledMs: number | null // most recent SEC filing date
  filingCadence: string | null // 'annual' | 'quarterly'
  stalenessDays: number | null
  stale: boolean | null
  // consume side (strategy by_ticker)
  inSource: boolean
  source: string | null // raw source; null source kept distinct from "no source row"
  lastReadBuiltMs: number | null // built_at
}

// Normalise the raw `source` string to the provenance bucket the UI tags by.
// 'pit-edgar*' → PIT (ours); a retired 'yahoo*' stamp in a historical row → Yahoo; null / unknown → none.
export type ProvenanceKind = 'pit' | 'yahoo' | 'none'
export function provenanceKind(source: string | null | undefined): ProvenanceKind {
  if (!source) return 'none'
  const s = source.toLowerCase()
  if (s.startsWith('pit')) return 'pit'
  if (s.startsWith('yahoo')) return 'yahoo'
  return 'none'
}

// The bare symbol a source row keys to: parse its T212 ticker, falling back to the raw key (already
// bare, or unparseable) so a source-only name still lands on a row.
function symbolOfSourceKey(ticker: string): string {
  return fromT212(ticker)?.symbol ?? ticker
}

// Full outer join freshness.names ⋈ source.by_ticker on the BARE symbol. Either side may be absent.
export function mergeFundamentalsRows(
  freshness: FreshnessAudit | null,
  source: FundamentalsSource | null,
): MergedRow[] {
  const bySymbol = new Map<string, MergedRow>()

  for (const n of freshness?.names ?? []) {
    const symbol = n.symbol.toUpperCase()
    bySymbol.set(symbol, {
      symbol,
      inFreshness: true,
      covered: n.covered,
      fiscalPeriodMs: n.newest_period_end,
      availabilityMs: n.newest_knowledge_ts,
      lastFiledMs: n.last_filed,
      filingCadence: n.filing_cadence,
      stalenessDays: n.staleness_days,
      stale: n.stale,
      inSource: false,
      source: null,
      lastReadBuiltMs: null,
    })
  }

  for (const [ticker, entry] of Object.entries(source?.by_ticker ?? {})) {
    const symbol = symbolOfSourceKey(ticker).toUpperCase()
    const existing = bySymbol.get(symbol)
    if (existing) {
      existing.inSource = true
      existing.source = entry.source
      existing.lastReadBuiltMs = entry.built_at
    } else {
      bySymbol.set(symbol, {
        symbol,
        inFreshness: false,
        covered: null,
        fiscalPeriodMs: null,
        availabilityMs: null,
        lastFiledMs: null,
        filingCadence: null,
        stalenessDays: null,
        stale: null,
        inSource: true,
        source: entry.source,
        lastReadBuiltMs: entry.built_at,
      })
    }
  }

  return [...bySymbol.values()]
}

// ── Sorting ───────────────────────────────────────────────────────────────────────────────────────
export type SortKey =
  | 'symbol'
  | 'source'
  | 'covered'
  | 'fiscal'
  | 'availability'
  | 'lastFiled'
  | 'lastReadBuilt'
  | 'stale'
export type SortDir = 'asc' | 'desc'

// Comparator value for a row under a sort key. Nulls always sort last (pushed to the low end before the
// direction flip is applied at the call site).
function sortValue(r: MergedRow, key: SortKey): number | string {
  switch (key) {
    case 'symbol':
      return r.symbol
    case 'source':
      return r.source ?? '￿' // unknown source sorts after named ones
    case 'covered':
      return r.covered ? 1 : 0
    case 'fiscal':
      return r.fiscalPeriodMs ?? -Infinity
    case 'availability':
      return r.availabilityMs ?? -Infinity
    case 'lastFiled':
      return r.lastFiledMs ?? -Infinity
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
    // Tie-break on symbol so the order is deterministic (a flicker-free, reproducible table).
    if (cmp === 0 && key !== 'symbol') cmp = a.symbol.localeCompare(b.symbol)
    return cmp * sign
  })
}

// ── Filtering ─────────────────────────────────────────────────────────────────────────────────────
export type RowFilter = 'all' | 'stale' | 'missing' | 'pit'

export function filterRows(rows: MergedRow[], filter: RowFilter, query: string): MergedRow[] {
  const q = query.trim().toLowerCase()
  return rows.filter((r) => {
    if (q && !r.symbol.toLowerCase().includes(q)) {
      return false
    }
    switch (filter) {
      case 'stale':
        return r.stale === true
      case 'missing':
        // "missing" = curated/read but NOT covered in the lake (the self-heal target).
        return r.covered === false || (r.inSource && !r.inFreshness)
      case 'pit':
        return provenanceKind(r.source) === 'pit'
      case 'all':
      default:
        return true
    }
  })
}

// ── Summary ─────────────────────────────────────────────────────────────────────────────────────
// Always-visible operator summary derived from the live source counts + the freshness aggregate. The
// live provenance is PIT-only post Yahoo-removal (pit-edgar | null); the summary reports pit-served +
// null-served (no yahoo-snapshot line — the stamp is retired from the live cycle).
export interface FundamentalsSummary {
  // live strategy source
  provider: string | null
  pitServed: number | null
  nullServed: number | null
  lastCycleMs: number | null
  // lake coverage (over the EDGAR-eligible denominator — see FreshnessAudit)
  covered: number | null
  universe: number | null
  stale: number | null
  retirable: boolean | null
  // The no-EDGAR exception set: names excluded from the eligible denominator because they file nothing
  // with the SEC (fail-closed). Always an array (empty when none / freshness cold).
  noEdgar: NoEdgarName[]
}

export function buildSummary(
  freshness: FreshnessAudit | null,
  source: FundamentalsSource | null,
): FundamentalsSummary {
  const srcCounts = source?.sources ?? {}
  // Sum every pit-* bucket so a future per-form source key still rolls up correctly.
  let pit = 0
  for (const [k, v] of Object.entries(srcCounts)) {
    if (provenanceKind(k) === 'pit') pit += v
  }
  // The literal "null" source bucket (a name the cycle built with no fundamentals source — non-US
  // fail-closed, or a US name whose quality factor couldn't be computed that cycle).
  const nullServed = srcCounts['null'] ?? null

  return {
    provider: source?.provider ?? null,
    pitServed: source ? pit : null,
    nullServed,
    lastCycleMs: source?.last_cycle_ts ?? null,
    covered: freshness?.covered ?? null,
    universe: freshness?.universe ?? null,
    stale: freshness?.stale ?? null,
    retirable: freshness?.retirable ?? null,
    noEdgar: freshness?.no_edgar ?? [],
  }
}

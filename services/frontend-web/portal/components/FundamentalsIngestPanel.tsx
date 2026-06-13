'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { FundamentalsSourceTag } from '@/components/FundamentalsSourceTag'
import {
  buildSummary,
  filterRows,
  mergeFundamentalsRows,
  sortRows,
  type FreshnessAudit,
  type FundamentalsSource,
  type MergedRow,
  type RowFilter,
  type SortDir,
  type SortKey,
} from '@/app/lib/fundamentals-merge'

// Operations › PIT Fundamentals panel — the operator surface over the fundamentals-HARVESTER (the
// per-CIK Parquet lake's write path), repointed off the retired Timescale ingestion service by epic
// pit-fundamentals-lake-rearchitecture (Task 21). The harvester is a pure EDGAR→lake service with NO
// Mongo and NO Timescale, so the shape is leaner than the old ingestion view:
//   1. STATUS    — lake state: bootstrap complete?, covered-CIK count, last sweep date, lake byte size,
//                  the bootstrap sentinel (completed-at, entities, mode), and whether the identity files
//                  (ticker_history / entities) are present. From /status. Polled every 15s (a background
//                  sweep moves coverage without us triggering it, so a static view would lie).
//   2. CONFIG    — the harvester's effective env knobs (sweep cadence, watchlist, EDGAR rps, UA-set
//                  flag). READ-ONLY — the harvester exposes no config PUT (the UA is a deploy-time env on
//                  the harvester; the status surface only reports whether it carries a contact). From /config.
//   3. SUMMARY + STATE TABLE — an always-visible PIT-fundamentals summary (live strategy source · PIT
//                  coverage C/U · stale · retirable) and a per-NAME table merging the harvester freshness
//                  audit (lake side) with the strategy by_ticker map (consume side), so BOTH clocks show
//                  per row: the fiscal period / availability / last filing (lake) vs when the strategy last
//                  read+built (consume). Sortable / filterable. Keyed by BARE symbol. The freshness read
//                  is passed the active universe via ?symbols= (the harvester has no Mongo — the universe
//                  is an input). Operational, NOT mode-gated.
//   4. FORCE-SWEEP — "Run sweep now" → POST …/force-sweep (single-flight in-cluster sweep). Confirm-
//                  before-run; the sweep result lands in /status + /runs (no run-id polling — the
//                  harvester sweep is fire-and-forget, single-flight).
//   5. RUNS      — recent sweep history (date + CIK count) from /runs.
//
// The quarantine panel + the per-name quarantine lookup + the UA editor are GONE: the lake design has no
// quarantine (decision D — a dirty fact is fail-closed-omitted at write time, never quarantined), and the
// harvester has no config-PUT. Everything here is operational, so nothing is mode-gated.

// ── Mirrors the harvester /status payload (services/fundamentals-harvester/src/status.py). ─────────
interface BootstrapSentinel {
  completed_at?: string | null
  entities?: number | null
  mode?: string | null
}

interface HarvesterStatus {
  service: string
  now_ms: number
  bootstrap_complete: boolean
  bootstrap: BootstrapSentinel | null
  covered_ciks: number
  last_sweep_date: string | null
  last_sweep_ciks: number
  lake_size_bytes: number
  lake_dir: string
  has_ticker_history: boolean
  has_entities: boolean
}

// Mirrors the harvester /config payload (read-only).
interface HarvesterConfig {
  lake_dir: string
  sweep_minutes: number
  watchlist: string[]
  watchlist_mode: boolean
  edgar_reqs_per_sec: string
  edgar_user_agent_set: boolean
}

// Mirrors the harvester /runs payload.
interface RunEntry {
  date: string
  ciks: number
}
interface RunsPayload {
  runs: RunEntry[]
  count: number
}

interface Props {
  initialStatus: HarvesterStatus | null
  initialConfig: HarvesterConfig | null
  initialFreshness?: FreshnessAudit | null
  initialSource?: FundamentalsSource | null
  initialRuns?: RunsPayload | null
  // The active universe (BARE symbols) the freshness audit is run over — the harvester has no Mongo, so
  // the portal supplies the universe via ?symbols=. Empty ⇒ the harvester defaults to the lake's
  // currently-listed tickers.
  universeSymbols?: string[]
}

function agoMs(ms: number | null): string {
  if (ms == null) return '—'
  const d = Date.now() - ms
  if (d < 60_000) return 'just now'
  const m = Math.floor(d / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function fmtBytes(bytes: number | null): string {
  if (bytes == null || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${units[i]}`
}

// Build the ?symbols= query string for the freshness poll from the active universe (capped defensively
// so a large universe can't blow the URL length; the harvester defaults to the lake's tickers anyway).
function symbolsQuery(symbols: string[] | undefined): string {
  const list = (symbols ?? []).filter(Boolean).slice(0, 600)
  return list.length ? `?symbols=${encodeURIComponent(list.join(','))}` : ''
}

export function FundamentalsIngestPanel({
  initialStatus,
  initialConfig,
  initialFreshness = null,
  initialSource = null,
  initialRuns = null,
  universeSymbols = [],
}: Props) {
  const [status, setStatus] = useState<HarvesterStatus | null>(initialStatus)
  const [config] = useState<HarvesterConfig | null>(initialConfig)
  const [runs, setRuns] = useState<RunsPayload | null>(initialRuns)

  // The two provenance reads behind the summary + per-name state table. Polled alongside status so a
  // background sweep / strategy cycle is reflected without an operator refresh.
  const [freshness, setFreshness] = useState<FreshnessAudit | null>(initialFreshness)
  const [source, setSource] = useState<FundamentalsSource | null>(initialSource)

  // Force-sweep tracking — fire-and-forget single-flight (no run-id polling: the harvester sweep result
  // lands in /status + /runs, which the 15s poll already refreshes).
  const [sweeping, setSweeping] = useState(false)
  const [sweepMsg, setSweepMsg] = useState<string | null>(null)

  const freshnessQs = useMemo(() => symbolsQuery(universeSymbols), [universeSymbols])
  // Keep the latest query string in a ref so the 15s interval (mounted once) always reads the current
  // universe without re-subscribing the timer on every render. Synced in an effect (never during render).
  const freshnessQsRef = useRef(freshnessQs)
  useEffect(() => {
    freshnessQsRef.current = freshnessQs
  }, [freshnessQs])

  async function refreshStatus(): Promise<void> {
    try {
      const r = await fetch('/portal-api/admin/fundamentals-ingest/status', { cache: 'no-store' })
      if (r.ok) setStatus(await r.json())
    } catch {
      // transient fetch failures must not blank the operator's view
    }
    try {
      const r = await fetch('/portal-api/admin/fundamentals-ingest/runs', { cache: 'no-store' })
      if (r.ok) {
        const b = await r.json().catch(() => null)
        if (b) setRuns(b)
      }
    } catch {
      // transient — keep the last good runs
    }
  }

  // Refresh the per-name provenance reads. Each is independent — a failure on one (or a null/cold body)
  // leaves the prior value rather than blanking the table, mirroring refreshStatus.
  async function refreshProvenance(): Promise<void> {
    try {
      const r = await fetch(
        `/portal-api/admin/fundamentals-ingest/freshness${freshnessQsRef.current}`,
        { cache: 'no-store' },
      )
      if (r.ok) {
        const b = await r.json().catch(() => null)
        if (b) setFreshness(b)
      }
    } catch {
      // transient — keep the last good freshness
    }
    try {
      const r = await fetch('/portal-api/admin/strategy/fundamentals-source', { cache: 'no-store' })
      if (r.ok) {
        const b = await r.json().catch(() => null)
        if (b) setSource(b)
      }
    } catch {
      // transient — keep the last good source map
    }
  }

  // 15s poll — matches the circuit-breaker / auto-approve cadence. Status + runs + the two provenance
  // reads refresh together so coverage, the summary, and the table never drift apart between ticks.
  useEffect(() => {
    const id = setInterval(() => {
      void refreshStatus()
      void refreshProvenance()
    }, 15_000)
    return () => clearInterval(id)
  }, [])

  // Derive the summary + the merged per-name rows once per (freshness, source) change.
  const summary = useMemo(() => buildSummary(freshness, source), [freshness, source])
  const mergedRows = useMemo(() => mergeFundamentalsRows(freshness, source), [freshness, source])

  // ── Force sweep ──────────────────────────────────────────────────────────────────────────────
  async function forceSweep(): Promise<void> {
    if (sweeping) return
    if (
      !window.confirm(
        'Run a fundamentals harvester sweep now?\n\n' +
          'This refreshes recently-filed CIKs from SEC EDGAR into the lake (single-flight — a concurrent ' +
          'trigger is a no-op). It runs in the background; coverage + the last-sweep date update below as it lands.',
      )
    )
      return
    setSweeping(true)
    setSweepMsg(null)
    try {
      const r = await fetch('/portal-api/admin/fundamentals-ingest/force-sweep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b.detail ?? b.error ?? `failed (${r.status})`)
      setSweepMsg(
        b.started === false
          ? 'A sweep is already in flight — it will land shortly.'
          : 'Sweep triggered — coverage + last-sweep update below as it completes.',
      )
      // Pull fresh status/runs shortly after so the operator sees the sweep land without waiting a full tick.
      setTimeout(() => void refreshStatus(), 4_000)
    } catch (e) {
      setSweepMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setSweeping(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────────────────────
  // Only show the wholesale "unavailable" fallback when EVERY read is cold. status/config back the
  // monitor; freshness/source back the summary + per-name table — independent upstreams, so a
  // status-service blip must not hide the always-visible coverage summary.
  if (!status && !config && !freshness && !source) {
    return (
      <div className="rounded border border-amber-900 bg-amber-950 px-4 py-2 text-sm text-amber-300">
        PIT-fundamentals harvester status unavailable — the harvester may be unreachable or still
        bootstrapping. The controls below still work once it recovers.
      </div>
    )
  }

  const bootstrapDone = status?.bootstrap_complete ?? false

  return (
    <div className="space-y-5">
      {/* ── Status: lake coverage + sweep + size ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Covered CIKs"
          value={status ? status.covered_ciks.toLocaleString() : '—'}
          hint="companies with harvested facts"
        />
        <Stat
          label="Bootstrap"
          value={status ? (bootstrapDone ? 'complete' : 'in progress') : '—'}
          hint={
            status?.bootstrap?.completed_at
              ? `${status.bootstrap.entities?.toLocaleString() ?? '—'} entities`
              : 'full companyfacts seed'
          }
          valueCls={status ? (bootstrapDone ? 'text-emerald-400' : 'text-amber-300') : undefined}
        />
        <Stat
          label="Last sweep"
          value={status?.last_sweep_date ?? '—'}
          hint={status ? `${status.last_sweep_ciks.toLocaleString()} CIKs refreshed` : 'newest filings'}
        />
        <Stat label="Lake size" value={fmtBytes(status?.lake_size_bytes ?? null)} hint="zstd parquet on disk" />
      </div>

      {/* Harvester config — effective env knobs (read-only; the harvester has no config PUT). */}
      <div className="rounded border border-gray-800 bg-gray-900 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Harvester config</h3>
        <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-3">
            <dt className="text-gray-400">Sweep cadence</dt>
            <dd className="text-gray-200">{config ? `every ${config.sweep_minutes}m` : '—'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-gray-400">EDGAR rps</dt>
            <dd className="text-gray-200">{config?.edgar_reqs_per_sec ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-gray-400">EDGAR User-Agent</dt>
            <dd className={config?.edgar_user_agent_set ? 'text-emerald-400' : 'text-red-400'}>
              {config ? (config.edgar_user_agent_set ? 'set (contact present)' : 'unset — sweeps refuse') : '—'}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-gray-400">Watchlist mode</dt>
            <dd className={config?.watchlist_mode ? 'text-amber-300' : 'text-gray-200'}>
              {config
                ? config.watchlist_mode
                  ? `${config.watchlist.length} name${config.watchlist.length === 1 ? '' : 's'}`
                  : 'full universe'
                : '—'}
            </dd>
          </div>
          <div className="flex justify-between gap-3 sm:col-span-2">
            <dt className="text-gray-400">Identity files</dt>
            <dd className="text-gray-200">
              ticker_history{' '}
              <span className={status?.has_ticker_history ? 'text-emerald-400' : 'text-amber-300'}>
                {status ? (status.has_ticker_history ? '✓' : '—') : '—'}
              </span>
              {' · '}entities{' '}
              <span className={status?.has_entities ? 'text-emerald-400' : 'text-amber-300'}>
                {status ? (status.has_entities ? '✓' : '—') : '—'}
              </span>
            </dd>
          </div>
        </dl>
      </div>

      {/* ── PIT-fundamentals summary + per-name state table ─────────────────────────────────────────
          Always-visible (operational): the live-source line, PIT coverage, stale count, the retirable
          gate, and the full per-name table with the lake + consume provenance clocks. */}
      <FundamentalsSummaryCard summary={summary} />
      <FundamentalsStateTable rows={mergedRows} hasFreshness={!!freshness} hasSource={!!source} />

      {/* ── Force sweep ───────────────────────────────────────────────────────────────────────── */}
      <div className="rounded border border-gray-800 bg-gray-900 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-gray-100">Run sweep now</h3>
            <p className="mt-1 text-xs text-gray-400">
              Force a harvester sweep in-cluster (single-flight) — refreshes recently-filed CIKs into the
              lake. The result lands in the coverage + last-sweep above and the run history below.
            </p>
          </div>
          <button
            type="button"
            onClick={forceSweep}
            disabled={sweeping}
            className="shrink-0 rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
          >
            {sweeping ? 'Triggering…' : 'Run sweep now'}
          </button>
        </div>
        {sweepMsg && <p className="mt-2 text-xs text-amber-300">{sweepMsg}</p>}
      </div>

      {/* ── Recent sweeps ─────────────────────────────────────────────────────────────────────── */}
      <div className="rounded border border-gray-800 bg-gray-900 p-4" data-testid="harvester-runs">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Recent sweeps</h3>
        {runs && runs.runs.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm">
            {runs.runs.map((r) => (
              <li key={r.date} className="flex justify-between gap-3">
                <span className="font-mono text-gray-300">{r.date}</span>
                <span className="text-gray-400">{r.ciks.toLocaleString()} CIKs refreshed</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-gray-500">No sweeps recorded yet.</p>
        )}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  valueCls,
}: {
  label: string
  value: string
  hint?: React.ReactNode
  valueCls?: string
}) {
  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-3">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${valueCls ?? 'text-gray-100'}`}>{value}</div>
      {hint != null && <div className="text-[11px] text-gray-500">{hint}</div>}
    </div>
  )
}

// ── Summary + table sub-components ───────────────────────────────────────────────────────────────

// UTC calendar date (yyyy-mm-dd) for a ms timestamp. The bi-temporal model is UTC-anchored, so the
// table renders dates in UTC to keep period-end / availability / filing instants comparable.
function fmtDateUTC(ms: number | null): string {
  if (ms == null) return '—'
  return new Date(ms).toISOString().slice(0, 10)
}

// Always-visible operator summary: the live strategy source line + the lake coverage gate. This is
// operational state (what's serving the live cycle, whether the universe is fully harvested), so NEVER
// mode-gated. The live provenance is PIT-only post Yahoo-removal — pit-edgar | null (no yahoo-snapshot).
function FundamentalsSummaryCard({ summary }: { summary: ReturnType<typeof buildSummary> }) {
  const providerLabel = summary.provider === 'pit' ? 'PIT (SEC EDGAR)' : summary.provider ?? '—'
  const coverage =
    summary.covered != null && summary.universe != null
      ? `${summary.covered}/${summary.universe}`
      : '—'
  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4" data-testid="fundamentals-summary">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        PIT-fundamentals summary
      </h3>
      <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="text-gray-300">
          Live strategy source:{' '}
          <span className="font-semibold text-gray-100">{providerLabel}</span>
          {summary.provider != null && (
            <span className="text-gray-400">
              {' '}
              — <span className="text-emerald-300">pit-edgar {summary.pitServed ?? '—'}</span>
              {summary.nullServed ? <span className="text-amber-300"> / null {summary.nullServed}</span> : null}
            </span>
          )}
        </span>
        <span className="text-gray-300" title="Covered / EDGAR-eligible US names (the no-EDGAR exception names below are excluded from this denominator)">
          PIT coverage: <span className="font-semibold text-gray-100">{coverage}</span>
          <span className="text-gray-500"> eligible</span>
        </span>
        <span className="text-gray-300">
          stale:{' '}
          <span className={`font-semibold ${summary.stale ? 'text-amber-300' : 'text-gray-100'}`}>
            {summary.stale ?? '—'}
          </span>
        </span>
        <span className="text-gray-300">
          retirable:{' '}
          <span
            className={`font-semibold ${
              summary.retirable === true
                ? 'text-emerald-400'
                : summary.retirable === false
                  ? 'text-amber-300'
                  : 'text-gray-100'
            }`}
          >
            {summary.retirable == null ? '—' : summary.retirable ? 'yes' : 'no'}
          </span>
        </span>
        <span className="text-gray-300">
          last cycle:{' '}
          <span className="font-semibold text-gray-100">{agoMs(summary.lastCycleMs)}</span>
        </span>
      </div>

      {/* No-EDGAR exception list — curated US names that file NOTHING with the SEC (an unsponsored ADR
          like TCEHY). They are EXCLUDED from the eligible coverage denominator above (so never counted
          "missing" and never blocking retirable) and fail-closed (no fundamentals — the value/quality
          legs are NaN-excluded). Listed here as a documented exception. */}
      {summary.noEdgar.length > 0 && (
        <p className="mt-3 text-xs text-gray-400" data-testid="fundamentals-no-edgar">
          {summary.noEdgar.length} name{summary.noEdgar.length === 1 ? '' : 's'} fail-closed (no SEC
          filings):{' '}
          {summary.noEdgar.map((n, i) => (
            <span key={n.symbol}>
              {i > 0 && ', '}
              <span className="font-mono text-amber-300" title={n.reason}>
                {n.symbol}
              </span>
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

const FILTERS: { key: RowFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'stale', label: 'Stale' },
  { key: 'missing', label: 'Missing' },
  { key: 'pit', label: 'PIT' },
]

// Full per-name state table merging the harvester freshness audit (lake: covered · fiscal period ·
// availability · last filed · stale) with the strategy by_ticker map (consume: source · last
// read+built). Keyed by BARE symbol. Sortable + filterable. Always-visible (operational), not mode-gated.
function FundamentalsStateTable({
  rows,
  hasFreshness,
  hasSource,
}: {
  rows: MergedRow[]
  hasFreshness: boolean
  hasSource: boolean
}) {
  const [sortKey, setSortKey] = useState<SortKey>('symbol')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [filter, setFilter] = useState<RowFilter>('all')
  const [query, setQuery] = useState('')

  const view = useMemo(
    () => sortRows(filterRows(rows, filter, query), sortKey, sortDir),
    [rows, filter, query, sortKey, sortDir],
  )

  function toggleSort(key: SortKey): void {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'symbol' || key === 'source' ? 'asc' : 'desc')
    }
  }

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4" data-testid="fundamentals-state-table">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          Per-name state
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter symbol…"
            spellCheck={false}
            className="w-36 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100 focus:border-emerald-600 focus:outline-none"
          />
          <div className="flex gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`rounded px-2 py-1 text-xs ${
                  filter === f.key
                    ? 'bg-emerald-800 text-emerald-100'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!hasFreshness && !hasSource ? (
        <p className="mt-3 text-sm text-amber-300">
          Per-name state unavailable — the harvester freshness + strategy source reads are cold or
          unreachable.
        </p>
      ) : (
        <>
          <p className="mt-1 text-[11px] text-gray-500">
            Two clocks per row: <span className="text-gray-400">last filed</span> = the most recent SEC
            filing the lake holds for the name · <span className="text-gray-400">last read+built</span> =
            when the live strategy last read it and built this name&apos;s factors.
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500">
                  <Th label="Symbol" col="symbol" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <Th label="Source" col="source" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <Th label="Covered" col="covered" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <Th label="Fiscal period (obs)" col="fiscal" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <Th label="Availability (know.)" col="availability" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <Th label="Last filed (SEC)" col="lastFiled" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <Th label="Last read+built (strat.)" col="lastReadBuilt" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <Th label="Stale?" col="stale" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                </tr>
              </thead>
              <tbody>
                {view.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-3 text-center text-gray-500">
                      No names match this filter.
                    </td>
                  </tr>
                ) : (
                  view.map((r) => (
                    <tr key={r.symbol} className="border-b border-gray-900 last:border-0">
                      <td className="py-1.5 pr-3 font-mono text-gray-200">{r.symbol}</td>
                      <td className="py-1.5 pr-3"><FundamentalsSourceTag source={r.source} /></td>
                      <td className="py-1.5 pr-3">
                        {r.covered == null ? (
                          <span className="text-gray-600">—</span>
                        ) : r.covered ? (
                          <span className="text-emerald-400">yes</span>
                        ) : (
                          <span className="text-amber-300">no</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-gray-300" title={r.fiscalPeriodMs ? new Date(r.fiscalPeriodMs).toISOString() : undefined}>
                        {fmtDateUTC(r.fiscalPeriodMs)}
                      </td>
                      <td className="py-1.5 pr-3 text-gray-300" title={r.availabilityMs ? new Date(r.availabilityMs).toISOString() : undefined}>
                        {fmtDateUTC(r.availabilityMs)}
                      </td>
                      <td className="py-1.5 pr-3 text-gray-300" title={r.lastFiledMs ? new Date(r.lastFiledMs).toISOString() : undefined}>
                        {fmtDateUTC(r.lastFiledMs)}
                      </td>
                      <td className="py-1.5 pr-3 text-gray-300" title={r.lastReadBuiltMs ? new Date(r.lastReadBuiltMs).toISOString() : undefined}>
                        {agoMs(r.lastReadBuiltMs)}
                      </td>
                      <td className="py-1.5 pr-3">
                        {r.stale == null ? (
                          <span className="text-gray-600">—</span>
                        ) : r.stale ? (
                          <span className="text-amber-300" title={r.stalenessDays != null ? `${r.stalenessDays}d · ${r.filingCadence ?? ''} cadence` : undefined}>
                            stale
                          </span>
                        ) : (
                          <span className="text-emerald-400">fresh</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-gray-600">
            {view.length} of {rows.length} name{rows.length === 1 ? '' : 's'}
          </p>
        </>
      )}
    </div>
  )
}

// Sortable header cell — clicking toggles the sort key/direction. Shows ▲/▼ on the active column.
function Th({
  label,
  col,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string
  col: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
}) {
  const active = sortKey === col
  return (
    <th className="py-1.5 pr-3 font-medium">
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`flex items-center gap-1 ${active ? 'text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
      >
        {label}
        {active && <span aria-hidden>{sortDir === 'asc' ? '▲' : '▼'}</span>}
      </button>
    </th>
  )
}

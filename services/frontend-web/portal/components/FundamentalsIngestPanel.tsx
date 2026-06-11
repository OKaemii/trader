'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { FundamentalsSourceTag } from '@/components/FundamentalsSourceTag'
import { QuantOnly } from '@/components/QuantOnly'
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

// Operations › PIT Fundamentals panel (card 134, extended by card 149) — the operator surface over
// the fundamentals-ingestion write-side. Jobs in one client component, SSR-seeded by the tab:
//   1. MONITOR  — coverage (instruments + facts), ingestion lag, last force-run state, quarantine
//                 count, and feed-health (effective EDGAR UA + provenance + ingest-enabled).
//                 Polls /portal-api/admin/fundamentals-ingest/status every 15s like the other
//                 operator cards (a background CronJob run moves coverage without us triggering it,
//                 so a static view would lie).
//   2. SUMMARY + STATE TABLE (card 149) — an always-visible PIT-fundamentals summary (live strategy
//                 source · PIT coverage C/U · stale N · retirable yes/no · last ingest run) and a full
//                 per-ticker table merging the freshness audit (warehouse side) with the strategy
//                 by_ticker map (consume side) so BOTH clocks show per row: when we last STORED a fact
//                 (ingest) vs when the strategy last READ+BUILT it. Sortable / filterable. Both reads
//                 poll on the same 15s cadence as status. This data is operational, so NOT mode-gated.
//   3. FORCE    — "Run ingest now" → POST …/force (single-flight in-cluster run), then polls
//                 …/runs/{run_id} until done|failed, surfacing the live counts. Confirm-before-run +
//                 disabled-while-running, matching the panic-control affordances.
//   4. UA EDITOR — the EDGAR User-Agent the next run sends to SEC, bound to GET/PUT …/config
//                 (portal_fundamentals_config override > env > default). Shows the effective value +
//                 where it came from; PUT persists the override; an empty value clears it back.
//
// Operational status, the summary, the state table, and the operator controls are NEVER mode-gated
// (per the portal safety contract); only the quarantine forensics — the by-reason breakdown and the
// per-name quarantine lookup — sit under <QuantOnly>.

// ── Mirrors the fundamentals-ingestion /status payload (snake_case, ms timestamps). ─────────────
interface RunRecord {
  run_id: string
  state: string // 'running' | 'done' | 'failed'
  scope: string // 'subset' | 'all'
  started_at_ms: number
  finished_at_ms: number | null
  requested: number
  ingested: number
  skipped: number
  raw_written: number
  canonical_inserted: number
  canonical_revisions: number
  canonical_skipped: number
  quarantined: number
  reason: string | null
  user_agent_source: string | null
}

interface IngestStatus {
  coverage: {
    instruments: number
    facts: number
    oldest_observation_ts: number | null
    newest_knowledge_ts: number | null
  }
  ingestion_lag_ms: number | null
  last_run: RunRecord | null
  quarantine: {
    total: number
    by_reason: Record<string, number>
    by_sector: Record<string, number>
    recent: unknown[]
  }
  feed_health: {
    edgar_user_agent: string
    edgar_user_agent_source: string // 'override' | 'env' | 'default'
    edgar_user_agent_usable: boolean
    coverage_cap: number | null
    ingest_enabled: boolean
  }
  generated_at_ms: number
}

// Mirrors the /config (GET/PUT) camelCase payload.
interface IngestConfig {
  edgarUserAgent: string
  edgarUserAgentSource: string // 'override' | 'env' | 'default'
  edgarUserAgentUsable: boolean
  coverageCap: number | null
  ingestEnabled: boolean
}

interface Props {
  initialStatus: IngestStatus | null
  initialConfig: IngestConfig | null
  // card 149: per-name freshness audit (warehouse side) + live strategy source map (consume side),
  // SSR-seeded by the tab. Either may be null (cold/unreachable upstream) without blanking the panel.
  initialFreshness?: FreshnessAudit | null
  initialSource?: FundamentalsSource | null
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

function durationMs(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

// Lag → fresh/stale badge. A day-old freshest fact means the nightly cron hasn't landed.
function lagBadge(lagMs: number | null): { label: string; cls: string } {
  if (lagMs == null) return { label: 'no data', cls: 'text-gray-500' }
  if (lagMs < 26 * 3_600_000) return { label: 'fresh', cls: 'text-emerald-400' } // < ~26h: nightly cadence ok
  if (lagMs < 72 * 3_600_000) return { label: 'stale', cls: 'text-amber-300' }
  return { label: 'very stale', cls: 'text-red-400' }
}

const SOURCE_LABEL: Record<string, string> = {
  override: 'portal override',
  env: 'cluster env',
  default: 'built-in default',
}

const RUN_DONE = (s: string | null | undefined) => s === 'done' || s === 'failed'

export function FundamentalsIngestPanel({
  initialStatus,
  initialConfig,
  initialFreshness = null,
  initialSource = null,
}: Props) {
  const [status, setStatus] = useState<IngestStatus | null>(initialStatus)
  const [config, setConfig] = useState<IngestConfig | null>(initialConfig)

  // card 149: the two provenance reads behind the summary + per-ticker state table. Polled alongside
  // status so a background ingest / strategy cycle is reflected without an operator refresh.
  const [freshness, setFreshness] = useState<FreshnessAudit | null>(initialFreshness)
  const [source, setSource] = useState<FundamentalsSource | null>(initialSource)

  // UA editor — seed the input from the EFFECTIVE config; '' (after edit) means "clear the override".
  const [uaInput, setUaInput] = useState<string>(initialConfig?.edgarUserAgent ?? '')
  const [savingUa, setSavingUa] = useState(false)
  const [uaMsg, setUaMsg] = useState<string | null>(null)

  // Force-ingest run tracking.
  const [forcing, setForcing] = useState(false) // true while a run is in flight (we triggered or it's polling)
  const [run, setRun] = useState<RunRecord | null>(initialStatus?.last_run ?? null)
  const [forceMsg, setForceMsg] = useState<string | null>(null)
  const runPoll = useRef<ReturnType<typeof setInterval> | null>(null)

  async function refreshStatus(): Promise<void> {
    try {
      const r = await fetch('/portal-api/admin/fundamentals-ingest/status', { cache: 'no-store' })
      if (r.ok) setStatus(await r.json())
    } catch {
      // transient fetch failures must not blank the operator's view
    }
  }

  // card 149: refresh the per-ticker provenance reads. Each is independent — a failure on one (or a
  // null/cold body) leaves the prior value rather than blanking the table, mirroring refreshStatus.
  async function refreshProvenance(): Promise<void> {
    try {
      const r = await fetch('/portal-api/admin/fundamentals-ingest/freshness', { cache: 'no-store' })
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

  // 15s poll — matches the circuit-breaker / auto-approve cadence. Status + the two provenance reads
  // refresh together so coverage, the summary, and the table never drift apart between ticks.
  useEffect(() => {
    const id = setInterval(() => {
      void refreshStatus()
      void refreshProvenance()
    }, 15_000)
    return () => clearInterval(id)
  }, [])

  // Stop any in-flight run poller on unmount.
  useEffect(() => () => { if (runPoll.current) clearInterval(runPoll.current) }, [])

  // card 149: derive the summary + the merged per-ticker rows once per (freshness, source) change.
  // Must be declared with the other hooks (before any early return) to satisfy rules-of-hooks.
  const summary = useMemo(() => buildSummary(freshness, source), [freshness, source])
  const mergedRows = useMemo(() => mergeFundamentalsRows(freshness, source), [freshness, source])

  // ── UA editor ────────────────────────────────────────────────────────────────────────────────
  async function saveUa(): Promise<void> {
    const next = uaInput.trim()
    const clearing = next === ''
    const consequence = clearing
      ? 'Clear the EDGAR User-Agent override and fall back to the cluster env / built-in default?'
      : `Set the EDGAR User-Agent the next ingest sends to SEC to:\n\n  ${next}\n\nSEC fair-access requires a descriptive UA with a contact. This is applied to the next run (cross-pod).`
    if (!window.confirm(consequence)) return
    setSavingUa(true); setUaMsg(null)
    try {
      const r = await fetch('/portal-api/admin/fundamentals-ingest/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // explicit null clears the override back to env/default
        body: JSON.stringify({ edgarUserAgent: clearing ? null : next }),
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b.detail ?? b.error ?? `failed (${r.status})`)
      const c: IngestConfig = b
      setConfig(c)
      setUaInput(c.edgarUserAgent ?? '')
      await refreshStatus() // feed-health on the monitor reflects the new effective UA + provenance
      setUaMsg(
        `Saved — effective UA now from the ${SOURCE_LABEL[c.edgarUserAgentSource] ?? c.edgarUserAgentSource}` +
          `${c.edgarUserAgentUsable ? '.' : ' (⚠ empty — a run will refuse until a contact is set).'}`,
      )
    } catch (e) {
      setUaMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingUa(false)
    }
  }

  // ── Force ingest ─────────────────────────────────────────────────────────────────────────────
  function pollRun(runId: string): void {
    if (runPoll.current) clearInterval(runPoll.current)
    runPoll.current = setInterval(async () => {
      try {
        const r = await fetch(`/portal-api/admin/fundamentals-ingest/runs/${encodeURIComponent(runId)}`, {
          cache: 'no-store',
        })
        if (!r.ok) return // 404 right after trigger can race the in-process registry — keep polling
        const rec: RunRecord = await r.json()
        setRun(rec)
        if (RUN_DONE(rec.state)) {
          if (runPoll.current) { clearInterval(runPoll.current); runPoll.current = null }
          setForcing(false)
          setForceMsg(
            rec.state === 'done'
              ? `Run ${rec.run_id.slice(0, 8)} done — ${rec.canonical_inserted} inserted, ${rec.canonical_revisions} revised, ${rec.quarantined} quarantined.`
              : `Run ${rec.run_id.slice(0, 8)} failed — ${rec.reason ?? 'unknown reason'}.`,
          )
          void refreshStatus()
        }
      } catch {
        // transient — the next tick retries
      }
    }, 3_000)
  }

  async function forceIngest(): Promise<void> {
    if (forcing) return
    if (
      !window.confirm(
        'Run a PIT-fundamentals ingest now over the full coverage set?\n\n' +
          'This starts the EDGAR backfill orchestrator in-cluster (single-flight — a concurrent ' +
          'trigger is a no-op). It can take minutes; progress shows below as it runs.',
      )
    )
      return
    setForcing(true); setForceMsg(null); setRun(null)
    try {
      const r = await fetch('/portal-api/admin/fundamentals-ingest/force', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // full coverage set
      })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b.detail ?? b.error ?? `failed (${r.status})`)
      const rec: RunRecord | undefined = b.run
      const runId: string | undefined = b.run_id ?? rec?.run_id
      if (!runId) throw new Error('no run id returned')
      setRun(rec ?? null)
      setForceMsg(b.started === false ? 'A run is already in flight — tracking it.' : `Triggered run ${runId.slice(0, 8)}.`)
      // a terminal record can come back immediately (e.g. an empty-UA refusal) — don't start polling
      if (rec && RUN_DONE(rec.state)) {
        setForcing(false)
        setForceMsg(
          rec.state === 'failed'
            ? `Run refused — ${rec.reason ?? 'unknown reason'}.`
            : `Run ${runId.slice(0, 8)} done.`,
        )
        void refreshStatus()
      } else {
        pollRun(runId)
      }
    } catch (e) {
      setForcing(false)
      setForceMsg(e instanceof Error ? e.message : String(e))
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────────────────────
  // Only show the wholesale "unavailable" fallback when EVERY read is cold. status/config back the
  // monitor + controls; freshness/source back the summary + per-ticker table — those come from
  // independent upstreams, so a status-service blip must not hide the always-visible coverage summary.
  if (!status && !config && !freshness && !source) {
    return (
      <div className="rounded border border-amber-900 bg-amber-950 px-4 py-2 text-sm text-amber-300">
        PIT-fundamentals status unavailable — the ingestion service may be unreachable. The controls
        below still work once it recovers.
      </div>
    )
  }

  const lag = lagBadge(status?.ingestion_lag_ms ?? null)
  const fh = status?.feed_health
  const uaSource = fh?.edgar_user_agent_source ?? config?.edgarUserAgentSource ?? '—'
  const uaUsable = fh?.edgar_user_agent_usable ?? config?.edgarUserAgentUsable ?? false
  const liveRun = run && !RUN_DONE(run.state)
  const uaDirty = (uaInput.trim()) !== (config?.edgarUserAgent ?? '')

  return (
    <div className="space-y-5">
      {/* ── Monitor: coverage + lag + feed-health ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Coverage" value={status ? status.coverage.instruments.toLocaleString() : '—'} hint="instruments with facts" />
        <Stat label="Facts" value={status ? status.coverage.facts.toLocaleString() : '—'} hint="current (non-superseded)" />
        <Stat
          label="Ingestion lag"
          value={status ? agoMs(status.coverage.newest_knowledge_ts) : '—'}
          hint={<span className={lag.cls}>{lag.label}</span>}
        />
        <Stat
          label="Quarantine"
          value={status ? status.quarantine.total.toLocaleString() : '—'}
          hint="QA hold-outs"
          valueCls={status && status.quarantine.total > 0 ? 'text-amber-300' : undefined}
        />
      </div>

      {/* Feed health — effective UA + provenance + ingest-enabled. Always visible (operational). */}
      <div className="rounded border border-gray-800 bg-gray-900 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Feed health</h3>
        <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-3 sm:col-span-2">
            <dt className="text-gray-400">Effective EDGAR User-Agent</dt>
            <dd className="truncate font-mono text-xs text-gray-200" title={fh?.edgar_user_agent}>
              {fh?.edgar_user_agent || '(unset)'}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-gray-400">UA source</dt>
            <dd className="text-gray-200">{SOURCE_LABEL[uaSource] ?? uaSource}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-gray-400">UA usable</dt>
            <dd className={uaUsable ? 'text-emerald-400' : 'text-red-400'}>{uaUsable ? 'yes' : 'no — run refuses'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-gray-400">Ingest enabled</dt>
            <dd className={fh?.ingest_enabled ? 'text-emerald-400' : 'text-amber-300'}>
              {fh?.ingest_enabled ? 'yes' : 'no'}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-gray-400">Coverage cap</dt>
            <dd className="text-gray-200">{fh?.coverage_cap ?? config?.coverageCap ?? '—'}</dd>
          </div>
        </dl>
      </div>

      {/* ── PIT-fundamentals summary + per-ticker state table (card 149) ───────────────────────────
          Always-visible (operational, not mode-gated): the live-source line, PIT coverage, stale
          count, the retirable gate, and the full per-ticker table with BOTH provenance clocks. */}
      <FundamentalsSummaryCard summary={summary} />
      <FundamentalsStateTable rows={mergedRows} hasFreshness={!!freshness} hasSource={!!source} />

      {/* Quarantine by-reason — a forensic QA breakdown, not a control: quant-only detail. */}
      {status && status.quarantine.total > 0 && Object.keys(status.quarantine.by_reason).length > 0 && (
        <QuantOnly>
          <div className="rounded border border-gray-800 bg-gray-950 p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Quarantine by reason</h3>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              {Object.entries(status.quarantine.by_reason).map(([reason, n]) => (
                <span key={reason} className="text-gray-300">
                  {reason}: <span className="text-amber-300">{n}</span>
                </span>
              ))}
            </div>
          </div>
        </QuantOnly>
      )}

      {/* Per-name quarantine lookup — forensic QA only (not a control): quant-only. */}
      <QuantOnly>
        <QuarantineLookup />
      </QuantOnly>

      {/* ── Force ingest ──────────────────────────────────────────────────────────────────────── */}
      <div className="rounded border border-gray-800 bg-gray-900 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-gray-100">Run ingest now</h3>
            <p className="mt-1 text-xs text-gray-400">
              Force a full-coverage EDGAR backfill in-cluster (single-flight). Last run:{' '}
              {status?.last_run || run ? (
                <RunBadge run={run ?? status?.last_run ?? null} />
              ) : (
                <span className="text-gray-500">none this pod lifetime</span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={forceIngest}
            disabled={forcing || !!liveRun}
            className="shrink-0 rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
          >
            {forcing || liveRun ? 'Running…' : 'Run ingest now'}
          </button>
        </div>

        {(liveRun || run) && (
          <div className="mt-3 rounded border border-gray-800 bg-gray-950 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-gray-400">
                run <span className="font-mono text-gray-300">{run!.run_id.slice(0, 8)}</span>
              </span>
              <RunBadge run={run} />
              <span className="text-gray-400">scope {run!.scope}</span>
              <span className="text-gray-400">requested {run!.requested}</span>
              <span className="text-gray-400">inserted {run!.canonical_inserted}</span>
              <span className="text-gray-400">revised {run!.canonical_revisions}</span>
              <span className="text-gray-400">quarantined {run!.quarantined}</span>
              {run!.finished_at_ms && (
                <span className="text-gray-500">took {durationMs(run!.finished_at_ms - run!.started_at_ms)}</span>
              )}
            </div>
          </div>
        )}
        {forceMsg && <p className="mt-2 text-xs text-amber-300">{forceMsg}</p>}
      </div>

      {/* ── UA editor ─────────────────────────────────────────────────────────────────────────── */}
      <div className="rounded border border-gray-800 bg-gray-900 p-4">
        <h3 className="font-semibold text-gray-100">EDGAR User-Agent</h3>
        <p className="mt-1 text-xs text-gray-400">
          The descriptive UA (with a contact) SEC fair-access requires. Effective value is{' '}
          <span className="text-gray-300">{SOURCE_LABEL[uaSource] ?? uaSource}</span>; saving sets the
          portal override (empty clears it back to env / default). Applied to the next run cross-pod.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={uaInput}
            onChange={(e) => setUaInput(e.target.value)}
            placeholder="trader-platform/1.0 (you@example.com)"
            spellCheck={false}
            className="w-full min-w-0 flex-1 rounded border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-gray-100 focus:border-emerald-600 focus:outline-none sm:w-auto"
          />
          <button
            type="button"
            onClick={saveUa}
            disabled={savingUa || !uaDirty}
            className="rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
          >
            {savingUa ? 'Saving…' : 'Save'}
          </button>
        </div>
        {uaMsg && <p className="mt-2 text-xs text-amber-300">{uaMsg}</p>}
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

function RunBadge({ run }: { run: RunRecord | null }) {
  if (!run) return <span className="text-gray-500">—</span>
  const cls =
    run.state === 'done'
      ? 'text-emerald-400'
      : run.state === 'failed'
        ? 'text-red-400'
        : 'text-amber-300'
  return (
    <span className={cls}>
      {run.state}
      {run.state !== 'running' && run.finished_at_ms ? ` · ${agoMs(run.finished_at_ms)}` : ''}
    </span>
  )
}

// ── card 149 helpers + sub-components ───────────────────────────────────────────────────────────

// UTC calendar date (yyyy-mm-dd) for a ms timestamp. The bi-temporal model is UTC-anchored, so the
// table renders dates in UTC to keep period-end / availability / store / build instants comparable.
function fmtDateUTC(ms: number | null): string {
  if (ms == null) return '—'
  return new Date(ms).toISOString().slice(0, 10)
}

// Always-visible operator summary: the live strategy source line + the warehouse coverage gate. This
// is operational state (what's serving the live cycle, whether Yahoo is retirable), so NEVER mode-gated.
function FundamentalsSummaryCard({ summary }: { summary: ReturnType<typeof buildSummary> }) {
  const providerLabel =
    summary.provider === 'pit' ? 'PIT (SEC EDGAR)' : summary.provider === 'yahoo' ? 'Yahoo' : '—'
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
              {' / '}
              <span className="text-gray-300">yahoo-snapshot {summary.yahooServed ?? '—'}</span>
              {summary.nullServed ? <span className="text-amber-300"> / null {summary.nullServed}</span> : null}
            </span>
          )}
        </span>
        <span className="text-gray-300" title="Covered / EDGAR-eligible curated US names (the no-EDGAR exception names below are excluded from this denominator)">
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
          last ingest run:{' '}
          <span className="font-semibold text-gray-100">{agoMs(summary.lastIngestRunMs)}</span>
          {summary.lastIngestRunState ? (
            <span className="text-gray-500"> ({summary.lastIngestRunState})</span>
          ) : null}
        </span>
      </div>

      {/* No-EDGAR exception list (epic Task A4) — curated US names that file nothing with the SEC (an
          unsponsored ADR like TCEHY). They are EXCLUDED from the eligible coverage denominator above (so
          never counted "missing" and never blocking retirable) and listed here as a documented
          degrade-to-Yahoo exception — the US analogue of the already-accepted LSE/foreign no-CIK names. */}
      {summary.noEdgar.length > 0 && (
        <p className="mt-3 text-xs text-gray-400" data-testid="fundamentals-no-edgar">
          {summary.noEdgar.length} name{summary.noEdgar.length === 1 ? '' : 's'} degrade to Yahoo (no SEC
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
  { key: 'yahoo', label: 'Yahoo' },
]

// Full per-ticker state table merging the freshness audit (warehouse: covered · fiscal period ·
// availability · last stored · stale) with the strategy by_ticker map (consume: source · last
// read+built). Both clocks per row — the whole point: "last stored" (ingest) ≠ "last read+built"
// (strategy). Sortable + filterable. Always-visible (operational), not mode-gated.
function FundamentalsStateTable({
  rows,
  hasFreshness,
  hasSource,
}: {
  rows: MergedRow[]
  hasFreshness: boolean
  hasSource: boolean
}) {
  const [sortKey, setSortKey] = useState<SortKey>('ticker')
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
      setSortDir(key === 'ticker' || key === 'source' ? 'asc' : 'desc')
    }
  }

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4" data-testid="fundamentals-state-table">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          Per-ticker state
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter ticker…"
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
          Per-ticker state unavailable — freshness + source reads are cold or unreachable.
        </p>
      ) : (
        <>
          <p className="mt-1 text-[11px] text-gray-500">
            Two clocks per row: <span className="text-gray-400">last stored</span> = when our ingest
            last persisted a fact · <span className="text-gray-400">last read+built</span> = when the
            live strategy last read it and built this name&apos;s factors.
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500">
                  <Th label="Ticker" col="ticker" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <Th label="Source" col="source" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <Th label="Covered" col="covered" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <Th label="Fiscal period (obs)" col="fiscal" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <Th label="Availability (know.)" col="availability" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <Th label="Last stored (ingest)" col="lastStored" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <Th label="Last read+built (strat.)" col="lastReadBuilt" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <Th label="Stale?" col="stale" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                </tr>
              </thead>
              <tbody>
                {view.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-3 text-center text-gray-500">
                      No tickers match this filter.
                    </td>
                  </tr>
                ) : (
                  view.map((r) => (
                    <tr key={r.ticker} className="border-b border-gray-900 last:border-0">
                      <td className="py-1.5 pr-3 font-mono text-gray-200">{r.ticker}</td>
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
                      <td className="py-1.5 pr-3 text-gray-300" title={r.lastStoredMs ? new Date(r.lastStoredMs).toISOString() : undefined}>
                        {agoMs(r.lastStoredMs)}
                      </td>
                      <td className="py-1.5 pr-3 text-gray-300" title={r.lastReadBuiltMs ? new Date(r.lastReadBuiltMs).toISOString() : undefined}>
                        {agoMs(r.lastReadBuiltMs)}
                      </td>
                      <td className="py-1.5 pr-3">
                        {r.stale == null ? (
                          <span className="text-gray-600">—</span>
                        ) : r.stale ? (
                          <span className="text-amber-300" title={r.stalenessDays != null ? `${r.stalenessDays}d` : undefined}>
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
            {view.length} of {rows.length} ticker{rows.length === 1 ? '' : 's'}
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

// Per-name quarantine lookup — forensic QA only (wrapped in <QuantOnly> at the call site). Type a
// ticker → the …/quarantine?symbol= proxy → AAPL-scoped counts (or an honest empty for an unknown
// symbol: resolved:false, instrument_id:-1, never the full unfiltered set).
interface QuarantineResult {
  resolved?: boolean
  symbol?: string
  instrument_id?: number
  total: number
  by_reason: Record<string, number>
  by_sector: Record<string, number>
  recent: { reason?: string; occurred_at?: string }[]
}

function QuarantineLookup() {
  const [symbol, setSymbol] = useState('')
  const [result, setResult] = useState<QuarantineResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function lookup(): Promise<void> {
    const s = symbol.trim().toUpperCase()
    if (!s) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const r = await fetch(
        `/portal-api/admin/fundamentals-ingest/quarantine?symbol=${encodeURIComponent(s)}`,
        { cache: 'no-store' },
      )
      const b = await r.json().catch(() => null)
      if (!r.ok || !b) throw new Error(b?.detail ?? b?.error ?? `failed (${r.status})`)
      setResult(b)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded border border-gray-800 bg-gray-950 p-4" data-testid="quarantine-lookup">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        Per-name quarantine lookup
      </h3>
      <p className="mt-1 text-[11px] text-gray-500">
        Scope the QA hold-out forensics to one ticker. An unknown symbol resolves to an honest empty
        (not the full set).
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void lookup()
          }}
          placeholder="e.g. AAPL"
          spellCheck={false}
          className="w-40 rounded border border-gray-700 bg-gray-950 px-2 py-1 font-mono text-sm text-gray-100 focus:border-emerald-600 focus:outline-none"
        />
        <button
          type="button"
          onClick={lookup}
          disabled={loading || symbol.trim() === ''}
          className="rounded bg-emerald-700 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
        >
          {loading ? 'Looking up…' : 'Look up'}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {result && (
        <div className="mt-3 text-sm">
          {result.resolved === false ? (
            <p className="text-amber-300">
              {result.symbol} not resolved (instrument_id {result.instrument_id}) — no such US name in
              the security master. Honest empty.
            </p>
          ) : (
            <>
              <p className="text-gray-300">
                {result.symbol ?? 'symbol'}: <span className="font-semibold text-gray-100">{result.total}</span>{' '}
                quarantined event{result.total === 1 ? '' : 's'}.
              </p>
              {Object.keys(result.by_reason).length > 0 && (
                <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1">
                  {Object.entries(result.by_reason).map(([reason, n]) => (
                    <span key={reason} className="text-gray-300">
                      {reason}: <span className="text-amber-300">{n}</span>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

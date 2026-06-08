'use client'

import { useEffect, useRef, useState } from 'react'
import { QuantOnly } from '@/components/QuantOnly'

// Operations › PIT Fundamentals panel (card 134) — the operator surface over the
// fundamentals-ingestion write-side. Three jobs in one client component, SSR-seeded by the tab:
//   1. MONITOR  — coverage (instruments + facts), ingestion lag, last force-run state, quarantine
//                 count, and feed-health (effective EDGAR UA + provenance + ingest-enabled).
//                 Polls /portal-api/admin/fundamentals-ingest/status every 15s like the other
//                 operator cards (a background CronJob run moves coverage without us triggering it,
//                 so a static view would lie).
//   2. FORCE    — "Run ingest now" → POST …/force (single-flight in-cluster run), then polls
//                 …/runs/{run_id} until done|failed, surfacing the live counts. Confirm-before-run +
//                 disabled-while-running, matching the panic-control affordances.
//   3. UA EDITOR — the EDGAR User-Agent the next run sends to SEC, bound to GET/PUT …/config
//                 (portal_fundamentals_config override > env > default). Shows the effective value +
//                 where it came from; PUT persists the override; an empty value clears it back.
//
// Operational status + the operator controls are NEVER mode-gated (per the portal safety contract);
// only the quarantine by-reason breakdown — a forensic QA detail, not a control — sits under
// <QuantOnly>.

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

export function FundamentalsIngestPanel({ initialStatus, initialConfig }: Props) {
  const [status, setStatus] = useState<IngestStatus | null>(initialStatus)
  const [config, setConfig] = useState<IngestConfig | null>(initialConfig)

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

  // 15s status poll — matches the circuit-breaker / auto-approve cadence.
  useEffect(() => {
    const id = setInterval(refreshStatus, 15_000)
    return () => clearInterval(id)
  }, [])

  // Stop any in-flight run poller on unmount.
  useEffect(() => () => { if (runPoll.current) clearInterval(runPoll.current) }, [])

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
  if (!status && !config) {
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

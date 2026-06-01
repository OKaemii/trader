'use client'
import { useState } from 'react'

// Mirror of strategy-engine GET /admin/api/strategy/config (one entry per known strategy).
// `schema` is the validator's default sweep grid; `defaults` the single live values; the two
// override maps are the portal's stored edits (null = use the strategy's own values).
export interface StrategyConfig {
  strategy_id: string
  schema: Record<string, number[]>
  defaults: Record<string, number>
  liveParams: Record<string, number> | null
  searchGrid: Record<string, number[]> | null
  updatedAt: string | null
}

const GRID_CAP = 256 // matches the server-side reject; product above this blows up MCPT cost

function parseList(csv: string): number[] {
  return csv
    .split(',')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n))
}

export function StrategyConfigEditor({ initial, active }: { initial: StrategyConfig[]; active: string }) {
  const [configs, setConfigs] = useState<StrategyConfig[]>(initial)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    const r = await fetch('/portal-api/admin/strategy/config')
    if (r.ok) {
      const data = await r.json().catch(() => null)
      if (data?.strategies) setConfigs(data.strategies as StrategyConfig[])
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-white">Strategy Config</h1>
        <p className="mt-1 text-sm text-gray-400">
          Per-strategy tunables. <span className="text-gray-200">Live value</span> is hot-applied by
          the engine on the next cycle (no redeploy). <span className="text-gray-200">Search grid</span>{' '}
          is what the validator sweeps — widen it deliberately, MCPT cost scales with the grid size.
        </p>
      </div>
      {configs.map((c) => (
        <StrategyCard
          key={`${c.strategy_id}:${c.updatedAt ?? 'none'}`}
          cfg={c}
          isActive={c.strategy_id === active}
          busy={busy}
          setBusy={setBusy}
          onSaved={refresh}
        />
      ))}
    </div>
  )
}

function StrategyCard({
  cfg,
  isActive,
  busy,
  setBusy,
  onSaved,
}: {
  cfg: StrategyConfig
  isActive: boolean
  busy: boolean
  setBusy: (b: boolean) => void
  onSaved: () => Promise<void>
}) {
  // Union of every tunable key the strategy exposes (some live-only knobs aren't in the grid schema).
  const keys = Array.from(new Set([...Object.keys(cfg.defaults), ...Object.keys(cfg.schema)])).sort()

  const [live, setLive] = useState<Record<string, string>>(() =>
    Object.fromEntries(keys.map((k) => [k, cfg.liveParams?.[k] !== undefined ? String(cfg.liveParams[k]) : ''])),
  )
  const [grid, setGrid] = useState<Record<string, string>>(() =>
    Object.fromEntries(keys.map((k) => [k, cfg.searchGrid?.[k]?.join(', ') ?? ''])),
  )
  const [error, setError] = useState<string | null>(null)

  // Effective grid product (server rejects > GRID_CAP). Empty grid fields fall back to the
  // strategy's default schema for that key, mirroring the validator's resolve-then-fallback.
  let product = 1
  for (const k of keys) {
    const overridden = parseList(grid[k] ?? '')
    const n = overridden.length > 0 ? overridden.length : (cfg.schema[k]?.length ?? 1)
    product *= n
  }
  const gridTooBig = product > GRID_CAP

  async function save() {
    setError(null)
    const liveParams: Record<string, number> = {}
    for (const k of keys) {
      const v = (live[k] ?? '').trim()
      if (v === '') continue
      const n = parseFloat(v)
      if (!Number.isFinite(n)) {
        setError(`Live value for "${k}" is not a number.`)
        return
      }
      liveParams[k] = n
    }
    const searchGrid: Record<string, number[]> = {}
    for (const k of keys) {
      const list = parseList(grid[k] ?? '')
      if (list.length > 0) searchGrid[k] = list
    }
    if (gridTooBig) {
      setError(`Search grid is ${product} points (> ${GRID_CAP}). Trim it before saving.`)
      return
    }

    const liveCount = Object.keys(liveParams).length
    const gridCount = Object.keys(searchGrid).length
    const ok = window.confirm(
      `Save ${cfg.strategy_id} config?\n\n` +
        `• ${liveCount} live value(s) — applied by the engine on the next cycle (no redeploy).\n` +
        `• ${gridCount} grid override(s) — swept on the next validator run (${product} grid points).\n\n` +
        `Empty fields fall back to the strategy's built-in defaults.`,
    )
    if (!ok) return

    setBusy(true)
    try {
      const r = await fetch('/portal-api/admin/strategy/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategy_id: cfg.strategy_id,
          liveParams: liveCount > 0 ? liveParams : null,
          searchGrid: gridCount > 0 ? searchGrid : null,
        }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        setError(body.error ?? `Save failed (${r.status}).`)
        return
      }
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-gray-200">{cfg.strategy_id}</h2>
        {isActive && (
          <span className="rounded bg-emerald-800 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-100">
            active
          </span>
        )}
        <span className="ml-auto text-[11px] text-gray-500">
          {cfg.updatedAt ? `edited ${new Date(cfg.updatedAt).toLocaleString()}` : 'no overrides'}
        </span>
      </div>

      {keys.length === 0 ? (
        <p className="mt-3 text-[11px] text-gray-500">This strategy exposes no tunable parameters.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="text-gray-500">
              <tr className="border-b border-gray-800 text-left">
                <th className="py-1 font-normal">Parameter</th>
                <th className="py-1 font-normal">Live value</th>
                <th className="py-1 font-normal">Search grid (comma-separated)</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k} className="border-b border-gray-800/50">
                  <td className="py-1.5 pr-3 font-mono text-gray-300">{k}</td>
                  <td className="py-1.5 pr-3">
                    <input
                      value={live[k] ?? ''}
                      onChange={(e) => setLive({ ...live, [k]: e.target.value })}
                      placeholder={cfg.defaults[k] !== undefined ? `default ${cfg.defaults[k]}` : '—'}
                      className="w-28 rounded border border-gray-700 bg-gray-950 px-2 py-1 font-mono text-gray-200 placeholder:text-gray-600"
                    />
                  </td>
                  <td className="py-1.5">
                    <input
                      value={grid[k] ?? ''}
                      onChange={(e) => setGrid({ ...grid, [k]: e.target.value })}
                      placeholder={cfg.schema[k] ? cfg.schema[k].join(', ') : 'not swept by default'}
                      className="w-60 rounded border border-gray-700 bg-gray-950 px-2 py-1 font-mono text-gray-200 placeholder:text-gray-600"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy || keys.length === 0 || gridTooBig}
          className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save
        </button>
        <span className={`text-[11px] ${gridTooBig ? 'text-amber-300' : 'text-gray-500'}`}>
          grid = {product} point{product === 1 ? '' : 's'}
          {gridTooBig && ` · exceeds ${GRID_CAP} — MCPT cost ≈ ${product} × ~2000 replays`}
        </span>
        {error && <span className="text-[11px] text-red-400">{error}</span>}
      </div>
    </section>
  )
}

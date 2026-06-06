'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  saveMarketDataConfig,
  backfillMarketData,
  clearMarketDataCache,
  type MarketDataConfig,
  type ProviderInfo,
  type PollIntervalOption,
} from '@/app/actions/admin'
import { OrderType } from '@/types/trader'

type BarFreq = 'daily' | 'intraday'

const TIER_STYLES: Record<PollIntervalOption['tier'], string> = {
  intraday: 'bg-purple-900/40 border-purple-700 text-purple-200',
  hourly:   'bg-amber-900/40  border-amber-700  text-amber-200',
  daily:    'bg-emerald-900/40 border-emerald-700 text-emerald-200',
}

// 'default' = no override; OrderType.Limit/Market = explicit override. We can't put
// 'default' inside the OrderType enum (it isn't a real order type), so the union below
// keeps the sentinel separate from the wire-format integer.
type ExecChoice = 'default' | OrderType

// Render labels for the radio. Limit = T212-friendly (low rate-limit churn); Market
// crosses the spread for immediate fills.
function execLabel(c: ExecChoice): string {
  if (c === 'default') return 'Use Helm default'
  if (c === OrderType.Limit)  return 'Limit (T212-friendly)'
  return 'Market (immediate fill)'
}

function orderTypeName(t: OrderType): string {
  return OrderType[t]   // 'Limit' / 'Market'
}

export function MarketDataEditor({
  initial,
  providerInfo,
}: {
  initial: MarketDataConfig
  providerInfo: ProviderInfo | null
}) {
  const [data, setData] = useState<MarketDataConfig>(initial)
  const [flash, setFlash] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const [barChoice, setBarChoice] = useState<'default' | BarFreq>(
    initial.override.barFrequency ?? 'default',
  )
  const [pollUseDefault, setPollUseDefault] = useState(initial.override.pollIntervalMs == null)
  const [pollMs, setPollMs] = useState<number>(
    initial.override.pollIntervalMs ?? initial.defaults.pollIntervalMs,
  )
  const [execChoice, setExecChoice] = useState<ExecChoice>(
    initial.override.signalOrderType ?? 'default',
  )
  const [sizeUseDefault, setSizeUseDefault] = useState(initial.override.universeMaxSize == null)
  const [universeMaxSize, setUniverseMaxSize] = useState<number>(
    initial.override.universeMaxSize ?? initial.defaults.universeMaxSize,
  )
  // Touched-flag so the auto-pair only fires when the user hasn't already expressed a
  // preference. Without this the radio would snap back every time the user toggled bar
  // frequency, which is surprising.
  const [execTouched, setExecTouched] = useState(false)

  // Auto-suggest: intraday pairs with Market orders (no time to wait on limit fills).
  // Daily pairs with Limit (cheaper on the spread). We only nudge when the operator
  // hasn't explicitly touched the execution radio.
  useEffect(() => {
    if (execTouched) return
    if (barChoice === 'intraday' && execChoice !== OrderType.Market) {
      setExecChoice(OrderType.Market)
    } else if (barChoice === 'daily' && execChoice === OrderType.Market) {
      setExecChoice(OrderType.Limit)
    } else if (barChoice === 'default' && execChoice !== 'default') {
      setExecChoice('default')
    }
  }, [barChoice, execChoice, execTouched])

  function onSave() {
    const sizeOverride = sizeUseDefault ? null : universeMaxSize
    // A change to the effective universe size re-shapes which instruments trade AND invalidates
    // prior backtest_results — confirm before committing (portal convention: spell out the consequence).
    const effectiveSizeNext = sizeOverride ?? data.defaults.universeMaxSize
    if (effectiveSizeNext !== data.effective.universeMaxSize) {
      const ok = window.confirm(
        `Change the active universe size from ${data.effective.universeMaxSize} to ${effectiveSizeNext}?\n\n` +
        `Takes effect on the next universe refresh and changes which instruments are traded. It also ` +
        `INVALIDATES prior backtest_results — re-run validation before re-enabling topology_v1 or any go-live gate.`,
      )
      if (!ok) return
    }
    startTransition(async () => {
      setFlash(null)
      const r = await saveMarketDataConfig(
        barChoice === 'default' ? null : barChoice,
        pollUseDefault ? null : pollMs,
        execChoice === 'default' ? null : execChoice,
        sizeOverride,
      )
      if (r.ok) {
        setFlash(
          execChoice === 'default'
            ? 'Saved. Effective on next poll iteration (universe size applies on the next universe refresh).'
            : `Saved. trading-service picks up signal order type = ${orderTypeName(execChoice)} on the next order; strategy-engine self-restarts (~10s) if bar frequency changed.`,
        )
        setData((d) => ({
          ...d,
          override: {
            barFrequency:    barChoice === 'default'  ? null : barChoice,
            pollIntervalMs:  pollUseDefault ? null : pollMs,
            signalOrderType: execChoice === 'default' ? null : execChoice,
            universeMaxSize: sizeOverride,
          },
          effective: { ...d.effective, universeMaxSize: effectiveSizeNext },
          updatedAt: new Date().toISOString(),
        }))
      } else {
        setFlash(`Save failed (${r.status})${r.error ? ': ' + r.error : ''}.`)
      }
    })
  }

  const effectiveExec: OrderType = execChoice === 'default' ? data.defaults.signalOrderType : execChoice
  const intradayNeedsMarket = barChoice === 'intraday' && effectiveExec !== OrderType.Market

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Market Data</h2>
        <p className="mt-1 text-sm text-gray-400">
          Override bar frequency, poll interval, signal order type, and universe size. Overrides layer
          on top of Helm defaults; pick “Use Helm default” to clear an override.
        </p>
      </div>

      {flash && (
        <div className="rounded border border-emerald-900 bg-emerald-950 px-4 py-2 text-sm text-emerald-300">
          {flash}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <InfoCard
          title="Override"
          rows={[
            ['Bar frequency', data.override.barFrequency ?? '— (default)'],
            [
              'Poll interval',
              data.override.pollIntervalMs != null
                ? `${data.override.pollIntervalMs} ms`
                : '— (default)',
            ],
            ['Signal order type', data.override.signalOrderType == null ? '— (default)' : orderTypeName(data.override.signalOrderType)],
            ['Universe size', data.override.universeMaxSize == null ? '— (default)' : String(data.override.universeMaxSize)],
          ]}
        />
        <InfoCard
          title="Effective (runtime)"
          rows={[
            ['Bar frequency', data.effective.barFrequency],
            ['Poll interval', `${data.effective.pollIntervalMs} ms`],
            ['Signal order type', orderTypeName(data.effective.signalOrderType)],
            ['Universe size', String(data.effective.universeMaxSize)],
          ]}
        />
        <InfoCard
          title="Helm defaults (env)"
          rows={[
            ['Bar frequency', data.defaults.barFrequency],
            ['Poll interval', `${data.defaults.pollIntervalMs} ms`],
            ['Signal order type', orderTypeName(data.defaults.signalOrderType)],
            ['Universe size', String(data.defaults.universeMaxSize)],
          ]}
        />
      </div>

      <section className="rounded border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-3 text-sm font-medium text-gray-300">Edit override</h2>

        <div className="mb-4">
          <div className="mb-1 text-xs text-gray-400">Bar frequency</div>
          <div className="flex gap-3 text-sm">
            {(['default', 'daily', 'intraday'] as const).map((opt) => (
              <label key={opt} className="flex items-center gap-2 text-gray-200">
                <input
                  type="radio"
                  name="bar"
                  checked={barChoice === opt}
                  onChange={() => setBarChoice(opt)}
                />
                {opt === 'default' ? 'Use Helm default' : opt}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Saving propagates live: market-data-service picks up the new poll cadence and bar
            granularity on the next iteration; trading-service swaps order routing per the
            execution mode below; strategy-engine self-restarts (~10s) if bar frequency changed,
            so its rolling-window constant (20 daily → 60 intraday) is recomputed with the new env.
          </p>
        </div>

        <div className="mb-4">
          <div className="mb-1 text-xs text-gray-400">Signal order type (trading-service)</div>
          <div className="flex gap-3 text-sm">
            {(['default', OrderType.Limit, OrderType.Market] as const).map((opt) => (
              <label key={opt} className="flex items-center gap-2 text-gray-200">
                <input
                  type="radio"
                  name="exec"
                  checked={execChoice === opt}
                  onChange={() => { setExecChoice(opt); setExecTouched(true) }}
                />
                {execLabel(opt)}
              </label>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-gray-500">
            <strong>Limit</strong> = priced at last close, kinder on T212's rate limit, can sit unfilled while price drifts.
            <strong> Market</strong> = crosses the spread immediately, no fill delay.
            Risk-exits always use Market regardless of this setting. Trading-service reads this live (15s cache; portal save invalidates immediately).
          </p>
          {intradayNeedsMarket && (
            <div className="mt-2 rounded border border-amber-900 bg-amber-950 px-3 py-2 text-xs text-amber-300">
              Intraday bar frequency pairs with Market orders — signals firing every 15m can't wait
              on limit fills. The current selection still uses Limit; consider switching above.
            </div>
          )}
        </div>

        <div className="mb-4">
          <label className="mb-1 flex items-center gap-2 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={pollUseDefault}
              onChange={(e) => setPollUseDefault(e.target.checked)}
            />
            Use Helm default poll interval
          </label>
          {providerInfo && providerInfo.allowedPollIntervals.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {providerInfo.allowedPollIntervals.map((opt) => {
                const selected = !pollUseDefault && pollMs === opt.ms
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setPollMs(opt.ms)}
                    disabled={pollUseDefault}
                    className={`rounded border px-3 py-1.5 text-xs font-medium transition ${
                      selected
                        ? TIER_STYLES[opt.tier] + ' ring-2 ring-indigo-500'
                        : TIER_STYLES[opt.tier] + ' opacity-60 hover:opacity-100'
                    } disabled:opacity-30`}
                  >
                    {opt.label}
                    <span className="ml-2 text-[10px] uppercase tracking-wide opacity-70">{opt.tier}</span>
                  </button>
                )
              })}
              <span className="self-center text-[10px] text-gray-500">
                provider: <code>{providerInfo.name}</code> · max history{' '}
                {Math.round(providerInfo.maxLookbackMs / 86_400_000)}d
              </span>
            </div>
          ) : (
            <>
              <input
                type="number"
                min={5000}
                max={86_400_000}
                step={1000}
                value={pollMs}
                disabled={pollUseDefault}
                onChange={(e) => setPollMs(parseInt(e.target.value || '0'))}
                className="w-48 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100 disabled:opacity-50"
              />
              <span className="ml-2 text-xs text-gray-500">milliseconds (5_000 – 86_400_000)</span>
            </>
          )}
        </div>

        <div className="mb-4">
          <label className="mb-1 flex items-center gap-2 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={sizeUseDefault}
              onChange={(e) => setSizeUseDefault(e.target.checked)}
            />
            Use Helm default universe size
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={10}
              max={500}
              step={1}
              value={universeMaxSize}
              disabled={sizeUseDefault}
              onChange={(e) => setUniverseMaxSize(parseInt(e.target.value || '0'))}
              className="w-32 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100 disabled:opacity-50"
            />
            <span className="text-xs text-gray-500">active instruments (10–500). Applies on the next universe refresh.</span>
          </div>
          <p className="mt-1 text-[11px] text-amber-400/80">
            Changing the universe size re-shapes which instruments are traded and <strong>invalidates prior
            backtest results</strong> — re-validate before re-enabling topology_v1 or any go-live gate.
          </p>
        </div>

        <button
          onClick={onSave}
          disabled={pending}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save override'}
        </button>
        {data.updatedAt && (
          <span className="ml-3 text-xs text-gray-500">
            Last edit by {data.updatedBy ?? 'unknown'} at {new Date(data.updatedAt).toLocaleString()}
          </span>
        )}
      </section>

      <HistorySection />
    </div>
  )
}

// Backfill + clear-cache controls. Storage is always 5m; backfill pulls 5m history
// from the active provider and upserts. Clear-cache wipes rows (with dry-run preview)
// and is the operator path for cleaning up legacy duplicate-row state.
function HistorySection() {
  const [days, setDays] = useState(60)
  const [tickers, setTickers] = useState('')
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null)
  const [clearMsg, setClearMsg] = useState<string | null>(null)
  const [clearInterval, setClearInterval] = useState<'all' | '5m' | '15m' | '1h' | 'daily'>('all')
  const [pending, startTransition] = useTransition()

  function runBackfill() {
    startTransition(async () => {
      setBackfillMsg(null)
      const list = tickers.split(',').map((t) => t.trim()).filter(Boolean)
      const r = await backfillMarketData(list.length > 0 ? list : null, days)
      if (r.ok) setBackfillMsg(`Backfilled ${r.data.tickers} ticker(s), ${r.data.bars} bars upserted, ${r.data.failures} failures.`)
      else      setBackfillMsg(`Failed (${r.status})${r.error ? ': ' + r.error : ''}.`)
    })
  }

  function runClear(dryRun: boolean) {
    startTransition(async () => {
      setClearMsg(null)
      const interval = clearInterval === 'all' ? null : clearInterval
      const r = await clearMarketDataCache(interval, null, dryRun)
      if (r.ok) {
        const { dryRun: wasDry, wouldDelete, deleted } = r.data
        setClearMsg(wasDry
          ? `Dry run: would delete ${wouldDelete ?? 0} row(s). Click "Clear (commit)" to delete.`
          : `Deleted ${deleted ?? 0} row(s).`)
      } else {
        setClearMsg(`Failed (${r.status})${r.error ? ': ' + r.error : ''}.`)
      }
    })
  }

  return (
    <>
      <section className="rounded border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-1 text-sm font-medium text-gray-300">Backfill 5m history</h2>
        <p className="mb-3 text-xs text-gray-500">
          Pulls historical 5m bars from the active provider (Yahoo: 60-day cap). Bars are upserted
          on (ticker, timestamp, &apos;5m&apos;); re-running is idempotent. Leaving Tickers empty uses the
          active universe.
        </p>

        <div className="mb-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Days
            <input
              type="number"
              min={1}
              max={60}
              step={1}
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value || '60'))}
              className="w-20 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100"
            />
          </label>
          <label className="flex flex-1 items-center gap-2 text-xs text-gray-400">
            Tickers (comma-separated, optional)
            <input
              type="text"
              value={tickers}
              onChange={(e) => setTickers(e.target.value)}
              placeholder="AAPL_US_EQ,MSFT_US_EQ"
              className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100"
            />
          </label>
        </div>

        <button
          onClick={runBackfill}
          disabled={pending}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? 'Running…' : 'Run backfill'}
        </button>
        {backfillMsg && <p className="mt-2 text-xs text-gray-400">{backfillMsg}</p>}
      </section>

      <section className="rounded border border-red-900 bg-gray-900 p-4">
        <h2 className="mb-1 text-sm font-medium text-red-300">Clear bar cache</h2>
        <p className="mb-3 text-xs text-gray-500">
          Wipes rows from <code>ohlcv_bars</code>. Use dry-run first to preview the count. Filtering
          by interval lets you target just the legacy duplicate-row state (interval=daily) without
          touching freshly backfilled 5m bars.
        </p>

        <div className="mb-3 flex items-center gap-3 text-sm">
          <span className="text-xs text-gray-400">Interval</span>
          {(['all', '5m', '15m', '1h', 'daily'] as const).map((opt) => (
            <label key={opt} className="flex items-center gap-1 text-gray-200">
              <input
                type="radio"
                name="clear-interval"
                checked={clearInterval === opt}
                onChange={() => setClearInterval(opt)}
              />
              {opt}
            </label>
          ))}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => runClear(true)}
            disabled={pending}
            className="rounded bg-gray-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-600 disabled:opacity-50"
          >
            Dry run
          </button>
          <button
            onClick={() => {
              if (window.confirm('Permanently delete matching ohlcv_bars rows?')) runClear(false)
            }}
            disabled={pending}
            className="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
          >
            Clear (commit)
          </button>
        </div>
        {clearMsg && <p className="mt-2 text-xs text-gray-400">{clearMsg}</p>}
      </section>
    </>
  )
}

function InfoCard({
  title,
  rows,
}: {
  title: string
  rows: [string, string | number | null][]
}) {
  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">{title}</div>
      <dl className="space-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between">
            <dt className="text-gray-400">{k}</dt>
            <dd className="text-gray-200">{v ?? '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

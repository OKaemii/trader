'use client'

import { useState, useTransition } from 'react'
import { saveMarketDataConfig, type MarketDataConfig } from '@/app/actions/admin'

type BarFreq = 'daily' | 'intraday'

export function MarketDataEditor({ initial }: { initial: MarketDataConfig }) {
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

  function onSave() {
    startTransition(async () => {
      setFlash(null)
      const r = await saveMarketDataConfig(
        barChoice === 'default' ? null : barChoice,
        pollUseDefault ? null : pollMs,
      )
      if (r.ok) {
        setFlash('Saved. Effective on next poll iteration.')
        setData((d) => ({
          ...d,
          override: {
            barFrequency: barChoice === 'default' ? null : barChoice,
            pollIntervalMs: pollUseDefault ? null : pollMs,
          },
          updatedAt: new Date().toISOString(),
        }))
      } else {
        setFlash(`Save failed (${r.status})${r.error ? ': ' + r.error : ''}.`)
      }
    })
  }

  const intradayWarning = barChoice === 'intraday'

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Market Data</h1>
        <p className="mt-1 text-sm text-gray-400">
          Override bar frequency and poll interval. Overrides layer on top of Helm defaults; pick
          “Use Helm default” to clear an override.
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
          ]}
        />
        <InfoCard
          title="Effective (runtime)"
          rows={[
            ['Bar frequency', data.effective.barFrequency],
            ['Poll interval', `${data.effective.pollIntervalMs} ms`],
          ]}
        />
        <InfoCard
          title="Helm defaults (env)"
          rows={[
            ['Bar frequency', data.defaults.barFrequency],
            ['Poll interval', `${data.defaults.pollIntervalMs} ms`],
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
          {intradayWarning && (
            <div className="mt-2 rounded border border-amber-900 bg-amber-950 px-3 py-2 text-xs text-amber-300">
              Intraday mode requires <code>EXECUTION_MODE=unrestricted</code> on strategy-engine.
              The override will be saved, but strategy/signal services must be configured separately.
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
    </div>
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

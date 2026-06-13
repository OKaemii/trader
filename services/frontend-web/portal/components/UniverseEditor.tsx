'use client'

import { useState, useTransition } from 'react'
import {
  refreshUniverse,
  saveUniverseOverrides,
  type UniverseOverrides,
} from '@/app/actions/admin'
import { identityKey, parseForcedAdd, type Market, type TickerIdentity } from '@/app/lib/ticker-identity'
import { MARKET_STYLES } from './market'

// Forced-add / forced-remove editor for the active universe. Since the bare-ticker flag-day (epic
// pit-fundamentals-lake-rearchitecture, Task 21) the operator types a BARE symbol (`GOOGL`) + picks a
// market (default US); the broker `_US_EQ` / `l_EQ` form never appears in this UI. Entries are bare
// `{symbol, market}` identities, rendered as `SYMBOL` + a market badge (so a cross-listed name is
// disambiguated), and posted as bare objects (saveUniverseOverrides → the backend resolves an add
// against the T212 catalog and persists the bare identity).

const MARKETS: Market[] = ['US', 'LSE']

export function UniverseEditor({ initial }: { initial: UniverseOverrides }) {
  const [adds, setAdds] = useState<TickerIdentity[]>(initial.adds)
  const [removes, setRemoves] = useState<TickerIdentity[]>(initial.removes)
  const [updatedAt, setUpdatedAt] = useState<string | null>(initial.updatedAt)
  const [updatedBy] = useState<string | null>(initial.updatedBy)
  const [addInput, setAddInput] = useState('')
  const [addMarket, setAddMarket] = useState<Market>('US')
  const [removeInput, setRemoveInput] = useState('')
  const [removeMarket, setRemoveMarket] = useState<Market>('US')
  const [flash, setFlash] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Parse the typed value (bare symbol, or a pasted legacy T212 string whose suffix market wins) into
  // the bare identity, then de-dup on (symbol, market). A blank/unparseable entry is ignored.
  function pushUnique(list: TickerIdentity[], raw: string, market: Market): TickerIdentity[] {
    const id = parseForcedAdd(raw, market)
    if (!id) return list
    const key = identityKey(id)
    if (list.some((e) => identityKey(e) === key)) return list
    return [...list, id]
  }

  function onSave() {
    startTransition(async () => {
      setFlash(null)
      const r = await saveUniverseOverrides(adds, removes)
      setFlash(r.ok ? 'Saved. Applied on next refresh.' : `Save failed (${r.status}).`)
      if (r.ok) setUpdatedAt(new Date().toISOString())
    })
  }

  function onRefresh() {
    startTransition(async () => {
      setFlash(null)
      const r = await refreshUniverse()
      if (r.ok) {
        setFlash(`Universe rebuilt — ${r.universeSize} tickers.`)
        // The server-action revalidatePath will refresh page; for instant feedback,
        // refetch via a server action would be ideal — for now show count.
      } else {
        setFlash(`Refresh failed (${r.status}).`)
      }
    })
  }

  return (
    <div className="space-y-6">
      {flash && (
        <div className="rounded border border-emerald-900 bg-emerald-950 px-4 py-2 text-sm text-emerald-300">
          {flash}
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={onSave}
          disabled={pending}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? 'Working…' : 'Save'}
        </button>
        <button
          onClick={onRefresh}
          disabled={pending}
          className="rounded border border-gray-700 bg-gray-800 px-4 py-2 text-sm font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-50"
        >
          {pending ? 'Working…' : 'Refresh now'}
        </button>
        {updatedAt && (
          <span className="self-center text-xs text-gray-500">
            Last edit by {updatedBy ?? 'unknown'} at {new Date(updatedAt).toLocaleString()}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <OverrideList
          title="Forced adds"
          placeholder="Symbol (e.g. GOOGL)"
          entries={adds}
          input={addInput}
          market={addMarket}
          onInput={setAddInput}
          onMarket={setAddMarket}
          onAdd={() => {
            setAdds((cur) => pushUnique(cur, addInput, addMarket))
            setAddInput('')
          }}
          onDelete={(key) => setAdds((cur) => cur.filter((e) => identityKey(e) !== key))}
        />
        <OverrideList
          title="Forced removes"
          placeholder="Symbol to exclude (e.g. TSLA)"
          entries={removes}
          input={removeInput}
          market={removeMarket}
          onInput={setRemoveInput}
          onMarket={setRemoveMarket}
          onAdd={() => {
            setRemoves((cur) => pushUnique(cur, removeInput, removeMarket))
            setRemoveInput('')
          }}
          onDelete={(key) => setRemoves((cur) => cur.filter((e) => identityKey(e) !== key))}
        />
      </div>
    </div>
  )
}

// One forced-adds / forced-removes column: a bare-symbol input + a market selector, and the list of
// bare identities (rendered SYMBOL + market badge). Extracted so adds + removes share the identical
// bare-identity affordance.
function OverrideList({
  title,
  placeholder,
  entries,
  input,
  market,
  onInput,
  onMarket,
  onAdd,
  onDelete,
}: {
  title: string
  placeholder: string
  entries: TickerIdentity[]
  input: string
  market: Market
  onInput: (v: string) => void
  onMarket: (m: Market) => void
  onAdd: () => void
  onDelete: (key: string) => void
}) {
  return (
    <section className="rounded border border-gray-800 bg-gray-900 p-4">
      <h2 className="mb-2 text-sm font-medium text-gray-300">{title}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onAdd()
        }}
        className="mb-2 flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => onInput(e.target.value)}
          placeholder={placeholder}
          aria-label={`${title} symbol`}
          className="flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100 placeholder:text-gray-600"
        />
        <select
          value={market}
          onChange={(e) => onMarket(e.target.value as Market)}
          aria-label={`${title} market`}
          className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-200"
        >
          {MARKETS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded bg-gray-800 px-3 py-1 text-sm text-gray-200 hover:bg-gray-700"
        >
          Add
        </button>
      </form>
      <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
        {entries.length === 0 && <li className="text-gray-500">None.</li>}
        {entries.map((e) => {
          const key = identityKey(e)
          const styles = MARKET_STYLES[e.market]
          return (
            <li
              key={key}
              className="flex items-center justify-between rounded px-2 py-1 hover:bg-gray-800"
            >
              <span className="flex items-center gap-2">
                <span className="font-mono text-gray-200">{e.symbol}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${styles.bg} ${styles.text}`}>
                  {styles.label}
                </span>
              </span>
              <button
                onClick={() => onDelete(key)}
                className="text-gray-500 hover:text-red-400"
                aria-label={`Remove ${e.symbol} (${e.market})`}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

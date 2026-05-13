'use client'

import { useState, useMemo, useTransition } from 'react'
import {
  refreshUniverse,
  saveUniverseOverrides,
  type UniverseOverrides,
} from '@/app/actions/admin'

export function UniverseEditor({ initial }: { initial: UniverseOverrides }) {
  const [adds, setAdds] = useState<string[]>(initial.adds)
  const [removes, setRemoves] = useState<string[]>(initial.removes)
  const [active, setActive] = useState<string[]>(initial.activeUniverse)
  const [updatedAt, setUpdatedAt] = useState<string | null>(initial.updatedAt)
  const [updatedBy, setUpdatedBy] = useState<string | null>(initial.updatedBy)
  const [addInput, setAddInput] = useState('')
  const [removeInput, setRemoveInput] = useState('')
  const [flash, setFlash] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const addSet = useMemo(() => new Set(adds.map((t) => t.toUpperCase())), [adds])
  const removeSet = useMemo(() => new Set(removes.map((t) => t.toUpperCase())), [removes])

  function pushUnique(list: string[], raw: string): string[] {
    const v = raw.toUpperCase().trim()
    if (!v || list.includes(v)) return list
    return [...list, v]
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
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Universe</h1>
        <p className="mt-1 text-sm text-gray-400">
          Forced adds and removes layer on top of the T212 eligibility-filtered list. Save
          persists; Refresh now rebuilds the universe immediately.
        </p>
      </div>

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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <section className="rounded border border-gray-800 bg-gray-900 p-4">
          <h2 className="mb-2 text-sm font-medium text-gray-300">
            Active universe <span className="text-gray-500">({active.length})</span>
          </h2>
          <div className="max-h-96 overflow-y-auto text-sm">
            {active.length === 0 && <div className="text-gray-500">No universe loaded.</div>}
            <ul className="space-y-1">
              {active.map((t) => {
                const isForced = addSet.has(t.toUpperCase())
                return (
                  <li
                    key={t}
                    className="flex items-center justify-between rounded px-2 py-1 hover:bg-gray-800"
                  >
                    <span className="text-gray-200">{t}</span>
                    {isForced && (
                      <span className="rounded bg-indigo-900 px-1.5 py-0.5 text-[10px] uppercase text-indigo-300">
                        Override
                      </span>
                    )}
                  </li>
                )
              })}
              {Array.from(removeSet).map((t) => (
                <li
                  key={`r-${t}`}
                  className="flex items-center justify-between rounded px-2 py-1 text-gray-500 line-through"
                >
                  <span>{t}</span>
                  <span className="rounded bg-red-950 px-1.5 py-0.5 text-[10px] uppercase text-red-400 no-underline">
                    Excluded
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="rounded border border-gray-800 bg-gray-900 p-4">
          <h2 className="mb-2 text-sm font-medium text-gray-300">Forced adds</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setAdds((cur) => pushUnique(cur, addInput))
              setAddInput('')
            }}
            className="mb-2 flex gap-2"
          >
            <input
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
              placeholder="Ticker (e.g. AAPL)"
              className="flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100 placeholder:text-gray-600"
            />
            <button
              type="submit"
              className="rounded bg-gray-800 px-3 py-1 text-sm text-gray-200 hover:bg-gray-700"
            >
              Add
            </button>
          </form>
          <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
            {adds.length === 0 && <li className="text-gray-500">None.</li>}
            {adds.map((t) => (
              <li
                key={t}
                className="flex items-center justify-between rounded px-2 py-1 hover:bg-gray-800"
              >
                <span className="text-gray-200">{t}</span>
                <button
                  onClick={() => setAdds((cur) => cur.filter((x) => x !== t))}
                  className="text-gray-500 hover:text-red-400"
                  aria-label={`Remove ${t}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded border border-gray-800 bg-gray-900 p-4">
          <h2 className="mb-2 text-sm font-medium text-gray-300">Forced removes</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setRemoves((cur) => pushUnique(cur, removeInput))
              setRemoveInput('')
            }}
            className="mb-2 flex gap-2"
          >
            <input
              value={removeInput}
              onChange={(e) => setRemoveInput(e.target.value)}
              placeholder="Ticker to exclude"
              className="flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100 placeholder:text-gray-600"
            />
            <button
              type="submit"
              className="rounded bg-gray-800 px-3 py-1 text-sm text-gray-200 hover:bg-gray-700"
            >
              Add
            </button>
          </form>
          <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
            {removes.length === 0 && <li className="text-gray-500">None.</li>}
            {removes.map((t) => (
              <li
                key={t}
                className="flex items-center justify-between rounded px-2 py-1 hover:bg-gray-800"
              >
                <span className="text-gray-200">{t}</span>
                <button
                  onClick={() => setRemoves((cur) => cur.filter((x) => x !== t))}
                  className="text-gray-500 hover:text-red-400"
                  aria-label={`Remove ${t}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}

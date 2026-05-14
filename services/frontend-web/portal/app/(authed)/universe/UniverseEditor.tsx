'use client'

import { useState, useTransition } from 'react'
import {
  refreshUniverse,
  saveUniverseOverrides,
  type UniverseOverrides,
} from '@/app/actions/admin'

export function UniverseEditor({ initial }: { initial: UniverseOverrides }) {
  const [adds, setAdds] = useState<string[]>(initial.adds)
  const [removes, setRemoves] = useState<string[]>(initial.removes)
  const [updatedAt, setUpdatedAt] = useState<string | null>(initial.updatedAt)
  const [updatedBy] = useState<string | null>(initial.updatedBy)
  const [addInput, setAddInput] = useState('')
  const [removeInput, setRemoveInput] = useState('')
  const [flash, setFlash] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function pushUnique(list: string[], raw: string): string[] {
    // Preserve case: T212 tickers like SGLNl_EQ encode exchange in the lowercase suffix
    // letter (`l` = London). Upper-casing the whole ticker corrupts it. Whitespace trimmed.
    const v = raw.trim()
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
              placeholder="T212 ticker (e.g. AAPL_US_EQ or SGLNl_EQ — case matters)"
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
              placeholder="T212 ticker to exclude (case-sensitive)"
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

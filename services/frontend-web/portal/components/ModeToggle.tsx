'use client'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { setMode } from '@/app/lib/mode'
import { useMode } from './ModeProvider'

// Beginner⇄Quant switch, styled on the AutoApproveToggle idiom (role="switch" pill).
// ON = Quant (full surface), OFF = Beginner (curated). On change it calls the setMode
// server action to persist the cookie, then router.refresh() so server-rendered surfaces
// (the layout's getMode() + any <QuantOnly>) re-evaluate against the new cookie.
//
// No confirm-before-mutate here: per AGENTS.md that guard is for state-changing actions;
// this only flips a display preference (no broker orders, no risk state). The visual
// idiom still matches the existing toggles for consistency.
export function ModeToggle() {
  const router = useRouter()
  const current = useMode()
  // Optimistic local mirror so the pill moves instantly; reconciled by router.refresh()
  // re-seeding <ModeProvider initial> (and rolled back if the server action throws).
  const [optimistic, setOptimistic] = useState(current === 'quant')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function toggle() {
    if (pending) return
    const nextQuant = !optimistic
    setOptimistic(nextQuant)
    setError(null)
    startTransition(async () => {
      try {
        await setMode(nextQuant ? 'quant' : 'beginner')
        router.refresh()
      } catch (e) {
        setOptimistic(!nextQuant) // rollback
        setError(e instanceof Error ? e.message : 'Failed to change mode')
      }
    })
  }

  const isQuant = optimistic

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-gray-300">Quant mode</h2>
          <p className="mt-1 text-xs text-gray-500">
            {isQuant
              ? 'ON — full surface, including advanced research & validation panels.'
              : 'Beginner — advanced panels curated away. Safety controls stay visible.'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isQuant}
          aria-label="Quant mode"
          onClick={toggle}
          disabled={pending}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
            isQuant ? 'bg-emerald-600' : 'bg-gray-700'
          } ${pending ? 'opacity-50' : ''}`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-lg transition-transform duration-200 ${
              isQuant ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}

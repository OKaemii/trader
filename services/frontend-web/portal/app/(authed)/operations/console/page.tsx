import { authedFetch } from '@/app/lib/auth-fetch'
import { PanicControls } from './PanicControls'

// Operations console — the safety surface (kill switch / pause / flatten). SSR-seeds the current
// control state, then the client component mutates + re-reads. Health/KPI/equity widgets are a
// follow-up (Plan C phases G2/G3).
export default async function ConsolePage() {
  const r = await authedFetch('/admin/api/signals/risk/controls')
  const controls = r.ok ? await r.json() : { killSwitch: false, paused: false }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Operations Console</h1>
        <p className="text-sm text-gray-400">Panic controls — global kill switch, strategy pause, and flatten-all.</p>
      </div>
      {!r.ok && (
        <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          {r.status === 401 || r.status === 403 ? 'Admin role required.' : `Controls state unavailable (${r.status}) — actions still work.`}
        </div>
      )}
      <PanicControls initial={controls} />
    </div>
  )
}

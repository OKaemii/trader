import { authedFetch } from '@/app/lib/auth-fetch'
import { ScannerView } from './ScannerView'

// SSR-seed: fetch the scanner snapshot + feed health server-side (JWT stays server-side), then
// hand to the client view for display + mutate (run scan / refresh fundamentals).
export default async function ScannerPage() {
  const [snapRes, healthRes, pieRes] = await Promise.all([
    authedFetch('/admin/api/market-data/scanner/snapshot'),
    authedFetch('/admin/api/market-data/scanner/feed-health'),
    authedFetch('/admin/api/signals/pies/strategy/high_velocity_v1'),   // active pie (best-effort)
  ])

  if (!snapRes.ok) {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-bold text-white">Market Scanner</h1>
        <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          {snapRes.status === 401 || snapRes.status === 403 ? 'Admin role required.' : `Failed to load (${snapRes.status}).`}
        </div>
      </div>
    )
  }

  const snapshot = await snapRes.json()
  const health = healthRes.ok ? await healthRes.json() : null
  const pie = pieRes.ok ? await pieRes.json() : null
  return <ScannerView initialSnapshot={snapshot} initialHealth={health} initialPie={pie} />
}

import { getMarketDataConfig, getMarketDataProviderInfo } from '@/app/actions/admin'
import { MarketDataEditor } from './MarketDataEditor'

export default async function MarketDataPage() {
  const [cfg, prov] = await Promise.all([
    getMarketDataConfig(),
    getMarketDataProviderInfo(),
  ])

  if (!cfg.ok) {
    return (
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Market Data</h1>
        </div>
        <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          {cfg.status === 401 || cfg.status === 403
            ? 'Admin role required.'
            : `Failed to load (${cfg.status}).`}
        </div>
      </div>
    )
  }

  // Provider-info failure is non-fatal — the editor falls back to the free-form ms
  // input. Most likely cause is an older market-data-service that doesn't expose the
  // endpoint yet.
  const providerInfo = prov.ok ? prov.data : null

  return <MarketDataEditor initial={cfg.data} providerInfo={providerInfo} />
}

'use server'

import { revalidatePath } from 'next/cache'
import { authedFetch } from '@/app/lib/auth-fetch'

export interface ActiveInstrument {
  ticker: string
  name: string
  sector: string
  market: 'US' | 'LSE' | 'OTHER'
  adv: number
}

export interface UniverseOverrides {
  adds: string[]
  removes: string[]
  activeUniverse: string[]
  activeUniverseDetailed?: ActiveInstrument[]
  updatedBy: string | null
  updatedAt: string | null
}

import type { OrderType } from '@/types/trader'

export interface MarketDataConfig {
  override: {
    barFrequency: 'daily' | 'intraday' | null
    pollIntervalMs: number | null
    // Numeric enum value (0 = Limit, 1 = Market). null = no override, use Helm default.
    signalOrderType: OrderType | null
  }
  effective: {
    barFrequency: 'daily' | 'intraday'
    pollIntervalMs: number
    signalOrderType: OrderType
  }
  defaults: {
    barFrequency: 'daily' | 'intraday'
    pollIntervalMs: number
    signalOrderType: OrderType
  }
  updatedBy: string | null
  updatedAt: string | null
}

// ── Universe ────────────────────────────────────────────────────────────────

export async function getUniverseOverrides(): Promise<
  { ok: true; data: UniverseOverrides } | { ok: false; status: number }
> {
  const r = await authedFetch('/api/admin/universe/overrides')
  if (!r.ok) return { ok: false, status: r.status }
  return { ok: true, data: (await r.json()) as UniverseOverrides }
}

export async function saveUniverseOverrides(
  adds: string[],
  removes: string[],
): Promise<{ ok: boolean; status: number }> {
  const r = await authedFetch('/api/admin/universe/overrides', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adds, removes }),
  })
  if (r.ok) revalidatePath('/universe')
  return { ok: r.ok, status: r.status }
}

export async function refreshUniverse(): Promise<
  { ok: true; universeSize: number } | { ok: false; status: number }
> {
  const r = await authedFetch('/api/admin/universe/refresh', { method: 'POST' })
  if (!r.ok) return { ok: false, status: r.status }
  const j = (await r.json()) as { universeSize: number }
  revalidatePath('/universe')
  return { ok: true, universeSize: j.universeSize }
}

// ── Market-data config ──────────────────────────────────────────────────────

export async function getMarketDataConfig(): Promise<
  { ok: true; data: MarketDataConfig } | { ok: false; status: number }
> {
  const r = await authedFetch('/api/admin/market-data/config')
  if (!r.ok) return { ok: false, status: r.status }
  return { ok: true, data: (await r.json()) as MarketDataConfig }
}

export type PollIntervalTier = 'intraday' | 'hourly' | 'daily'
export interface PollIntervalOption {
  key:   string
  ms:    number
  label: string
  tier:  PollIntervalTier
}
export interface ProviderInfo {
  name:                 string
  maxLookbackMs:        number
  allowedPollIntervals: PollIntervalOption[]
}

export async function getMarketDataProviderInfo(): Promise<
  { ok: true; data: ProviderInfo } | { ok: false; status: number }
> {
  const r = await authedFetch('/api/admin/market-data/provider-info')
  if (!r.ok) return { ok: false, status: r.status }
  return { ok: true, data: (await r.json()) as ProviderInfo }
}

export async function saveMarketDataConfig(
  barFrequency: 'daily' | 'intraday' | null,
  pollIntervalMs: number | null,
  signalOrderType: OrderType | null,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const r = await authedFetch('/api/admin/market-data/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ barFrequency, pollIntervalMs, signalOrderType }),
  })
  if (r.ok) {
    revalidatePath('/market-data')
    return { ok: true, status: r.status }
  }
  const j = await r.json().catch(() => ({})) as { error?: string }
  return { ok: false, status: r.status, error: j.error }
}

// ── Backfill / clear-cache ──────────────────────────────────────────────────
//
// Backfill pulls 5m history from the active provider (Yahoo today), upserts to
// ohlcv_bars, invalidates the shared-bars Redis cache. Idempotent — re-running on
// already-covered tickers rewrites the same rows. The bootstrap path runs the same
// logic on first boot; this action is for explicit operator-driven refreshes.

export interface BackfillResult {
  tickers: number
  bars: number
  failures: number
}

export async function backfillMarketData(
  tickers: string[] | null,
  days: number,
): Promise<{ ok: true; data: BackfillResult } | { ok: false; status: number; error?: string }> {
  const body: Record<string, unknown> = { days }
  if (tickers && tickers.length > 0) body.tickers = tickers
  const r = await authedFetch('/api/admin/market-data/backfill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const j = await r.json().catch(() => ({})) as { error?: string }
    return { ok: false, status: r.status, error: j.error }
  }
  return { ok: true, data: (await r.json()) as BackfillResult }
}

// Wipes rows from ohlcv_bars. With dryRun=true (default) returns the would-delete count
// without mutating — operator inspects before committing. `interval` and `beforeTimestamp`
// narrow the scope; omit both to wipe everything (use with care).
export interface ClearCacheResult {
  dryRun?: boolean
  wouldDelete?: number
  deleted?: number
  filter: Record<string, unknown>
}

// ── Read-only bar history ───────────────────────────────────────────────────
//
// Calls market-data-service's admin /bars endpoint (which reads from the shared-bars
// Redis cache, falling back to Mongo). Used by the Universe page's history chart.

export type BarInterval = '5m' | '15m' | '1h' | 'daily'
export type BarRange    = '30d' | '60d' | '90d'

export interface BarPoint {
  ticker: string
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface MarketDataHealth {
  status: 'ok'
  bar_frequency: 'daily' | 'intraday'
  poll_interval_ms: number
  universe_size: number
  last_poll_ts: number | null
  last_bar_count: number
  total_cycles: number
  next_poll_ts: number
}

export async function getMarketDataHealth(): Promise<
  { ok: true; data: MarketDataHealth } | { ok: false; status: number }
> {
  const r = await authedFetch('/api/admin/market-data/health')
  if (!r.ok) return { ok: false, status: r.status }
  return { ok: true, data: (await r.json()) as MarketDataHealth }
}

export async function getMarketDataCoverage(): Promise<
  { ok: true; data: Record<string, number> } | { ok: false; status: number }
> {
  const r = await authedFetch('/api/admin/market-data/coverage')
  if (!r.ok) return { ok: false, status: r.status }
  const body = (await r.json()) as { coverage: Record<string, number> }
  return { ok: true, data: body.coverage ?? {} }
}

export async function getBarHistory(
  ticker: string,
  interval: BarInterval,
  range: BarRange,
): Promise<{ ok: true; data: { ticker: string; interval: BarInterval; range: BarRange; bars: BarPoint[] } } | { ok: false; status: number; error?: string }> {
  const url = `/api/admin/market-data/bars/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`
  const r = await authedFetch(url)
  if (!r.ok) {
    const j = await r.json().catch(() => ({})) as { error?: string }
    return { ok: false, status: r.status, error: j.error }
  }
  return { ok: true, data: (await r.json()) }
}

export async function clearMarketDataCache(
  interval: '5m' | '15m' | '1h' | 'daily' | null,
  beforeTimestamp: number | null,
  dryRun: boolean,
): Promise<{ ok: true; data: ClearCacheResult } | { ok: false; status: number; error?: string }> {
  const body: Record<string, unknown> = { dryRun }
  if (interval)        body.interval        = interval
  if (beforeTimestamp) body.beforeTimestamp = beforeTimestamp
  const r = await authedFetch('/api/admin/market-data/clear-cache', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const j = await r.json().catch(() => ({})) as { error?: string }
    return { ok: false, status: r.status, error: j.error }
  }
  return { ok: true, data: (await r.json()) as ClearCacheResult }
}

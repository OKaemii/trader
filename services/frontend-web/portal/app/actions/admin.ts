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

export interface MarketDataConfig {
  override: { barFrequency: 'daily' | 'intraday' | null; pollIntervalMs: number | null }
  effective: { barFrequency: 'daily' | 'intraday'; pollIntervalMs: number }
  defaults: { barFrequency: 'daily' | 'intraday'; pollIntervalMs: number }
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

export async function saveMarketDataConfig(
  barFrequency: 'daily' | 'intraday' | null,
  pollIntervalMs: number | null,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const r = await authedFetch('/api/admin/market-data/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ barFrequency, pollIntervalMs }),
  })
  if (r.ok) {
    revalidatePath('/market-data')
    return { ok: true, status: r.status }
  }
  const j = await r.json().catch(() => ({})) as { error?: string }
  return { ok: false, status: r.status, error: j.error }
}

// Technical-indicator route — a thin, metered passthrough to EODHD's Technical API (Task 13's
// eodhd-client.technical()), surfaced for the History page's supplemental overlays (T28, plan §H).
//
//   Admin: GET /admin/api/market-data/technical?ticker=&func=[&period=&from=&to=]
//          → { ticker, func, points: [{ date, values }, …] }
//
// DISPLAY / SUPPLEMENT ONLY. These are the indicators we deliberately do NOT compute client-side
// (MACD/ADX/ATR/Bollinger/beta). The trading *factors* stay computed in quant-core for live/replay
// parity (§H) — this endpoint never feeds the strategy. It holds no store: technical series are a
// read-only research overlay, so we map the ticker and pass straight through to the metered client,
// which degrades to [] on budget exhaustion / not-entitled / error (never throws into a request).
//
// `func` is allow-listed to the supplement set so a stray query can't burn the EODHD budget on an
// arbitrary indicator and to make the "display-only" intent explicit at the seam. Auth is per-route
// (parseAdminHeaders), mirroring the corporate-actions / news routers.

import { Hono } from 'hono';
import { parseAdminHeaders } from '@trader/shared-auth/middleware';
import {
  getEodhdClient,
  toEodhdSymbol,
  type EodhdTechnicalPoint,
} from '../bars/infrastructure/providers/eodhd-client.ts';

// The supplemental indicators the History overlays offer. Kept here (not in the client) because the
// allow-list is a UI/seam policy, not an EODHD capability — the client can fetch any function. ADX
// and ATR are oscillator/range outputs; bbands/beta/sma carry the price-unit caveat (see below).
export const TECHNICAL_FUNCS = ['macd', 'adx', 'atr', 'bbands', 'beta', 'volatility', 'sma'] as const;
export type TechnicalFunc = (typeof TECHNICAL_FUNCS)[number];

// Indirection so the route is unit-testable without an HTTP round-trip to EODHD: the wiring binds
// this to getEodhdClient().technical() through the same T212→EODHD symbol resolution the
// corporate-actions / daily-feed paths use; a test injects a fake.
export type TechnicalFetcher = (
  ticker: string,
  func: TechnicalFunc,
  params: Record<string, string>,
) => Promise<EodhdTechnicalPoint[]>;

export const defaultTechnicalFetcher: TechnicalFetcher = (ticker, func, params) =>
  getEodhdClient().technical(toEodhdSymbol(ticker), func, params);

export function createTechnicalRouter(fetcher: TechnicalFetcher = defaultTechnicalFetcher): Hono {
  const r = new Hono();

  r.get('/admin/api/market-data/technical', parseAdminHeaders, async (c) => {
    const ticker = (c.req.query('ticker') ?? '').trim();
    if (!ticker) return c.json({ error: 'ticker query param required' }, 400);

    const func = (c.req.query('func') ?? '').trim().toLowerCase();
    if (!func) return c.json({ error: 'func query param required' }, 400);
    if (!(TECHNICAL_FUNCS as readonly string[]).includes(func)) {
      return c.json({ error: `func must be one of: ${TECHNICAL_FUNCS.join(', ')}`, allowed: TECHNICAL_FUNCS }, 400);
    }

    // Pass through only the small set of EODHD params the overlays use, ignoring anything else so a
    // caller can't smuggle arbitrary query knobs at the upstream. `period` defaults are EODHD's own.
    const params: Record<string, string> = {};
    for (const key of ['period', 'from', 'to'] as const) {
      const v = (c.req.query(key) ?? '').trim();
      if (v) params[key] = v;
    }

    const points = await fetcher(ticker, func as TechnicalFunc, params);
    return c.json({ ticker, func, points });
  });

  return r;
}

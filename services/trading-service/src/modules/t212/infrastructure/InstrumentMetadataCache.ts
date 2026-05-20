import type { Logger } from '@trader/core';
import type { Trading212Client } from './Trading212Client.ts';

// Per-ticker order rules derived from T212 instrument metadata.
//
//   minQuantity — smallest tradeable size. A submission below this returns 4xx
//                 `min-quantity-exceeded`. Implicit precision = number of decimals
//                 in minQuantity itself (T212 won't accept finer subdivisions).
//   precision   — number of decimal places the broker will accept. `0.01` → 2,
//                 `0.001` → 3, `1` → 0 (whole-share). Sub-broker tickers commonly
//                 quote oddly-precisioned minima (e.g. 0.01510719 for LSE ETF SUPRl);
//                 the broker still enforces the implied 8 decimals exactly.
export interface QuantityRules {
  minQuantity: number;
  precision:   number;
}

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h — T212 ticker set is stable day-to-day.

// Default precision applied to every instrument when T212's metadata response doesn't
// expose a per-ticker precision field (which is the current production reality — the
// public /equity/metadata/instruments endpoint omits it entirely). 2 was picked from
// observed broker rejections: LSE GBX names (LANDl, SBRYl, BMEl, CNAl, UUl) require
// precision ≤ 2; sending 4 dp gets a `quantity-precision-mismatch` 400 from T212.
// US fractional names that genuinely accept 4 dp will be over-floored at this default
// (e.g. 0.9148 → 0.91) — that's a small economic cost we eat until we can source the
// real per-ticker precision (planned follow-up).
export const DEFAULT_PRECISION = 2;
const FALLBACK_RULES: QuantityRules = { minQuantity: 10 ** -DEFAULT_PRECISION, precision: DEFAULT_PRECISION };

// Tiny in-process cache. The full instrument list is ~5k entries and a few MB; one
// fetch per pod per day. Not persisted to Redis — a cold pod just refetches.
//
// On first call we lazy-load; subsequent calls within REFRESH_INTERVAL_MS hit the
// in-memory map. After that, a single background refresh kicks off and the previous
// map remains in use until it completes (no thundering herd, no stale-then-empty gap).
export class InstrumentMetadataCache {
  private rules: Map<string, QuantityRules> = new Map();
  private lastLoad = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly client: Trading212Client,
    private readonly logger: Logger,
  ) {}

  async getRules(ticker: string): Promise<QuantityRules> {
    await this.ensureLoaded();
    return this.rules.get(ticker) ?? FALLBACK_RULES;
  }

  // Eagerly populate. Caller during boot can await this so the first signal doesn't
  // pay the 1-2s metadata fetch latency on the critical path.
  async load(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this._load();
    try { await this.inFlight; } finally { this.inFlight = null; }
  }

  private async ensureLoaded(): Promise<void> {
    const now = Date.now();
    if (this.rules.size === 0 || now - this.lastLoad > REFRESH_INTERVAL_MS) {
      try { await this.load(); }
      catch (err) {
        // Fall back to the cached map even if stale. A T212 metadata blip should not
        // halt the dispatcher — every signal would then fail with sized-quantity=0.
        this.logger.warn({ err }, 'instrument-metadata refresh failed — using stale cache');
      }
    }
  }

  private async _load(): Promise<void> {
    const t0 = Date.now();
    const list = await this.client.getInstruments();
    const next = new Map<string, QuantityRules>();
    let defaultedPrecision = 0;
    let defaultedMin = 0;
    for (const inst of list) {
      const precision = typeof inst.precision === 'number' && Number.isFinite(inst.precision) && inst.precision >= 0
        ? inst.precision
        : (defaultedPrecision++, DEFAULT_PRECISION);
      const minQuantity = Number.isFinite(inst.minTradeQuantity) && inst.minTradeQuantity > 0
        ? inst.minTradeQuantity
        : (defaultedMin++, 10 ** -precision);
      next.set(inst.ticker, { minQuantity, precision });
    }
    this.rules = next;
    this.lastLoad = Date.now();
    this.logger.info({
      count: next.size, defaultedPrecision, defaultedMin, ms: Date.now() - t0,
    }, 'instrument-metadata loaded');
  }
}

// Counts decimal places in the minQuantity scalar. For 0.01 → 2, 0.001 → 3, 1 → 0.
// For irregular minima like 0.01510719 we get 8, which is what T212 expects.
//
// Uses the native toString() representation. T212 returns these as JSON numbers
// whose JS repr is the shortest round-tripping decimal (0.01 → "0.01"), so a simple
// scan is reliable here. toFixed(N) is unsafe because (0.01).toFixed(20) yields
// "0.01000000000000000021" — the 1e-19 ghost ULP — and trim-trailing-zeros would
// then over-count. Scientific notation ("1e-7") is handled explicitly below.
export function decimalsOf(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (x >= 1 && Number.isInteger(x)) return 0;
  const s = x.toString();
  if (s.includes('e') || s.includes('E')) {
    // Tiny minima like 1e-7. The exponent gives the precision directly.
    const m = /e-(\d+)/i.exec(s);
    if (m && m[1]) return parseInt(m[1], 10);
    return 0;
  }
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

// Apply the rules to a raw computed quantity. Returns 0 when the floored result is
// below minQuantity — the caller treats that as ZeroQuantity (terminal failure) and
// never makes the T212 round-trip.
export function applyQuantityRules(raw: number, rules: QuantityRules): number {
  if (raw <= 0) return 0;
  const factor = Math.pow(10, rules.precision);
  const floored = Math.floor(raw * factor) / factor;
  return floored >= rules.minQuantity ? floored : 0;
}

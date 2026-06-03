// EODHD API-call budget limiter — per-minute + per-UTC-day ceilings with a variable
// per-request cost. EODHD weights endpoints differently (a single /eod call is cheap; the
// screener and bulk-last-day cost more), so acquire() takes a `cost`. Mirrors the TwelveData
// CreditLimiter pattern but is exported + standalone so the screener, the bulk daily feed,
// and the daily-history backfill all share one budget and it is unit-testable.
//
// Once the day budget is spent, acquire() throws EodhdDailyLimitError so callers degrade to
// "return nothing" rather than hammering a budget that is already gone. The conservative
// defaults (1000/min, 90000/day) sit comfortably under the 100k/month plan with headroom.

import { setTimeout as sleep } from 'node:timers/promises';

export class EodhdDailyLimitError extends Error {
  constructor(public readonly used: number, public readonly limit: number) {
    super(`EODHD daily call budget exhausted (${used}/${limit})`);
    this.name = 'EodhdDailyLimitError';
  }
}

function startOfUtcDay(atMs = Date.now()): number {
  const d = new Date(atMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export class EodhdCreditLimiter {
  private window: Array<{ ts: number; cost: number }> = [];   // (timestamp, cost) within the last 60s
  private dayUsed = 0;
  private dayStart = startOfUtcDay();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly perMinute: number, private readonly perDay: number) {}

  get used(): number { this.rollover(); return this.dayUsed; }
  get dailyLimit(): number { return this.perDay; }
  get perMinuteLimit(): number { return this.perMinute; }

  private rollover(): void {
    const ds = startOfUtcDay();
    if (ds !== this.dayStart) { this.dayStart = ds; this.dayUsed = 0; this.window = []; }
  }

  private windowCost(now: number): number {
    this.window = this.window.filter((e) => now - e.ts < 60_000);
    return this.window.reduce((a, e) => a + e.cost, 0);
  }

  // Acquire budget for one request costing `cost` calls. Serialised on `tail` so the
  // window/day counters mutate atomically between awaits (concurrent callers queue). Throws
  // EodhdDailyLimitError when the day budget would be exceeded — fail fast rather than sleep
  // toward an exhausted budget.
  async acquire(cost = 1): Promise<void> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => { release = r; });
    await prev;
    try {
      this.rollover();
      if (this.dayUsed + cost > this.perDay) throw new EodhdDailyLimitError(this.dayUsed, this.perDay);
      for (;;) {
        const now = Date.now();
        const used = this.windowCost(now);
        // Let a single oversized request (cost > perMinute) through when the window is empty,
        // otherwise it could never proceed. Normal requests wait for the oldest slot to expire.
        if (used + cost <= this.perMinute || this.window.length === 0) break;
        const oldest = this.window[0]!;
        await sleep(60_000 - (now - oldest.ts) + 50);          // +50ms slop so the slot has truly expired
      }
      this.window.push({ ts: Date.now(), cost });
      this.dayUsed += cost;
    } finally {
      release();
    }
  }
}

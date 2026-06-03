// EodhdCreditLimiter — per-day budget accounting + fail-fast on exhaustion. The per-minute
// pacing (which sleeps) is exercised only via the oversized-request escape hatch so the suite
// stays fast.

import { describe, it, expect } from 'vitest';
import { EodhdCreditLimiter, EodhdDailyLimitError } from '../modules/bars/infrastructure/providers/eodhd-credit-limiter.ts';

describe('EodhdCreditLimiter', () => {
  it('accounts variable cost against the daily budget', async () => {
    const lim = new EodhdCreditLimiter(1000, 100);
    await lim.acquire(5);
    await lim.acquire(10);
    expect(lim.used).toBe(15);
    expect(lim.dailyLimit).toBe(100);
    expect(lim.perMinuteLimit).toBe(1000);
  });

  it('throws EodhdDailyLimitError when a request would exceed the day budget (no partial spend)', async () => {
    const lim = new EodhdCreditLimiter(1000, 10);
    await lim.acquire(8);
    await expect(lim.acquire(5)).rejects.toBeInstanceOf(EodhdDailyLimitError);
    expect(lim.used).toBe(8);   // the rejected acquire did not consume budget
  });

  it('lets a single oversized request through when the per-minute window is empty', async () => {
    const lim = new EodhdCreditLimiter(8, 1000);   // perMinute 8 < cost 100
    await expect(lim.acquire(100)).resolves.toBeUndefined();
    expect(lim.used).toBe(100);
  });
});

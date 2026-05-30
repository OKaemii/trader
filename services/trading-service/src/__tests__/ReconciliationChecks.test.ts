import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  cashCheck,
  fillsCheck,
  ordersCheck,
  positionsCheck,
} from '../modules/reconciliation/application/ReconciliationChecks.ts';

const T = DEFAULT_THRESHOLDS;

describe('positionsCheck', () => {
  it('clean when system == broker', () => {
    const f = positionsCheck([{ ticker: 'AAPL', quantity: 10 }], [{ ticker: 'AAPL', quantity: 10 }], T);
    expect(f).toHaveLength(1);
    expect(f[0]!.isClean).toBe(true);
  });

  it('auto-heals sub-threshold position drift', () => {
    const f = positionsCheck([{ ticker: 'AAPL', quantity: 100 }], [{ ticker: 'AAPL', quantity: 99.5 }], T);
    expect(f[0]!.driftType).toBe('position_drift');
    expect(f[0]!.autoHealable).toBe(true);
    expect(f[0]!.severity).toBe('minor');
  });

  it('flags major + non-healable above the alert threshold', () => {
    const f = positionsCheck([{ ticker: 'AAPL', quantity: 100 }], [{ ticker: 'AAPL', quantity: 80 }], T);
    expect(f[0]!.severity).toBe('major');
    expect(f[0]!.autoHealable).toBe(false);
  });

  it('flags oob_position (broker holds, system does not) — never auto-heal', () => {
    const f = positionsCheck([], [{ ticker: 'TSLA', quantity: 5 }], T);
    expect(f[0]!.driftType).toBe('oob_position');
    expect(f[0]!.autoHealable).toBe(false);
    expect(f[0]!.severity).toBe('major');
  });
});

describe('cashCheck', () => {
  it('day-1 baseline is clean', () => {
    const f = cashCheck({ free: 100, total: 100 }, null, T);
    expect(f[0]!.isClean).toBe(true);
  });
  it('never auto-heals and majors past the alert amount', () => {
    const f = cashCheck({ free: 0, total: 1000 }, 900, T);
    expect(f[0]!.driftType).toBe('cash_drift');
    expect(f[0]!.autoHealable).toBe(false);
    expect(f[0]!.severity).toBe('major');
  });
  it('minor under the alert amount', () => {
    const f = cashCheck({ free: 0, total: 905 }, 900, T);
    expect(f[0]!.severity).toBe('minor');
  });
});

describe('ordersCheck', () => {
  it('order_state_drift is auto-healable when T212 says terminal', () => {
    const f = ordersCheck(
      [{ orderId: 'o1', ticker: 'AAPL', side: 'BUY', status: 'submitted' }],
      [{ orderId: 'o1', ticker: 'AAPL', status: 'CANCELLED' }],
      new Set(['o1']),
    );
    expect(f.find((x) => x.driftType === 'order_state_drift')?.autoHealable).toBe(true);
  });
  it('oob_order for an order the system has no record of', () => {
    const f = ordersCheck([], [{ orderId: 'x9', ticker: 'NVDA', status: 'FILLED' }], new Set());
    expect(f[0]!.driftType).toBe('oob_order');
    expect(f[0]!.autoHealable).toBe(false);
  });
  it('a KNOWN already-filled order is NOT oob (regression: filled ≠ out-of-band)', () => {
    const f = ordersCheck([], [{ orderId: 'o2', ticker: 'MSFT', status: 'FILLED' }], new Set(['o2']));
    expect(f).toHaveLength(0);
  });
});

describe('fillsCheck', () => {
  it('flags a missing fill for a KNOWN order not in the ledger', () => {
    const f = fillsCheck([], [{ fillId: 'c', orderId: 'o1' }], new Set(['o1']));
    expect(f.some((x) => x.driftType === 'missing_fill')).toBe(true);
  });
  it('does NOT flag a fill for an unknown order (that is oob_order territory)', () => {
    const f = fillsCheck([], [{ fillId: 'c', orderId: 'x9' }], new Set());
    expect(f.some((x) => x.driftType === 'missing_fill')).toBe(false);
  });
  it('flags a duplicate fill in the ledger', () => {
    const f = fillsCheck(['a', 'a'], [], new Set());
    expect(f.some((x) => x.driftType === 'duplicate_fill')).toBe(true);
  });
  it('clean when the ledger covers all known-order broker fills', () => {
    expect(fillsCheck(['a'], [{ fillId: 'a', orderId: 'o1' }], new Set(['o1']))).toHaveLength(0);
  });
});

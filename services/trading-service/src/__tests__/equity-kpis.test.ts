import { describe, it, expect } from 'vitest';
import { computeEquityKpis, type NavPoint } from '../modules/reconciliation/application/equity-kpis.ts';

const pt = (t: number, nav: number, cash = 0, positionsValue = nav): NavPoint => ({ t, nav, cash, positionsValue });

describe('computeEquityKpis', () => {
  it('returns a zeroed result for an empty series', () => {
    const { series, kpis } = computeEquityKpis([]);
    expect(series).toEqual([]);
    expect(kpis.nSnapshots).toBe(0);
    expect(kpis.firstAt).toBeNull();
    expect(kpis.totalReturnPct).toBe(0);
  });

  it('computes total return from first to last NAV', () => {
    const { kpis } = computeEquityKpis([pt(1, 1000), pt(2, 1100), pt(3, 1200)]);
    expect(kpis.start).toBe(1000);
    expect(kpis.current).toBe(1200);
    expect(kpis.totalReturnPct).toBeCloseTo(0.2, 9);
    expect(kpis.high).toBe(1200);
    expect(kpis.low).toBe(1000);
    expect(kpis.nSnapshots).toBe(3);
  });

  it('computes worst peak-to-trough as maxDrawdownPct (≤ 0)', () => {
    // 1000 → 1200 (peak) → 900 (trough) → 1000. Worst DD = (900-1200)/1200 = -0.25.
    const { kpis } = computeEquityKpis([pt(1, 1000), pt(2, 1200), pt(3, 900), pt(4, 1000)]);
    expect(kpis.maxDrawdownPct).toBeCloseTo(-0.25, 9);
    expect(kpis.high).toBe(1200);
    expect(kpis.low).toBe(900);
  });

  it('currentDrawdownPct measures running-peak → latest', () => {
    // Peak 1200 at t2; latest 1000 → current DD = (1000-1200)/1200 = -0.1667.
    const { kpis } = computeEquityKpis([pt(1, 1000), pt(2, 1200), pt(3, 1000)]);
    expect(kpis.currentDrawdownPct).toBeCloseTo(-0.16666, 4);
  });

  it('reports zero current drawdown when the latest NAV is the peak', () => {
    const { kpis } = computeEquityKpis([pt(1, 1000), pt(2, 1100), pt(3, 1300)]);
    expect(kpis.currentDrawdownPct).toBeCloseTo(0, 9);
    expect(kpis.maxDrawdownPct).toBeCloseTo(0, 9);
  });

  it('carries the latest cash / positions split + timestamps', () => {
    const { kpis } = computeEquityKpis([pt(10, 1000, 400, 600), pt(20, 1100, 300, 800)]);
    expect(kpis.cash).toBe(300);
    expect(kpis.positionsValue).toBe(800);
    expect(kpis.firstAt).toBe(10);
    expect(kpis.lastAt).toBe(20);
  });
});

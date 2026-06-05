import { describe, it, expect } from 'vitest';
import { computeEquityKpis, repairLegacyNavPoint, type NavPoint } from '../modules/reconciliation/application/equity-kpis.ts';

const pt = (t: number, nav: number, cash = 0, positionsValue = nav): NavPoint => ({ t, nav, cash, positionsValue });

describe('repairLegacyNavPoint', () => {
  it('repairs a legacy double-counted row (nav == cash + positions, cash == total)', () => {
    // Legacy writer: cash=total=900, positions=900, nav=total+positions=1800 (the inflated print).
    const out = repairLegacyNavPoint({ t: 1, nav: 1800, cash: 900, positionsValue: 900 });
    expect(out.nav).toBe(900);              // correct nav = broker total (the stored cash)
    expect(out.cash).toBe(0);               // reconstructed free = total - positions
    expect(out.positionsValue).toBe(900);
  });

  it('leaves a heavily-invested post-fix row untouched (free < positions)', () => {
    // free=120, positions=880, total=1000. The identity nav==cash+positions holds, but free (120) is
    // BELOW the position value — impossible for a legacy row where cash held the broker total.
    const p = { t: 2, nav: 1000, cash: 120, positionsValue: 880 };
    expect(repairLegacyNavPoint(p)).toBe(p);  // cash (120) < positions (880) → structural guard rejects
  });

  it('leaves a typical post-fix row untouched (residual from invested≠ourPV)', () => {
    const p = { t: 3, nav: 1000, cash: 500, positionsValue: 110 };  // |1000-500-110| = 390 ≫ 0.01
    expect(repairLegacyNavPoint(p)).toBe(p);
  });

  it('does not touch zero-position rows (no double-count possible)', () => {
    const p = { t: 4, nav: 1000, cash: 1000, positionsValue: 0 };
    expect(repairLegacyNavPoint(p)).toBe(p);
  });

  it('a repaired series no longer reports the inflated period high', () => {
    const raw: NavPoint[] = [
      { t: 1, nav: 1000, cash: 1000, positionsValue: 0 },     // pre-investment, fine
      { t: 2, nav: 1900, cash: 950, positionsValue: 950 },    // legacy: true nav 950
      { t: 3, nav: 980, cash: 70, positionsValue: 910 },      // post-fix: nav 980 (total)
    ];
    const { kpis } = computeEquityKpis(raw.map(repairLegacyNavPoint));
    expect(kpis.high).toBe(1000);   // not 1900
  });
});

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

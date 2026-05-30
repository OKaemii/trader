import { describe, it, expect } from 'vitest';
import { computeSlippage } from '../modules/tca/application/slippage.ts';

describe('computeSlippage', () => {
  it('BUY above mid is a positive cost', () => {
    // arrival mid 100, fill mid 100.5 (adverse), fill 100.6.
    const s = computeSlippage({ side: 'BUY', fillPrice: 100.6, arrivalMid: 100, fillMid: 100.5 });
    expect(s.arrivalSlipBps).toBeCloseTo(50, 6);     // (100.5-100)/100 * 10000
    expect(s.fillSlipBps).toBeCloseTo((0.1 / 100.5) * 10000, 6);
    expect(s.totalCostBps).toBeCloseTo(60, 6);       // (100.6-100)/100 * 10000
  });

  it('SELL below mid is a positive cost (sign flips)', () => {
    // SELL: fill 99.4 vs arrival mid 100 → selling cheap is a cost (+60 bps).
    const s = computeSlippage({ side: 'SELL', fillPrice: 99.4, arrivalMid: 100, fillMid: 99.5 });
    expect(s.totalCostBps).toBeCloseTo(60, 6);       // -1 * (99.4-100)/100 * 10000
    expect(s.arrivalSlipBps).toBeCloseTo(50, 6);     // -1 * (99.5-100)/100 * 10000
  });

  it('null mids → null slippage (no fresh quote)', () => {
    const s = computeSlippage({ side: 'BUY', fillPrice: 100, arrivalMid: null, fillMid: null });
    expect(s.arrivalSlipBps).toBeNull();
    expect(s.fillSlipBps).toBeNull();
    expect(s.totalCostBps).toBeNull();
  });

  it('fill mid present but arrival missing → fill slip only', () => {
    const s = computeSlippage({ side: 'BUY', fillPrice: 100.2, arrivalMid: null, fillMid: 100 });
    expect(s.arrivalSlipBps).toBeNull();
    expect(s.fillSlipBps).toBeCloseTo(20, 6);
    expect(s.totalCostBps).toBeNull();
  });
});

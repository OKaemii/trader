// QMJ quality screen — the three rules + fail-closed denominators. Pure; mirrors quant-core
// quality.py.

import { describe, it, expect } from 'vitest';
import { computeRatios, qualityPass } from '../modules/fundamentals/application/qmj.ts';

const base = { netIncome: 1000, totalEquity: 5000, totalDebt: 3000, currentAssets: 3000, currentLiabilities: 1500, marketCapGbp: 1e10 };

describe('qmj', () => {
  it('computes ROE / D-E / current ratio', () => {
    expect(computeRatios(base)).toEqual({ roe: 0.2, debtToEquity: 0.6, currentRatio: 2 });
  });
  it('passes a quality name (ROE 0.20, D/E 0.6, CR 2.0)', () => {
    expect(qualityPass(base)).toBe(true);
  });
  it('fails on low ROE', () => {
    expect(qualityPass({ ...base, netIncome: 100 })).toBe(false);        // ROE 0.02 < 0.10
  });
  it('fails on high leverage', () => {
    expect(qualityPass({ ...base, totalDebt: 12000 })).toBe(false);      // D/E 2.4 > 2.0
  });
  it('fails on weak liquidity', () => {
    expect(qualityPass({ ...base, currentAssets: 1000 })).toBe(false);   // CR 0.67 < 1.0
  });
  it('fail-closed on zero / missing denominators', () => {
    expect(computeRatios({ ...base, totalEquity: 0 })).toBeNull();
    expect(qualityPass({ ...base, totalEquity: 0 })).toBe(false);
    expect(qualityPass({ ...base, currentLiabilities: 0 })).toBe(false);
  });
});

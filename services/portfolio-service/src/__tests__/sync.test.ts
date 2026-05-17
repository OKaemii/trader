// Regression coverage for the FX/Money cleanup:
//   - buildPositionUpdate never writes the legacy currentValueGBP field
//   - $unset always clears currentValueGBP on every write so legacy rows self-heal
//   - currentPrice + currentValue are Money-shaped in the instrument currency
//   - sumPositionsGBP throws on FX failure (the silent-native-as-GBP bug class is
//     impossible — there is no longer a code path that substitutes a native scalar
//     into a GBP-named column)

import { describe, it, expect } from "vitest";
import { buildPositionUpdate } from '../sync.ts';
import { sumPositionsGBP, type FxConverter, type PositionDoc } from '@trader/shared-portfolio';
import type { Money } from '@trader/shared-types';

const FIXED_NOW = new Date('2026-05-16T12:00:00Z');

describe('buildPositionUpdate', () => {
  it('does NOT write currentValueGBP into $set (legacy dual-write field is gone)', () => {
    const upd = buildPositionUpdate({
      ticker: 'AAPL_US_EQ',
      quantity: 10,
      currency: 'USD',
      priceNative: 200,
      valueNative: 2000,
      weight: 0.02,
      now: () => FIXED_NOW,
    });
    expect('currentValueGBP' in upd.$set).toBe(false);
  });

  it('always $unsets currentValueGBP so pre-FX rows self-heal on the next sync', () => {
    const upd = buildPositionUpdate({
      ticker: 'VOD_l_EQ',
      quantity: 100,
      currency: 'GBP',
      priceNative: 80,
      valueNative: 8000,
      weight: 0.08,
      now: () => FIXED_NOW,
    });
    expect(upd.$unset.currentValueGBP).toBe('');
  });

  it('writes currentPrice and currentValue as Money in the instrument currency', () => {
    const upd = buildPositionUpdate({
      ticker: 'AAPL_US_EQ',
      quantity: 10,
      currency: 'USD',
      priceNative: 200,
      valueNative: 2000,
      weight: 0.02,
      now: () => FIXED_NOW,
    });
    expect(upd.$set.currentPrice).toEqual({ amount: 200,  currency: 'USD' });
    expect(upd.$set.currentValue).toEqual({ amount: 2000, currency: 'USD' });
  });
});

describe('sumPositionsGBP behaviour the portfolio sync depends on', () => {
  function throwingFx(): FxConverter {
    return { async toGBP() { throw new Error('fx unavailable'); } };
  }
  function identityGbpFx(): FxConverter {
    return {
      async toGBP(m: Money) {
        if (m.currency === 'GBP') return m.amount;
        return m.amount * 0.8;
      },
    };
  }

  it('throws when FX fails — caller (portfolio-service sync) must skip the cycle, not substitute native', () => {
    const positions: PositionDoc[] = [
      { ticker: 'AAPL_US_EQ', currentValue: { amount: 1000, currency: 'USD' } },
    ];
    expect(sumPositionsGBP(positions, throwingFx())).rejects.toThrow('fx unavailable');
  });

  it('sums correctly when FX is healthy', async () => {
    const positions: PositionDoc[] = [
      { ticker: 'VOD_l_EQ',   currentValue: { amount: 100,  currency: 'GBP' } },
      { ticker: 'AAPL_US_EQ', currentValue: { amount: 1000, currency: 'USD' } },
    ];
    const total = await sumPositionsGBP(positions, identityGbpFx());
    expect(total).toBeCloseTo(900, 4);   // 100 GBP + 1000 USD * 0.8
  });
});

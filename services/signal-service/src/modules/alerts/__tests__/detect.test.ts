import { describe, it, expect } from 'vitest';
import { detectCross, onCooldown, deriveRulesFromPlan } from '../application/detect.ts';

const money = (amount: number, currency: 'GBP' | 'USD' = 'USD') => ({ amount, currency });
const H = 3_600_000;

describe('detectCross', () => {
    it("'above' fires when the bar high reaches/exceeds the level", () => {
        expect(detectCross({ direction: 'above', level: money(110) }, { high: 110, low: 100, close: 105 })).toBe(true);
        expect(detectCross({ direction: 'above', level: money(110) }, { high: 109, low: 100, close: 105 })).toBe(false);
    });
    it("'below' fires on an intraday low touch even if the close reverted above the level", () => {
        expect(detectCross({ direction: 'below', level: money(95) }, { high: 105, low: 95, close: 102 })).toBe(true);
        expect(detectCross({ direction: 'below', level: money(95) }, { high: 105, low: 96, close: 102 })).toBe(false);
    });
});

describe('onCooldown', () => {
    it('is false before the first fire', () => {
        expect(onCooldown({ cooldownH: 24 }, 1000)).toBe(false);
    });
    it('suppresses within the window and allows after', () => {
        const now = 100 * H;
        expect(onCooldown({ cooldownH: 24, lastFiredAt: now - 23 * H }, now)).toBe(true);
        expect(onCooldown({ cooldownH: 24, lastFiredAt: now - 25 * H }, now)).toBe(false);
    });
});

describe('deriveRulesFromPlan', () => {
    it('derives a below(stop) + above(target) rule with deterministic ids', () => {
        const { upsert, removeIds } = deriveRulesFromPlan({ ticker: 'AAPL_US_EQ', stop: money(90), target: money(130) });
        expect(upsert).toHaveLength(2);
        expect(removeIds).toHaveLength(0);
        expect(upsert.find((r) => r.kind === 'stop')).toMatchObject({ id: 'AAPL_US_EQ:stop', direction: 'below', level: money(90), source: 'tradeplan' });
        expect(upsert.find((r) => r.kind === 'target')).toMatchObject({ id: 'AAPL_US_EQ:target', direction: 'above', level: money(130) });
    });
    it('removes the derived rule for a cleared field', () => {
        const { upsert, removeIds } = deriveRulesFromPlan({ ticker: 'X', stop: money(50) });
        expect(upsert.map((r) => r.kind)).toEqual(['stop']);
        expect(removeIds).toContain('X:target');
    });
});

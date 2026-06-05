import { describe, it, expect } from 'vitest';
import {
    rMultiple, stopDistancePct, daysHeld, pickEntryBuy, enrichPosition, CurrencyMismatchError,
} from '../application/EnrichedPositions.ts';
import type { TradeSignal } from '../../signals/domain/TradeSignal.ts';
import type { Position, TradePlan } from '@trader/contracts';

// enrichPosition only reads entryPrice + executedAt off each BUY; a minimal cast keeps the
// test focused on the math rather than the full TradeSignal constructor.
const buy = (entryPrice: number | undefined, executedAt: number | undefined): TradeSignal =>
    ({ entryPrice, executedAt } as unknown as TradeSignal);

describe('rMultiple', () => {
    it('computes (current - entry) / (entry - stop)', () => {
        expect(rMultiple(100, 90, 110)).toBeCloseTo(1.0);    // +1R: gained one unit of risk
        expect(rMultiple(100, 90, 80)).toBeCloseTo(-2.0);    // -2R: blew through the stop
    });
    it('is null when entry === stop (risk undefined)', () => {
        expect(rMultiple(100, 100, 110)).toBeNull();
    });
});

describe('stopDistancePct', () => {
    it('is the fraction from current down to the stop', () => {
        expect(stopDistancePct(90, 100)).toBeCloseTo(0.1);
    });
    it('guards a non-positive current price', () => {
        expect(stopDistancePct(90, 0)).toBeNull();
    });
});

describe('daysHeld', () => {
    it('counts elapsed days, floored at 0', () => {
        const now = Date.UTC(2026, 0, 11);
        expect(daysHeld(Date.UTC(2026, 0, 1), now)).toBeCloseTo(10);
        expect(daysHeld(now + 1000, now)).toBe(0);          // future entry → 0, never negative
    });
});

describe('pickEntryBuy', () => {
    it('picks the oldest BUY carrying an entry price (FIFO entry leg)', () => {
        expect(pickEntryBuy([buy(105, 300), buy(100, 100), buy(102, 200)])?.entryPrice).toBe(100);
    });
    it('skips BUYs missing an entry price or executedAt', () => {
        expect(pickEntryBuy([buy(undefined, 50), buy(100, 100)])?.entryPrice).toBe(100);
    });
    it('returns null when there are no usable BUYs', () => {
        expect(pickEntryBuy([])).toBeNull();
    });
});

describe('enrichPosition', () => {
    const pos = (currency: 'GBP' | 'USD', current: number): Position =>
        ({ ticker: 'AAPL_US_EQ', quantity: 10, currentPrice: { amount: current, currency } });
    const plan = (currency: 'GBP' | 'USD', stop?: number, target?: number): TradePlan => ({
        ticker: 'AAPL_US_EQ', updatedBy: 'op', updatedAt: 0,
        ...(stop != null ? { stop: { amount: stop, currency } } : {}),
        ...(target != null ? { target: { amount: target, currency } } : {}),
    });

    it('joins entry + days-held and derives R and stop distance', () => {
        const now = Date.UTC(2026, 0, 11);
        const out = enrichPosition(pos('USD', 110), [buy(100, Date.UTC(2026, 0, 1))], plan('USD', 90, 130), now);
        expect(out.entryPrice).toBe(100);
        expect(out.daysHeld).toBeCloseTo(10);
        expect(out.rMultiple).toBeCloseTo(1.0);
        expect(out.stopDistancePct).toBeCloseTo((110 - 90) / 110);
        expect(out.currency).toBe('USD');
        expect(out.target).toEqual({ amount: 130, currency: 'USD' });
    });

    it('returns null R / days-held when there is no entry or no plan', () => {
        const out = enrichPosition(pos('USD', 110), [], null, 0);
        expect(out.entryPrice).toBeNull();
        expect(out.rMultiple).toBeNull();
        expect(out.daysHeld).toBeNull();
        expect(out.stop).toBeNull();
    });

    it('throws CurrencyMismatchError when the plan currency differs from the position', () => {
        expect(() => enrichPosition(pos('USD', 110), [buy(100, 1)], plan('GBP', 90), 0))
            .toThrow(CurrencyMismatchError);
    });
});

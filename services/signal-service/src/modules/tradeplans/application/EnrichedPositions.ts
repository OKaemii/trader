// Pure enrichment math: join a live position with its opening BUY signal (entry price +
// days held) and the operator's trade plan (stop/target), and derive the R-multiple and
// stop distance. Kept pure (no IO) so the swing-portal R-multiple math is unit-tested
// independently of Mongo / the trading client.

import type { Money } from '@trader/shared-types';
import type { Position, TradePlan, EnrichedPosition } from '@trader/contracts';
import type { TradeSignal } from '../../signals/domain/TradeSignal.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export class CurrencyMismatchError extends Error {
    constructor(public readonly a: string, public readonly b: string) {
        super(`trade-plan currency mismatch: ${a} vs ${b}`);
        this.name = 'CurrencyMismatchError';
    }
}

/** R-multiple = (current − entry) / (entry − stop). Null when entry === stop (risk undefined). */
export function rMultiple(entry: number, stop: number, current: number): number | null {
    const risk = entry - stop;
    if (risk === 0) return null;
    return (current - entry) / risk;
}

/** Distance from the current price down to the stop, as a fraction of current. Null if current ≤ 0. */
export function stopDistancePct(stop: number, current: number): number | null {
    if (current <= 0) return null;
    return (current - stop) / current;
}

export function daysHeld(entryAt: number, now: number): number {
    return Math.max(0, (now - entryAt) / DAY_MS);
}

/**
 * The FIFO entry leg: the oldest open executed BUY that carries an entry price. `openBuys`
 * already arrives oldest-first from the repository, but we don't rely on that — we pick the
 * minimum `executedAt` defensively.
 */
export function pickEntryBuy(openBuys: TradeSignal[]): TradeSignal | null {
    const withEntry = openBuys.filter((b) => b.entryPrice != null && b.executedAt != null);
    if (withEntry.length === 0) return null;
    return withEntry.reduce((oldest, b) => (b.executedAt! < oldest.executedAt! ? b : oldest));
}

function assertSameCurrency(a: Money, b: Money): void {
    if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

/**
 * Enrich one position. Throws CurrencyMismatchError if a trade-plan stop/target is in a
 * different currency than the position's current price (mirrors PlaceOrderUseCase's
 * pre-sizing currency assertion — never silently mix GBP and USD).
 */
export function enrichPosition(
    position: Position,
    openBuys: TradeSignal[],
    plan: TradePlan | null,
    now: number,
): EnrichedPosition {
    const currentPrice = position.currentPrice ?? null;
    const stop = plan?.stop ?? null;
    const target = plan?.target ?? null;

    if (currentPrice && stop) assertSameCurrency(currentPrice, stop);
    if (currentPrice && target) assertSameCurrency(currentPrice, target);

    const entryBuy = pickEntryBuy(openBuys);
    const entryPrice = entryBuy?.entryPrice ?? null;
    const entryAt = entryBuy?.executedAt ?? null;
    const current = currentPrice?.amount ?? null;

    const r = (entryPrice != null && stop != null && current != null)
        ? rMultiple(entryPrice, stop.amount, current)
        : null;
    const sdist = (stop != null && current != null)
        ? stopDistancePct(stop.amount, current)
        : null;

    return {
        ticker: position.ticker,
        quantity: position.quantity,
        currency: currentPrice?.currency ?? stop?.currency ?? target?.currency ?? null,
        currentPrice,
        entryPrice,
        entryAt,
        daysHeld: entryAt != null ? daysHeld(entryAt, now) : null,
        stop,
        target,
        rMultiple: r,
        stopDistancePct: sdist,
        note: plan?.note ?? null,
    };
}

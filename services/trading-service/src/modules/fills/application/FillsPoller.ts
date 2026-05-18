import type { Logger } from '@trader/core';
import type { SignalServiceClient, OpenBuy } from '@trader/contracts';
import { type Order, OrderSide, OrderStatus } from '../../orders/domain/Order.ts';
import type { IOrderRepository } from '../../orders/domain/IOrderRepository.ts';
import type { Trading212Client, T212HistoryItem } from '../../t212/infrastructure/Trading212Client.ts';
import { scaleT212Quote, type PriceLookupForScaler } from '../../../shared/T212PriceScaler.ts';

const MAX_HISTORY_PAGES = 5;    // 5 × 50 = 250 most-recent terminal orders — well beyond a 30s tick window
const HISTORY_PAGE_SIZE = 50;

// Reconciles Mongo `submitted` orders against T212 state every tick.
//
//   open ─── still in /equity/orders ──────► leave alone
//        └── missing from /equity/orders ──► look up in /equity/history/orders
//                                            ├─ status=FILLED  with `fill`       → mark filled (real price + time)
//                                            ├─ status=CANCELLED|REJECTED|EXPIRED → mark cancelled
//                                            └─ not in history yet                → leave; retry next tick
//
// On BUY fills, signal-service is notified via SignalServiceClient.markExecuted so the BUY
// signal records `executedQuantity` (used for FIFO round-trip closure). On SELL fills:
//   1. The SELL signal itself is closed via markClosed with exitPrice = fill.price.
//   2. Open BUY signals for the same ticker are walked oldest-first via openBuys. Their
//      `executedQuantity` is FIFO-consumed against the SELL fill quantity. Each fully-
//      consumed BUY is closed; if the SELL only partially consumes the next BUY, that
//      BUY's quantity is decremented via decrementQuantity and it stays open. Limitation:
//      partial-decrement keeps the BUY at its original entryPrice, so a BUY split across
//      two SELLs reports one exit (the one that closed it). Acceptable until per-leg fills
//      become a requirement.
export class FillsPoller {
    private timer?: ReturnType<typeof setInterval> | undefined;
    private tickCounter = 0;
    private idleTicks = 0;

    constructor(
        private readonly orderRepo:   IOrderRepository,
        private readonly t212:        Trading212Client,
        private readonly signal:      SignalServiceClient,
        private readonly intervalMs:  number,
        private readonly logger:      Logger,
        // Optional but required in production: cross-checks T212 fill prices against the
        // stored bar close to detect pence-quoted LSE listings. Without it, fills for
        // tickers like SUPRl_EQ / SGLNl_EQ are written 100x inflated to Mongo.
        private readonly priceLookup: PriceLookupForScaler | null = null,
    ) {}

    start(): void {
        if (this.timer) return;
        this.logger.info({ intervalMs: this.intervalMs }, 'fills-poller: starting');
        this.tick().catch((err) => this.logger.warn({ err }, 'initial tick failed'));
        this.timer = setInterval(() => {
            this.tick().catch((err) => this.logger.warn({ err }, 'tick failed'));
        }, this.intervalMs);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
            this.logger.info('fills-poller: stopped');
        }
    }

    private async tick(): Promise<void> {
        this.tickCounter++;
        const open = await this.orderRepo.findOpen();
        if (open.length === 0) {
            this.idleTicks++;
            // Log every ~minute equivalent so k9s shows we're alive even with no open orders.
            const logEvery = Math.max(1, Math.floor(60_000 / this.intervalMs));
            if (this.idleTicks % logEvery === 0) {
                this.logger.info({ tick: this.tickCounter, idleTicks: this.idleTicks },
                    'fills-poller: idle (no submitted orders)');
            }
            return;
        }
        this.idleTicks = 0;
        this.logger.info({ tick: this.tickCounter, open: open.length }, 'fills-poller: tick start');

        const active    = await this.t212.listActiveOrders();
        const activeIds = new Set(active.map((o) => o.id));

        const terminated = open.filter((o) => o.t212OrderId && !activeIds.has(o.t212OrderId));
        if (terminated.length === 0) {
            this.logger.info({ tick: this.tickCounter, activeAtBroker: active.length },
                'fills-poller: all open orders still active at broker — no terminations to resolve');
            return;
        }
        this.logger.info({ tick: this.tickCounter, terminated: terminated.length, activeAtBroker: active.length },
            'fills-poller: terminations detected — fetching history');

        const lookupIds = new Set(terminated.map((o) => String(o.t212OrderId)));
        const history   = await this.collectHistoryFor(lookupIds);
        this.logger.info({ tick: this.tickCounter, wanted: lookupIds.size, resolved: history.size },
            'fills-poller: history fetched');

        for (const order of terminated) {
            const item = history.get(String(order.t212OrderId));
            if (!item) {
                // Not in history yet; T212 typically populates within a tick or two. Skip and retry.
                this.logger.info({ tick: this.tickCounter, t212OrderId: order.t212OrderId, ticker: order.ticker },
                    'fills-poller: order not in history yet — retrying next tick');
                continue;
            }
            await this.applyHistoryItem(order, item);
        }
    }

    // Walks the history paginator until every wanted ID is found, MAX_HISTORY_PAGES pages
    // have been scanned, or T212 reports no more pages. Returns a map keyed by stringified
    // T212 order id (the API returns numeric ids; we store strings in Mongo).
    private async collectHistoryFor(wantedIds: Set<string>): Promise<Map<string, T212HistoryItem>> {
        const out: Map<string, T212HistoryItem> = new Map();
        let cursor: string | undefined;

        for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
            const { items, nextPagePath } = await this.t212.getHistoricalOrders({
                ...(cursor !== undefined ? { cursor } : {}),
                limit: HISTORY_PAGE_SIZE,
            });
            for (const item of items) {
                const id = String(item.order.id);
                if (wantedIds.has(id)) out.set(id, item);
            }
            if (out.size === wantedIds.size) break;       // found them all
            if (!nextPagePath) break;                     // no more pages
            cursor = nextPagePath;
        }
        return out;
    }

    private async applyHistoryItem(order: Order, item: T212HistoryItem): Promise<void> {
        const status = item.order.status;

        if (status === 'FILLED' && item.fill) {
            const filledAt = Date.parse(item.fill.filledAt);
            const rawFillPrice = item.fill.price;
            const fillPrice = this.priceLookup
                ? await scaleT212Quote(order.ticker, rawFillPrice, this.priceLookup, this.logger)
                : rawFillPrice;
            const filledQuantity = item.fill.quantity;
            await this.orderRepo.save({ ...order, status: OrderStatus.Filled, filledAt, fillPrice, filledQuantity });

            if (order.side === OrderSide.Buy) {
                // Record the real fill quantity on the BUY signal so future SELLs can FIFO it.
                await this.notifyExecuted(order.signalId, filledAt, filledQuantity);
            } else {
                // Close the SELL signal itself, then walk the entry BUYs FIFO and close them too.
                await this.notifyClosed(order.signalId, filledAt, fillPrice);
                await this.attributeSellToBuys(order.ticker, filledAt, fillPrice, filledQuantity);
            }
            this.logger.info({
                ticker: order.ticker, side: OrderSide[order.side], t212OrderId: order.t212OrderId,
                filledQuantity, fillPrice,
            }, 'order filled');
            return;
        }

        if (status === 'CANCELLED' || status === 'REJECTED' || status === 'EXPIRED') {
            await this.orderRepo.save({ ...order, status: OrderStatus.Cancelled, filledQuantity: item.order.filledQuantity });
            this.logger.info({
                ticker: order.ticker, side: OrderSide[order.side], t212OrderId: order.t212OrderId,
                status: status.toLowerCase(),
            }, 'order terminal');
            return;
        }

        // Unknown terminal status — record for visibility; leave submitted so a later tick can resolve it.
        this.logger.warn({ ticker: order.ticker, t212OrderId: order.t212OrderId, status }, 'unhandled history status');
    }

    // FIFO round-trip closure. Walks open BUYs for the ticker oldest-first; each fully-
    // consumed BUY is closed at exitPrice; the boundary BUY (if the SELL only partially
    // covers it) has its remaining executedQuantity decremented and stays open.
    private async attributeSellToBuys(ticker: string, at: number, exitPrice: number, sellQuantity: number): Promise<void> {
        const open = await this.fetchOpenBuys(ticker);
        let remaining = sellQuantity;
        for (const buy of open) {
            if (remaining <= 0) break;
            const buyQty = buy.executedQuantity ?? 0;
            if (buyQty <= 0) continue;
            if (remaining >= buyQty) {
                await this.notifyClosed(buy.id, at, exitPrice);
                remaining -= buyQty;
            } else {
                await this.notifyDecrement(buy.id, remaining);
                remaining = 0;
            }
        }
        if (remaining > 0) {
            // SELL fill exceeded recorded BUY shares — likely manual T212 trades, an out-of-band
            // backfill, or the BUY's executedQuantity was never recorded (pre-task-3 history).
            // Surface it but don't error: the SELL signal itself is already closed.
            this.logger.warn({ ticker, sellQuantity, overAttribution: remaining },
                'SELL fill over-attributed — no matching open BUY shares left');
        }
    }

    private async fetchOpenBuys(ticker: string): Promise<OpenBuy[]> {
        try {
            const res = await this.signal.openBuys(ticker);
            return res.signals;
        } catch (err) {
            this.logger.warn({ err, ticker }, 'open-buys fetch failed');
            return [];
        }
    }

    private async notifyExecuted(signalId: string, at: number, quantity: number): Promise<void> {
        try {
            await this.signal.markExecuted(signalId, at, quantity);
        } catch (err) {
            this.logger.warn({ err, signalId }, 'executed notify failed');
        }
    }

    private async notifyDecrement(signalId: string, by: number): Promise<void> {
        try {
            await this.signal.decrementQuantity(signalId, by);
        } catch (err) {
            this.logger.warn({ err, signalId }, 'decrement notify failed');
        }
    }

    private async notifyClosed(signalId: string, at: number, exitPrice: number): Promise<void> {
        try {
            await this.signal.markClosed(signalId, exitPrice, at);
        } catch (err) {
            this.logger.warn({ err, signalId }, 'close notify failed');
        }
    }
}

import { generateInternalToken, mintInternalJwt } from '@trader/shared-auth';
import { type Order, OrderSide, OrderStatus } from '../../domain/entities/Order.ts';
import type { IOrderRepository } from '../../domain/interfaces/IOrderRepository.ts';
import type { Trading212Client, T212HistoryItem } from '../../infrastructure/t212.ts';

const SIGNAL_SERVICE   = process.env.SIGNAL_SERVICE_URL ?? 'http://signal-service:3003';
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
// On BUY fills, signal-service is notified via /internal/trading/signals/:id/executed
// with the real fill quantity so the BUY signal records `executedQuantity` (used for
// FIFO round-trip closure). On SELL fills:
//   1. The SELL signal itself is closed with exitPrice = fill.price (POST .../closed).
//   2. Open BUY signals for the same ticker are walked oldest-first via signal-service's
//      /internal/trading/signals/open-buys/:ticker. Their `executedQuantity` is FIFO-
//      consumed against the SELL fill quantity. Each fully-consumed BUY is closed; if
//      the SELL only partially consumes the next BUY, that BUY's quantity is decremented
//      and it stays open. Limitation: the partial-decrement keeps the BUY at its original
//      entryPrice, so a BUY split across two SELLs reports one exit (the one that closed
//      it). Acceptable until per-leg fills become a requirement.
export class FillsPoller {
  private timer?: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly orderRepo:  IOrderRepository,
    private readonly t212:       Trading212Client,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.tick().catch((e) => console.warn('[FillsPoller] initial tick failed:', e));
    this.timer = setInterval(() => {
      this.tick().catch((e) => console.warn('[FillsPoller] tick failed:', e));
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    const open = await this.orderRepo.findOpen();
    if (open.length === 0) return;

    const active    = await this.t212.listActiveOrders();
    const activeIds = new Set(active.map((o) => o.id));

    const terminated = open.filter((o) => o.t212OrderId && !activeIds.has(o.t212OrderId));
    if (terminated.length === 0) return;

    const lookupIds = new Set(terminated.map((o) => String(o.t212OrderId)));
    const history   = await this.collectHistoryFor(lookupIds);

    for (const order of terminated) {
      const item = history.get(String(order.t212OrderId));
      if (!item) {
        // Not in history yet; T212 typically populates within a tick or two. Skip and retry.
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
      const fillPrice = item.fill.price;
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
      console.log(`[FillsPoller] ${order.ticker} ${OrderSide[order.side]} t212=${order.t212OrderId} → filled ${filledQuantity} @ ${fillPrice}`);
      return;
    }

    if (status === 'CANCELLED' || status === 'REJECTED' || status === 'EXPIRED') {
      await this.orderRepo.save({ ...order, status: OrderStatus.Cancelled, filledQuantity: item.order.filledQuantity });
      console.log(`[FillsPoller] ${order.ticker} ${OrderSide[order.side]} t212=${order.t212OrderId} → ${status.toLowerCase()}`);
      return;
    }

    // Unknown terminal status — record for visibility; leave submitted so a later tick can resolve it.
    console.warn(`[FillsPoller] ${order.ticker} t212=${order.t212OrderId} unhandled history status: ${status}`);
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
      console.warn(`[FillsPoller] SELL fill on ${ticker} (qty=${sellQuantity}) over-attributed by ${remaining} — no matching open BUY shares left`);
    }
  }

  private async fetchOpenBuys(ticker: string): Promise<Array<{ id: string; executedQuantity?: number; executedAt?: number }>> {
    try {
      const res = await fetch(`${SIGNAL_SERVICE}/internal/trading/signals/open-buys/${encodeURIComponent(ticker)}`, {
        headers: { 'X-Internal-Token': generateInternalToken('trading-service'),
          'Authorization':     `Bearer ${await mintInternalJwt('trading-service')}` },
      });
      if (!res.ok) {
        console.warn(`[FillsPoller] open-buys ${ticker} → ${res.status}`);
        return [];
      }
      const body = await res.json() as { signals?: Array<{ id: string; executedQuantity?: number; executedAt?: number }> };
      return body.signals ?? [];
    } catch (e) {
      console.warn(`[FillsPoller] open-buys ${ticker} error:`, e);
      return [];
    }
  }

  private async notifyExecuted(signalId: string, at: number, quantity: number): Promise<void> {
    try {
      const res = await fetch(`${SIGNAL_SERVICE}/internal/trading/signals/${signalId}/executed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': generateInternalToken('trading-service'),
          'Authorization':     `Bearer ${await mintInternalJwt('trading-service')}`,
        },
        body: JSON.stringify({ at, quantity }),
      });
      if (!res.ok) {
        console.warn(`[FillsPoller] executed notify ${signalId} → ${res.status}`);
      }
    } catch (e) {
      console.warn(`[FillsPoller] executed notify ${signalId} error:`, e);
    }
  }

  private async notifyDecrement(signalId: string, by: number): Promise<void> {
    try {
      const res = await fetch(`${SIGNAL_SERVICE}/internal/trading/signals/${signalId}/decrement-quantity`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': generateInternalToken('trading-service'),
          'Authorization':     `Bearer ${await mintInternalJwt('trading-service')}`,
        },
        body: JSON.stringify({ by }),
      });
      if (!res.ok) {
        console.warn(`[FillsPoller] decrement notify ${signalId} → ${res.status}`);
      }
    } catch (e) {
      console.warn(`[FillsPoller] decrement notify ${signalId} error:`, e);
    }
  }

  private async notifyClosed(signalId: string, at: number, exitPrice: number): Promise<void> {
    try {
      const res = await fetch(`${SIGNAL_SERVICE}/internal/trading/signals/${signalId}/closed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': generateInternalToken('trading-service'),
          'Authorization':     `Bearer ${await mintInternalJwt('trading-service')}`,
        },
        body: JSON.stringify({ at, exitPrice }),
      });
      if (!res.ok) {
        console.warn(`[FillsPoller] close notify ${signalId} → ${res.status}`);
      }
    } catch (e) {
      console.warn(`[FillsPoller] close notify ${signalId} error:`, e);
    }
  }
}

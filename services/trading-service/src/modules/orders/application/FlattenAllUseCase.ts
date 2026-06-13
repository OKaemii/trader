import type { Logger } from '@trader/core';
import type { Trading212Client } from '../../t212/infrastructure/Trading212Client.ts';

// One-click flatten — cancel every resting order, then market-sell every open position. The hard
// "get me out now" half of the panic button. Best-effort per item (errors collected, never aborts
// the batch); idempotent (a no-op when already flat). T212 only — the route guards it to
// demo/live. T212 signs quantity (negative = SELL), so the exit is placeMarketOrder(ticker, -qty).
export interface FlattenResult { cancelledOrders: number; soldPositions: number; errors: string[] }

export class FlattenAllUseCase {
  constructor(private readonly client: Trading212Client, private readonly logger: Logger) {}

  async execute(): Promise<FlattenResult> {
    const errors: string[] = [];
    let cancelledOrders = 0;
    let soldPositions = 0;

    // 1. Cancel resting orders first so freed reservations don't block the sells.
    let orders: Array<{ id: string }> = [];
    try { orders = await this.client.listActiveOrders(); }
    catch (err) { errors.push(`list orders: ${err instanceof Error ? err.message : String(err)}`); }
    for (const o of orders) {
      try { await this.client.cancelOrder(o.id); cancelledOrders++; }
      catch (err) { errors.push(`cancel ${o.id}: ${err instanceof Error ? err.message : String(err)}`); }
    }

    // 2. Market-sell every open position (signed negative quantity = SELL). The position already
    // carries its bare (symbol, market) — pass that straight to the client, which re-derives the
    // broker string at the send. No ticker re-parse here.
    let positions: Awaited<ReturnType<Trading212Client['getPositions']>> = [];
    try { positions = await this.client.getPositions(); }
    catch (err) { errors.push(`positions: ${err instanceof Error ? err.message : String(err)}`); }
    for (const p of positions) {
      if (p.quantity > 0) {
        try { await this.client.placeMarketOrder({ symbol: p.symbol, market: p.market }, -p.quantity); soldPositions++; }
        catch (err) { errors.push(`sell ${p.ticker}: ${err instanceof Error ? err.message : String(err)}`); }
      }
    }

    this.logger.warn({ cancelledOrders, soldPositions, errorCount: errors.length },
      'FLATTEN ALL executed — cancelled resting orders + market-sold all positions');
    return { cancelledOrders, soldPositions, errors };
  }
}

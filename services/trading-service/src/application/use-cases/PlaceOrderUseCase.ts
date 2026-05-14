import { randomUUID } from 'node:crypto';
import { generateInternalToken } from '@trader/shared-auth';
import type { Order } from '../../domain/entities/Order.ts';
import type { IOrderRepository } from '../../domain/interfaces/IOrderRepository.ts';
import type { IOrderExecutor } from '../../domain/interfaces/IOrderExecutor.ts';
import { OrderRouter } from '../services/OrderRouter.ts';

type TradingMode = 'paper' | 'demo' | 'live';
const TRADING_MODE     = (process.env.TRADING_MODE ?? 'paper') as TradingMode;
const EXECUTION_MODE   = (process.env.EXECUTION_MODE ?? 't212') as 't212' | 'unrestricted';
const SIGNAL_SERVICE   = process.env.SIGNAL_SERVICE_URL ?? 'http://signal-service:3003';

async function notifySignalExecuted(signalId: string, at: number): Promise<void> {
  try {
    const res = await fetch(`${SIGNAL_SERVICE}/internal/trading/signals/${signalId}/executed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': generateInternalToken('trading-service'),
      },
      body: JSON.stringify({ at }),
    });
    if (!res.ok) {
      console.warn(`[PlaceOrder] signal lifecycle update failed for ${signalId}: ${res.status}`);
    }
  } catch (err) {
    // Lifecycle update is best-effort — order state in trading-service is authoritative.
    console.warn(`[PlaceOrder] signal lifecycle update error for ${signalId}:`, err);
  }
}

export interface PlaceOrderInput {
  signalId:     string;
  ticker:       string;
  action:       'BUY' | 'SELL';
  targetWeight: number;         // [0,1] — from TradeSignal; must be >= 0 (long-only)
  confidence:   number;
  totalNAV?:    number;         // if provided, used to compute quantity
  currentPrice?: number;
  currentQuantity?: number;
}

export class PlaceOrderUseCase {
  private readonly router = new OrderRouter();

  constructor(
    private readonly orderRepo:    IOrderRepository,
    private readonly executor:     IOrderExecutor,
    private readonly liveApproved: () => Promise<boolean>,
  ) {}

  async execute(input: PlaceOrderInput): Promise<Order | null> {
    // Mode semantics:
    //   paper → no broker call; notifications only.
    //   demo  → real orders to demo.trading212 with demo API keys; no live-gate required.
    //   live  → real orders to trading212 with live API keys; live-gate must be approved.
    if (TRADING_MODE === 'paper') {
      console.log(`[PlaceOrder] TRADING_MODE=paper — skipping order for ${input.ticker}`);
      return null;
    }

    if (TRADING_MODE === 'live') {
      const approved = await this.liveApproved();
      if (!approved) {
        console.warn(`[PlaceOrder] live trading gate not approved — rejecting order for ${input.ticker}. Call POST /api/admin/trading/approve-live first.`);
        return null;
      }
    }

    // Long-only enforcement: targetWeight must be [0,1]; no short positions
    if (input.targetWeight < 0) {
      console.error(`[PlaceOrder] rejected negative targetWeight=${input.targetWeight} for ${input.ticker} — long-only only`);
      return null;
    }

    const side: 'buy' | 'sell' = input.action === 'BUY' ? 'buy' : 'sell';

    // Determine order type: limit for signal-driven orders, market for risk exits
    const orderType = this.router.selectOrderType('signal', EXECUTION_MODE);

    // Quantity calculation: requires totalNAV + currentPrice
    const quantity = this._computeQuantity(input);
    if (quantity <= 0) {
      console.log(`[PlaceOrder] computed quantity=0 for ${input.ticker} — skipping`);
      return null;
    }

    const order: Order = {
      id:           randomUUID(),
      ticker:       input.ticker,
      side,
      orderType,
      quantity,
      limitPrice:   orderType === 'limit' ? input.currentPrice : undefined,
      status:       'pending',
      signalId:     input.signalId,
      targetWeight: input.targetWeight,
      timestamp:    Date.now(),
    };

    await this.orderRepo.save(order);

    try {
      const result = await this.executor.execute({
        ticker:     order.ticker,
        side:       order.side,
        orderType:  order.orderType,
        quantity:   order.quantity,
        limitPrice: order.limitPrice,
      });

      order.status       = result.status;
      order.t212OrderId  = result.t212OrderId;
      order.executedAt   = Date.now();
      if (result.message) order.errorMessage = result.message;
    } catch (err) {
      order.status       = 'failed';
      order.errorMessage = String(err);
      console.error(`[PlaceOrder] T212 execution error for ${order.ticker}:`, err);
    }

    await this.orderRepo.save(order);

    // T212 returns 'submitted' on placement; fills are async and not yet polled, so we
    // mark the signal as executed at submit time. Re-evaluate once a fills poller exists.
    if ((order.status === 'submitted' || order.status === 'filled') && order.executedAt) {
      await notifySignalExecuted(order.signalId, order.executedAt);
    }

    return order;
  }

  private _computeQuantity(input: PlaceOrderInput): number {
    const { totalNAV, currentPrice, currentQuantity = 0, targetWeight, action } = input;
    if (!totalNAV || !currentPrice || currentPrice <= 0) {
      // Cannot size without price data — caller must supply these or quantity defaults to 0
      return 0;
    }
    const targetValue  = targetWeight * totalNAV;
    const currentValue = currentQuantity * currentPrice;
    const delta        = (targetValue - currentValue) / currentPrice;

    if (action === 'BUY'  && delta > 0) return Math.floor(delta);
    if (action === 'SELL' && delta < 0) return Math.floor(Math.abs(delta));
    return 0;
  }
}

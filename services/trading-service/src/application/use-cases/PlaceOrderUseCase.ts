import { randomUUID } from 'node:crypto';
import { mintInternalJwt } from '@trader/shared-auth';
import type { Money } from '@trader/shared-types';
import {
  type Order,
  OrderSide,
  OrderStatus,
  OrderType,
  TradingMode,
  parseTradingMode,
} from '../../domain/entities/Order.ts';
import type { IOrderRepository } from '../../domain/interfaces/IOrderRepository.ts';
import type { IOrderExecutor } from '../../domain/interfaces/IOrderExecutor.ts';
import { OrderRouter, OrderReason } from '../services/OrderRouter.ts';

// TRADING_MODE is read per-call (not module-load) so the same process can host
// multiple test modes and parent processes can flip the env before constructing
// a use case. In production this is set once and never changes; the function-call
// cost is a single object lookup + string compare.
const tradingMode = (): TradingMode => parseTradingMode(process.env.TRADING_MODE);
const SIGNAL_SERVICE   = process.env.SIGNAL_SERVICE_URL ?? 'http://signal-service:3003';

// SIGNAL_ORDER_TYPE is consumed via an injected getter (see live-config.ts) so a portal
// save flips order routing (Limit ⇄ Market) without a service restart. Tests and any
// caller that doesn't care can omit the getter and get the env-frozen default.
const envSignalOrderType: OrderType =
  process.env.SIGNAL_ORDER_TYPE === 'Market' || process.env.SIGNAL_ORDER_TYPE === String(OrderType.Market)
    ? OrderType.Market
    : OrderType.Limit;

async function notifySignalExecuted(signalId: string, at: number): Promise<void> {
  try {
    const res = await fetch(`${SIGNAL_SERVICE}/internal/trading/signals/${signalId}/executed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
          'Authorization':     `Bearer ${await mintInternalJwt('trading-service')}`,
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
  // totalNAV and currentPrice MUST be in the same currency — typically the instrument's
  // listing currency. _computeQuantity asserts equality and rejects mismatches with
  // zero-qty + a logged error. Callers holding NAV in a different currency (the
  // dispatcher, with GBP account NAV) MUST FX-convert before constructing this input;
  // the type system now carries the currency tag through every call site, so the
  // 100x position-sizing bug class (GBP NAV against USD price) cannot compile.
  totalNAV?:        Money;
  currentPrice?:    Money;
  currentQuantity?: number;
}

export class PlaceOrderUseCase {
  private readonly router = new OrderRouter();
  private readonly getSignalOrderType: () => Promise<OrderType>;

  constructor(
    private readonly orderRepo:    IOrderRepository,
    private readonly executor:     IOrderExecutor,
    private readonly liveApproved: () => Promise<boolean>,
    getSignalOrderType?: () => Promise<OrderType>,
  ) {
    // Default to the env-frozen value so existing callers (tests, ad-hoc tooling) don't
    // need to thread the live getter through. Production wiring in index.ts always
    // injects the Mongo-backed getter from infrastructure/live-config.ts.
    this.getSignalOrderType = getSignalOrderType ?? (async () => envSignalOrderType);
  }

  async execute(input: PlaceOrderInput): Promise<Order | null> {
    // Mode semantics:
    //   Paper → no broker call; notifications only.
    //   Demo  → real orders to demo.trading212 with demo API keys; no live-gate required.
    //   Live  → real orders to trading212 with live API keys; live-gate must be approved.
    const mode = tradingMode();
    if (mode === TradingMode.Paper) {
      console.log(`[PlaceOrder] TRADING_MODE=Paper — skipping order for ${input.ticker}`);
      return null;
    }

    if (mode === TradingMode.Live) {
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

    const side: OrderSide = input.action === 'BUY' ? OrderSide.Buy : OrderSide.Sell;

    // Determine order type: signal-driven uses the operator-selected default; risk exits
    // always go out as market. Read live so a portal flip takes effect on the very next
    // order without restarting trading-service.
    const signalOrderType = await this.getSignalOrderType();
    const orderType = this.router.selectOrderType(OrderReason.Signal, signalOrderType);

    // Quantity calculation: requires totalNAV + currentPrice
    const quantity = this._computeQuantity(input);
    if (quantity <= 0) {
      console.log(`[PlaceOrder] computed quantity=0 for ${input.ticker} — skipping`);
      return null;
    }

    const limitPrice = orderType === OrderType.Limit ? input.currentPrice?.amount : undefined;
    const order: Order = {
      id:           randomUUID(),
      ticker:       input.ticker,
      side,
      orderType,
      quantity,
      ...(limitPrice !== undefined ? { limitPrice } : {}),
      status:       OrderStatus.Pending,
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
        ...(order.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}),
      });

      order.status       = result.status;
      order.t212OrderId  = result.t212OrderId;
      order.executedAt   = Date.now();
      if (result.message) order.errorMessage = result.message;
    } catch (err) {
      order.status       = OrderStatus.Failed;
      order.errorMessage = String(err);
      console.error(`[PlaceOrder] T212 execution error for ${order.ticker}:`, err);
    }

    await this.orderRepo.save(order);

    // T212 returns Submitted on placement; fills are async and not yet polled, so we
    // mark the signal as executed at submit time. Re-evaluate once a fills poller exists.
    if ((order.status === OrderStatus.Submitted || (order.status as OrderStatus) === OrderStatus.Filled) && order.executedAt) {
      await notifySignalExecuted(order.signalId, order.executedAt);
    }

    return order;
  }

  private _computeQuantity(input: PlaceOrderInput): number {
    const { totalNAV, currentPrice, currentQuantity = 0, targetWeight, action } = input;
    if (!totalNAV || !currentPrice || currentPrice.amount <= 0) {
      // Cannot size without price data — caller must supply these or quantity defaults to 0
      return 0;
    }
    if (totalNAV.currency !== currentPrice.currency) {
      // Currency mismatch is the 100x bug class — refuse to size and log loudly so the
      // operator can grep the offending caller. Returning 0 (rather than throwing) keeps
      // the dispatcher's terminal-failure path: zero qty → markFailed(CashInsufficient).
      console.error(
        `[PlaceOrder] currency mismatch for ${input.ticker}: ` +
        `totalNAV=${totalNAV.currency} currentPrice=${currentPrice.currency}. ` +
        `Caller must FX-convert before sizing.`,
      );
      return 0;
    }
    const targetValue  = targetWeight * totalNAV.amount;
    const currentValue = currentQuantity * currentPrice.amount;
    const delta        = (targetValue - currentValue) / currentPrice.amount;

    if (action === 'BUY'  && delta > 0) return Math.floor(delta);
    if (action === 'SELL' && delta < 0) return Math.floor(Math.abs(delta));
    return 0;
  }
}

import { randomUUID } from 'node:crypto';
import { generateInternalToken } from '@trader/shared-auth';
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

const TRADING_MODE     = parseTradingMode(process.env.TRADING_MODE);
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
  // FX contract (2026-05-15): `totalNAV` and `currentPrice` MUST be expressed in the
  // instrument's listing currency. Caller is responsible for FX-converting account-level
  // NAV (which sits in BASE_CURRENCY = GBP) into the instrument's currency before
  // passing — the dispatcher does this via FxClient. Mixing currencies here is the
  // class of bug that caused 100x position-sizing errors on LSE pence-quoted stocks
  // before pence normalisation landed.
  totalNAV?:    number;         // instrument currency
  currentPrice?: number;        // instrument currency (already pence-normalised at the market-data boundary)
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
    if (TRADING_MODE === TradingMode.Paper) {
      console.log(`[PlaceOrder] TRADING_MODE=Paper — skipping order for ${input.ticker}`);
      return null;
    }

    if (TRADING_MODE === TradingMode.Live) {
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

    const order: Order = {
      id:           randomUUID(),
      ticker:       input.ticker,
      side,
      orderType,
      quantity,
      limitPrice:   orderType === OrderType.Limit ? input.currentPrice : undefined,
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
        limitPrice: order.limitPrice,
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
    if ((order.status === OrderStatus.Submitted || order.status === OrderStatus.Filled) && order.executedAt) {
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

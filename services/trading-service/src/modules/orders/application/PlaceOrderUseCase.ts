import { randomUUID } from 'node:crypto';
import type { Logger } from '@trader/core';
import type { SignalServiceClient } from '@trader/contracts';
import type { Money } from '@trader/shared-types';
import {
    type Order,
    OrderSide,
    OrderStatus,
    OrderType,
    TradingMode,
} from '../domain/Order.ts';
import type { IOrderRepository } from '../domain/IOrderRepository.ts';
import type { IOrderExecutor } from '../domain/IOrderExecutor.ts';
import { OrderRouter, OrderReason } from './OrderRouter.ts';

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

export interface PlaceOrderDeps {
    orderRepo:          IOrderRepository;
    executor:           IOrderExecutor;
    liveApproved:       () => Promise<boolean>;
    signal:             SignalServiceClient;
    logger:             Logger;
    tradingMode:        TradingMode;
    getSignalOrderType: () => Promise<OrderType>;
}

export class PlaceOrderUseCase {
    private readonly router = new OrderRouter();
    private readonly orderRepo:          IOrderRepository;
    private readonly executor:           IOrderExecutor;
    private readonly liveApproved:       () => Promise<boolean>;
    private readonly signal:             SignalServiceClient;
    private readonly logger:             Logger;
    private readonly tradingMode:        TradingMode;
    private readonly getSignalOrderType: () => Promise<OrderType>;

    constructor(deps: PlaceOrderDeps) {
        this.orderRepo          = deps.orderRepo;
        this.executor           = deps.executor;
        this.liveApproved       = deps.liveApproved;
        this.signal             = deps.signal;
        this.logger             = deps.logger;
        this.tradingMode        = deps.tradingMode;
        this.getSignalOrderType = deps.getSignalOrderType;
    }

    async execute(input: PlaceOrderInput): Promise<Order | null> {
        // Mode semantics:
        //   Paper → no broker call; notifications only.
        //   Demo  → real orders to demo.trading212 with demo API keys; no live-gate required.
        //   Live  → real orders to trading212 with live API keys; live-gate must be approved.
        if (this.tradingMode === TradingMode.Paper) {
            this.logger.info({ ticker: input.ticker }, 'TRADING_MODE=Paper — skipping order');
            return null;
        }

        if (this.tradingMode === TradingMode.Live) {
            const approved = await this.liveApproved();
            if (!approved) {
                this.logger.warn({ ticker: input.ticker },
                    'live trading gate not approved — rejecting order. POST /api/admin/trading/approve-live first.');
                return null;
            }
        }

        if (input.targetWeight < 0) {
            this.logger.error({ targetWeight: input.targetWeight, ticker: input.ticker },
                'rejected negative targetWeight — long-only only');
            return null;
        }

        const side: OrderSide = input.action === 'BUY' ? OrderSide.Buy : OrderSide.Sell;

        // Determine order type: signal-driven uses the operator-selected default; risk exits
        // always go out as market. Read live so a portal flip takes effect on the very next
        // order without restarting trading-service.
        const signalOrderType = await this.getSignalOrderType();
        const orderType = this.router.selectOrderType(OrderReason.Signal, signalOrderType);

        const quantity = this._computeQuantity(input);
        if (quantity <= 0) {
            this.logger.info({ ticker: input.ticker }, 'computed quantity=0 — skipping');
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
            this.logger.error({ err, ticker: order.ticker }, 'T212 execution error');
        }

        await this.orderRepo.save(order);

        // T212 returns Submitted on placement; fills are async and polled separately. We
        // optimistically mark the signal as executed at submit time; FillsPoller corrects
        // it later with the actual fill quantity + price.
        if ((order.status === OrderStatus.Submitted || (order.status as OrderStatus) === OrderStatus.Filled) && order.executedAt) {
            await this.notifySignalExecuted(order.signalId, order.executedAt);
        }

        return order;
    }

    private async notifySignalExecuted(signalId: string, at: number): Promise<void> {
        try {
            await this.signal.markExecuted(signalId, at);
        } catch (err) {
            // Lifecycle update is best-effort — order state in trading-service is authoritative.
            this.logger.warn({ err, signalId }, 'signal lifecycle update failed');
        }
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
            this.logger.error({
                ticker: input.ticker,
                totalNAV: totalNAV.currency,
                currentPrice: currentPrice.currency,
            }, 'currency mismatch — caller must FX-convert before sizing');
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

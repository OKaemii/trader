import { Hono } from 'hono';
import { bindContract, type Logger } from '@trader/core';
import { parseInternalHeaders } from '@trader/shared-auth/middleware';
import {
    Signals,
    type ClaimResponse,
    type ClosedResponse,
    type DecrementQuantityResponse,
    type ExecutedResponse,
    type OpenBuysResponse,
    type QueueRequeueResponse,
    type QueueSweepResponse,
} from '@trader/contracts';
import { SignalLifecycle, SignalFailureReason } from '@trader/shared-types';
import type { ISignalRepository } from '../domain/ISignalRepository.ts';
import type { ISignalPublisher } from '../domain/ISignalPublisher.ts';

interface Deps {
    signalRepo: ISignalRepository;
    // Publisher gated on the executed transition so notification-service only emails
    // signals that actually went through to T212 (policy b — see CLAUDE.md).
    publisher: ISignalPublisher;
    logger: Logger;
}

/**
 * /internal/api/signals/* — peer-to-peer endpoints called by trading-service over the
 * order-execution loop. The signal-service public router owns the admin endpoints; this
 * file is exclusively the s2s surface.
 */
export function createInternalRouter(deps: Deps): Hono {
    const router = new Hono();
    const fromTrading = parseInternalHeaders('trading-service');

    bindContract(router, Signals.markExecutedContract, fromTrading, async ({ params, body }): Promise<ExecutedResponse> => {
        const at = body.at ?? Date.now();
        await deps.signalRepo.markExecuted(params.id, at, body.quantity);
        const signal = await deps.signalRepo.findById(params.id);
        if (signal) {
            try { await deps.publisher.publish(signal); }
            catch (err) { deps.logger.warn({ err, signalId: params.id }, 'publish on executed failed'); }
        }
        const response: ExecutedResponse = { id: params.id, executedAt: at };
        if (body.quantity !== undefined) response.executedQuantity = body.quantity;
        return response;
    });

    bindContract(router, Signals.markClosedContract, fromTrading, async ({ params, body }): Promise<ClosedResponse> => {
        const at = body.at ?? Date.now();
        await deps.signalRepo.markClosed(params.id, at, body.exitPrice);
        return { id: params.id, closedAt: at, exitPrice: body.exitPrice };
    });

    bindContract(router, Signals.openBuysContract, fromTrading, async ({ params }): Promise<OpenBuysResponse> => {
        const signals = await deps.signalRepo.findOpenBuysByTicker(params.ticker);
        return {
            signals: signals.map((s) => {
                const out: { id: string; executedQuantity?: number; executedAt?: number } = { id: s.id };
                if (s.executedQuantity !== undefined) out.executedQuantity = s.executedQuantity;
                if (s.executedAt !== undefined)       out.executedAt       = s.executedAt;
                return out;
            }),
        };
    });

    bindContract(router, Signals.decrementQuantityContract, fromTrading, async ({ params, body }): Promise<DecrementQuantityResponse> => {
        await deps.signalRepo.decrementExecutedQuantity(params.id, body.by);
        return { id: params.id, decrementedBy: body.by };
    });

    // Order-dispatcher queue endpoints — the signal collection IS the durable queue.
    // claim returns the next queued signal atomically (no double-execution under multi-pod
    // dispatcher). requeue/failed close the loop after the dispatcher tries to place the order.
    bindContract(router, Signals.claimQueueContract, fromTrading, async (): Promise<ClaimResponse> => {
        const signal = await deps.signalRepo.claimNextQueued();
        if (!signal) return { signal: null };
        const out: ClaimResponse["signal"] = {
            id:           signal.id,
            ticker:       signal.ticker,
            action:       signal.action,
            targetWeight: signal.targetWeight,
            confidence:   signal.confidence,
            timestamp:    signal.timestamp,
            attempts:     signal.attempts,
        };
        if (signal.entryPrice !== undefined) out.entryPrice = signal.entryPrice;
        return { signal: out };
    });

    bindContract(router, Signals.requeueContract, fromTrading, async ({ params }): Promise<QueueRequeueResponse> => {
        await deps.signalRepo.requeue(params.id);
        return { id: params.id, lifecycle: SignalLifecycle.Queued };
    });

    bindContract(router, Signals.failQueueContract, fromTrading, async ({ params, body }): Promise<void> => {
        if (SignalFailureReason[body.reason] === undefined) {
            throw new Error(`invalid reason (expected SignalFailureReason enum integer, got ${body.reason})`);
        }
        await deps.signalRepo.markFailed(params.id, body.reason, body.detail);
    });

    bindContract(router, Signals.sweepQueueContract, fromTrading, async ({ body }): Promise<QueueSweepResponse> => {
        const ms = body?.thresholdMs ?? 60_000;
        const reverted = await deps.signalRepo.sweepStaleExecuting(ms);
        return { reverted };
    });

    return router;
}

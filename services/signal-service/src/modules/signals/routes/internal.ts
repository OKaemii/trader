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
    type TelemetrySnapshotResponse,
} from '@trader/contracts';
import { SignalLifecycle, SignalFailureReason } from '@trader/shared-types';
import type { ISignalRepository } from '../domain/ISignalRepository.ts';
import type { ISignalPublisher } from '../domain/ISignalPublisher.ts';
import type { GetTelemetrySnapshotUseCase } from '../application/GetTelemetrySnapshot.ts';

interface Deps {
    signalRepo: ISignalRepository;
    // Publisher gated on the executed transition so notification-service only emails
    // signals that actually went through to T212 (policy b — see CLAUDE.md).
    publisher: ISignalPublisher;
    logger: Logger;
    // Optional in tests that only exercise the queue endpoints. Production wiring always
    // injects this — notification-service polls it once per report-cadence flush.
    telemetrySnapshot?: GetTelemetrySnapshotUseCase;
}

/**
 * /internal/api/signals/* — peer-to-peer endpoints called by trading-service over the
 * order-execution loop. The signal-service public router owns the admin endpoints; this
 * file is exclusively the s2s surface.
 */
export function createInternalRouter(deps: Deps): Hono {
    const router = new Hono();
    const fromTrading      = parseInternalHeaders('trading-service');
    const fromNotification = parseInternalHeaders('notification-service');

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

    // Reporting telemetry feed for notification-service's TelemetryBuilder. GET-with-query
    // keeps the contract idempotent (no state change on the producer side).
    bindContract(router, Signals.telemetrySnapshotContract, fromNotification, async ({ query }): Promise<TelemetrySnapshotResponse> => {
        if (!deps.telemetrySnapshot) {
            throw new Error('telemetrySnapshot use-case not wired — required for notification-service callers');
        }
        const opts: { tickers?: readonly string[]; strategyId?: string } = {};
        if (query.tickers) {
            const parsed = query.tickers.split(',').map((t) => t.trim()).filter(Boolean);
            if (parsed.length > 0) opts.tickers = parsed;
        }
        if (query.strategyId) opts.strategyId = query.strategyId;
        return deps.telemetrySnapshot.execute(query.since, opts);
    });

    return router;
}

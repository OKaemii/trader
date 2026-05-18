import { Hono } from 'hono';
import { bindContract, type Logger } from '@trader/core';
import { requireInternal, requireCaller } from '@trader/shared-auth/middleware';
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
import type { ApproveSignalUseCase } from '../../approval/application/ApproveSignal.ts';
import type { RiskEngine } from '../../risk/application/RiskEngine.ts';
import type { ISignalRepository } from '../domain/ISignalRepository.ts';
import type { ISignalPublisher } from '../domain/ISignalPublisher.ts';

interface Deps {
    findRecent: { execute: (limit: number) => Promise<unknown[]> };
    approveSignal: ApproveSignalUseCase;
    riskEngine: RiskEngine;
    signalRepo: ISignalRepository;
    // Publisher gated on the executed transition so notification-service only emails
    // signals that actually went through to T212 (policy b — see CLAUDE.md).
    publisher: ISignalPublisher;
    logger: Logger;
}

/**
 * Routes that close the signal/trading-service feedback loop. Each route binds to a
 * shared contract in @trader/contracts — both the consumer (trading-service's
 * SignalServiceClient) and this producer pull the same schemas. The handler return
 * types are checked against the contract's responseSchema at compile time.
 */
export function createInternalRouter(deps: Deps): Hono {
    const router = new Hono();
    const fromTrading = [requireInternal, requireCaller('trading-service')] as const;

    // ── trading-service ⇒ signal-service lifecycle callbacks ────────────────────
    bindContract(router, Signals.markExecutedContract, ...fromTrading, async ({ params, body }): Promise<ExecutedResponse> => {
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

    bindContract(router, Signals.markClosedContract, ...fromTrading, async ({ params, body }): Promise<ClosedResponse> => {
        const at = body.at ?? Date.now();
        await deps.signalRepo.markClosed(params.id, at, body.exitPrice);
        return { id: params.id, closedAt: at, exitPrice: body.exitPrice };
    });

    bindContract(router, Signals.openBuysContract, ...fromTrading, async ({ params }): Promise<OpenBuysResponse> => {
        const signals = await deps.signalRepo.findOpenBuysByTicker(params.ticker);
        // The repository returns full TradeSignal entities; the wire contract only needs
        // the fields the FIFO walker consumes.
        return {
            signals: signals.map((s) => {
                const out: { id: string; executedQuantity?: number; executedAt?: number } = { id: s.id };
                if (s.executedQuantity !== undefined) out.executedQuantity = s.executedQuantity;
                if (s.executedAt !== undefined)       out.executedAt       = s.executedAt;
                return out;
            }),
        };
    });

    bindContract(router, Signals.decrementQuantityContract, ...fromTrading, async ({ params, body }): Promise<DecrementQuantityResponse> => {
        await deps.signalRepo.decrementExecutedQuantity(params.id, body.by);
        return { id: params.id, decrementedBy: body.by };
    });

    // ── Order-dispatcher queue endpoints ────────────────────────────────────────
    // The signal collection IS the durable queue. claim returns the next queued signal
    // atomically (no double-execution under multi-pod dispatcher). requeue/failed close
    // the loop after the dispatcher tries to place the order.

    bindContract(router, Signals.claimQueueContract, ...fromTrading, async (): Promise<ClaimResponse> => {
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

    bindContract(router, Signals.requeueContract, ...fromTrading, async ({ params }): Promise<QueueRequeueResponse> => {
        await deps.signalRepo.requeue(params.id);
        return { id: params.id, lifecycle: SignalLifecycle.Queued };
    });

    bindContract(router, Signals.failQueueContract, ...fromTrading, async ({ params, body }): Promise<void> => {
        if (SignalFailureReason[body.reason] === undefined) {
            throw new Error(`invalid reason (expected SignalFailureReason enum integer, got ${body.reason})`);
        }
        await deps.signalRepo.markFailed(params.id, body.reason, body.detail);
    });

    bindContract(router, Signals.sweepQueueContract, ...fromTrading, async ({ body }): Promise<QueueSweepResponse> => {
        const ms = body?.thresholdMs ?? 60_000;
        const reverted = await deps.signalRepo.sweepStaleExecuting(ms);
        return { reverted };
    });

    // ── api-gateway-scoped (admin reads + risk control) ─────────────────────────
    // Per-route middleware (NOT a wildcard `use('/internal/*', mw)`) — Hono applies
    // wildcard middleware to routes registered before it on the same router, which
    // previously double-gated the trading-service callbacks above. See PROGRESS.md.
    const fromGateway = [requireInternal, requireCaller('api-gateway')] as const;

    router.get('/internal/signals/latest', ...fromGateway, async (c) => {
        const signals = await deps.findRecent.execute(50);
        return c.json({ signals });
    });

    router.post('/internal/signals/approve/:id', ...fromGateway, async (c) => {
        const id = c.req.param('id')!;
        await deps.approveSignal.execute(id);
        return c.json({ approved: id });
    });

    router.get('/internal/risk/status', ...fromGateway, async (c) => {
        const status = await deps.riskEngine.status();
        return c.json(status);
    });

    router.post('/internal/risk/circuit-breaker/reset', ...fromGateway, async (c) => {
        await deps.riskEngine.resetCircuitBreaker();
        return c.json({ reset: true, ts: Date.now() });
    });

    return router;
}

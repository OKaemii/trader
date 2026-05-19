import type { InternalTokenMinter } from "../client.ts";
import { createInternalCaller } from "../client.ts";
import {
    markExecutedContract,
    markClosedContract,
    decrementQuantityContract,
    openBuysContract,
    claimQueueContract,
    requeueContract,
    failQueueContract,
    sweepQueueContract,
    telemetrySnapshotContract,
} from "./contracts.ts";
import type {
    ExecutedResponse,
    ClosedResponse,
    DecrementQuantityResponse,
    OpenBuysResponse,
    ClaimResponse,
    QueueRequeueResponse,
    QueueSweepResponse,
    TelemetrySnapshotResponse,
} from "./schemas.ts";

/**
 * Typed peer-service client for signal-service's /internal/* endpoints.
 * Owned by callers (trading-service: dispatcher + FillsPoller + PlaceOrderUseCase);
 * injected via wiring.ts.
 */
export interface SignalServiceClientOptions {
    baseUrl: string;
    callerService: string;
    mintToken: InternalTokenMinter;
    fetcher?: typeof fetch;
}

export class SignalServiceClient {
    private readonly call: ReturnType<typeof createInternalCaller>;

    constructor(opts: SignalServiceClientOptions) {
        this.call = createInternalCaller(opts);
    }

    markExecuted(id: string, at?: number, quantity?: number): Promise<ExecutedResponse> {
        const body: { at?: number; quantity?: number } = {};
        if (at !== undefined) body.at = at;
        if (quantity !== undefined) body.quantity = quantity;
        return this.call(markExecutedContract, { params: { id }, body });
    }

    markClosed(id: string, exitPrice: number, at?: number): Promise<ClosedResponse> {
        const body: { at?: number; exitPrice: number } = { exitPrice };
        if (at !== undefined) body.at = at;
        return this.call(markClosedContract, { params: { id }, body });
    }

    decrementQuantity(id: string, by: number): Promise<DecrementQuantityResponse> {
        return this.call(decrementQuantityContract, { params: { id }, body: { by } });
    }

    openBuys(ticker: string): Promise<OpenBuysResponse> {
        return this.call(openBuysContract, { params: { ticker } });
    }

    claimQueue(): Promise<ClaimResponse> {
        return this.call(claimQueueContract);
    }

    requeue(id: string): Promise<QueueRequeueResponse> {
        return this.call(requeueContract, { params: { id } });
    }

    failQueue(id: string, reason: number, detail?: string): Promise<void> {
        const body: { reason: number; detail?: string } = { reason };
        if (detail !== undefined) body.detail = detail;
        return this.call(failQueueContract, { params: { id }, body }) as Promise<void>;
    }

    sweepQueue(thresholdMs?: number): Promise<QueueSweepResponse> {
        const body: { thresholdMs?: number } = {};
        if (thresholdMs !== undefined) body.thresholdMs = thresholdMs;
        return this.call(sweepQueueContract, { body });
    }

    telemetrySnapshot(
        since: number,
        opts: { tickers?: readonly string[]; strategyId?: string } = {},
    ): Promise<TelemetrySnapshotResponse> {
        const query: { since: number; tickers?: string; strategyId?: string } = { since };
        if (opts.tickers && opts.tickers.length > 0) query.tickers = opts.tickers.join(',');
        if (opts.strategyId) query.strategyId = opts.strategyId;
        return this.call(telemetrySnapshotContract, { query });
    }
}

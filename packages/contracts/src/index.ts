export * from "./money.ts";
export * from "./contract.ts";
export * from "./client.ts";

export * as Trading       from "./trading/index.ts";
export * as Signals       from "./signals/index.ts";
export * as MarketData    from "./market-data/index.ts";
export * as Auth          from "./auth/index.ts";
export * as Notification  from "./notification/index.ts";
export * as Gateway       from "./gateway/index.ts";

// Convenience: hoist the typed peer-service clients + the most-referenced response types
// to the top level so consumers don't have to dance through namespace aliasing for them.
export { TradingServiceClient, type TradingServiceClientOptions } from "./trading/client.ts";
export { SignalServiceClient,  type SignalServiceClientOptions  } from "./signals/client.ts";

export type {
    ExecutedResponse, ClosedResponse, DecrementQuantityResponse,
    OpenBuysResponse, OpenBuy, ClaimResponse, QueueRequeueResponse, QueueSweepResponse,
    ClaimedSignal, ExecutedNotification, ClosedNotification, DecrementQuantityRequest,
    QueueFailedRequest, QueueSweepRequest, AutoApproveBody,
} from "./signals/schemas.ts";

export type {
    CashResponse, PositionsResponse, Position, ExecuteOrderRequest,
} from "./trading/schemas.ts";

export type {
    BarInterval, RangeKey, OHLCVBar,
    UniverseOverridesRequest, BackfillRequest, ClearCacheRequest, MarketConfigRequest,
    InternalBarsRequest, InternalBarsResponse,
} from "./market-data/schemas.ts";

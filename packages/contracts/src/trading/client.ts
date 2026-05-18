import type { InternalTokenMinter } from "../client.ts";
import { createInternalCaller } from "../client.ts";
import {
    getCashContract,
    getPositionsContract,
} from "./contracts.ts";
import type { CashResponse, PositionsResponse } from "./schemas.ts";

/**
 * Typed peer-service client for trading-service's internal endpoints.
 * Owned by callers (signal-service, portfolio-service); injected via wiring.ts.
 *
 *   const trading = new TradingServiceClient({
 *       baseUrl: env.TRADING_SERVICE_URL,
 *       callerService: "signal-service",
 *       mintToken: mintInternalJwt,
 *   });
 *   const cash = await trading.getCash();   // typed CashResponse
 */
export interface TradingServiceClientOptions {
    baseUrl: string;
    callerService: string;
    mintToken: InternalTokenMinter;
    fetcher?: typeof fetch;
}

export class TradingServiceClient {
    private readonly call: ReturnType<typeof createInternalCaller>;

    constructor(opts: TradingServiceClientOptions) {
        this.call = createInternalCaller(opts);
    }

    getCash(): Promise<CashResponse> {
        return this.call(getCashContract);
    }

    getPositions(): Promise<PositionsResponse> {
        return this.call(getPositionsContract);
    }
}

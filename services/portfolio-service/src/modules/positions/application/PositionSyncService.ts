import type { Db } from "mongodb";
import type { Logger } from "@trader/core";
import type { TradingServiceClient } from "@trader/contracts";
import type { FxClient } from "@trader/shared-fx";
import { COLLECTIONS } from "@trader/shared-mongo";
import { BASE_CURRENCY, type Currency } from "@trader/shared-types";
import { sumPositionsGBP, type PositionDoc } from "@trader/shared-portfolio";
import { buildPositionUpdate } from "./sync.ts";

export interface PositionSyncDeps {
    db: Db;
    fx: FxClient;
    trading: TradingServiceClient;
    logger: Logger;
}

// Periodic sync from trading-service positions + cash into Mongo. Positions are stored
// canonically in the listing currency; GBP NAV is derived on read by sumPositionsGBP.
export class PositionSyncService {
    private tradingUnreachableLogged = false;

    constructor(private readonly deps: PositionSyncDeps) {}

    async run(): Promise<void> {
        try {
            const [posRes, cashRes] = await Promise.all([
                this.deps.trading.getPositions(),
                this.deps.trading.getCash().catch(() => null),
            ]);
            this.tradingUnreachableLogged = false;

            const cashGBP = (cashRes?.total.currency ?? cashRes?.free.currency) === "GBP"
                ? (cashRes?.total.amount ?? cashRes?.free.amount ?? undefined)
                : undefined;

            // Extract native-currency price + value. Positions are stored in their listing
            // currency; GBP is derived on read.
            const sized = posRes.positions.map((p) => {
                const q = typeof p.quantity === "number" ? p.quantity : 0;
                const ccy: Currency = (p.currentPrice?.currency ?? BASE_CURRENCY) as Currency;
                const priceNative = p.currentPrice?.amount ?? 0;
                return { p, q, ccy, priceNative, valueNative: q * priceNative };
            });

            // GBP NAV for weight denominator. If FX is unavailable past the 24h stale
            // window sumPositionsGBP throws and we skip the entire sync — better than
            // persisting weights derived from a fabricated value.
            const positionsForSum: PositionDoc[] = sized.map((s) => ({
                ticker:       s.p.ticker,
                quantity:     s.q,
                currency:     s.ccy,
                currentValue: { amount: s.valueNative, currency: s.ccy },
            }));
            let positionsGBP = 0;
            try {
                positionsGBP = await sumPositionsGBP(positionsForSum, this.deps.fx);
            } catch (err) {
                this.deps.logger.warn({ err }, "FX unavailable — skipping sync to avoid stale weights");
                return;
            }
            const navBasisGBP = cashGBP && cashGBP > 0 ? cashGBP : positionsGBP;

            for (const { p, q, ccy, priceNative, valueNative } of sized) {
                const valueGBP = navBasisGBP > 0 && valueNative > 0
                    ? await this.deps.fx.toGBP({ amount: valueNative, currency: ccy })
                    : 0;
                const weight = navBasisGBP > 0 ? valueGBP / navBasisGBP : 0;
                const update = buildPositionUpdate({
                    ticker:      p.ticker,
                    quantity:    q,
                    currency:    ccy,
                    priceNative,
                    valueNative,
                    weight,
                });
                await this.deps.db.collection(COLLECTIONS.POSITIONS).updateOne(
                    { ticker: p.ticker },
                    update,
                    { upsert: true },
                );
            }

            // Drop positions that T212 no longer reports (sold to zero) so currentWeights
            // doesn't keep returning stale exposure that blocks new BUYs on the same ticker.
            const heldTickers = posRes.positions
                .map((p) => p.ticker)
                .filter((t): t is string => typeof t === "string");
            await this.deps.db.collection(COLLECTIONS.POSITIONS).deleteMany({ ticker: { $nin: heldTickers } });
        } catch (err) {
            const cause = (err as { cause?: { code?: string } })?.cause;
            const code = cause?.code ?? (err as { code?: string })?.code;
            const unreachableCodes = new Set([
                "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN",
                "ConnectionRefused", "UnknownHostname", "ConnectionTimeout", "Timeout",
            ]);
            if (code && unreachableCodes.has(code)) {
                if (!this.tradingUnreachableLogged) {
                    this.deps.logger.warn({ code }, "trading-service unreachable, skipping position sync");
                    this.tradingUnreachableLogged = true;
                }
                return;
            }
            this.deps.logger.error({ err }, "sync error");
        }
    }

    /** Schedules `run()` every `intervalMs`, invokes once immediately. Returns a stop fn. */
    start(intervalMs: number): () => void {
        const timer = setInterval(() => { void this.run(); }, intervalMs);
        void this.run();
        return () => clearInterval(timer);
    }
}

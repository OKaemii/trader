import type { Db } from "mongodb";
import type { Logger } from "@trader/core";
import type { TradingServiceClient } from "@trader/contracts";
import type { FxClient } from "@trader/shared-fx";
import { COLLECTIONS } from "@trader/shared-mongo";
import { BASE_CURRENCY, type Currency } from "@trader/shared-types";
import { sumPositionsGBP, type PositionDoc } from "@trader/shared-portfolio";
import { buildPositionUpdate } from "./sync.ts";
import { tryIdentityOf } from "../../../shared/identity.ts";

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
    private cycleCounter = 0;

    constructor(private readonly deps: PositionSyncDeps) {}

    async run(): Promise<void> {
        this.cycleCounter++;
        const cycle = this.cycleCounter;
        const cycleStart = Date.now();
        this.deps.logger.info({ cycle }, "position-sync: cycle start");
        try {
            const [posRes, cashRes] = await Promise.all([
                this.deps.trading.getPositions(),
                this.deps.trading.getCash().catch(() => null),
            ]);
            this.tradingUnreachableLogged = false;
            this.deps.logger.info({
                cycle,
                positions: posRes.positions.length,
                cashFree: cashRes?.free?.amount,
                cashTotal: cashRes?.total?.amount,
                cashCcy:  cashRes?.total?.currency ?? cashRes?.free?.currency,
            }, "position-sync: fetched from trading-service");

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
                this.deps.logger.warn({ cycle, err }, "FX unavailable — skipping sync to avoid stale weights");
                return;
            }
            const navBasisGBP = cashGBP && cashGBP > 0 ? cashGBP : positionsGBP;
            this.deps.logger.info({
                cycle, positionsGBP, navBasisGBP,
                navBasisSource: cashGBP && cashGBP > 0 ? "cashGBP" : "positionsGBP",
            }, "position-sync: NAV computed");

            // Held identities — the (symbol, market) pairs T212 currently reports. Positions are
            // stored keyed on this bare identity since Task 16a; the T212 ticker is split at this
            // sync boundary (trading-service still hands us the concatenated form until Task 17).
            // Fail-soft: an instrument whose ticker doesn't parse as a US/LSE equity is skipped for
            // both the upsert and the held-set, never aborting the whole sync.
            const held: Array<{ symbol: string; market: string }> = [];
            let upserted = 0;
            for (const { p, q, ccy, priceNative, valueNative } of sized) {
                const id = p.ticker ? tryIdentityOf(p.ticker) : null;
                if (!id) {
                    this.deps.logger.warn({ cycle, ticker: p.ticker }, "position-sync: un-routable ticker — skipping");
                    continue;
                }
                held.push({ symbol: id.symbol, market: id.market });
                const valueGBP = navBasisGBP > 0 && valueNative > 0
                    ? await this.deps.fx.toGBP({ amount: valueNative, currency: ccy })
                    : 0;
                const weight = navBasisGBP > 0 ? valueGBP / navBasisGBP : 0;
                const update = buildPositionUpdate({
                    symbol:      id.symbol,
                    market:      id.market,
                    quantity:    q,
                    currency:    ccy,
                    priceNative,
                    valueNative,
                    weight,
                    avgPriceNative: p.averagePrice?.amount,
                });
                await this.deps.db.collection(COLLECTIONS.POSITIONS).updateOne(
                    { symbol: id.symbol, market: id.market },
                    update,
                    { upsert: true },
                );
                upserted++;
            }

            // Drop positions that T212 no longer reports (sold to zero) so currentWeights doesn't
            // keep returning stale exposure that blocks new BUYs on the same name. Keep only the
            // held (symbol, market) identities: $nor of the per-identity equality matches deletes
            // everything not in the held set (an empty held set deletes all, as the old $nin:[] did).
            const keepMatches = held.map((h) => ({ symbol: h.symbol, market: h.market }));
            const deleteFilter = keepMatches.length > 0 ? { $nor: keepMatches } : {};
            const deleteRes = await this.deps.db.collection(COLLECTIONS.POSITIONS).deleteMany(deleteFilter);
            this.deps.logger.info({
                cycle,
                upserted,
                deleted:  deleteRes.deletedCount,
                durationMs: Date.now() - cycleStart,
                heldSample: held.slice(0, 10).map((h) => `${h.symbol}:${h.market}`),
            }, "position-sync: cycle done");
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
        this.deps.logger.info({ intervalMs }, "position-sync: starting (will run immediately, then every intervalMs)");
        const timer = setInterval(() => { void this.run(); }, intervalMs);
        void this.run();
        return () => {
            clearInterval(timer);
            this.deps.logger.info("position-sync: stopped");
        };
    }
}

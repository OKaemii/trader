import type { Db } from "mongodb";
import type { Logger } from "@trader/core";
import type { TradingServiceClient } from "@trader/contracts";
import type { FxClient } from "@trader/shared-fx";
import { COLLECTIONS } from "@trader/shared-mongo";
import { type Currency } from "@trader/shared-types";
import { sumPositionsGBP, type PositionDoc } from "@trader/shared-portfolio";
import { buildPositionUpdate } from "./sync.ts";
import { tryIdentityOf, currencyOf } from "../../../shared/identity.ts";

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

            // Resolve each T212 position to its bare (symbol, market) identity and derive currency
            // from that identity via the adapter (US → USD, LSE → GBP) — the single Money-contract
            // rule, matching how the price was tagged at the broker boundary. Positions are stored
            // in their listing currency; GBP is derived on read. Fail-soft: a position whose ticker
            // isn't a recognised US/LSE equity is dropped here (skipped for both sizing + the held
            // set) rather than aborting the whole sync.
            const sized = posRes.positions.flatMap((p) => {
                const id = p.ticker ? tryIdentityOf(p.ticker) : null;
                if (!id) {
                    this.deps.logger.warn({ cycle, ticker: p.ticker }, "position-sync: un-routable ticker — skipping");
                    return [];
                }
                const q = typeof p.quantity === "number" ? p.quantity : 0;
                const ccy: Currency = currencyOf(id);
                const priceNative = p.currentPrice?.amount ?? 0;
                return [{ p, id, q, ccy, priceNative, valueNative: q * priceNative }];
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
            // stored keyed on this bare identity; the broker ticker was split to (symbol, market)
            // up front (un-routable names already dropped from `sized`).
            const held: Array<{ symbol: string; market: string }> = [];
            let upserted = 0;
            for (const { p, id, q, ccy, priceNative, valueNative } of sized) {
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

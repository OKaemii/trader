import type { Db } from "mongodb";
import type { Logger } from "@trader/core";
import type { FxClient } from "@trader/shared-fx";
import { COLLECTIONS } from "@trader/shared-mongo";
import { sumPositionsGBP, type PositionDoc } from "@trader/shared-portfolio";
import { tickerOf } from "../../../shared/identity.ts";

export interface PortfolioReadDeps {
    db: Db;
    fx: FxClient;
    logger: Logger;
}

export interface PnlSummary {
    totalValueGBP: number;
    totalCostGBP:  number;
    unrealisedPnLGBP: number;
    positions:     number;
}

export class PortfolioReadService {
    constructor(private readonly deps: PortfolioReadDeps) {}

    async listPositions(): Promise<unknown[]> {
        const docs = await this.deps.db.collection(COLLECTIONS.POSITIONS).find({}).toArray();
        // Positions are keyed on (symbol, market) since Task 16a; re-derive a `ticker` onto each doc
        // so the /api/portfolio/positions response keeps its pre-Thread-A shape for consumers.
        return docs.map((d) => {
            if (typeof d.symbol === "string" && typeof d.market === "string") {
                try { return { ...d, ticker: tickerOf(d.symbol, d.market) }; } catch { /* leave as-is */ }
            }
            return d;
        });
    }

    /** Returns null if FX is unavailable past the 24h stale window. Caller maps to 502. */
    async pnl(): Promise<PnlSummary | null> {
        const positions = await this.deps.db.collection(COLLECTIONS.POSITIONS).find({}).toArray() as unknown as PositionDoc[];
        let totalValueGBP: number;
        try {
            totalValueGBP = await sumPositionsGBP(positions, this.deps.fx);
        } catch (err) {
            this.deps.logger.warn({ err }, "fx unavailable for P&L computation");
            return null;
        }
        // costBasisGBP is the GBP at entry — set at trade close time, not FX-converted on
        // read. Legacy rows without it contribute 0 to cost rather than mixing in a
        // native-currency scalar.
        const totalCostGBP = positions.reduce((acc: number, p: PositionDoc) => {
            const cost = (p as PositionDoc & { costBasisGBP?: number }).costBasisGBP;
            return acc + (typeof cost === "number" ? cost : 0);
        }, 0);
        return {
            totalValueGBP,
            totalCostGBP,
            unrealisedPnLGBP: totalValueGBP - totalCostGBP,
            positions:        positions.length,
        };
    }
}

import type { Logger } from '@trader/core';
import type { TradeSignalDTO } from '@trader/shared-types';
import type { SignalServiceClient } from '@trader/contracts';
import type { CycleBatch } from './CycleAnalysisBatcher.ts';
import type { TelemetryBlock } from './ReportContext.ts';

// Snapshot fetchers — narrow interfaces so the TelemetryBuilder doesn't pin a particular
// HTTP client implementation. Mirrored by SignalServiceClient + a thin sectors fetcher in
// wiring.ts. Keeping them as interfaces makes the unit tests trivial (pass plain objects).
export interface ISignalTelemetryFetcher {
    telemetrySnapshot(
        since: number,
        opts?: { tickers?: readonly string[]; strategyId?: string },
    ): Promise<Awaited<ReturnType<SignalServiceClient['telemetrySnapshot']>>>;
}

export interface ISectorsFetcher {
    fetchSectors(): Promise<{ sectors: Record<string, string>; fetchedAt: number }>;
}

// Map StrategyDecayMonitor's StrategyHealth → a bounded multiplier the renderers can use
// to gauge how aggressively to lean into the cycle's picks. Bounds are illustrative; the
// real multiplier flows from RegimeState. We surface this one so the report can show
// "decay is dragging the engine to 0.5x sizing" even when no signals arrived this window.
const DECAY_MULTIPLIER: Record<TelemetryBlock['decay']['health'], number> = {
    healthy:   1.0,
    warning:   0.85,
    degraded:  0.5,
    suspended: 0.0,
};

// Computes the local components of the TelemetryBlock (HHI, top-3 concentration,
// per-sector roll-up, BUY/SELL/HOLD split) and merges them with the snapshots pulled
// from signal-service + market-data-service. One assembled TelemetryBlock per batch
// flush — feeds the SanityChecker and every renderer.
export class TelemetryBuilder {
    constructor(
        private readonly signals: ISignalTelemetryFetcher,
        private readonly universe: ISectorsFetcher,
        private readonly logger: Logger,
    ) {}

    async build(batch: CycleBatch): Promise<TelemetryBlock> {
        const windowStart = batch.firstSeenAt;
        const windowEnd   = batch.lastSeenAt;

        // Two remote fetches in parallel. Both individually tolerant of failure — the
        // telemetry block degrades to default zeros so the report still renders rather
        // than blocking the operator on an upstream blip.
        const batchTickers = Array.from(new Set(batch.signals.map((s) => s.ticker)));
        const [snapshot, sectorsResp] = await Promise.all([
            this.signals.telemetrySnapshot(batch.cycleTs, {
                tickers:    batchTickers,
                strategyId: batch.strategyId,
            }).catch((err) => {
                this.logger.warn({ err, cycleKey: batch.cycleKey }, 'telemetry-snapshot fetch failed; degrading');
                return null;
            }),
            this.universe.fetchSectors().catch((err) => {
                this.logger.warn({ err, cycleKey: batch.cycleKey }, 'sectors fetch failed; degrading');
                return { sectors: {}, fetchedAt: 0 };
            }),
        ]);

        const signalsByAction = this.countByAction(batch.signals);
        const bySector        = this.rollupBySector(batch.signals);
        const concentration   = this.concentration(batch.signals);

        const sectorsMap = sectorsResp.sectors;
        const activeCount = Object.keys(sectorsMap).length;
        const unknownCount = activeCount === 0 ? 0
            : Object.values(sectorsMap).filter((s) => s === 'Unknown').length;
        const unknownFraction = activeCount === 0 ? 0 : unknownCount / activeCount;

        const navGbp = snapshot?.risk.navGbp ?? 0;
        const mtmGbp = snapshot?.openPositions.mtmGbp ?? 0;
        const cashFractionApprox = navGbp > 0
            ? Math.max(0, Math.min(1, 1 - (mtmGbp / navGbp)))
            : null;

        // Regime: the first signal in the batch carries this cycle's features snapshot.
        // All signals in a batch share the same StrategyOutput (single emit cycle), so
        // sampling the head is sufficient. coldStart is 0.5 (RegimeEngine's sentinel for
        // "engine hasn't accumulated enough history yet" — exactly the value an untrained
        // model would default to before any observations).
        const head = batch.signals[0]?.features_snapshot;
        const regimeConfidence = head?.regime_confidence ?? null;
        const positionSizeMultiplier = head?.position_size_multiplier ?? null;
        const coldStart = regimeConfidence === 0.5;

        const decayHealth = snapshot?.decay.health ?? 'healthy';
        const ic30d       = snapshot?.decay.metrics?.icTStat ?? null;

        return {
            windowStart,
            windowEnd,
            signals: {
                total: batch.signals.length,
                ...signalsByAction,
                bySector,
            },
            realisedSinceLast: {
                closedSignals: snapshot?.realisedSinceLast.closedSignals ?? 0,
                pnlGbp:        snapshot?.realisedSinceLast.pnlGbp        ?? 0,
                bestPick:      snapshot?.realisedSinceLast.bestPick      ?? null,
                worstPick:     snapshot?.realisedSinceLast.worstPick     ?? null,
            },
            openExposure: {
                navGbp,
                cashFractionApprox,
                top3Concentration:   concentration.top3,
                hhi:                 concentration.hhi,
                positionsByLifecycle: snapshot?.lifecycleCounters ?? this.zeroedLifecycleCounters(),
            },
            regime: { confidence: regimeConfidence, positionSizeMultiplier, coldStart },
            decay:  { health: decayHealth, multiplier: DECAY_MULTIPLIER[decayHealth], ic_30d: ic30d },
            universe: {
                activeCount,
                readyCount:            activeCount,
                unknownSectorFraction: unknownFraction,
            },
            circuitBreaker: snapshot?.risk.circuit ?? { open: false, reason: null },
            history: {
                previousDigestAt:      snapshot?.history.previousDigestAt      ?? null,
                timeSinceLastDigestMs: snapshot?.history.previousDigestAt != null
                    ? Math.max(0, batch.cycleTs - snapshot.history.previousDigestAt)
                    : null,
                signalsSinceLastDigest: snapshot?.history.signalsSinceLastDigest ?? 0,
                priorAppearances:       snapshot?.history.priorAppearances       ?? {},
            },
        };
    }

    // ── Local computations on batch.signals ────────────────────────────────────

    private countByAction(signals: TradeSignalDTO[]): { buys: number; sells: number; holds: number } {
        let buys = 0, sells = 0, holds = 0;
        for (const s of signals) {
            if      (s.action === 'BUY')  buys++;
            else if (s.action === 'SELL') sells++;
            else                          holds++;
        }
        return { buys, sells, holds };
    }

    private rollupBySector(signals: TradeSignalDTO[]): TelemetryBlock['signals']['bySector'] {
        const acc = new Map<string, { n: number; sumConf: number; sumScore: number }>();
        for (const s of signals) {
            const sector = s.features_snapshot?.sectors?.[s.ticker] ?? 'Unknown';
            const score  = s.features_snapshot?.composite_scores?.[s.ticker] ?? 0;
            const entry  = acc.get(sector) ?? { n: 0, sumConf: 0, sumScore: 0 };
            entry.n += 1;
            entry.sumConf += s.confidence;
            entry.sumScore += score;
            acc.set(sector, entry);
        }
        return Array.from(acc.entries())
            .map(([sector, e]) => ({
                sector,
                n: e.n,
                avgConfidence: e.n > 0 ? e.sumConf / e.n : 0,
                avgScore:      e.n > 0 ? e.sumScore / e.n : 0,
            }))
            .sort((a, b) => b.n - a.n);
    }

    private concentration(signals: TradeSignalDTO[]): { top3: number; hhi: number } {
        const weights = signals.map((s) => Math.abs(s.targetWeight)).filter((w) => w > 0);
        if (weights.length === 0) return { top3: 0, hhi: 0 };
        const total = weights.reduce((a, b) => a + b, 0);
        if (total === 0) return { top3: 0, hhi: 0 };
        const normalised = weights.map((w) => w / total);
        const top3 = normalised.slice().sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
        const hhi  = normalised.reduce((acc, w) => acc + w * w, 0);
        return { top3, hhi };
    }

    private zeroedLifecycleCounters(): Record<string, number> {
        return {
            pending: 0, approved: 0, queued: 0, executing: 0,
            executed: 0, closed: 0, failed: 0, cancelled: 0,
        };
    }
}

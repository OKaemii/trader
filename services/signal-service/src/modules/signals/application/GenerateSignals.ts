import { TradeSignal, SignalLifecycle, type Action } from '../domain/TradeSignal.ts';
import type { ISignalRepository } from '../domain/ISignalRepository.ts';
import type { ISignalPublisher } from '../domain/ISignalPublisher.ts';
import type { IPortfolioState } from '../../risk/application/IPortfolioState.ts';
import type { IPriceLookup } from '../domain/IPriceLookup.ts';
import type { StrategyOutput } from '@trader/shared-types';
import type { Logger } from '@trader/core';
import { buildStructuredRationale } from './RationaleBuilder.ts';
import { PortfolioConstructor } from './PortfolioConstructor.ts';
import type { RiskEngine } from '../../risk/application/RiskEngine.ts';
import type { StrategyDecayMonitor } from '../../approval/application/StrategyDecayMonitor.ts';
import type { AutoApprovalGate } from '../../approval/application/AutoApprovalGate.ts';
import { randomUUID } from 'node:crypto';

export interface GenerateSignalsConfig {
  minActionableConfidence: number;
  volTarget: number;
  // Minimum positive (resp. negative) cross-section size below which the p95-based
  // divisor is meaningless. On a singleton the p95 IS the element → ratio = 1 →
  // confidence pins to 1.0 regardless of how small the score actually is. Falling back
  // to a fixed absolute divisor (1.0) prevents the false-positive but doesn't suppress
  // a real high-conviction pick. Tunable per environment via env (default 5).
  minPositivePeers?: number;
  // |score| below this is treated as "no real conviction" — confidence forced to 0
  // (BUY gate then drops it). Independent of the cross-section size; covers the
  // factor-collapse case where every score rounds to ~0. Default 0.1.
  minScoreEpsilon?: number;
}

const DEFAULT_MIN_POSITIVE_PEERS = 5;
const DEFAULT_MIN_SCORE_EPSILON  = 0.1;

export class GenerateSignalsUseCase {
  constructor(
    private readonly signalRepo: ISignalRepository,
    private readonly publisher: ISignalPublisher,
    private readonly portfolioState: IPortfolioState,
    private readonly riskEngine: RiskEngine,
    private readonly logger: Logger,
    private readonly config: GenerateSignalsConfig,
    private readonly portfolioConstructor: PortfolioConstructor = new PortfolioConstructor(),
    private readonly decayMonitor?: StrategyDecayMonitor,
    private readonly priceLookup?: IPriceLookup,
    private readonly autoApprovalGate?: AutoApprovalGate,
  ) {}

  async execute(features: StrategyOutput): Promise<TradeSignal[]> {
    const universeSize = features.ticker_universe.length;
    this.logger.info(
      {
        strategy_id: features.strategy_id,
        ts: features.timestamp,
        universeSize,
        regime_confidence: features.regime_confidence,
        minActionableConfidence: this.config.minActionableConfidence,
        volTarget: this.config.volTarget,
      },
      'GenerateSignals.execute: start',
    );
    const { allowed, reason } = await this.riskEngine.canTrade();
    if (!allowed) {
      this.logger.warn({ reason }, 'GenerateSignals.execute: circuit open — emitting 0 signals');
      return [];
    }

    // Strategy decay check: runs after every rebalance cycle (Section 28)
    let decayMultiplier = 1.0;
    if (this.decayMonitor) {
      const health = await this.decayMonitor.run();
      if (health === 'suspended') {
        this.logger.warn('strategy suspended by decay monitor — no new signals');
        return [];
      }
      if (health === 'degraded') {
        decayMultiplier = 0.25;
        this.logger.warn('strategy degraded — reducing position size to 25%');
      }
    }

    const currentWeights = await this.portfolioState.currentWeights();

    const { weights: rawWeights, stabilityWarnings, uncertainty } =
      this.portfolioConstructor.construct(
        {
          scores: features.ticker_universe.map((t) => features.composite_scores[t] ?? 0),
          tickers: features.ticker_universe,
          sectors: features.ticker_universe.map((t) => features.sectors[t] ?? 'Unknown'),
          currentWeights: features.ticker_universe.map((t) => currentWeights[t] ?? 0),
          targetVol: this.config.volTarget,
          covariance: features.covariance_matrix,
        },
        features.factor_attributions ?? {},
      );

    if (stabilityWarnings.length > 0) {
      for (const w of stabilityWarnings) this.logger.warn({ warning: w }, 'portfolio-constructor stability');
    }

    const weights = this.riskEngine.applyRegimeScaling(
      rawWeights,
      (features.position_size_multiplier ?? 1.0) * decayMultiplier,
    );

    const decayFactor = this.riskEngine.confidenceDecayFactor();

    // Confidence normalisation: sign-aware, cross-sectional, scale-free. We compute p95
    // separately over positive and negative composite scores and pick the divisor matching
    // the score's sign. Rationale: long-side conviction should be measured against the
    // dispersion of *other long candidates*, not against an asymmetric bearish tail. A
    // single divisor pooled over |score| lets a heavy short-side tail (e.g. distressed
    // tickers in the universe) inflate the divisor and push every BUY confidence below
    // MIN_ACTIONABLE_CONFIDENCE, silently dropping the entire long book. Falls back to 1.0
    // when a side is empty or its p95 is zero.
    const p95 = (xs: number[]): number => {
      if (xs.length === 0) return 1.0;
      const sorted = xs.slice().sort((a, b) => a - b);
      const v = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 1.0;
      return v > 0 ? v : 1.0;
    };
    const posScores = features.ticker_universe
      .map((t) => features.composite_scores[t] ?? 0)
      .filter((v) => v > 0);
    const negScores = features.ticker_universe
      .map((t) => features.composite_scores[t] ?? 0)
      .filter((v) => v < 0)
      .map((v) => -v);
    // Singleton / sparse-cross-section fallback. Below `minPositivePeers`, p95 collapses
    // to "the score itself" and every emitted confidence pins to 1.0 — the operator
    // reads a 100%-confidence BUY for what is in fact a near-zero composite. Switching
    // to an absolute divisor of 1.0 keeps the value in [0, 1] but lets it scale honestly
    // with the actual score magnitude. Surfaced as `confidence_sparse_positive` /
    // `_sparse_negative` flags so downstream sanity checks can warn.
    const minPositivePeers = this.config.minPositivePeers ?? DEFAULT_MIN_POSITIVE_PEERS;
    const minScoreEpsilon  = this.config.minScoreEpsilon  ?? DEFAULT_MIN_SCORE_EPSILON;
    const sparsePositive = posScores.length < minPositivePeers;
    const sparseNegative = negScores.length < minPositivePeers;
    const divisorPos = sparsePositive ? 1.0 : p95(posScores);
    const divisorNeg = sparseNegative ? 1.0 : p95(negScores);
    if (sparsePositive || sparseNegative) {
      this.logger.info({
        posCount: posScores.length, negCount: negScores.length,
        sparsePositive, sparseNegative, minPositivePeers,
      }, 'GenerateSignals.execute: sparse cross-section — using absolute divisor fallback');
    }

    // Look up last close for every universe ticker in one round-trip — used as entryPrice
    // when emitting BUY/SELL signals. Optional dependency: tests can omit priceLookup.
    const lastCloses = this.priceLookup
      ? await this.priceLookup.lastCloseMany(features.ticker_universe)
      : {};

    // In-flight guard: skip tickers that already have a signal in Approved / Queued /
    // Executing. Without this, the strategy reads stale currentWeights (positions sync
    // every 5min) and re-emits a BUY for a ticker whose prior BUY is still draining the
    // dispatcher queue. By the time the dispatcher claims the new signal the position has
    // filled to (or past) target, qty rounds to zero, and the signal fails with what looks
    // like ZeroQuantity — but the real cause is the strategy never seeing its own pending
    // intent. Filter is bounded at 500 — well above the typical in-flight depth.
    const inflightSignals = await this.signalRepo.findByLifecycle(
      [SignalLifecycle.Approved, SignalLifecycle.Queued, SignalLifecycle.Executing],
      500,
    );
    const inflightTickers = new Set(inflightSignals.map((s) => s.ticker));
    if (inflightTickers.size > 0) {
      this.logger.info({ count: inflightTickers.size, sample: Array.from(inflightTickers).slice(0, 10) },
        'GenerateSignals.execute: in-flight signals — those tickers will be skipped this cycle');
    }

    const signals = features.ticker_universe
      .map((ticker: string, i: number): TradeSignal | null => {
        if (inflightTickers.has(ticker)) return null;
        const w = weights[i] ?? 0;
        const currentW = currentWeights[ticker] ?? 0;
        if (w < 0.01 && currentW < 0.01) return null;

        const action: Action =
          w > currentW + 0.01 ? 'BUY' :
          w < currentW - 0.01 ? 'SELL' :   // SELL = reduce long, never short
          'HOLD';

        if (action === 'HOLD') return null;

        const rationale = buildStructuredRationale(ticker, features, uncertainty);
        if (!rationale) return null;

        try {
          const entry = lastCloses[ticker];
          const score = features.composite_scores[ticker] ?? 0;
          const divisor = score >= 0 ? divisorPos : divisorNeg;
          // Per-signal AnalysisContext — minimal subset of the cycle's StrategyOutput
          // needed by downstream notification enrichment (sector, score, regime). We
          // deliberately drop the full covariance_matrix and ticker_universe to keep
          // the wire/Mongo payload small; the AnalysisEmailSender only reads:
          //   - sectors[this.ticker]
          //   - composite_scores[this.ticker]
          //   - regime_confidence
          //   - position_size_multiplier
          //   - strategy_id
          // Without this attachment, the email enricher saw `undefined` for every
          // field and the LLM hallucinated alarming "Unknown sector / 0.000 score /
          // unknown regime" context (visible to the operator as concerning analysis).
          const analysisContext = {
            timestamp:                features.timestamp,
            strategy_id:              features.strategy_id,
            ticker_universe:          [],
            composite_scores:         { [ticker]: score },
            factor_attributions:      features.factor_attributions[ticker]
              ? { [ticker]: features.factor_attributions[ticker] }
              : {},
            sectors:                  { [ticker]: features.sectors[ticker] ?? 'Unknown' },
            covariance_matrix:        [],
            regime_confidence:        features.regime_confidence,
            ...(features.position_size_multiplier !== undefined
              ? { position_size_multiplier: features.position_size_multiplier }
              : {}),
            ...(features.signal_weights !== undefined ? { signal_weights: features.signal_weights } : {}),
            ...(features.feature_stability !== undefined ? { feature_stability: features.feature_stability } : {}),
            ...(features.betti_curves !== undefined ? { betti_curves: features.betti_curves } : {}),
            ...(features.laplacian_residuals !== undefined && features.laplacian_residuals[ticker] !== undefined
              ? { laplacian_residuals: { [ticker]: features.laplacian_residuals[ticker] } }
              : {}),
            // report_cadence drives notification-service CycleAnalysisBatcher windowing.
            // Copy at emit time so each persisted signal carries the cadence in force on
            // the cycle that produced it — operator can flip BAR_FREQUENCY mid-stream and
            // older signals retain their original cadence label.
            ...(features.report_cadence !== undefined ? { report_cadence: features.report_cadence } : {}),
          };
          // Tiny-score gate: a |score| below `minScoreEpsilon` is operationally
          // indistinguishable from noise, even if the cross-section is healthy. Force
          // confidence to 0 so the BUY filter drops it — keeps the operator from
          // seeing a 100%-confidence pick whose displayed score rounds to 0.000.
          const rawConfidence = Math.min(Math.abs(score) / divisor, 1) * decayFactor;
          const confidence = Math.abs(score) < minScoreEpsilon ? 0 : rawConfidence;
          return new TradeSignal({
            id: randomUUID(),
            timestamp: features.timestamp,
            ticker,
            strategy_id: features.strategy_id,
            action,
            confidence,
            targetWeight: w,
            rationale: JSON.stringify(rationale),
            ...(entry && entry > 0 ? { entryPrice: entry } : {}),
            lifecycle: SignalLifecycle.Pending,
            features_snapshot: analysisContext,
          });
        } catch { return null; }
      })
      // SELLs are exits — portfolio decisions, not conviction decisions. When the
      // optimiser drops a held ticker out of its top picks, w < currentW and a SELL
      // is emitted: that's the strategy saying "free this capital for better picks".
      // Gating SELLs on confidence (which measures direction conviction, not
      // rebalance need) used to suppress exits for held positions with near-zero
      // composite_scores, so positions persisted even when the optimiser wanted them
      // gone. BUYs still need conviction — they commit new capital.
      .filter((s): s is TradeSignal =>
        s !== null && (
          s.action === 'SELL' ||
          s.isActionable(this.config.minActionableConfidence)
        ));

    const actionCounts = signals.reduce<Record<string, number>>((acc, s) => {
      acc[s.action] = (acc[s.action] ?? 0) + 1;
      return acc;
    }, {});
    this.logger.info(
      {
        emitted: signals.length,
        actionCounts,
        decayFactor,
        decayMultiplier,
        divisorPos,
        divisorNeg,
        sample: signals.slice(0, 5).map((s) => ({ ticker: s.ticker, action: s.action, confidence: s.confidence, targetWeight: s.targetWeight })),
      },
      `GenerateSignals.execute: emitted ${signals.length} actionable signal(s) of ${universeSize} candidates`,
    );

    await Promise.all(signals.map((s) => this.signalRepo.save(s)));
    // Notification policy (b): emails fire only on lifecycle='executed', not on emission.
    // The publish-to-TRADE_SIGNALS hop happens in the internal-router /executed callback so
    // notification-service sees a signal exactly once, after T212 confirms placement.

    // Auto-approve gate: when the operator flips the Redis flag, every freshly emitted
    // signal is approved here without waiting for manual click. Fire-and-forget — the
    // gate logs its own outcome and a slow trading-service round-trip shouldn't block
    // the next strategy cycle. See AutoApprovalGate for the cash pro-rate logic.
    if (this.autoApprovalGate) {
      this.autoApprovalGate.process(signals).catch((err: unknown) => {
        this.logger.warn({ err }, 'auto-approval gate failed');
      });
    }
    return signals;
  }
}

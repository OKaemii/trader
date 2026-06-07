// strategy-impact aggregation (Task 12 §B/§E). Backs the Research → Strategy Impact tab:
// GET /admin/api/signals/strategy-impact?ticker= returns, per strategy that has touched the
// ticker, where the ticker sits in that strategy's ranking + how often/long it has been held +
// the realised P&L attributed to it. Pure mapping over the per-cycle held_set_snapshots (T11)
// plus this service's own executed/closed signals — no I/O here, so it is unit-tested directly.

import { SignalLifecycle } from '@trader/shared-types';

// One per-cycle snapshot row (verbatim shape from T11 — see HeldSetSnapshot.HeldSetSnapshotDoc).
// Only the fields the aggregation reads are required; callers pass the raw docs through.
export interface StrategyImpactSnapshot {
  strategy_id:      string;
  observation_ts:   number;
  ticker:           string;
  rank:             number;
  selected:         boolean;
  holding_age_days: number;
}

// The slice of a signal the contribution calc needs. Mirrors TradeSignal — kept minimal so the
// pure function doesn't depend on the entity class (and the test can build plain objects).
export interface StrategyImpactSignal {
  strategy_id:  string;
  ticker:       string;
  action:       string;          // 'BUY' | 'SELL' | 'HOLD'
  lifecycle:    SignalLifecycle; // failed/cancelled rows must already be filtered out by the caller
  entryPrice?:  number | undefined;
  exitPrice?:   number | undefined;
}

// Per-strategy impact metrics for one ticker. One entry per strategy that has either ranked or
// traded the ticker.
export interface StrategyImpactRow {
  strategyId:              string;
  currentRank:             number | null; // latest snapshot's rank for this ticker (null ⇒ never ranked)
  historicalInclusionPct:  number;        // fraction of this ticker's snapshots with selected=true, [0,1]
  avgHoldingDays:          number;        // mean holding_age_days over snapshots where selected (0 if none)
  contributionPct:         number;        // realised round-trip return attributed to the ticker, as a fraction
  selected:                boolean;       // latest snapshot's selected flag
}

// Build the per-strategy impact rows for one ticker.
//
// Inputs are already scoped to the single ticker (the caller queries by ticker):
//   - `snapshots`: every held_set_snapshots row for the ticker, any cycle, any strategy.
//   - `signals`:   this ticker's signals, ALREADY filtered to lifecycle ∈ {executed, closed} by the
//                  caller (a failed/cancelled order never happened — it gets no contribution, no
//                  inclusion, exactly as the failure invariant in CLAUDE.md requires).
//
// We group by strategy so a ticker that has run under more than one ACTIVE_STRATEGY over its life
// reports a row per strategy rather than blending their rankings.
export function buildStrategyImpact(
  snapshots: StrategyImpactSnapshot[],
  signals:   StrategyImpactSignal[],
): StrategyImpactRow[] {
  // Union of strategy ids seen in either source — a ticker ranked but never traded (or vice versa)
  // still gets a row.
  const strategyIds = new Set<string>();
  for (const s of snapshots) strategyIds.add(s.strategy_id);
  for (const s of signals)   strategyIds.add(s.strategy_id);

  const rows: StrategyImpactRow[] = [];
  for (const strategyId of strategyIds) {
    const snaps = snapshots.filter((s) => s.strategy_id === strategyId);
    const sigs  = signals.filter((s) => s.strategy_id === strategyId);

    // Latest snapshot drives currentRank + selected. observation_ts is unique per cycle for a
    // (strategy, ticker), so a max over it picks the most recent ranking.
    const latest = snaps.reduce<StrategyImpactSnapshot | null>(
      (acc, s) => (acc === null || s.observation_ts > acc.observation_ts ? s : acc),
      null,
    );

    // historicalInclusionPct: fraction of this ticker's snapshots where it was in the held set.
    const inclusionPct = snaps.length > 0
      ? snaps.filter((s) => s.selected).length / snaps.length
      : 0;

    // avgHoldingDays: mean holding age over the cycles it was actually held (selected). Averaging
    // over non-selected cycles (age 0) would understate how long it sits when in the book.
    const heldSnaps = snaps.filter((s) => s.selected);
    const avgHoldingDays = heldSnaps.length > 0
      ? heldSnaps.reduce((sum, s) => sum + s.holding_age_days, 0) / heldSnaps.length
      : 0;

    rows.push({
      strategyId,
      currentRank:            latest?.rank ?? null,
      historicalInclusionPct: inclusionPct,
      avgHoldingDays,
      contributionPct:        contributionForStrategy(sigs),
      selected:               latest?.selected ?? false,
    });
  }

  // Stable order for deterministic output (and a tidy table) — by strategy id.
  rows.sort((a, b) => (a.strategyId < b.strategyId ? -1 : a.strategyId > b.strategyId ? 1 : 0));
  return rows;
}

// Realised P&L attributed to the ticker under one strategy, summed over closed long round-trips.
// A BUY signal that reached `Closed` carries both entryPrice and exitPrice (the FillsPoller stamps
// exitPrice on closure), so its realised return is (exit - entry)/entry. We sum those fractions —
// the contribution of holding the name. Open (Executed-but-not-Closed) positions have no exit yet
// and contribute nothing realised; SELL legs are exits of a long and aren't separate round-trips,
// so they're excluded to avoid double counting the same trade.
function contributionForStrategy(signals: StrategyImpactSignal[]): number {
  let total = 0;
  for (const s of signals) {
    if (s.action !== 'BUY') continue;
    if (s.lifecycle !== SignalLifecycle.Closed) continue;
    if (!s.entryPrice || !s.exitPrice || s.entryPrice <= 0) continue;
    total += (s.exitPrice - s.entryPrice) / s.entryPrice;
  }
  return total;
}

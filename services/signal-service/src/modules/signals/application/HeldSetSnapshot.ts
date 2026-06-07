// held_set_snapshots writer (Task 11 §B). After the long-only optimiser produces the final
// weights each cycle, signal-service records one doc per ranked universe name so the Strategy
// Impact (GET /admin/api/signals/strategy-impact?ticker=) + Factor Evolution surfaces have a
// per-cycle inclusion/holding history to read. Doc shape is fixed by Task 5 (#58); keep it verbatim.

const MS_PER_DAY = 86_400_000;

// One persisted row per ranked name per cycle. Append-only.
export interface HeldSetSnapshotDoc {
  strategy_id:      string;
  observation_ts:   number;   // cycle as_of_ms (knowledge time)
  ticker:           string;
  rank:             number;   // 1..N from sorting composite_scores descending
  selected:         boolean;  // true = in the final held set (weight > 0)
  weight:           number;   // final long-only weight (0 when not selected)
  holding_age_days: number;   // whole days since the oldest open BUY for this ticker (0 if none held)
}

export interface HeldSetSnapshotInput {
  strategyId:    string;
  observationTs: number;                  // cycle as_of_ms — same instant used for emission
  tickers:       string[];                // the full ranked universe (one doc each)
  // Final long-only weight per ticker, aligned by position with `tickers`. 0 ⇒ not selected.
  weights:       number[];
  // Composite score per ticker, aligned by position with `tickers`. Drives `rank`.
  scores:        number[];
  // Oldest open-BUY executedAt (unix ms) for tickers that are currently held, keyed by ticker.
  // Absent ⇒ nothing held for that name ⇒ holding_age_days = 0. The map is built from the same
  // executed-BUY lookup the FIFO/closure path uses, so failed orders never count.
  oldestOpenBuyAtByTicker: Record<string, number | undefined>;
}

// A small positive weight floor: weights at/below this are treated as "not selected". Mirrors
// the optimiser's intent — a name the solver zeroed out (or left as floating-point dust) is not
// a held position. Anything the optimiser genuinely allocates is orders of magnitude larger.
const SELECTED_WEIGHT_EPSILON = 1e-9;

// Pure mapping: cycle data → one snapshot doc per ranked name. No I/O — unit-tested directly.
//
// `rank` is assigned by sorting the universe by composite score descending (rank 1 = highest
// score), tie-broken by ticker for determinism so two names with identical scores get a stable
// order across cycles. `selected` follows the final weight (the held set is exactly the names the
// optimiser gave a positive weight), independent of score sign — a high score that the sector cap
// or top-K trimmed out is `selected: false` with weight 0.
export function buildHeldSetSnapshots(input: HeldSetSnapshotInput, nowMs: number): HeldSetSnapshotDoc[] {
  const { strategyId, observationTs, tickers, weights, scores, oldestOpenBuyAtByTicker } = input;

  // Rank by score descending. Build an index order first, then map index → rank so the output
  // stays aligned with the original `tickers` order (callers don't have to re-join).
  const order = tickers
    .map((ticker, i) => ({ ticker, score: scores[i] ?? 0, i }))
    .sort((a, b) => (b.score - a.score) || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  const rankByIndex = new Array<number>(tickers.length);
  order.forEach((entry, position) => { rankByIndex[entry.i] = position + 1; });

  return tickers.map((ticker, i): HeldSetSnapshotDoc => {
    const weight = weights[i] ?? 0;
    const selected = weight > SELECTED_WEIGHT_EPSILON;
    const oldestBuyAt = oldestOpenBuyAtByTicker[ticker];
    // holding_age = whole days since the oldest open BUY filled. A name with no open BUY (never
    // held, or held only by failed/closed orders) has age 0. floor() so a position opened 2h ago
    // reads 0 days, not a fractional day.
    const holdingAgeDays = oldestBuyAt != null && oldestBuyAt <= nowMs
      ? Math.floor((nowMs - oldestBuyAt) / MS_PER_DAY)
      : 0;
    return {
      strategy_id:      strategyId,
      observation_ts:   observationTs,
      ticker,
      rank:             rankByIndex[i] ?? i + 1,
      selected,
      weight:           selected ? weight : 0,
      holding_age_days: holdingAgeDays,
    };
  });
}

// Best-effort sink for the per-cycle snapshot. A write failure must log and return — never throw
// into the signal-emission path (same contract as the strategy-engine feature/factor store).
export interface IHeldSetSnapshotStore {
  write(docs: HeldSetSnapshotDoc[]): Promise<void>;
}

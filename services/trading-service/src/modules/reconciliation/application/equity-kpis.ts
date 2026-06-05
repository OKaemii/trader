// Pure performance KPIs over a NAV time-series (nav_history, written ~every 4h by the
// reconciliation loop). Deliberately NO annualised Sharpe/volatility here: the irregular ~4h
// cadence + short live history make annualised risk-adjusted metrics misleading, and fabricating
// them from a handful of NAV prints would violate the no-false-signal contract. Annualised,
// risk-adjusted metrics (DSR / deflated Sharpe over multi-year daily) live in the backtest
// validator, computed honestly. Here we report only what the raw NAV series can support directly:
// realised return, period high/low, and peak-to-trough drawdown.

export interface NavPoint {
  t: number;              // snapshot epoch ms
  nav: number;
  cash: number;
  positionsValue: number;
}

export interface EquityKpis {
  nSnapshots: number;
  firstAt: number | null;
  lastAt: number | null;
  current: number;
  cash: number;
  positionsValue: number;
  start: number;
  totalReturnPct: number;       // (current - start) / start
  high: number;
  low: number;
  maxDrawdownPct: number;       // worst peak-to-trough decline over the window (≤ 0)
  currentDrawdownPct: number;   // running-peak → latest (≤ 0)
}

const EMPTY: EquityKpis = {
  nSnapshots: 0, firstAt: null, lastAt: null, current: 0, cash: 0, positionsValue: 0,
  start: 0, totalReturnPct: 0, high: 0, low: 0, maxDrawdownPct: 0, currentDrawdownPct: 0,
};

/**
 * Repair the legacy NAV double-count for a single ledger point (pure; returns a new point or the
 * input unchanged). Exported for unit testing + applied at the equity read path.
 *
 * Before the 2026-06-03 fix (commit 8d6a8f8) the reconciliation writer stored
 *   cash = broker.total,  positionsValue = pv,  nav = broker.total + pv
 * — adding position value on top of the broker `total`, which ALREADY includes open positions.
 * That inflated nav by `pv` (≈2× once fully invested: the "£6,631" period-high that never
 * happened). The post-fix writer stores cash = broker.FREE, nav = broker.total.
 *
 * A legacy row is identified by the exact arithmetic identity the bug produced —
 * `nav === cash + positionsValue` — together with `cash >= positionsValue`: the legacy `cash` was
 * the broker *total*, which necessarily covers the position value, whereas a meaningfully-invested
 * post-fix row stores `free` cash that is *below* its position value. That structural guard rejects
 * genuine post-fix rows (where `free < positions`) while still catching a fully-invested legacy row
 * (`cash == positionsValue`, the most-inflated ~2× case). For a legacy row the correct nav is
 * exactly the stored `cash` (= broker.total); we also reconstruct an approximate free cash
 * (`cash - positionsValue`) so the split still reconciles. nav_history is an append-only ledger, so
 * the correction lives here at read time — stored rows are never mutated, but KPIs see the honest
 * series.
 */
export function repairLegacyNavPoint(p: NavPoint): NavPoint {
  const looksDoubleCounted =
    p.positionsValue > 0.01 &&                              // a double-count only exists once positions are held
    p.cash + 0.01 >= p.positionsValue &&                   // legacy cash = broker total ⇒ ≥ position value
    Math.abs(p.nav - (p.cash + p.positionsValue)) < 0.01;  // the exact identity the bug wrote (nav = total + pv)
  if (!looksDoubleCounted) return p;
  return { t: p.t, nav: p.cash, cash: p.cash - p.positionsValue, positionsValue: p.positionsValue };
}

/** `series` MUST be time-ordered ascending (oldest first). Returns the series + derived KPIs. */
export function computeEquityKpis(series: NavPoint[]): { series: NavPoint[]; kpis: EquityKpis } {
  if (series.length === 0) return { series, kpis: { ...EMPTY } };

  const first = series[0]!;
  const last = series[series.length - 1]!;
  const start = first.nav;
  const current = last.nav;

  let high = -Infinity;
  let low = Infinity;
  let peak = -Infinity;
  let maxDrawdownPct = 0;
  for (const p of series) {
    const v = p.nav;
    if (v > high) high = v;
    if (v < low) low = v;
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (v - peak) / peak;          // ≤ 0
      if (dd < maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  return {
    series,
    kpis: {
      nSnapshots: series.length,
      firstAt: first.t,
      lastAt: last.t,
      current,
      cash: last.cash,
      positionsValue: last.positionsValue,
      start,
      totalReturnPct: start > 0 ? (current - start) / start : 0,
      high,
      low,
      maxDrawdownPct,
      currentDrawdownPct: peak > 0 ? (current - peak) / peak : 0,
    },
  };
}

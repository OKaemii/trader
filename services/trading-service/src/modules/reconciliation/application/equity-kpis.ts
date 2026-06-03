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

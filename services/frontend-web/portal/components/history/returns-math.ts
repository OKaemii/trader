// Pure return/drawdown math for the History tab (T28). Extracted from the chart component so it
// carries no React/DOM and can be unit-tested directly. All series are re-indexed to 0% at the first
// point, so a curve always starts at the origin.

// One daily observation the History tab works from. `close` is the price (BASE units, pence already
// killed at the market-data boundary). `divPerShare` is the cash dividend with an ex-date ON this day
// (0 on non-ex days) — used to build the TOTAL-RETURN series (price return + reinvested dividends),
// distinct from the price-only return.
export interface HistoryPoint {
  time: number // unix seconds (chronological)
  close: number
  divPerShare: number
}

// Cumulative PRICE return, indexed to the first close (so the curve starts at 0%).
export function priceReturnSeries(pts: HistoryPoint[]): number[] {
  const base = pts[0]?.close
  if (!base || base <= 0) return pts.map(() => 0)
  return pts.map((p) => p.close / base - 1)
}

// Cumulative TOTAL return: the price path with each ex-date's dividend reinvested at that day's
// close (the standard discrete dividend-reinvestment growth factor). Compounding the per-day growth
// — (close_t/close_{t-1}) · (1 + div_t/close_t) — gives a wealth index we re-index to 0% at the
// start. A non-payer collapses to the price return exactly (div = 0 ⇒ growth factor of 1).
export function totalReturnSeries(pts: HistoryPoint[]): number[] {
  const out: number[] = []
  let wealth = 1
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) {
      out.push(0)
      continue
    }
    const prev = pts[i - 1]!.close
    const cur = pts[i]!.close
    if (prev > 0 && cur > 0) {
      const priceGrowth = cur / prev
      const divGrowth = 1 + (pts[i]!.divPerShare > 0 ? pts[i]!.divPerShare / cur : 0)
      wealth *= priceGrowth * divGrowth
    }
    out.push(wealth - 1)
  }
  return out
}

// Drawdown of a wealth index built from cumulative returns: value/running-peak − 1, a non-positive
// fraction (0 at a new high).
export function drawdownSeries(cumReturns: number[]): number[] {
  let peak = 1
  return cumReturns.map((r) => {
    const wealth = 1 + r
    if (wealth > peak) peak = wealth
    return peak > 0 ? wealth / peak - 1 : 0
  })
}

// @trader/shared-indicators — pure technical-indicator math over plain number series.
//
// Dependency-free on purpose: both the market-data swing screener (server-side, over the
// whole universe) and the portal candlestick chart (client-side overlays) compute the same
// indicators from the same code, so a chart and a screen can never disagree.
//
// Convention: inputs are chronological (oldest first). Series-returning functions return an
// array aligned 1:1 with the input, with `null` for indices inside the indicator's warm-up
// window (not enough history yet). Scalars return `null` when there isn't enough history.

/**
 * Simple moving average. `out[i]` = mean of `values[i-period+1 .. i]`, or `null` until
 * `period` samples exist (i.e. for i < period-1).
 */
export function sma(values: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error(`sma: period must be > 0, got ${period}`);
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Wilder's RSI over the trailing `period` price changes. `out[i]` is 0–100, or `null`
 * until warmed (indices 0..period). Conventions at the extremes: no losses in the window
 * → 100, no gains → 0, perfectly flat (no gains and no losses) → 50 (neutral).
 */
export function rsi(closes: number[], period = 14): (number | null)[] {
  if (period <= 0) throw new Error(`rsi: period must be > 0, got ${period}`);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  // Seed the average gain/loss over the first `period` changes (indices 1..period).
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    if (ch > 0) avgGain += ch;
    else avgLoss += -ch;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  // Wilder smoothing for every later index.
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Average volume over the trailing `period` samples, or `null` if there isn't enough
 * history. Used by the screener's unusual-volume ratio `latest / avgVolume`.
 */
export function avgVolume(volumes: number[], period = 20): number | null {
  if (period <= 0) throw new Error(`avgVolume: period must be > 0, got ${period}`);
  if (volumes.length < period) return null;
  let sum = 0;
  for (let i = volumes.length - period; i < volumes.length; i++) sum += volumes[i]!;
  return sum / period;
}

/** Highest high over the trailing `lookback` samples (default ~252 trading days = 52w). */
export function high52w(highs: number[], lookback = 252): number | null {
  return extremeTail(highs, lookback, Math.max);
}

/** Lowest low over the trailing `lookback` samples (default ~252 trading days = 52w). */
export function low52w(lows: number[], lookback = 252): number | null {
  return extremeTail(lows, lookback, Math.min);
}

function extremeTail(
  values: number[],
  lookback: number,
  pick: (a: number, b: number) => number,
): number | null {
  if (values.length === 0) return null;
  const start = Math.max(0, values.length - lookback);
  let acc = values[start]!;
  for (let i = start + 1; i < values.length; i++) acc = pick(acc, values[i]!);
  return acc;
}

/** Simple percentage return `(to - from) / from`; 0 when `from` is 0 (div-by-zero guard). */
export function pctReturn(from: number, to: number): number {
  if (from === 0) return 0;
  return (to - from) / from;
}

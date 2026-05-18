// Wall-clock-aligned poll scheduling.
//
// Why this exists: the prior pollLoop used `sleep(pollIntervalMs)` which drifts
// relative to wall-clock — a pod restart at 09:17 ends up polling at 10:17, 11:17,
// ... instead of the round-hour marks an operator expects. With many tickers and
// scripts inspecting "the 14:00 bar", consistent timing matters.
//
// Design:
//   nextAlignedTick(intervalMs, anchorOffsetMs = 0, nowMs = Date.now())
//   returns the next wall-clock-aligned tick time after `nowMs`.
//
// The grid is anchored to UTC midnight 1970-01-01 + anchorOffsetMs. For an hourly
// interval (3600_000 ms) with offset 0, ticks land at every UTC HH:00:00. For a
// 24h interval with offset = 22*3600_000, ticks land at 22:00 UTC each day.
//
// msUntilNextTick is a convenience wrapper returning how long to sleep — used
// directly by pollLoop in place of the fixed pollIntervalMs sleep.

export function nextAlignedTick(
  intervalMs: number,
  anchorOffsetMs: number = 0,
  nowMs: number = Date.now(),
): number {
  // Treat anchorOffsetMs as a phase offset against UTC midnight. The grid points are
  // anchor, anchor + interval, anchor + 2·interval, ... Find the smallest grid point
  // strictly greater than nowMs.
  const sinceAnchor = nowMs - anchorOffsetMs;
  const ticksSoFar  = Math.floor(sinceAnchor / intervalMs);
  // Add 1 so we always advance past `nowMs`, even when nowMs already sits on a tick
  // (otherwise we'd return the current instant and the caller would sleep 0ms).
  return anchorOffsetMs + (ticksSoFar + 1) * intervalMs;
}

export function msUntilNextTick(
  intervalMs: number,
  anchorOffsetMs: number = 0,
  nowMs: number = Date.now(),
): number {
  return nextAlignedTick(intervalMs, anchorOffsetMs, nowMs) - nowMs;
}

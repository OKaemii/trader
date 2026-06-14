// backfill — pull historical 5m bars from a MarketDataProvider, upsert to ohlcv_bars,
// invalidate the shared-bars Redis cache, and publish a pubsub notification so other
// services can refresh their derived views.
//
// Used in two places:
//   1. Bootstrap (market-data-service startup) — runs once if no 5m history exists.
//      Lets a freshly-deployed cluster reach a usable warmup state without waiting
//      for live-poll to accumulate ~20 days of bars.
//   2. Admin endpoint POST /api/admin/market-data/backfill — explicit operator call
//      with custom ticker/window args.
//
// **Both paths are gate-bypass relative to the session-aware poll gate.** The
// session calendar (@trader/shared-calendar) skips Yahoo calls when no relevant
// market is open. Backfills do the opposite: an operator running a backfill at
// 03:00 Sunday explicitly wants those calls (e.g. recovering from a multi-day
// outage that happened during a closed window). The calendar is not consulted by
// the functions here — call sites have already decided to hit the upstream.

import type { Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import { COLLECTIONS } from '@trader/shared-mongo';
import { invalidateBars, computeMissingRanges } from '@trader/shared-bars';
import type { MissingRange } from '@trader/shared-bars';
import { Trading212TickerAdapter } from '@trader/ticker-identity';
import type { BarInterval } from '@trader/shared-types';
import type { MarketDataProvider } from './providers/market-data-provider.ts';
import { writeBarRevisions } from './persist-bars.ts';
import { log } from '../../../logger.ts';

// ohlcv_bars is keyed on the bare identity (symbol, market); the coverage/heal reads here split the
// T212 ticker at the storage boundary via the platform's single suffix parser.
const tickerAdapter = new Trading212TickerAdapter();

const FIVE_MIN_MS = 5 * 60_000;
// Bridge a weeknight overnight close (~17.5h, e.g. Mon 16:00 → Tue 09:30) between two covered
// sessions — it's intrinsic to a 5m series, not missing data. Sized BELOW a fully-missing
// trading day (Mon 16:00 → Wed 09:30 ≈ 41.5h) so a real interior hole stays a fetchable gap.
// A weekend close (~65.5h) deliberately exceeds this and is re-fetched: a single time threshold
// can't tell a long weekend from a genuinely-missing trading week, so we err toward fetching
// (the provider returns ~nothing for a truly-closed window, and the write is a hash-gated
// no-op). The clean zero-fetch-on-full-coverage guarantee is on the DAILY series — its weekday
// grid lets a ≤4-day bridge separate weekends from real gaps unambiguously.
const INTRADAY_BRIDGE_MS = 18 * 60 * 60_000;

// Topic for the cross-service cache-invalidation pubsub. Anything maintaining a
// derived view of bar history (signal-service' price-lookup cache, the portal's
// historical chart, etc.) should subscribe and drop affected entries.
export const CACHE_INVALIDATED_TOPIC = 'bars:cache-invalidated';

export interface BackfillResult {
  ticker:    string;
  fetched:   number;
  upserted:  number;
  error?:    string;
}

export interface BackfillOpts {
  windowMs?:  number;   // default: 60 days (matches Yahoo 5m lookback cap)
  concurrency?: number; // tickers handled in parallel; default 5
  // Gap-aware escape hatch. Default (false): fetch ONLY the observation_ts sub-ranges we
  // don't already hold — a fully-covered ticker spends zero upstream calls / zero credits.
  // `forceRefetch: true` re-downloads the whole window (the pre-gap-aware behaviour) to
  // repair a suspected-bad span; never the default. See research-trading-os.md §I.
  forceRefetch?: boolean;
}

/**
 * Drop gaps shorter than `bridgeMs` — the market-closure holes that are intrinsic to a price
 * series, NOT missing data. A daily series has no Sat/Sun bar; an intraday 5m series has no
 * overnight bar. On the calendar grid those closures read as little holes between two covered
 * trading days (or at a window boundary that happens to land on a weekend). Re-fetching them
 * every run would (a) cost an upstream call that returns nothing and (b) break the §I "full
 * coverage ⇒ zero fetch" contract — including the #57 ≤1-step spurious trailing gap. So a gap
 * is kept only when it spans more than `bridgeMs` of wall-clock (`end − start ≥ bridgeMs`) — a
 * genuine multi-session hole worth filling. The position of the gap is irrelevant: a weekend at
 * the very start/end of the window is still just a weekend, and the live `healMissingHistory`
 * tail-heal + live poll already cover the most-recent ≤1-session tail.
 *
 * `bridgeMs = 0` keeps every gap (raw grid math). For daily, ~4 days bridges a weekend + an
 * adjacent long-weekend holiday; for intraday 5m, ~18h bridges any overnight/weekend close while
 * still flagging a fully-missing trading day as a fetchable gap.
 */
function dropClosureGaps(gaps: MissingRange[], bridgeMs: number): MissingRange[] {
  if (bridgeMs <= 0) return gaps;
  return gaps.filter((g) => g.end - g.start >= bridgeMs);
}

/**
 * Gap-aware fetch planning. Reads the observation_ts we already hold for (`ticker`,
 * `interval`) inside `[startMs, endMs]`, then returns the uncovered sub-ranges to fetch as
 * provider `(startMs, endMs)` pairs (genuine interior gaps AND leading/trailing tail). Full
 * coverage ⇒ `[]` ⇒ the caller makes zero upstream calls.
 *
 * **Grid flooring (the #57 caveat).** `computeMissingRanges` walks a fixed `stepMs` grid
 * anchored at `neededStart`; a held bar covers the grid point in whose `[point, point+step)`
 * bucket it lands. Bars are stamped on a step-aligned grid (5m bars at HH:00/05/…; daily at
 * 00:00:00Z), but `[startMs, endMs]` come from `now − window … now` — mid-grid instants. If
 * we anchored the grid to those raw bounds, every held bar would sit a fraction of a step off
 * its grid point and read as a gap. So we floor both bounds to the `stepMs` grid first — then
 * grid points line up with bar stamps and a calendar-complete ticker yields `[]` (true
 * zero-fetch tail), exactly as #57's release notes prescribe.
 *
 * **Closure bridging.** `bridgeMs` drops the intrinsic market-closure holes (weekends for
 * daily, overnights for intraday) so a fully-seeded ticker re-runs at zero fetch — see
 * `dropClosureGaps`. Pass `0` to keep the raw grid math.
 *
 * Live (`is_superseded:false`) rows only — the same fast lane `coverageOf` and the live read
 * path use.
 *
 * STORE NOTE (RC4 audit, card 218). Reads Mongo `ohlcv_bars` directly — deliberately, and
 * correctly. Coverage/gap detection MUST read the store the bars are WRITTEN to, not the
 * `BARS_BACKEND` read store. `writeBarRevisions` (persist-bars.ts) is still Mongo-primary
 * (Timescale only when `DUAL_WRITE_BARS=true`), so every backfill/poll/emit write lands in Mongo;
 * a gap check against the (read-side) Timescale store would mis-detect coverage and re-fetch the
 * whole universe each cycle. Flipping this site to the `BARS_BACKEND` dispatcher in ISOLATION
 * would CAUSE a re-fetch storm, not fix one. The real defect is the writer/reader store inversion
 * (live config is `BARS_BACKEND=timescale` + `DUAL_WRITE_BARS=false`, so reads dispatch to
 * Timescale while writes stay Mongo); this read moves to dispatch ATOMICALLY with the writer flip
 * — see the follow-up card "writeBarRevisions Timescale-primary". Until then, Mongo IS the write
 * store and reading it here is the consistent choice.
 */
export async function planGapWindows(
  db: Db,
  ticker: string,
  interval: BarInterval,
  startMs: number,
  endMs: number,
  stepMs: number,
  bridgeMs = 0,
): Promise<MissingRange[]> {
  // Floor both bounds onto the step grid so grid points coincide with bar stamps.
  const neededStart = Math.floor(startMs / stepMs) * stepMs;
  const neededEnd   = Math.floor(endMs   / stepMs) * stepMs;

  const { symbol, market } = tickerAdapter.fromT212(ticker);
  const docs = await db
    .collection(COLLECTIONS.OHLCV_BARS)
    .find(
      { symbol, market, interval, is_superseded: false, observation_ts: { $gte: neededStart, $lte: endMs } },
      { projection: { _id: 0, observation_ts: 1 } },
    )
    .toArray();

  const observed: number[] = [];
  for (const d of docs) {
    const ts = (d as { observation_ts?: unknown }).observation_ts;
    if (typeof ts === 'number') observed.push(ts);
  }

  const gaps = computeMissingRanges(observed, neededStart, neededEnd, stepMs);
  return dropClosureGaps(gaps, bridgeMs);
}

/**
 * Backfill 5m history for one or more tickers. Persists to ohlcv_bars (5m, upserted
 * on (ticker, timestamp, interval)) and emits a pubsub message per ticker so the
 * shared-bars cache and any subscribers refresh.
 */
export async function backfillTickers(
  db: Db,
  redis: RedisClientType,
  provider: MarketDataProvider,
  tickers: string[],
  opts: BackfillOpts = {},
): Promise<BackfillResult[]> {
  const windowMs    = opts.windowMs    ?? 60 * 24 * 60 * 60_000;
  const concurrency = opts.concurrency ?? 5;
  const force       = opts.forceRefetch ?? false;
  const endTs       = Date.now();
  const startTs     = endTs - windowMs;

  const results: BackfillResult[] = [];
  for (let i = 0; i < tickers.length; i += concurrency) {
    const slice = tickers.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      slice.map((t) => backfillOne(db, redis, provider, t, startTs, endTs, force)),
    );
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      const t = slice[j];
      if (!r || !t) continue;
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ ticker: t, fetched: 0, upserted: 0, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    }
  }
  return results;
}

async function backfillOne(
  db: Db,
  redis: RedisClientType,
  provider: MarketDataProvider,
  ticker: string,
  startTs: number,
  endTs: number,
  force: boolean,
): Promise<BackfillResult> {
  const interval: BarInterval = '5m';

  // Gap-aware FETCH planning. Unless `force`, fetch only the observation_ts sub-ranges we
  // don't already hold — a fully-covered ticker spends zero upstream calls. The provider
  // paginates each gap window internally. `force` re-fetches the whole window (one call) to
  // repair a suspected-bad span. The write path stays unchanged either way: every fetched
  // bar still flows through the hash-gated, bi-temporal writeBarRevisions.
  let fetchWindows: Array<{ startMs: number; endMs: number }>;
  if (force) {
    fetchWindows = [{ startMs: startTs, endMs: endTs }];
  } else {
    const gaps = await planGapWindows(db, ticker, interval, startTs, endTs, FIVE_MIN_MS, INTRADAY_BRIDGE_MS);
    if (gaps.length === 0) {
      // Fully covered: zero upstream calls, zero credits. Nothing to invalidate either —
      // no new bars, so cached ranges remain valid.
      return { ticker, fetched: 0, upserted: 0 };
    }
    fetchWindows = gaps.map((g) => ({ startMs: g.start, endMs: g.end + FIVE_MIN_MS }));
  }

  const bars = (
    await Promise.all(fetchWindows.map((w) => provider.fetchHistory(ticker, w.startMs, w.endMs)))
  ).flat();
  if (bars.length === 0) return { ticker, fetched: 0, upserted: 0 };

  // Bi-temporal write path: cosmetic re-polls are no-ops (idempotent re-backfill),
  // genuine revisions append a new row with the prior superseded. Replaces the old
  // bulkWrite-upsert which silently overwrote every column on each re-run.
  const stats = await writeBarRevisions(db, bars, interval);
  // `upserted` keeps its old semantics for the admin caller and portal display: count
  // of rows that actually changed something. `skipped` (idempotent) doesn't count.
  // Fall back to fetched count when stats.inserted is zero AND there were no skips —
  // shouldn't happen but mirrors the previous defensive fallback.
  const reported = stats.inserted > 0 ? stats.inserted : (stats.skipped > 0 ? 0 : bars.length);

  // Cache: drop every cached range for this (ticker, 5m). shared-bars repopulates lazily
  // on the next read. Then publish a notification so other services (signal-service'
  // price-lookup cache, portal historical charts) can drop their own derived state.
  await invalidateBars(redis, ticker, '5m');
  try {
    await redis.publish(CACHE_INVALIDATED_TOPIC, JSON.stringify({ ticker, interval, fetched: bars.length, ts: Date.now() }));
  } catch (err) {
    log.warn(`[backfill] pubsub publish failed for ${ticker}:`, err);
  }

  return { ticker, fetched: bars.length, upserted: reported };
}

/**
 * Bootstrap-time check: returns the subset of tickers that have INSUFFICIENT 5m
 * history for the strategy's rolling window.
 *
 * The old behaviour ("tickers with ZERO bars") caused a real production issue:
 * when the universe rotates to include a ticker that has 1-50 stale bars from a
 * previous run, bootstrap treated it as "fine" and never deep-backfilled. The
 * strategy then sees ready=0 for that ticker forever (or until 15h of live polling
 * accumulates enough). Symptom: `ready=0/N` on every strategy cycle despite the
 * pod claiming bootstrap is healthy.
 *
 * `minBars` defaults to 250 (≈ 1 trading day of 5m bars × 3 — enough headroom for
 * the strategy's 60-bar 15m rolling window plus the regime engine's 126-cycle
 * prewarm at intraday cadence). Override per call when bootstrapping a different
 * mode.
 *
 * STORE NOTE (RC4 audit, card 218). Reads Mongo `ohlcv_bars` — correct: this gates a backfill, so
 * it must read the store the bars are WRITTEN to (Mongo, via the still-Mongo-primary
 * `writeBarRevisions`), NOT the `BARS_BACKEND` read store. Moves to dispatch with the writer flip
 * — see `planGapWindows` STORE NOTE + the "writeBarRevisions Timescale-primary" follow-up card.
 */
export async function tickersMissingHistory(
  db: Db,
  tickers: string[],
  minBars = 250,
): Promise<string[]> {
  if (tickers.length === 0) return [];
  const collection = db.collection(COLLECTIONS.OHLCV_BARS);
  // Split each T212 ticker to its (symbol, market) identity (storage key); re-key the grouped
  // result back to the caller's ticker so the returned "missing" list stays in T212 form.
  const ids = tickers.map((t) => ({ ticker: t, ...tickerAdapter.fromT212(t) }));
  const tickerByIdentity = new Map(ids.map((i) => [`${i.symbol}|${i.market}`, i.ticker]));
  // Count only the latest unsuperseded revision per (symbol, market, observation_ts). A name
  // with N first-prints and M revisions has N unsuperseded rows, not N+M — without
  // is_superseded:false the count would inflate after every revision and a brand-new
  // ticker that revised every bar would falsely appear "well-covered".
  const counts = await collection.aggregate([
    { $match: { $or: ids.map((i) => ({ symbol: i.symbol, market: i.market })), interval: '5m', is_superseded: false } },
    { $group: { _id: { symbol: '$symbol', market: '$market' }, count: { $sum: 1 } } },
  ]).toArray();
  const sufficient = new Set(
    counts
      .filter((d: Record<string, unknown>) => (d.count as number) >= minBars)
      .map((d: Record<string, unknown>) => {
        const id = d._id as { symbol: string; market: string };
        return tickerByIdentity.get(`${id.symbol}|${id.market}`);
      })
      .filter((t): t is string => t !== undefined),
  );
  return tickers.filter((t) => !sufficient.has(t));
}

/**
 * Per-cycle self-heal. One Mongo aggregation finds the latest 5m bar per ticker;
 * any ticker whose latest bar is older than `staleThresholdMs` (default 24h —
 * matches fetchRecent's window so we only heal what fetchRecent can't auto-cover)
 * gets a targeted backfill from its latestTs to now.
 *
 * If the gap exceeds the provider's lookback cap (Yahoo: 60 days), the heal call
 * fills what it can and a `bad_ticks{type:'unrecoverable_gap'}` doc is written so
 * an operator can see "this ticker has missing dates and the upstream can't recover
 * them" without grep-ing logs.
 *
 * Steady-state cost when nothing is gapped: one aggregation, zero Yahoo calls.
 *
 * STORE NOTE (RC4 audit, card 218). The latest-bar aggregation reads Mongo `ohlcv_bars` — correct:
 * heal decides what to re-fetch, so it must read the store the bars are WRITTEN to (Mongo, via the
 * still-Mongo-primary `writeBarRevisions`), NOT the `BARS_BACKEND` read store. A heal driven off a
 * stale Timescale read would re-fetch the universe every cycle (credit blowout). Moves to dispatch
 * with the writer flip — see `planGapWindows` STORE NOTE + the "writeBarRevisions Timescale-primary"
 * follow-up card.
 */
export async function healMissingHistory(
  db: Db,
  redis: RedisClientType,
  provider: MarketDataProvider,
  tickers: string[],
  opts: { staleThresholdMs?: number; expectedLatestMs?: number } = {},
): Promise<{ healed: number; barsAdded: number; unrecoverable: number }> {
  if (tickers.length === 0) return { healed: 0, barsAdded: 0, unrecoverable: 0 };
  const stale = opts.staleThresholdMs ?? 24 * 60 * 60_000;
  const now   = Date.now();
  const collection = db.collection(COLLECTIONS.OHLCV_BARS);

  // Session-aware gap detection. When the caller passes `expectedLatestMs` (the most
  // recent session close for the relevant market, from @trader/shared-calendar's
  // expectedLatestBarMs), a ticker is gapped iff its latest bar is older than that —
  // i.e. genuine missing data, not "we paused polling during a closed window". This
  // suppresses ~150 false-positive heals on Monday mornings when every US ticker's
  // latest bar is Friday's close (>64h old by Monday morning) but nothing is actually
  // missing. Without an `expectedLatestMs`, falls back to the flat 24h threshold.
  const isGapped = (latestMs: number): boolean => {
    if (typeof opts.expectedLatestMs === 'number') {
      // 60s grace covers Yahoo late-prints vs the exact close ms.
      return latestMs < opts.expectedLatestMs - 60_000;
    }
    return now - latestMs > stale;
  };

  // Single aggregation: latest unsuperseded observation_ts per (symbol, market) for the 5m series.
  // Names not present in the result have no history at all (handled by bootstrap, not heal — heal
  // trusts that bootstrap ran). is_superseded:false keeps the gap check honest: a revision of a
  // stale bar shouldn't appear as fresh coverage. Split the T212 tickers to identities and re-key
  // the grouped result back to T212 (backfillTickers below takes T212 tickers).
  const ids = tickers.map((t) => ({ ticker: t, ...tickerAdapter.fromT212(t) }));
  const tickerByIdentity = new Map(ids.map((i) => [`${i.symbol}|${i.market}`, i.ticker]));
  const agg = await collection.aggregate([
    { $match: { $or: ids.map((i) => ({ symbol: i.symbol, market: i.market })), interval: '5m', is_superseded: false } },
    { $group: { _id: { symbol: '$symbol', market: '$market' }, latest: { $max: '$observation_ts' } } },
  ]).toArray() as Array<{ _id: { symbol: string; market: string }; latest: number | Date }>;

  const gapped: Array<{ ticker: string; latestMs: number }> = [];
  for (const row of agg) {
    const ticker = tickerByIdentity.get(`${row._id.symbol}|${row._id.market}`);
    if (ticker === undefined) continue;
    // observation_ts is a number; legacy rows pre-migration carried Date. Tolerate both
    // until the migration has run on every existing deployment.
    const latestMs = row.latest instanceof Date ? row.latest.getTime() : Number(row.latest);
    if (isGapped(latestMs)) gapped.push({ ticker, latestMs });
  }
  if (gapped.length === 0) return { healed: 0, barsAdded: 0, unrecoverable: 0 };

  log.warn(`[heal] ${gapped.length} ticker(s) have >${(stale / 3_600_000).toFixed(1)}h gap — backfilling`);

  let barsAdded = 0;
  let unrecoverable = 0;

  // Group tickers by "how much history they need" so the heal calls go out with
  // the right window per ticker (provider truncates internally to maxLookbackMs).
  for (const { ticker, latestMs } of gapped) {
    const requestedWindowMs = now - latestMs;
    const cappedWindowMs    = Math.min(requestedWindowMs, provider.maxLookbackMs);
    const startTs = now - cappedWindowMs;

    // forceRefetch: heal has ALREADY established this ticker is gapped and computed the exact
    // tail window it wants — re-running gap detection inside backfillTickers would be a
    // redundant coverage query AND would change heal's long-standing semantics (it fetches its
    // computed window unconditionally). Forcing keeps the tail-heal path UNCHANGED by the
    // gap-aware retrofit; the gap-aware path governs only bootstrap + the admin backfill.
    const results = await backfillTickers(db, redis, provider, [ticker], { windowMs: cappedWindowMs, forceRefetch: true });
    const upserted = results[0]?.upserted ?? 0;
    barsAdded += upserted;

    if (requestedWindowMs > provider.maxLookbackMs) {
      // Provider truncated. We have new bars from `startTs` forward, but the segment
      // from `latestMs` to `startTs` is gone from upstream history — strategy will
      // see a non-contiguous series for this ticker until someone re-bootstraps from
      // a deeper-history source.
      unrecoverable++;
      try {
        await db.collection(COLLECTIONS.BAD_TICKS).insertOne({
          type: 'unrecoverable_gap',
          ticker,
          gapStartMs: latestMs,
          gapEndMs:   startTs,
          gapDurationMs: startTs - latestMs,
          provider: provider.name,
          providerMaxLookbackMs: provider.maxLookbackMs,
          loggedAt: new Date(),
        });
      } catch (err) {
        log.warn('[heal] failed to log unrecoverable_gap:', err);
      }
      log.warn(`[heal] unrecoverable gap for ${ticker}: ${latestMs} → ${startTs} (${((startTs - latestMs) / 86_400_000).toFixed(1)}d) past provider cap`);
    }
  }

  return { healed: gapped.length, barsAdded, unrecoverable };
}

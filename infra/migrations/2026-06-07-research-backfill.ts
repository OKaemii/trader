/**
 * Research-backfill migration (Task 17 — plan §B / §H / §I). One-shot, idempotent,
 * GAP-AWARE, credit-thrifty. Populates the two Research-surface stores HISTORICALLY so
 * Strategy Impact / Factor Evolution have depth on day one:
 *
 *   - factor_scores       — one source-stamped doc per (ticker, observation_ts) carrying the
 *                           four research factors. Only momentum + volatility (price factors,
 *                           source 'eod') and Value's dividend-yield leg (source 'div') are
 *                           backfillable; Quality and Value's earnings/book leg are forward-only
 *                           and stay {raw:null, pct:null, source:null} — NEVER fabricated (§H).
 *   - held_set_snapshots  — one doc per universe name per cycle, ranked by the historical
 *                           composite (momentum z). No replayed optimiser, so weight 0 /
 *                           selected:false / holding_age 0 — honest per-cycle ranks, never an
 *                           invented holding.
 *
 * SOURCES (EODHD, not Yahoo — §I "Backfill fidelity"):
 *   - Price factors read our OWN bi-temporal persisted daily series (interval:'daily',
 *     is_superseded:false) — already seeded by daily-history.ts under DAILY_HISTORY_PROVIDER=eodhd.
 *     Each historical date computes from the closes whose observation_ts <= that date, so there
 *     is NO look-ahead. A name ABSENT from the daily store falls back to a direct EODHD /eod
 *     fetch (bounded by an in-process credit counter; --force to re-fetch a name we already hold).
 *   - The dividend-yield leg reads the corporate_actions store (one doc per ticker, ex-dated
 *     dividends in BASE units) and divides the trailing-12m dividend-per-share by the UNADJUSTED
 *     daily close (rawClose) at/<= the date — point-in-time, no look-ahead.
 *
 * GAP-AWARE (§I). Per ticker, the dates we ALREADY have a factor_scores row for are detected
 * (one indexed aggregation), missing dates computed via the shared computeMissingRanges grid math,
 * and only the missing dates are (re)computed + written. A fully-covered ticker writes nothing — a
 * second run over covered data writes ~nothing (the §I guarantee). `--force` ignores coverage and
 * re-computes the whole span (repairs a suspected-bad run). The OPT-IN `--fill-missing` pass
 * additionally re-visits existing rows that still carry a null BACKFILLABLE factor (momentum /
 * volatility / value) — a date that lacked enough daily history or a div-yield at first write — so a
 * now-deeper daily-store tail upgrades them in place. (Quality is permanently this-backfill-null and
 * is NOT a fill-missing trigger; a future PIT warehouse upgrades it through its own path.) Writes
 * are upserts keyed on (ticker, observation_ts) — idempotent: a re-run overwrites, never duplicates.
 *
 * CREDIT BUDGET: the only upstream calls are the EODHD /eod fallback for names absent from the
 * daily store, each metered + capped by EODHD_BACKFILL_CALL_LIMIT (default 2000). The bi-temporal
 * daily read + the corporate_actions read are pure Mongo. A second run over covered data makes
 * ZERO upstream calls.
 *
 * RUN (operator-driven — the live backfill is NOT part of CI; CI runs only the unit tests):
 *   MONGODB_URL=mongodb://trader:<pw>@host:27017/trader \
 *   EODHD_API_KEY=<key> \
 *     pnpm tsx infra/migrations/2026-06-07-research-backfill.ts [--force] [--tickers=A,B] \
 *       [--years=5] [--limit-tickers=N]
 *
 *   --force            re-fetch + re-compute covered regions (default: gap-aware skip).
 *   --fill-missing     also re-visit existing rows whose momentum/volatility/value is still null
 *                      (upgrade them once the daily-store tail extends back). Off by default.
 *   --tickers=A,B      restrict to a comma-separated T212 ticker set (default: the active universe).
 *   --years=N          lookback in years (default 5; clamped to the seeded daily history depth).
 *   --limit-tickers=N  process only the first N universe tickers (a small-set dry run).
 *   DRY_RUN=1          compute + log, but do NOT write (a safe rehearsal).
 *
 * See agent-docs/plans/research-trading-os.md §B (Backfill) / §H (entitlements) / §I (gap-aware).
 */

// This is an operator-run CLI migration — console is its output channel (progress + the final
// coverage report the operator reads). Same convention as every sibling migration here.
/* eslint-disable no-console */
import { MongoClient, type Db } from 'mongodb';

import {
  DAY_MS,
  floorToUtcDay,
  planScoreDays,
  dividendYieldAsOf,
  computeCrossSection,
  hasNullSourceFactor,
  type DividendForYield,
  type TickerClosesAsOf,
  type FactorScoreDoc,
  type HeldSetSnapshotDoc,
} from './lib/research-backfill-core.ts';

// Collection names — mirror packages/shared-mongo/src/collections.ts (the cross-service
// contract). Kept as literals so the migration runs with only the mongodb driver.
const COLL_BARS = 'ohlcv_bars';
const COLL_INSTRUMENT_REGISTRY = 'instrument_registry';
const COLL_CORPORATE_ACTIONS = 'corporate_actions';
const COLL_FACTOR_SCORES = 'factor_scores';
const COLL_HELD_SET_SNAPSHOTS = 'held_set_snapshots';

const MONGO_URI = process.env.MONGODB_URL ?? process.env.MONGO_URI ?? 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGODB_DB ?? process.env.MONGO_DB ?? 'trader';
const DRY_RUN = process.env.DRY_RUN === '1';

// The strategy_id stamped on held_set_snapshots — the active research strategy. Overridable so a
// re-run after a strategy switch backfills under the right id.
const STRATEGY_ID = process.env.BACKFILL_STRATEGY_ID ?? 'factor_rank_v1';

// Hard cap on EODHD /eod fallback calls for names absent from the daily store — keeps a one-shot
// backfill well inside the 100k/month plan. Each fetched name is one call.
const EODHD_BACKFILL_CALL_LIMIT = Number(process.env.EODHD_BACKFILL_CALL_LIMIT ?? 2000);
const EODHD_API_KEY = process.env.EODHD_API_KEY ?? '';
const EODHD_BASE = 'https://eodhd.com/api';

// A trailing window of closes large enough to cover 12-1 momentum (252 lookback + 21 skip ~= 273
// trading days) PLUS slack. We slice the as-of closes to this many trading rows per date.
const MOMENTUM_WINDOW_ROWS = 320;

interface Args {
  force: boolean;
  fillMissing: boolean;
  tickers: string[] | null;
  years: number;
  limitTickers: number | null;
}

function parseArgs(argv: string[]): Args {
  let force = false;
  let fillMissing = false;
  let tickers: string[] | null = null;
  let years = 5;
  let limitTickers: number | null = null;
  for (const a of argv) {
    if (a === '--force') force = true;
    else if (a === '--fill-missing') fillMissing = true;
    else if (a.startsWith('--tickers=')) {
      const list = a
        .slice('--tickers='.length)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      tickers = list.length > 0 ? list : null;
    } else if (a.startsWith('--years=')) {
      const n = Number(a.slice('--years='.length));
      if (Number.isFinite(n) && n > 0) years = n;
    } else if (a.startsWith('--limit-tickers=')) {
      const n = Number(a.slice('--limit-tickers='.length));
      if (Number.isFinite(n) && n > 0) limitTickers = Math.floor(n);
    }
  }
  return { force, fillMissing, tickers, years, limitTickers };
}

// ── EODHD /eod fallback — minimal, metered, only for names absent from the daily store ──

// EODHD SYMBOL.EXCHANGE for a T212 ticker (mirror of eodhd-client.toEodhdSymbol's intent: US
// suffix -> .US, LSE l_EQ -> .LSE; default .US for the curated US+LSE universe).
function toEodhdSymbol(t212Ticker: string): string {
  const parts = t212Ticker.split('_');
  const rawSymbol = parts[0] ?? t212Ticker;
  // LSE T212 tickers are 'SYMBOLl_EQ' (trailing lowercase L); strip it for the EODHD base symbol.
  const isLse = parts.length === 2 && parts[1] === 'EQ' && /l$/.test(rawSymbol);
  const base = isLse ? rawSymbol.replace(/l$/, '') : rawSymbol;
  return isLse ? `${base}.LSE` : `${base}.US`;
}

interface DailyClose {
  observation_ts: number; // UTC-midnight ms
  close: number; // total-return adjusted close, BASE units
  rawClose: number; // UNADJUSTED close, BASE units (the div-yield denominator)
}

let eodhdCallsUsed = 0;

/**
 * EODHD /eod daily history for one ticker over [fromMs, toMs], returned oldest-first as
 * {observation_ts, close, rawClose}. Metered: increments the call counter and refuses past the
 * cap (returns []). Degrades to [] on any error / missing key — a backfill must never throw on a
 * single name. close is the total-return adjusted close; rawClose is the unadjusted close, both
 * pence-killed for LSE (÷100) to match the persisted daily series' base units.
 */
async function fetchEodhdDaily(t212Ticker: string, fromMs: number, toMs: number): Promise<DailyClose[]> {
  if (!EODHD_API_KEY) return [];
  if (eodhdCallsUsed >= EODHD_BACKFILL_CALL_LIMIT) return [];
  const symbol = toEodhdSymbol(t212Ticker);
  const priceScale = symbol.endsWith('.LSE') ? 0.01 : 1; // LSE pence -> GBP at the boundary
  const fromIso = new Date(fromMs).toISOString().slice(0, 10);
  const toIso = new Date(toMs).toISOString().slice(0, 10);
  const qs = new URLSearchParams({
    api_token: EODHD_API_KEY,
    fmt: 'json',
    from: fromIso,
    to: toIso,
    period: 'd',
    order: 'a',
  }).toString();
  eodhdCallsUsed++;
  try {
    const res = await fetch(`${EODHD_BASE}/eod/${symbol}?${qs}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) return [];
    const out: DailyClose[] = [];
    for (const r of rows) {
      const obsMs = Date.parse(`${String(r.date ?? '')}T00:00:00Z`);
      const rawClose = Number(r.close);
      const adj = Number(r.adjusted_close);
      if (!Number.isFinite(obsMs) || !(rawClose > 0)) continue;
      const adjClose = Number.isFinite(adj) && adj > 0 ? adj : rawClose;
      out.push({
        observation_ts: obsMs,
        close: adjClose * priceScale,
        rawClose: rawClose * priceScale,
      });
    }
    out.sort((a, b) => a.observation_ts - b.observation_ts);
    return out;
  } catch {
    return [];
  }
}

// ── Mongo reads ─────────────────────────────────────────────────────────────────────────

/** The active universe (instrument_registry, activeTo:null) — the names the backfill scores. */
async function loadActiveUniverse(db: Db): Promise<string[]> {
  const docs = await db
    .collection(COLL_INSTRUMENT_REGISTRY)
    .find({ activeTo: null }, { projection: { _id: 0, ticker: 1 } })
    .toArray();
  const out: string[] = [];
  for (const d of docs) {
    const t = (d as { ticker?: unknown }).ticker;
    if (typeof t === 'string' && t) out.push(t);
  }
  return out.sort();
}

/**
 * One ticker's persisted daily series (live, is_superseded:false) within [fromMs, toMs], oldest
 * first. Reads close + rawClose (the div-yield denominator). Empty when the name isn't seeded.
 */
async function loadDailySeries(db: Db, ticker: string, fromMs: number, toMs: number): Promise<DailyClose[]> {
  const docs = await db
    .collection(COLL_BARS)
    .find(
      { ticker, interval: 'daily', is_superseded: false, observation_ts: { $gte: fromMs, $lte: toMs } },
      { projection: { _id: 0, observation_ts: 1, close: 1, rawClose: 1 } },
    )
    .sort({ observation_ts: 1 })
    .toArray();
  const out: DailyClose[] = [];
  for (const d of docs) {
    const obs = (d as { observation_ts?: unknown }).observation_ts;
    const close = Number((d as { close?: unknown }).close);
    const rawCloseRaw = (d as { rawClose?: unknown }).rawClose;
    if (typeof obs !== 'number' || !(close > 0)) continue;
    // rawClose is absent on legacy/aggregated rows — fall back to close (the div-yield helper still
    // produces a finite ratio; only the adjustment differs). Matches the live host's fallback.
    const rawClose = Number.isFinite(Number(rawCloseRaw)) && Number(rawCloseRaw) > 0 ? Number(rawCloseRaw) : close;
    out.push({ observation_ts: obs, close, rawClose });
  }
  return out;
}

/** Stored ex-dated dividends for one ticker (BASE units) — the div-yield input. Empty when none. */
async function loadDividends(db: Db, ticker: string): Promise<DividendForYield[]> {
  // corporate_actions keys on a string `_id` = ticker (CorporateActionsStore), not an ObjectId.
  const coll = db.collection<{ _id: string; dividends?: unknown }>(COLL_CORPORATE_ACTIONS);
  const doc = await coll.findOne({ _id: ticker });
  const raw = doc?.dividends;
  if (!Array.isArray(raw)) return [];
  const out: DividendForYield[] = [];
  for (const d of raw) {
    const date = (d as { date?: unknown }).date;
    const v = Number((d as { valuePerShare?: unknown }).valuePerShare);
    if (typeof date === 'string' && date && Number.isFinite(v)) out.push({ date, valuePerShare: v });
  }
  return out;
}

/** The observation dates we ALREADY have a factor_scores row for, within [fromDay, toDay]. */
async function loadExistingScoreDays(db: Db, ticker: string, fromDay: number, toDay: number): Promise<number[]> {
  const docs = await db
    .collection(COLL_FACTOR_SCORES)
    .find({ ticker, observation_ts: { $gte: fromDay, $lte: toDay } }, { projection: { _id: 0, observation_ts: 1 } })
    .toArray();
  const out: number[] = [];
  for (const d of docs) {
    const ts = (d as { observation_ts?: unknown }).observation_ts;
    if (typeof ts === 'number') out.push(ts);
  }
  return out;
}

/**
 * The observation dates whose existing factor_scores row still has a null BACKFILLABLE factor
 * (momentum / volatility / value) — the --fill-missing targets. Subset of loadExistingScoreDays;
 * the opt-in --fill-missing pass re-computes these so a newly-seeded daily tail (or a now-present
 * div-yield) upgrades them in place. Quality nulls are excluded by hasNullSourceFactor, so a
 * steady-state row is NOT a target (that keeps the default gap-aware run zero-write).
 */
async function loadFillMissingDays(db: Db, ticker: string, fromDay: number, toDay: number): Promise<number[]> {
  const docs = await db
    .collection(COLL_FACTOR_SCORES)
    .find({ ticker, observation_ts: { $gte: fromDay, $lte: toDay } }, { projection: { _id: 0, observation_ts: 1, factors: 1 } })
    .toArray();
  const out: number[] = [];
  for (const d of docs) {
    const ts = (d as { observation_ts?: unknown }).observation_ts;
    const factors = (d as { factors?: unknown }).factors;
    if (typeof ts === 'number' && factors != null && hasNullSourceFactor({ factors: factors as never })) {
      out.push(ts);
    }
  }
  return out;
}

// ── Writes ────────────────────────────────────────────────────────────────────────────

async function upsertFactorScores(db: Db, docs: FactorScoreDoc[]): Promise<number> {
  if (docs.length === 0 || DRY_RUN) return 0;
  const ops = docs.map((d) => ({
    updateOne: {
      filter: { ticker: d.ticker, observation_ts: d.observation_ts },
      update: { $set: d },
      upsert: true,
    },
  }));
  const res = await db.collection(COLL_FACTOR_SCORES).bulkWrite(ops, { ordered: false });
  return (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
}

async function upsertHeldSetSnapshots(db: Db, docs: HeldSetSnapshotDoc[]): Promise<number> {
  if (docs.length === 0 || DRY_RUN) return 0;
  const ops = docs.map((d) => ({
    updateOne: {
      filter: { strategy_id: d.strategy_id, ticker: d.ticker, observation_ts: d.observation_ts },
      update: { $set: d },
      upsert: true,
    },
  }));
  const res = await db.collection(COLL_HELD_SET_SNAPSHOTS).bulkWrite(ops, { ordered: false });
  return (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
}

async function ensureIndexes(db: Db): Promise<void> {
  // Mirror the index the live writers create (idempotent — Mongo no-ops a matching create).
  await db
    .collection(COLL_FACTOR_SCORES)
    .createIndex({ ticker: 1, observation_ts: -1 }, { name: 'factor_scores_ticker_obs' });
  await db
    .collection(COLL_HELD_SET_SNAPSHOTS)
    .createIndex({ strategy_id: 1, ticker: 1, observation_ts: 1 }, { name: 'held_strategy_ticker_obs' });
  await db
    .collection(COLL_HELD_SET_SNAPSHOTS)
    .createIndex({ strategy_id: 1, observation_ts: 1 }, { name: 'held_strategy_obs' });
}

// ── Per-ticker pipeline: gather as-of series, plan dates, compute cross-section per date ──

interface TickerData {
  ticker: string;
  daily: DailyClose[]; // full series in range, oldest-first
  dividends: DividendForYield[];
  scoreDays: number[]; // the dates this ticker should (re)write a row for
}

/**
 * For a fixed observation date, the as-of closes (only observation_ts <= date, last
 * MOMENTUM_WINDOW_ROWS) + the point-in-time div-yield leg (trailing-12m dividend / rawClose
 * at/<= date) for one ticker. Returns null when the name has neither a usable price series nor a
 * div-yield at this date (nothing honest to record).
 */
function asOfForDate(data: TickerData, observationTs: number): TickerClosesAsOf | null {
  const asOf = data.daily.filter((d) => d.observation_ts <= observationTs);
  const closes = asOf.slice(-MOMENTUM_WINDOW_ROWS).map((d) => d.close);
  const lastRaw = asOf.length > 0 ? asOf[asOf.length - 1]!.rawClose : null;
  const divYield = dividendYieldAsOf(data.dividends, lastRaw, observationTs);
  if (closes.length < 2 && divYield == null) return null;
  return { ticker: data.ticker, closes, divYield };
}

interface Stats {
  tickers: number;
  seededFromStore: number;
  seededFromEodhd: number;
  noHistory: number;
  factorRowsWritten: number;
  heldRowsWritten: number;
  datesComputed: number;
  eodhdCalls: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[research-backfill] mongo=${MONGO_URI.replace(/:[^@/]*@/, ':***@')} db=${DB_NAME} ` +
      `force=${args.force} fillMissing=${args.fillMissing} dryRun=${DRY_RUN} years=${args.years} strategy=${STRATEGY_ID}`,
  );

  const nowMs = Date.now();
  const endDay = floorToUtcDay(nowMs);
  const startDay = floorToUtcDay(nowMs - args.years * 365 * DAY_MS);

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const db = client.db(DB_NAME);
    await ensureIndexes(db);

    let tickers = args.tickers ?? (await loadActiveUniverse(db));
    if (args.limitTickers != null) tickers = tickers.slice(0, args.limitTickers);
    console.log(`[research-backfill] universe: ${tickers.length} tickers`);

    // Phase 1: per ticker, gather the daily series + dividends + the gap-aware date plan. Build a
    // cross-section per observation date that batches every ticker scheduled to write that date.
    const perTicker: TickerData[] = [];
    const stats: Stats = {
      tickers: tickers.length,
      seededFromStore: 0,
      seededFromEodhd: 0,
      noHistory: 0,
      factorRowsWritten: 0,
      heldRowsWritten: 0,
      datesComputed: 0,
      eodhdCalls: 0,
    };

    for (const ticker of tickers) {
      let daily = await loadDailySeries(db, ticker, startDay, endDay);
      if (daily.length === 0) {
        // Absent from the daily store — fall back to a metered EODHD /eod fetch.
        daily = await fetchEodhdDaily(ticker, startDay, endDay);
        if (daily.length > 0) stats.seededFromEodhd++;
      } else if (args.force) {
        // --force on a name we hold: top up from EODHD too, in case the store tail is stale.
        const extra = await fetchEodhdDaily(ticker, startDay, endDay);
        if (extra.length > daily.length) {
          daily = extra;
          stats.seededFromEodhd++;
        } else {
          stats.seededFromStore++;
        }
      } else {
        stats.seededFromStore++;
      }

      if (daily.length === 0) {
        stats.noHistory++;
        console.warn(`[research-backfill] coverage gap: ${ticker} has no daily history in range — skipped`);
        continue;
      }

      const dividends = await loadDividends(db, ticker);

      // Gap-aware date plan: every grid date we don't already have a row for. --force ignores
      // coverage and re-computes the whole span. The OPT-IN --fill-missing pass additionally
      // re-visits existing rows that still carry a null backfillable factor (a date that lacked
      // history/div-yield at first write) so a now-deeper daily-store tail upgrades them in place.
      // Without --fill-missing the default run is purely gap-aware — a fully-covered span writes
      // ~nothing (the §I "second run writes ~nothing" guarantee).
      const existing = args.force ? [] : await loadExistingScoreDays(db, ticker, startDay, endDay);
      const gapDays = planScoreDays(existing, startDay, endDay, args.force);
      const fillMissing =
        args.fillMissing && !args.force ? await loadFillMissingDays(db, ticker, startDay, endDay) : [];
      // The needed date set is constrained to dates the ticker actually has >=1 close at/<=, so we
      // don't write rows before the series starts.
      const earliest = daily[0]!.observation_ts;
      const scoreDays = Array.from(new Set([...gapDays, ...fillMissing]))
        .filter((d) => d >= floorToUtcDay(earliest))
        .sort((a, b) => a - b);

      perTicker.push({ ticker, daily, dividends, scoreDays });
    }

    // Phase 2: invert to date -> tickers, so each date's cross-section z-scores/percentiles span
    // the whole universe at that date (cross-sectional factors are meaningless per-ticker).
    const tickersByDate = new Map<number, TickerData[]>();
    for (const t of perTicker) {
      for (const d of t.scoreDays) {
        let list = tickersByDate.get(d);
        if (!list) {
          list = [];
          tickersByDate.set(d, list);
        }
        list.push(t);
      }
    }

    const dates = Array.from(tickersByDate.keys()).sort((a, b) => a - b);
    console.log(`[research-backfill] dates to compute: ${dates.length} (across ${perTicker.length} seeded tickers)`);

    for (const date of dates) {
      const list = tickersByDate.get(date)!;
      const asOf: TickerClosesAsOf[] = [];
      for (const t of list) {
        const cell = asOfForDate(t, date);
        if (cell) asOf.push(cell);
      }
      if (asOf.length === 0) continue;

      const { factorDocs, heldSetDocs } = computeCrossSection(date, asOf, STRATEGY_ID, nowMs);
      stats.factorRowsWritten += await upsertFactorScores(db, factorDocs);
      stats.heldRowsWritten += await upsertHeldSetSnapshots(db, heldSetDocs);
      stats.datesComputed++;
      if (stats.datesComputed % 100 === 0) {
        process.stdout.write(
          `\r[research-backfill] dates=${stats.datesComputed}/${dates.length} ` +
            `factorRows=${stats.factorRowsWritten} heldRows=${stats.heldRowsWritten} eodhd=${eodhdCallsUsed}`,
        );
      }
    }
    process.stdout.write('\n');

    stats.eodhdCalls = eodhdCallsUsed;
    console.log('[research-backfill] done:');
    console.log(`  tickers:              ${stats.tickers}`);
    console.log(`  seeded (store):       ${stats.seededFromStore}`);
    console.log(`  seeded (EODHD /eod):  ${stats.seededFromEodhd}`);
    console.log(`  no history (skipped): ${stats.noHistory}`);
    console.log(`  dates computed:       ${stats.datesComputed}`);
    console.log(`  factor_scores writes: ${stats.factorRowsWritten}${DRY_RUN ? ' (DRY RUN — not persisted)' : ''}`);
    console.log(`  held_set writes:      ${stats.heldRowsWritten}${DRY_RUN ? ' (DRY RUN — not persisted)' : ''}`);
    console.log(`  EODHD calls used:     ${stats.eodhdCalls} / ${EODHD_BACKFILL_CALL_LIMIT}`);
    if (eodhdCallsUsed >= EODHD_BACKFILL_CALL_LIMIT) {
      console.warn('[research-backfill] WARNING: EODHD call cap hit — some absent names may be unseeded. Re-run to continue.');
    }
    console.log('[research-backfill] complete');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('[research-backfill] FATAL', err);
  process.exit(1);
});

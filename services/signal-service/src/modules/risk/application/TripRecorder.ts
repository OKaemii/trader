import type { Collection, Db } from 'mongodb';
import type { Logger } from '@trader/core';
import type { TradingServiceClient } from '@trader/contracts';
import type { ISignalRepository } from '../../signals/domain/ISignalRepository.ts';
import { SignalLifecycle } from '@trader/shared-types';
import { tickerOf } from '../../../shared/identity.ts';

// Re-derive a T212 ticker label onto a snapshotted signal/position doc, which is keyed on the bare
// (symbol, market) identity since Task 16a. Best-effort: a corrupt market falls back to the bare
// symbol (or a legacy `ticker` field on a pre-migration doc) so the operator post-mortem keeps a
// readable label instead of rendering "—".
function withTickerLabel<T extends Record<string, unknown>>(doc: T): T & { ticker: string } {
  let ticker: string | undefined;
  if (typeof doc.symbol === 'string' && typeof doc.market === 'string') {
    try { ticker = tickerOf(doc.symbol, doc.market); } catch { ticker = undefined; }
  }
  if (!ticker) ticker = typeof doc.ticker === 'string' ? doc.ticker : (typeof doc.symbol === 'string' ? doc.symbol : '');
  return { ...doc, ticker };
}

// One Mongo doc per circuit-breaker trip. Lives in `circuit_breaker_trips`. The
// shape is "lean post-mortem" — enough to reconstruct the moment from the portal
// without exploding doc size:
//   - risk numbers at trip time (the reason the gate fired)
//   - account snapshot (cash + positions in their native currencies)
//   - last 50 signals across all lifecycles (the pipeline state right before drain)
//   - last 20 risk_rejections (prior-history context — were we close to tripping?)
//   - the ids of BUYs the auto-drain cancelled
//
// Strategy-output / OHLCV / factor decomposition are intentionally not snapshotted:
// they're either reconstructable from the existing collections by timestamp, or they
// would balloon the doc size into the hundreds of KB. Add them later if a real trip
// shows the lean snapshot isn't enough.

export interface TripContext {
  reason: 'DAILY_LOSS_HALT' | 'DRAWDOWN_HALT';
  reasonText: string;        // human-readable reason for the portal row
  nav: number;
  hwm: number;
  dayOpenNav: number;
  dailyLossPct: number;
  drawdownPct: number;
}

interface TripDoc {
  id: string;                // ULID-ish "trip_<unix-ms>"; what the portal uses to deep-link
  ts: number;
  reason: TripContext['reason'];
  reasonText: string;
  nav: number;
  hwm: number;
  dayOpenNav: number;
  dailyLossPct: number;
  drawdownPct: number;
  cashSnapshot: unknown;     // raw /internal/trading/cash response shape
  positions: unknown[];      // raw positions docs as stored in `positions`
  recentSignals: unknown[];  // last 50 by timestamp desc
  recentRejections: unknown[]; // last 20 by timestamp desc
  cancelledSignalIds: string[]; // BUYs the auto-drain killed
  cancelledCount: number;
}

export class TripRecorder {
  private readonly trips: Collection<TripDoc>;
  private readonly positions: Collection;
  private readonly rejections: Collection;
  private readonly signals: Collection;

  constructor(
    db: Db,
    private readonly signalRepo: ISignalRepository,
    private readonly trading: TradingServiceClient,
    private readonly logger: Logger,
  ) {
    this.trips      = db.collection<TripDoc>('circuit_breaker_trips');
    this.positions  = db.collection('positions');
    this.rejections = db.collection('risk_rejections');
    this.signals    = db.collection('signals');
  }

  async capture(ctx: TripContext, cancelledSignalIds: string[]): Promise<string> {
    const id = `trip_${Date.now()}`;
    // Every fetch is wrapped — a degraded source mustn't block the trip record from
    // landing in Mongo. The trip itself is the load-bearing event; the snapshot is
    // best-effort context.
    const [cashSnapshot, positionsRaw, recentSignalsRaw, recentRejections] = await Promise.all([
      this.safe(() => this.trading.getCash(), 'cash snapshot'),
      this.safe(() => this.positions.find({}).toArray(), 'positions snapshot'),
      this.safe(() => this.signals.find({}, {
        sort: { timestamp: -1 },
        limit: 50,
        projection: {
          // Storage is keyed on (symbol, market) since Task 16a; project both and re-derive the
          // ticker label below so the post-mortem view stays readable.
          id: 1, symbol: 1, market: 1, action: 1, lifecycle: 1, timestamp: 1, targetWeight: 1,
          confidence: 1, entryPrice: 1, approvedAt: 1, executedAt: 1, failureReason: 1,
          failureDetail: 1, strategy_id: 1, _id: 0,
        },
      }).toArray(), 'recent signals'),
      this.safe(() => this.rejections.find({}, {
        sort: { timestamp: -1 },
        limit: 20,
        projection: { _id: 0 },
      }).toArray(), 'recent rejections'),
    ]);

    // Re-derive a `ticker` label from each snapshotted doc's (symbol, market) so the
    // /risk/trips/:id forensic view renders names, not "—".
    const positions = positionsRaw?.map((d) => withTickerLabel(d as Record<string, unknown>)) ?? null;
    const recentSignals = recentSignalsRaw?.map((d) => withTickerLabel(d as Record<string, unknown>)) ?? null;

    const doc: TripDoc = {
      id,
      ts: Date.now(),
      reason: ctx.reason,
      reasonText: ctx.reasonText,
      nav: ctx.nav,
      hwm: ctx.hwm,
      dayOpenNav: ctx.dayOpenNav,
      dailyLossPct: ctx.dailyLossPct,
      drawdownPct: ctx.drawdownPct,
      cashSnapshot: cashSnapshot ?? null,
      positions: positions ?? [],
      recentSignals: recentSignals ?? [],
      recentRejections: recentRejections ?? [],
      cancelledSignalIds,
      cancelledCount: cancelledSignalIds.length,
    };
    await this.trips.insertOne(doc);
    this.logger.warn({
      tripId: id, reason: ctx.reason, nav: ctx.nav, hwm: ctx.hwm,
      cancelled: cancelledSignalIds.length,
    }, 'circuit-breaker trip recorded');
    return id;
  }

  async list(limit = 50): Promise<TripDoc[]> {
    return this.trips
      .find({}, { projection: { positions: 0, recentSignals: 0, recentRejections: 0, cashSnapshot: 0 } })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
  }

  async findById(id: string): Promise<TripDoc | null> {
    return this.trips.findOne({ id });
  }

  // SignalLifecycle re-exported so route handlers can decode lifecycle ints without
  // depending on the signals module directly.
  static readonly Lifecycle = SignalLifecycle;

  private async safe<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
    try { return await fn(); }
    catch (err) {
      this.logger.warn({ err, label }, 'trip snapshot fetch failed (continuing)');
      return null;
    }
  }
}

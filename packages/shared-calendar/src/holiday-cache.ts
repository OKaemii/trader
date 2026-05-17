// HolidayCache — read-through cache for HolidayTable values.
// Layering: mem → Mongo (`market_calendar` collection) → live HolidayProvider →
// StaticFallbackProvider. Background weekly refresh.
//
// The cache is the only place HolidayTable values come from at runtime. Calendars
// hold a reference and resolve every query through it; tests inject a stub.

import type { Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import type { HolidayTable, Market } from './calendar.ts';

export interface HolidayProvider {
  readonly market: Market;
  fetchYear(year: number): Promise<HolidayTable>;
}

export interface HolidaySourceHealth {
  readonly market: Market;
  readonly lastFetchedAt: number | null;
  readonly source: HolidayTable['source'] | 'never';
  readonly ageMs: number | null;
}

export class HolidayCache {
  private readonly mem = new Map<string, HolidayTable>();
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly providers: Record<Market, HolidayProvider>,
    private readonly fallback: Record<Market, Record<number, HolidayTable>>,
    private readonly refreshIntervalMs: number = 7 * 24 * 3600_000,
  ) {}

  // Read-through: in-memory → Mongo → live provider → static fallback.
  // The first three layers update the next-tier on success; static fallback never
  // writes to Mongo (it's not authoritative).
  async getTable(market: Market, year: number): Promise<HolidayTable> {
    const key = `${market}:${year}`;
    const memHit = this.mem.get(key);
    if (memHit && Date.now() - memHit.fetchedAt < this.refreshIntervalMs) return memHit;

    const mongoHit = await this.db.collection<HolidayTable>(COLLECTIONS.MARKET_CALENDAR)
      .findOne({ market, year });
    if (mongoHit && Date.now() - mongoHit.fetchedAt < this.refreshIntervalMs) {
      // Strip Mongo's _id so downstream type-checks don't see extra fields.
      const clean: HolidayTable = {
        market: mongoHit.market, year: mongoHit.year,
        fullClosures: mongoHit.fullClosures, halfDays: mongoHit.halfDays,
        fetchedAt: mongoHit.fetchedAt, source: mongoHit.source,
      };
      this.mem.set(key, clean);
      return clean;
    }

    try {
      const fresh = await this.providers[market].fetchYear(year);
      await this.db.collection(COLLECTIONS.MARKET_CALENDAR).updateOne(
        { market, year },
        { $set: fresh },
        { upsert: true },
      );
      this.mem.set(key, fresh);
      return fresh;
    } catch (err) {
      console.warn(`[shared-calendar] live fetch failed for ${market} ${year}, falling back:`, err);
      // Both fallback paths stamp `fetchedAt: Date.now()` on the in-memory copy so the
      // negative case is mem-cached for refreshIntervalMs and we don't hammer the dead
      // provider every call. The persisted source field is preserved unchanged so
      // getSourceHealth (which reads from Mongo, not mem) still shows the authentic
      // origin (`cache` for stale-mongo-fallback, `never` for static-fallback-only).
      if (mongoHit) {
        const clean: HolidayTable = {
          market: mongoHit.market, year: mongoHit.year,
          fullClosures: mongoHit.fullClosures, halfDays: mongoHit.halfDays,
          fetchedAt: Date.now(), source: mongoHit.source,
        };
        this.mem.set(key, clean);
        return clean;
      }
      const fb = this.fallback[market]?.[year];
      if (fb) {
        console.warn(`[shared-calendar] using STATIC FALLBACK for ${market} ${year} — live providers + cache both unavailable. Investigate.`);
        const stamped: HolidayTable = { ...fb, fetchedAt: Date.now() };
        this.mem.set(key, stamped);
        return stamped;
      }
      // No fallback for this year either — system has run past the operator-maintained
      // static table. Degrade to "no holidays" (every weekday treated as a session day)
      // rather than throwing, so the gate keeps running. Cost: we'll poll on a holiday
      // and Yahoo will return stale data; harmless. Surfaced as source='never' on the
      // portal so the operator sees it and ships an updated table.
      console.warn(`[shared-calendar] no holiday table for ${market} ${year} — treating year as having no closures. Update the static fallback.`);
      const stub: HolidayTable = {
        market, year,
        fullClosures: [], halfDays: [],
        fetchedAt: Date.now(),
        source: 'static-fallback',
      };
      this.mem.set(key, stub);
      return stub;
    }
  }

  async refreshAll(): Promise<void> {
    const year = new Date().getUTCFullYear();
    for (const market of ['US', 'LSE'] as Market[]) {
      for (const y of [year, year + 1]) {
        try {
          const fresh = await this.providers[market].fetchYear(y);
          await this.db.collection(COLLECTIONS.MARKET_CALENDAR).updateOne(
            { market, year: y },
            { $set: fresh },
            { upsert: true },
          );
          this.mem.set(`${market}:${y}`, fresh);
        } catch (err) {
          console.warn(`[shared-calendar] refresh ${market}/${y} failed (non-fatal):`, err);
        }
      }
    }
  }

  startBackgroundRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      this.refreshAll().catch((err) => console.warn('[shared-calendar] background refresh error:', err));
    }, this.refreshIntervalMs);
    // Don't keep the event loop alive on this timer (graceful shutdown).
    if (typeof this.refreshTimer.unref === 'function') this.refreshTimer.unref();
  }

  stopBackgroundRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // For the portal: per-market last-fetched + source.
  async getSourceHealth(): Promise<HolidaySourceHealth[]> {
    const out: HolidaySourceHealth[] = [];
    const year = new Date().getUTCFullYear();
    for (const market of ['US', 'LSE'] as Market[]) {
      const t = await this.db.collection<HolidayTable>(COLLECTIONS.MARKET_CALENDAR)
        .findOne({ market, year });
      out.push({
        market,
        lastFetchedAt: t?.fetchedAt ?? null,
        source: t?.source ?? 'never',
        ageMs: t?.fetchedAt ? Date.now() - t.fetchedAt : null,
      });
    }
    return out;
  }
}

// Session-aware exchange calendar.
//
// Public API mirrors `exchange_calendars` (Python) / `pandas-market-calendars` so a
// future swap to a library wrapper or a paid feed (Polygon /marketstatus, Bloomberg
// BMC) is a one-file replacement of the HolidayProvider, not a rewrite of consumers.
//
// Used by:
//   - market-data-service pollLoop — gates Yahoo polls on per-market state
//   - market-data-service healMissingHistory — session-aware "is this ticker stale"
//   - portal /market-data/calendar — renders 30-day grid per market
//
// Time-zone handling: opens/closes stored as exchange-local 'HH:MM'. DST is resolved
// at query time via Intl.DateTimeFormat({timeZone}). No precomputed UTC tables, so
// US and UK DST mismatches each spring/autumn (US shifts 2nd Sun Mar, UK last Sun Mar;
// US shifts 1st Sun Nov, UK last Sun Oct) resolve correctly per-date without manual
// intervention.

import type { TickerIdentity } from '@trader/ticker-identity';

import type { HolidayCache } from './holiday-cache.ts';

export type Market = 'US' | 'LSE';

export type MarketState =
  | 'REGULAR'   // inside the liquid-hours window
  | 'PRE'       // before regular open (today is a session day; open hasn't happened yet)
  | 'POST'      // after regular close, within post-close grace window
  | 'CLOSED';   // weekend, holiday, or outside any session window

export interface HalfDay {
  readonly date: string;        // 'YYYY-MM-DD' exchange-local
  readonly closeLocal: string;  // 'HH:MM' exchange-local time
}

export interface HolidayTable {
  readonly market: Market;
  readonly year: number;
  readonly fullClosures: readonly string[];   // 'YYYY-MM-DD' exchange-local
  readonly halfDays:     readonly HalfDay[];
  readonly fetchedAt:    number;              // Unix ms when this table was sourced
  readonly source:       'eodhd' | 'ical' | 'gov-uk' | 'cache' | 'static-fallback';
}

export interface ExchangeCalendar {
  readonly market: Market;
  readonly timezone: 'America/New_York' | 'Europe/London';
  readonly regularOpenLocal:  string;   // 'HH:MM' exchange-local
  readonly regularCloseLocal: string;
  readonly postCloseGraceMs: number;    // how long after close to keep polling
  readonly holidays: HolidayCache;       // attached at boot; mutable so calendars can be
                                          // instantiated before the cache is hydrated
}

// ── Date/time helpers — all explicit about timezone, no Date.toISOString tricks ────

// 'YYYY-MM-DD' for the given instant in the given timezone.
export function formatLocalDate(ms: number, tz: ExchangeCalendar['timezone']): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${d}`;
}

// 0=Sun ... 6=Sat in the given timezone.
export function dayOfWeekIn(ms: number, tz: ExchangeCalendar['timezone']): number {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
    .format(new Date(ms));
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w as 'Sun'] ?? 0;
}

export function yearOf(ms: number, tz: ExchangeCalendar['timezone']): number {
  return parseInt(formatLocalDate(ms, tz).slice(0, 4), 10);
}

// Convert an exchange-local date + HH:MM into a UTC Unix-ms timestamp. The combination
// 'YYYY-MM-DDTHH:MM:00' is interpreted in the given timezone. Implemented by binary-
// searching the inverse: parse the local string, then adjust by the timezone offset at
// that wall-clock moment. Robust across DST transitions (the offset is per-date).
export function localTimeToUtc(
  date: string,                                      // 'YYYY-MM-DD'
  hhmm: string,                                      // 'HH:MM'
  tz: ExchangeCalendar['timezone'],
): number {
  const dateParts = date.split('-').map((s) => parseInt(s, 10));
  const timeParts = hhmm.split(':').map((s) => parseInt(s, 10));
  const year  = dateParts[0] ?? 0;
  const month = dateParts[1] ?? 1;
  const day   = dateParts[2] ?? 1;
  const hour  = timeParts[0] ?? 0;
  const min   = timeParts[1] ?? 0;
  // Start with a UTC guess, then correct by the actual offset for that instant in tz.
  const utcGuess = Date.UTC(year, month - 1, day, hour, min, 0, 0);
  const offsetMs = utcGuess - tzMsAtUtc(utcGuess, tz);
  return utcGuess + offsetMs;
}

// Return what `utcMs` reads as wall-clock-ms in `tz` (i.e. Date.UTC of the local
// year/month/day/hour/min interpreted in that timezone). Used by localTimeToUtc to
// compute the per-instant offset.
function tzMsAtUtc(utcMs: number, tz: ExchangeCalendar['timezone']): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(utcMs));
  const y = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
  const m = parseInt(parts.find((p) => p.type === 'month')!.value, 10);
  const d = parseInt(parts.find((p) => p.type === 'day')!.value, 10);
  let h = parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
  if (h === 24) h = 0;   // Intl quirk: midnight may report as '24'
  const mi = parseInt(parts.find((p) => p.type === 'minute')!.value, 10);
  const s  = parseInt(parts.find((p) => p.type === 'second')!.value, 10);
  return Date.UTC(y, m - 1, d, h, mi, s);
}

// ── Core state-of-market query ────────────────────────────────────────────────

export async function marketStateOf(cal: ExchangeCalendar, nowMs: number): Promise<MarketState> {
  const dow = dayOfWeekIn(nowMs, cal.timezone);
  if (dow === 0 || dow === 6) return 'CLOSED';

  const localDate = formatLocalDate(nowMs, cal.timezone);
  const table = await cal.holidays.getTable(cal.market, yearOf(nowMs, cal.timezone));
  if (table.fullClosures.includes(localDate)) return 'CLOSED';

  const halfDay = table.halfDays.find((h) => h.date === localDate);
  const closeLocal = halfDay ? halfDay.closeLocal : cal.regularCloseLocal;

  const openMs  = localTimeToUtc(localDate, cal.regularOpenLocal, cal.timezone);
  const closeMs = localTimeToUtc(localDate, closeLocal, cal.timezone);

  if (nowMs < openMs)                            return 'PRE';
  if (nowMs < closeMs)                           return 'REGULAR';
  if (nowMs <= closeMs + cal.postCloseGraceMs)   return 'POST';
  return 'CLOSED';
}

// Whether to make an upstream call right now for this market. PRE/POST counted as
// pollable: PRE primes the cache for opening, POST captures the late EOD print.
export async function shouldPollMarket(cal: ExchangeCalendar, nowMs: number): Promise<boolean> {
  const s = await marketStateOf(cal, nowMs);
  return s === 'REGULAR' || s === 'POST' || s === 'PRE';
}

// ── Universe partitioning ─────────────────────────────────────────────────────
//
// Routing is on the canonical identity's `market` field, not the broker string's
// suffix — `TickerIdentity {symbol, market}` is the platform source of truth, and the
// `_US_EQ`/`l_EQ` form is known only to `Trading212TickerAdapter` at the broker boundary
// (Thread A). A caller still holding T212-form strings (the market-data poll loop reads
// the legacy `instrument_registry`) bridges them through `adapter.fromT212` BEFORE calling
// this — that conversion, not a suffix regex here, is where a non-US/LSE form (a CFD, a
// crypto pair) is filtered out (the adapter throws; the caller routes it to its own OTHER
// bucket). So this function sees only tradable US/LSE identities, and the partition keys
// are exactly the two `Market` members — no `OTHER` bucket reaches the calendar.
export function partitionByMarket(
  identities: readonly TickerIdentity[],
): Record<Market, TickerIdentity[]> {
  const out: Record<Market, TickerIdentity[]> = { US: [], LSE: [] };
  for (const id of identities) {
    out[id.market].push(id);
  }
  return out;
}

// ── Next open / next close ───────────────────────────────────────────────────

// Find the next session-open timestamp strictly after `nowMs`. Walks day-by-day up
// to 14 days ahead — covers any plausible holiday cluster. Throws if nothing is
// found (would indicate a calendar bug or year-table exhaustion).
export async function nextOpen(cal: ExchangeCalendar, nowMs: number): Promise<number> {
  // Check today first (e.g. pre-market call): today's open may still be in the future.
  for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
    const probe = nowMs + dayOffset * 86_400_000;
    const localDate = formatLocalDate(probe, cal.timezone);
    const dow = dayOfWeekIn(probe, cal.timezone);
    if (dow === 0 || dow === 6) continue;
    const table = await cal.holidays.getTable(cal.market, yearOf(probe, cal.timezone));
    if (table.fullClosures.includes(localDate)) continue;
    const openMs = localTimeToUtc(localDate, cal.regularOpenLocal, cal.timezone);
    if (openMs > nowMs) return openMs;
  }
  throw new Error(`[shared-calendar] no next open found for ${cal.market} within 14 days of ${new Date(nowMs).toISOString()}`);
}

export async function nextClose(cal: ExchangeCalendar, nowMs: number): Promise<number> {
  for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
    const probe = nowMs + dayOffset * 86_400_000;
    const localDate = formatLocalDate(probe, cal.timezone);
    const dow = dayOfWeekIn(probe, cal.timezone);
    if (dow === 0 || dow === 6) continue;
    const table = await cal.holidays.getTable(cal.market, yearOf(probe, cal.timezone));
    if (table.fullClosures.includes(localDate)) continue;
    const halfDay = table.halfDays.find((h) => h.date === localDate);
    const closeLocal = halfDay ? halfDay.closeLocal : cal.regularCloseLocal;
    const closeMs = localTimeToUtc(localDate, closeLocal, cal.timezone);
    if (closeMs > nowMs) return closeMs;
  }
  throw new Error(`[shared-calendar] no next close found for ${cal.market} within 14 days of ${new Date(nowMs).toISOString()}`);
}

export async function soonestNextOpen(cals: readonly ExchangeCalendar[], nowMs: number): Promise<number> {
  const results = await Promise.all(cals.map((c) => nextOpen(c, nowMs)));
  return Math.min(...results);
}

// ── Session-aware heal threshold ─────────────────────────────────────────────
//
// Returns the timestamp of the most recent session close (or current open's start, if
// we're mid-session) for this market. Used by healMissingHistory to decide whether a
// ticker's latest bar is "really" stale or just "the market hasn't traded since".
//
// Returns null for the pathological case where no session has occurred in the last
// 7 days — heal falls back to its flat 24h threshold.

export async function expectedLatestBarMs(cal: ExchangeCalendar, nowMs: number): Promise<number | null> {
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const probe = nowMs - dayOffset * 86_400_000;
    const localDate = formatLocalDate(probe, cal.timezone);
    const dow = dayOfWeekIn(probe, cal.timezone);
    if (dow === 0 || dow === 6) continue;
    const table = await cal.holidays.getTable(cal.market, yearOf(probe, cal.timezone));
    if (table.fullClosures.includes(localDate)) continue;
    const halfDay = table.halfDays.find((h) => h.date === localDate);
    const closeLocal = halfDay ? halfDay.closeLocal : cal.regularCloseLocal;
    const closeMs = localTimeToUtc(localDate, closeLocal, cal.timezone);
    if (closeMs <= nowMs) return closeMs;
  }
  return null;
}

// ── Per-market EOD poll scheduling ───────────────────────────────────────────
//
// Daily-cadence polling can't use a single shared UTC anchor: no instant has both
// LSE (closes 16:30 London) and NYSE (closes 16:00 New York) freshly closed, so a
// one-anchor grid leaves whichever market closed earlier perpetually unpolled.
// Instead the pollLoop wakes once per market, `offsetMs` into that market's own
// post-close window, and fetches only that market's just-completed session.
//
// nextEodPollInstant mirrors nextClose but returns `close + offsetMs` and tolerates
// being called mid-POST: it returns today's `close + offsetMs` when that instant is
// still in the future (so a pod that boots shortly after a close still polls today's
// session rather than skipping to tomorrow).

export async function nextEodPollInstant(
  cal: ExchangeCalendar,
  offsetMs: number,
  nowMs: number,
): Promise<number> {
  for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
    const probe = nowMs + dayOffset * 86_400_000;
    const localDate = formatLocalDate(probe, cal.timezone);
    const dow = dayOfWeekIn(probe, cal.timezone);
    if (dow === 0 || dow === 6) continue;
    const table = await cal.holidays.getTable(cal.market, yearOf(probe, cal.timezone));
    if (table.fullClosures.includes(localDate)) continue;
    const halfDay = table.halfDays.find((h) => h.date === localDate);
    const closeLocal = halfDay ? halfDay.closeLocal : cal.regularCloseLocal;
    const pollMs = localTimeToUtc(localDate, closeLocal, cal.timezone) + offsetMs;
    if (pollMs > nowMs) return pollMs;
  }
  throw new Error(`[shared-calendar] no next EOD poll instant for ${cal.market} within 14 days of ${new Date(nowMs).toISOString()}`);
}

export async function soonestEodPollInstant(
  cals: readonly ExchangeCalendar[],
  offsetMs: number,
  nowMs: number,
): Promise<number> {
  const results = await Promise.all(cals.map((c) => nextEodPollInstant(c, offsetMs, nowMs)));
  return Math.min(...results);
}

// ── Schedule iteration (for portal calendar grid) ────────────────────────────

export interface ScheduledSession {
  readonly date: string;          // 'YYYY-MM-DD' exchange-local
  readonly market: Market;
  readonly isOpen: boolean;
  readonly isHalfDay: boolean;
  readonly openMs:  number | null;
  readonly closeMs: number | null;
}

// Iterate sessions in [fromMs, toMs] for a calendar. Used by the portal to render the
// 30-day grid. Days are returned even when closed (caller wants the visual marker);
// open/closeMs are null for closed days.
export async function scheduleBetween(
  cal: ExchangeCalendar,
  fromMs: number,
  toMs: number,
): Promise<ScheduledSession[]> {
  if (toMs < fromMs) return [];
  const out: ScheduledSession[] = [];
  for (let dayOffset = 0; ; dayOffset++) {
    const probe = fromMs + dayOffset * 86_400_000;
    if (probe > toMs) break;
    const localDate = formatLocalDate(probe, cal.timezone);
    const dow = dayOfWeekIn(probe, cal.timezone);
    if (dow === 0 || dow === 6) {
      out.push({ date: localDate, market: cal.market, isOpen: false, isHalfDay: false, openMs: null, closeMs: null });
      continue;
    }
    const table = await cal.holidays.getTable(cal.market, yearOf(probe, cal.timezone));
    if (table.fullClosures.includes(localDate)) {
      out.push({ date: localDate, market: cal.market, isOpen: false, isHalfDay: false, openMs: null, closeMs: null });
      continue;
    }
    const halfDay = table.halfDays.find((h) => h.date === localDate);
    const closeLocal = halfDay ? halfDay.closeLocal : cal.regularCloseLocal;
    out.push({
      date: localDate,
      market: cal.market,
      isOpen: true,
      isHalfDay: !!halfDay,
      openMs:  localTimeToUtc(localDate, cal.regularOpenLocal, cal.timezone),
      closeMs: localTimeToUtc(localDate, closeLocal, cal.timezone),
    });
  }
  return out;
}

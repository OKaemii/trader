// Yahoo `quoteSummary(assetProfile)` client — sourcing GICS sectors for the active
// universe. Free, rate-limited (~2k req/hr on the free endpoint), and the sector
// value is stable for months, so we read-through cache via MongoInstrumentMeta and
// only hit Yahoo for cache misses or rows older than `staleMs`.
//
// Ticker conversion (`AAPL_US_EQ` → `AAPL`, `SHELl_EQ` → `SHEL.L`) reuses the
// existing `toYahooSymbol` helper from yahoo-client.ts so we stay one-sourced on
// suffix rules.
import { setTimeout as sleep } from 'node:timers/promises';
import { toYahooSymbol, isBlacklisted } from '../../bars/infrastructure/providers/yahoo-client.ts';
import { log } from '../../../logger.ts';

// Yahoo's `quoteSummary` JSON has many modules; we only consume `assetProfile.sector`.
// Field is camelCase on the wire.
interface AssetProfile {
  sector?:   string;
  industry?: string;
}

interface QuoteSummaryResult {
  quoteSummary?: {
    result?: Array<{ assetProfile?: AssetProfile }> | null;
    error?:  { description?: string } | null;
  };
}

export interface SectorLookup {
  ticker:   string;
  sector:   string;
  industry?: string;
}

export interface YahooSectorClientOptions {
  baseUrl?: string;
  // Total attempts per ticker including the first. Backoff between attempts is
  // RETRY_BACKOFF_MS * attemptNumber so transient errors recover without hammering
  // upstream. Default 3 mirrors the bar-client.
  maxAttempts?:    number;
  retryBackoffMs?: number;
  // Inter-request delay applied between successful tickers — Yahoo's quoteSummary
  // doesn't tolerate bursts well. Default 200ms gives ~5 req/s, well under the
  // soft limits.
  interRequestMs?: number;
  // Optional injected fetch for tests. Defaults to global fetch.
  fetchFn?: typeof fetch;
}

const DEFAULTS: Required<Omit<YahooSectorClientOptions, 'fetchFn'>> = {
  baseUrl:        'https://query2.finance.yahoo.com/v10/finance/quoteSummary',
  maxAttempts:    3,
  retryBackoffMs: 200,
  interRequestMs: 200,
};

export class YahooSectorClient {
  private readonly baseUrl:        string;
  private readonly maxAttempts:    number;
  private readonly retryBackoffMs: number;
  private readonly interRequestMs: number;
  private readonly fetchFn:        typeof fetch;
  // In-memory hit cache across the lifetime of one UniverseManager.refresh. Useful
  // when the same shortName resolves into multiple T212 tickers (cross-listings) so
  // we don't double-fetch the same Yahoo symbol within a single refresh cycle.
  private readonly memo: Map<string, SectorLookup | null> = new Map();

  constructor(opts: YahooSectorClientOptions = {}) {
    this.baseUrl        = opts.baseUrl        ?? DEFAULTS.baseUrl;
    this.maxAttempts    = opts.maxAttempts    ?? DEFAULTS.maxAttempts;
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULTS.retryBackoffMs;
    this.interRequestMs = opts.interRequestMs ?? DEFAULTS.interRequestMs;
    this.fetchFn        = opts.fetchFn        ?? ((globalThis.fetch) as typeof fetch);
  }

  /**
   * Fetch sectors for the given T212 tickers. Returns a partial map — tickers Yahoo
   * doesn't recognise (404), blacklisted symbols, and persistently-failing requests
   * are simply absent from the result. Callers (UniverseManager) treat absence as
   * "leave the existing entry as 'Unknown' and try again next refresh".
   */
  async fetchSectors(tickers: string[]): Promise<Record<string, SectorLookup>> {
    const out: Record<string, SectorLookup> = {};
    for (const ticker of tickers) {
      const result = await this.fetchOne(ticker);
      if (result) out[ticker] = result;
      // Inter-request delay only when we actually hit upstream (memoised results skip).
      await sleep(this.interRequestMs);
    }
    return out;
  }

  /** Single-ticker fetch with the in-memory memo + per-ticker retry/backoff. */
  async fetchOne(ticker: string): Promise<SectorLookup | null> {
    const yahooSymbol = toYahooSymbol(ticker);
    if (isBlacklisted(yahooSymbol)) {
      return null;
    }
    const memoed = this.memo.get(yahooSymbol);
    if (memoed !== undefined) {
      return memoed ? { ...memoed, ticker } : null;
    }

    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const profile = await this.fetchAssetProfile(yahooSymbol);
        if (profile && profile.sector) {
          const result: SectorLookup = {
            ticker,
            sector:    profile.sector,
            ...(profile.industry !== undefined ? { industry: profile.industry } : {}),
          };
          // Memoise by yahoo symbol so cross-listings share the lookup.
          this.memo.set(yahooSymbol, result);
          return result;
        }
        // No sector in payload — Yahoo knows the symbol but doesn't carry sector data.
        // Treat as a soft miss; cache the null so we don't retry within this refresh.
        this.memo.set(yahooSymbol, null);
        return null;
      } catch (err) {
        lastErr = err;
        const isLastAttempt = attempt === this.maxAttempts;
        if (!isLastAttempt) {
          await sleep(this.retryBackoffMs * attempt);
        }
      }
    }
    log.warn(`[yahoo-sector] ${ticker} (${yahooSymbol}): exhausted ${this.maxAttempts} attempts: ${String(lastErr)}`);
    // Don't memoise hard failures — leave room to retry on the next refresh cycle.
    return null;
  }

  /** Raw HTTP call. Returns null on 404 (unknown symbol); throws on other failures. */
  private async fetchAssetProfile(yahooSymbol: string): Promise<AssetProfile | null> {
    const url = `${this.baseUrl}/${encodeURIComponent(yahooSymbol)}?modules=assetProfile`;
    const res = await this.fetchFn(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept:       'application/json',
      },
    });

    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Yahoo quoteSummary ${yahooSymbol}: HTTP ${res.status}`);

    const body = (await res.json()) as QuoteSummaryResult;
    if (body.quoteSummary?.error) {
      throw new Error(`Yahoo quoteSummary ${yahooSymbol}: ${body.quoteSummary.error.description ?? 'error'}`);
    }
    const result = body.quoteSummary?.result?.[0];
    return result?.assetProfile ?? null;
  }
}

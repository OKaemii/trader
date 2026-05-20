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
  // Yahoo `quoteSummary` no longer accepts anonymous requests — every call needs a
  // session cookie + crumb token. Bootstrap: GET seedUrl → collect Set-Cookie →
  // GET crumbUrl with that cookie → response body is the crumb. Both are passed on
  // every subsequent quoteSummary call. Tests override the URLs to stub the flow.
  seedUrl?:  string;
  crumbUrl?: string;
  // Total attempts per ticker including the first. Backoff between attempts is
  // RETRY_BACKOFF_MS * attemptNumber so transient errors recover without hammering
  // upstream. Default 3 mirrors the bar-client.
  maxAttempts?:    number;
  retryBackoffMs?: number;
  // Inter-request delay applied between successful tickers — Yahoo's quoteSummary
  // doesn't tolerate bursts well. Default 200ms gives ~5 req/s, well under the
  // soft limits.
  interRequestMs?: number;
  // How long to skip session-bootstrap attempts after a failed bootstrap. Without
  // this, every ticker would re-trigger seed + crumb requests, hammering Yahoo's
  // anti-abuse layer once the IP is already rate-limited. 15min default matches
  // observed Yahoo cooldown windows; tests pass 0 to disable.
  sessionFailureCooldownMs?: number;
  // Optional injected fetch for tests. Defaults to global fetch.
  fetchFn?: typeof fetch;
}

const DEFAULTS: Required<Omit<YahooSectorClientOptions, 'fetchFn'>> = {
  baseUrl:        'https://query2.finance.yahoo.com/v10/finance/quoteSummary',
  seedUrl:        'https://fc.yahoo.com/',
  crumbUrl:       'https://query2.finance.yahoo.com/v1/test/getcrumb',
  maxAttempts:    3,
  retryBackoffMs: 200,
  interRequestMs: 200,
  sessionFailureCooldownMs: 15 * 60_000,
};

// Yahoo refuses default Node user-agents on the crumb endpoint. Sending a real
// browser UA gets us through; everything else 401s before the cookie is even
// inspected. Same string for the seed + crumb + quoteSummary calls.
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface YahooSession {
  cookie: string;
  crumb:  string;
}

// Extract the Set-Cookie payloads from a fetch Response and collapse them into a
// single `Cookie:` header value (`name=value; name2=value2`). Node 18+ undici
// exposes `getSetCookie()` returning string[]; the fallback handles older runtimes
// + the test path where headers are constructed plainly.
function extractCookieHeader(res: Response): string {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const raw: string[] = typeof h.getSetCookie === 'function'
    ? h.getSetCookie()
    : (() => { const r = res.headers.get('set-cookie'); return r ? [r] : []; })();
  return raw
    .map((c) => c.split(';', 1)[0]?.trim() ?? '')
    .filter(Boolean)
    .join('; ');
}

export class YahooSectorClient {
  private readonly baseUrl:        string;
  private readonly seedUrl:        string;
  private readonly crumbUrl:       string;
  private readonly maxAttempts:    number;
  private readonly retryBackoffMs: number;
  private readonly interRequestMs: number;
  private readonly sessionFailureCooldownMs: number;
  private readonly fetchFn:        typeof fetch;
  // In-memory hit cache across the lifetime of one UniverseManager.refresh. Useful
  // when the same shortName resolves into multiple T212 tickers (cross-listings) so
  // we don't double-fetch the same Yahoo symbol within a single refresh cycle.
  private readonly memo: Map<string, SectorLookup | null> = new Map();
  // Cached session (cookie + crumb). Acquired lazily on first fetchOne; cleared on
  // any 401/403 so the next retry re-acquires.
  private session: YahooSession | null = null;
  // Unix-ms timestamp before which getSession() short-circuits without hitting
  // Yahoo. Set when a bootstrap fails. Without this, every ticker in a 192-ticker
  // batch would re-trigger seed + crumb requests, pinning the IP at the 429 wall.
  private sessionRetryAfter: number = 0;

  constructor(opts: YahooSectorClientOptions = {}) {
    this.baseUrl        = opts.baseUrl        ?? DEFAULTS.baseUrl;
    this.seedUrl        = opts.seedUrl        ?? DEFAULTS.seedUrl;
    this.crumbUrl       = opts.crumbUrl       ?? DEFAULTS.crumbUrl;
    this.maxAttempts    = opts.maxAttempts    ?? DEFAULTS.maxAttempts;
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULTS.retryBackoffMs;
    this.interRequestMs = opts.interRequestMs ?? DEFAULTS.interRequestMs;
    this.sessionFailureCooldownMs = opts.sessionFailureCooldownMs ?? DEFAULTS.sessionFailureCooldownMs;
    this.fetchFn        = opts.fetchFn        ?? ((globalThis.fetch) as typeof fetch);
  }

  // Bootstrap (or return cached) Yahoo session: hit the seed URL to collect a
  // session cookie, then fetch a crumb against the same cookie. Yahoo's anti-abuse
  // layer treats requests without (cookie ∧ crumb) as 401, so this MUST succeed
  // before any quoteSummary call lands.
  //
  // Failure cooldown: a failed bootstrap sets `sessionRetryAfter` so subsequent
  // tickers in the same batch short-circuit (throw immediately) instead of each
  // re-hitting Yahoo. Without this, the 192-ticker enrichment loop sends 192+
  // seed/crumb requests in a row — guaranteed 429.
  private async getSession(): Promise<YahooSession> {
    if (this.session) return this.session;
    const now = Date.now();
    if (now < this.sessionRetryAfter) {
      const waitMs = this.sessionRetryAfter - now;
      throw new Error(`Yahoo session bootstrap: cooldown for another ${Math.ceil(waitMs / 1000)}s after recent failure`);
    }
    try {
      const seedRes = await this.fetchFn(this.seedUrl, {
        headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' },
        redirect: 'manual',   // fc.yahoo.com replies 302; we only need the Set-Cookie on this hop
      });
      const cookie = extractCookieHeader(seedRes);
      if (!cookie) throw new Error(`Yahoo session bootstrap: no Set-Cookie from ${this.seedUrl} (HTTP ${seedRes.status})`);
      const crumbRes = await this.fetchFn(this.crumbUrl, {
        headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', Cookie: cookie },
      });
      if (!crumbRes.ok) throw new Error(`Yahoo crumb fetch: HTTP ${crumbRes.status}`);
      const crumb = (await crumbRes.text()).trim();
      // Yahoo occasionally returns an HTML consent page (EU geo) instead of the bare crumb token.
      // Detect that explicitly so we fail loudly instead of sending '<!DOCTYPE...' as the crumb.
      if (!crumb || crumb.startsWith('<')) throw new Error('Yahoo crumb fetch: empty or non-token response');
      this.session = { cookie, crumb };
      return this.session;
    } catch (err) {
      // Don't keep hammering Yahoo's anti-abuse layer. Mark a cooldown so every
      // subsequent fetchOne in this batch fails fast without sending more requests.
      this.sessionRetryAfter = Date.now() + this.sessionFailureCooldownMs;
      throw err;
    }
  }

  /** Drop the cached session (e.g. after a 401) so the next getSession() re-acquires. */
  private invalidateSession(): void {
    this.session = null;
  }

  /**
   * Fetch sectors for the given T212 tickers. Returns a partial map — tickers Yahoo
   * doesn't recognise (404), blacklisted symbols, and persistently-failing requests
   * are simply absent from the result. Callers (UniverseManager) treat absence as
   * "leave the existing entry as 'Unknown' and try again next refresh".
   */
  async fetchSectors(tickers: string[]): Promise<Record<string, SectorLookup>> {
    const out: Record<string, SectorLookup> = {};
    if (tickers.length === 0) return out;
    // Eager bootstrap. If the session can't be acquired (Yahoo IP rate-limit, EU
    // consent wall, etc.), skip the whole batch instead of iterating 192 tickers
    // and re-tripping the cooldown. UniverseManager treats an empty return as
    // "leave existing sectors as 'Unknown', try again next refresh."
    try {
      await this.getSession();
    } catch (err) {
      log.warn(`[yahoo-sector] session bootstrap failed — skipping ${tickers.length} ticker(s) until next refresh: ${String(err)}`);
      return out;
    }
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
    const sess = await this.getSession();
    const url = `${this.baseUrl}/${encodeURIComponent(yahooSymbol)}?modules=assetProfile&crumb=${encodeURIComponent(sess.crumb)}`;
    const res = await this.fetchFn(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept:       'application/json',
        Cookie:       sess.cookie,
      },
    });

    // 401/403 = session went stale (crumb rotated, cookie expired). Drop it so the
    // outer retry loop's next attempt re-acquires. Throwing keeps the retry path
    // running rather than memoising a permanent miss.
    if (res.status === 401 || res.status === 403) {
      this.invalidateSession();
      throw new Error(`Yahoo quoteSummary ${yahooSymbol}: HTTP ${res.status} (session reset)`);
    }
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

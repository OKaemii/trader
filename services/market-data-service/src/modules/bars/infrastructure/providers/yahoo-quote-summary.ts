// Shared Yahoo `quoteSummary` session — the cookie+crumb bootstrap + a generic module fetch.
// Yahoo refuses anonymous quoteSummary requests: every call needs a session cookie (from a seed
// GET) + a crumb token (fetched against that cookie) + a browser UA. This owns that dance and
// returns the requested modules for a symbol, so callers (fundamentals provider here; the sector
// client is a candidate to converge on this later) don't each re-implement it.

import { setTimeout as sleep } from 'node:timers/promises';

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface YahooSession { cookie: string; crumb: string; }

/** Structural fetcher so consumers can be unit-tested with a stub (no session machinery). */
export interface QuoteSummaryFetcher {
  fetchModules(yahooSymbol: string, modules: string[]): Promise<Record<string, unknown> | null>;
}

export interface YahooQuoteSummaryOptions {
  baseUrl?: string;
  seedUrl?: string;
  crumbUrl?: string;
  maxAttempts?: number;
  retryBackoffMs?: number;
  sessionFailureCooldownMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULTS: Required<Omit<YahooQuoteSummaryOptions, 'fetchFn'>> = {
  baseUrl:        'https://query2.finance.yahoo.com/v10/finance/quoteSummary',
  seedUrl:        'https://fc.yahoo.com/',
  crumbUrl:       'https://query2.finance.yahoo.com/v1/test/getcrumb',
  maxAttempts:    3,
  retryBackoffMs: 200,
  sessionFailureCooldownMs: 15 * 60_000,
};

function extractCookieHeader(res: Response): string {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const raw: string[] = typeof h.getSetCookie === 'function'
    ? h.getSetCookie()
    : (() => { const r = res.headers.get('set-cookie'); return r ? [r] : []; })();
  return raw.map((c) => c.split(';', 1)[0]?.trim() ?? '').filter(Boolean).join('; ');
}

interface QuoteSummaryBody {
  quoteSummary?: {
    result?: Array<Record<string, unknown>> | null;
    error?:  { description?: string } | null;
  };
}

export class YahooQuoteSummary implements QuoteSummaryFetcher {
  private readonly baseUrl:        string;
  private readonly seedUrl:        string;
  private readonly crumbUrl:       string;
  private readonly maxAttempts:    number;
  private readonly retryBackoffMs: number;
  private readonly sessionFailureCooldownMs: number;
  private readonly fetchFn:        typeof fetch;
  private session: YahooSession | null = null;
  private sessionRetryAfter = 0;

  constructor(opts: YahooQuoteSummaryOptions = {}) {
    this.baseUrl        = opts.baseUrl        ?? DEFAULTS.baseUrl;
    this.seedUrl        = opts.seedUrl        ?? DEFAULTS.seedUrl;
    this.crumbUrl       = opts.crumbUrl       ?? DEFAULTS.crumbUrl;
    this.maxAttempts    = opts.maxAttempts    ?? DEFAULTS.maxAttempts;
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULTS.retryBackoffMs;
    this.sessionFailureCooldownMs = opts.sessionFailureCooldownMs ?? DEFAULTS.sessionFailureCooldownMs;
    this.fetchFn        = opts.fetchFn        ?? ((globalThis.fetch) as typeof fetch);
  }

  private async getSession(): Promise<YahooSession> {
    if (this.session) return this.session;
    const now = Date.now();
    if (now < this.sessionRetryAfter) {
      throw new Error(`Yahoo session bootstrap: cooldown for another ${Math.ceil((this.sessionRetryAfter - now) / 1000)}s`);
    }
    try {
      const seedRes = await this.fetchFn(this.seedUrl, { headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' }, redirect: 'manual' });
      const cookie = extractCookieHeader(seedRes);
      if (!cookie) throw new Error(`Yahoo session bootstrap: no Set-Cookie (HTTP ${seedRes.status})`);
      const crumbRes = await this.fetchFn(this.crumbUrl, { headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', Cookie: cookie } });
      if (!crumbRes.ok) throw new Error(`Yahoo crumb fetch: HTTP ${crumbRes.status}`);
      const crumb = (await crumbRes.text()).trim();
      if (!crumb || crumb.startsWith('<')) throw new Error('Yahoo crumb fetch: empty or non-token response');
      this.session = { cookie, crumb };
      return this.session;
    } catch (err) {
      this.sessionRetryAfter = Date.now() + this.sessionFailureCooldownMs;
      throw err;
    }
  }

  private invalidateSession(): void { this.session = null; }

  /** Fetch the requested modules for one symbol. null on 404; throws (after retries) otherwise. */
  async fetchModules(yahooSymbol: string, modules: string[]): Promise<Record<string, unknown> | null> {
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const sess = await this.getSession();
        const url = `${this.baseUrl}/${encodeURIComponent(yahooSymbol)}?modules=${encodeURIComponent(modules.join(','))}&crumb=${encodeURIComponent(sess.crumb)}`;
        const res = await this.fetchFn(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', Cookie: sess.cookie } });
        if (res.status === 401 || res.status === 403) { this.invalidateSession(); throw new Error(`Yahoo quoteSummary ${yahooSymbol}: HTTP ${res.status} (session reset)`); }
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`Yahoo quoteSummary ${yahooSymbol}: HTTP ${res.status}`);
        const body = (await res.json()) as QuoteSummaryBody;
        if (body.quoteSummary?.error) throw new Error(`Yahoo quoteSummary ${yahooSymbol}: ${body.quoteSummary.error.description ?? 'error'}`);
        return body.quoteSummary?.result?.[0] ?? null;
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxAttempts) await sleep(this.retryBackoffMs * attempt);
      }
    }
    throw lastErr ?? new Error(`Yahoo quoteSummary ${yahooSymbol}: failed`);
  }
}

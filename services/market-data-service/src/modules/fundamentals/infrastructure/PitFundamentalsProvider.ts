// PIT fundamentals provider — sources the QMJ line items for US (*_US_EQ) names from the
// bi-temporal SEC-EDGAR warehouse via fundamentals-api, instead of Yahoo's forward-only snapshot.
// This is the market-data-service side of retiring Yahoo for US: the *live strategy* seam already
// routes US to the warehouse; this migrates the SEPARATE Yahoo QMJ surface (the company_fundamentals
// snapshot the scanner shows + the strategy's Yahoo fallback reads via /internal/api/fundamentals).
//
// Routing, by T212 suffix:
//   - US (*_US_EQ)  → fundamentals-api GET /internal/api/fundamentals-pit?tickers=&asOf=<now ms>
//                     (in-cluster, FUNDAMENTALS_API_URL, internal JWT minted as `market-data-service`).
//   - non-US (LSE *l_EQ, anything else) → the injected Yahoo provider (no EDGAR for non-US).
//
// FALL-BACK to Yahoo is the safety net on three paths, so the QMJ screen never breaks while coverage
// is still being proven complete:
//   1. non-US names (never had a US warehouse fact),
//   2. a US name the warehouse has no fact for ≤ now (a PIT *miss* — the resolver returns it with an
//      empty line-item dict + null source), and
//   3. a hard fundamentals-api outage / non-200 / malformed payload (degrade, never throw).
// The flip to FUNDAMENTALS_PROVIDER=pit is gated (a later card) on the freshness audit proving US
// coverage; until then, and on any miss, Yahoo still answers — availability, not a silent dependency.

import { mintInternalJwt } from '@trader/shared-auth';
import type { FundamentalsProvider, FundamentalsRaw } from './FundamentalsProvider.ts';
import { log } from '../../../logger.ts';

// The 6 QMJ inputs are stored in the warehouse as canonical snake_case `LINE_ITEMS`
// (quant_core.fundamentals.contract) and surfaced verbatim by fundamentals-api's resolver; the
// market-data QMJ screen wants camelCase `FundamentalsRaw`. Missing items default to 0 downstream,
// which keeps the screen fail-closed (a zero denominator => excluded, never a false PASS) — the same
// contract YahooFundamentalsProvider honours.
type PitPayload = Record<string, unknown>;

const CALLER = 'market-data-service';

/** Per-name source stamp the provider decided on the most recent fetch. */
export const SOURCE_PIT_EDGAR = 'pit-edgar';
export const SOURCE_YAHOO = 'yahoo';

/** US (NYSE/NASDAQ) names carry the `_US_EQ` T212 suffix; everything else is non-US for routing. */
function isUsTicker(ticker: string): boolean {
  return /_US_EQ$/i.test(ticker);
}

/** Parse a fundamentals-api numeric line item; a null/non-finite value is treated as absent. */
function num(node: unknown): number | undefined {
  if (typeof node === 'number') return Number.isFinite(node) ? node : undefined;
  if (typeof node === 'string') {
    const n = Number(node);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * A PIT payload is a "hit" only when it carries a `source` (a covered, resolved name). The resolver
 * returns an *unresolved/miss* name present with `source: null` and an empty line-item dict — that
 * must fall back to Yahoo, not be mapped to an all-zero (fail-closed) FundamentalsRaw that hides the
 * gap from the scanner. (Same "empty line items ⇒ let it fall back" contract as the strategy seam.)
 */
function isPitHit(payload: PitPayload | undefined): payload is PitPayload {
  return payload != null && typeof payload === 'object' && typeof payload.source === 'string';
}

/** Map a covered name's snake_case PIT payload onto camelCase `FundamentalsRaw` (missing ⇒ 0). */
function toFundamentalsRaw(payload: PitPayload): FundamentalsRaw {
  return {
    netIncome:          num(payload.net_income) ?? 0,
    totalEquity:        num(payload.total_equity) ?? 0,
    totalDebt:          num(payload.total_debt) ?? 0,
    currentAssets:      num(payload.current_assets) ?? 0,
    currentLiabilities: num(payload.current_liabilities) ?? 0,
    marketCapGbp:       num(payload.market_cap_gbp) ?? 0,
  };
}

export class PitFundamentalsProvider implements FundamentalsProvider {
  // Per-ticker source decided on the most recent fetch (`pit-edgar` for a warehouse hit, `yahoo` for
  // a non-US name / PIT miss / outage fall-back). Lets the scanner show the honest per-name source.
  private readonly lastSources = new Map<string, string>();

  constructor(
    private readonly yahoo: FundamentalsProvider,
    private readonly baseUrl: string,
    // Injected for tests; defaults to the global fetch. Mint is injected likewise so the JWT path is
    // exercised without a live signer dependency in unit tests.
    private readonly fetcher: typeof fetch = fetch,
    private readonly mintToken: (caller: string) => Promise<string> = mintInternalJwt,
    private readonly timeoutMs = 10_000,
  ) {}

  /** The source (`pit-edgar` | `yahoo`) the last fetch resolved this ticker from; undefined if unseen. */
  sourceOf(ticker: string): string | undefined {
    return this.lastSources.get(ticker);
  }

  async fetch(tickers: string[]): Promise<Record<string, FundamentalsRaw>> {
    if (tickers.length === 0) return {};
    const usNames  = tickers.filter(isUsTicker);
    const nonUs    = tickers.filter((t) => !isUsTicker(t));

    const out: Record<string, FundamentalsRaw> = {};

    // 1. US slice → PIT warehouse (as-of now). A hit is mapped + stamped `pit-edgar`; misses are
    //    collected and folded into the Yahoo fall-back below.
    const pitMisses: string[] = [];
    if (usNames.length > 0) {
      const pit = await this.fetchPit(usNames);
      for (const ticker of usNames) {
        const payload = pit[ticker];
        if (isPitHit(payload)) {
          out[ticker] = toFundamentalsRaw(payload);
          this.lastSources.set(ticker, SOURCE_PIT_EDGAR);
        } else {
          pitMisses.push(ticker);
        }
      }
    }

    // 2. non-US names + US PIT misses → the injected Yahoo provider (the fall-back). Tickers Yahoo
    //    also can't resolve are absent from its result (the existing best-effort contract).
    const yahooNames = [...nonUs, ...pitMisses];
    if (yahooNames.length > 0) {
      const fallback = await this.yahoo.fetch(yahooNames);
      for (const ticker of yahooNames) {
        if (fallback[ticker] !== undefined) {
          out[ticker] = fallback[ticker];
          this.lastSources.set(ticker, SOURCE_YAHOO);
        }
      }
    }

    return out;
  }

  /**
   * One round-trip to fundamentals-api for the whole US slice. Returns the per-ticker payload map
   * (`{ ticker: { <line items>, source, observation_ts, knowledge_ts } }`). NEVER throws: any
   * transport error, non-2xx, timeout, or malformed body degrades to `{}` so the whole US slice
   * falls back to Yahoo — the screen must not break on a research-fundamentals service being down.
   */
  private async fetchPit(usNames: string[]): Promise<Record<string, PitPayload>> {
    const asOf = Date.now();
    const url = `${this.baseUrl.replace(/\/$/, '')}/internal/api/fundamentals-pit`
      + `?tickers=${encodeURIComponent(usNames.join(','))}&asOf=${asOf}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const token = await this.mintToken(CALLER);
      const res = await this.fetcher(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      // A cold warehouse answers 503; any non-2xx (incl. 403 if the route ever adds a caller
      // allow-list) degrades the whole US slice to Yahoo rather than surfacing a broken screen.
      if (!res.ok) {
        log.warn(`[fundamentals/pit] fundamentals-api ${res.status} — falling back to Yahoo for ${usNames.length} US name(s)`);
        return {};
      }
      const body = (await res.json()) as { fundamentals?: unknown };
      const fundamentals = body?.fundamentals;
      // A structurally-malformed-but-JSON-valid payload also degrades to {} (don't trust the upstream
      // shape never regresses) — exactly the strategy seam's "parse failure ⇒ {}" contract.
      if (!fundamentals || typeof fundamentals !== 'object') return {};
      return fundamentals as Record<string, PitPayload>;
    } catch (err) {
      log.warn(`[fundamentals/pit] read failed (degrading to Yahoo fallback): ${err instanceof Error ? err.message : String(err)}`);
      return {};
    } finally {
      clearTimeout(timer);
    }
  }
}

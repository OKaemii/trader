// PIT fundamentals provider — sources the QMJ line items for US (*_US_EQ) names from the per-CIK
// SEC-EDGAR Parquet lake via fundamentals-api, instead of Yahoo's forward-only snapshot. This is the
// market-data-service side of the platform-wide Yahoo removal (epic pit-fundamentals-lake-
// rearchitecture, Thread C + decision H): the live strategy seam already reads the lake; this is the
// SEPARATE QMJ surface (the company_fundamentals snapshot the scanner shows + the strategy's
// /internal/api/fundamentals reader).
//
// Routing, by the bare-identity market (resolved through the Trading212TickerAdapter):
//   - US (market 'US')  → fundamentals-api GET /internal/api/fundamentals-pit?tickers=&asOf=<now ms>
//                         (in-cluster, FUNDAMENTALS_API_URL, internal JWT minted as `market-data-service`).
//   - non-US (LSE, anything else) → FAIL-CLOSED: no fundamentals (no EDGAR for them, no Yahoo
//                         substitute). The name is simply absent from the result.
//
// FAIL-CLOSED, no fallback. Three paths yield "no fundamentals for this name" (absent from the map):
//   1. a non-US name (never had a US EDGAR fact);
//   2. a US name the lake has no fact for ≤ now (a PIT *miss* — the resolver returns it with an empty
//      line-item dict + null source);
//   3. a hard fundamentals-api outage / non-200 / malformed payload (the whole US slice degrades to
//      "no fundamentals" — logged, never thrown).
// A name with no fundamentals gets no company_fundamentals doc, so the scanner / Research render it
// `source: null` / `—` — honest "not covered", never a fabricated value and never a silent Yahoo read.

import { mintInternalJwt } from '@trader/shared-auth';
import type { FundamentalsProvider, FundamentalsRaw } from './FundamentalsProvider.ts';
import { tryIdentityOf } from '../../../shared/identity.ts';
import { log } from '../../../logger.ts';

// The line items are stored in the lake as canonical snake_case `LINE_ITEMS`
// (quant_core.fundamentals.contract) and surfaced verbatim by fundamentals-api's resolver; the
// market-data QMJ screen wants camelCase `FundamentalsRaw`. A missing QMJ input defaults to 0,
// which keeps the screen fail-closed (a zero denominator => excluded, never a false PASS).
// `marketCapGbp` (a display field, not a QMJ input) is the lone exception: an absent computed cap is
// carried as `null`, never a fabricated £0.
type PitPayload = Record<string, unknown>;

const CALLER = 'market-data-service';

/** The only source stamp this provider emits (a covered US lake hit). Non-US / misses get no doc. */
export const SOURCE_PIT_EDGAR = 'pit-edgar';

/** US (NYSE/NASDAQ) names route to the lake; non-US fail-closed. Routed via the identity adapter. */
function isUsTicker(ticker: string): boolean {
  return tryIdentityOf(ticker)?.market === 'US';
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
 * returns an *unresolved/miss* name present with `source: null` and an empty line-item dict — that is
 * FAIL-CLOSED (omitted), not mapped to an all-zero FundamentalsRaw that would hide the gap from the
 * scanner. (Same "empty line items ⇒ no fundamentals" contract as the strategy seam.)
 */
function isPitHit(payload: PitPayload | undefined): payload is PitPayload {
  return payload != null && typeof payload === 'object' && typeof payload.source === 'string';
}

// Map a covered name's snake_case PIT payload onto camelCase `FundamentalsRaw`. The five QMJ inputs
// default a missing item to 0 (fail-closed — a zero denominator excludes the name, never a false
// PASS). `marketCapGbp` is NOT a QMJ input and 0 is never a real cap, so an absent computed cap is
// carried as `null` (renders `—` on the scanner / Research, not a fabricated £0). The resolver omits
// `market_cap_gbp` only when the cap is genuinely uncomputable (shares absent, or a pre-data as-of) —
// exactly the cases that should display `—`, not £0.
function toFundamentalsRaw(payload: PitPayload): FundamentalsRaw {
  return {
    netIncome:          num(payload.net_income) ?? 0,
    totalEquity:        num(payload.total_equity) ?? 0,
    totalDebt:          num(payload.total_debt) ?? 0,
    currentAssets:      num(payload.current_assets) ?? 0,
    currentLiabilities: num(payload.current_liabilities) ?? 0,
    marketCapGbp:       num(payload.market_cap_gbp) ?? null,
  };
}

export class PitFundamentalsProvider implements FundamentalsProvider {
  // Per-ticker source decided on the most recent fetch — only ever `pit-edgar` (a covered US lake
  // hit). A non-US name / PIT miss / outage is absent from the result and unstamped, so the scanner
  // surfaces it as `source: null` (the cache writes no doc for it).
  private readonly lastSources = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    // Injected for tests; defaults to the global fetch. Mint is injected likewise so the JWT path is
    // exercised without a live signer dependency in unit tests.
    private readonly fetcher: typeof fetch = fetch,
    private readonly mintToken: (caller: string) => Promise<string> = mintInternalJwt,
    private readonly timeoutMs = 10_000,
  ) {}

  /** The source (`pit-edgar`) the last fetch resolved this ticker from; undefined if unseen/uncovered. */
  sourceOf(ticker: string): string | undefined {
    return this.lastSources.get(ticker);
  }

  async fetch(tickers: string[]): Promise<Record<string, FundamentalsRaw>> {
    if (tickers.length === 0) return {};
    const usNames = tickers.filter(isUsTicker);

    const out: Record<string, FundamentalsRaw> = {};

    // US slice → PIT lake (as-of now). A hit is mapped + stamped `pit-edgar`; a miss is fail-closed
    // (omitted). Non-US names are never sent and never appear in the result. A whole-slice outage
    // degrades the US slice to "no fundamentals" (fetchPit returns {}), never throws.
    if (usNames.length > 0) {
      const pit = await this.fetchPit(usNames);
      for (const ticker of usNames) {
        const payload = pit[ticker];
        if (isPitHit(payload)) {
          out[ticker] = toFundamentalsRaw(payload);
          this.lastSources.set(ticker, SOURCE_PIT_EDGAR);
        }
        // else: PIT miss → fail-closed (no doc, scanner shows source:null). No fallback.
      }
    }

    return out;
  }

  /**
   * One round-trip to fundamentals-api for the whole US slice. Returns the per-ticker payload map
   * (`{ ticker: { <line items>, source, observation_ts, knowledge_ts } }`). NEVER throws: any
   * transport error, non-2xx, timeout, or malformed body degrades to `{}` so the whole US slice
   * fail-closes to "no fundamentals" — the screen must not break on a research-fundamentals service
   * being down (and there is no Yahoo fallback to mask it).
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
      // A cold lake answers 503; any non-2xx (incl. 403 if the route ever adds a caller allow-list)
      // fail-closes the whole US slice rather than surfacing a broken screen.
      if (!res.ok) {
        log.warn(`[fundamentals/pit] fundamentals-api ${res.status} — no fundamentals for ${usNames.length} US name(s) this refresh`);
        return {};
      }
      const body = (await res.json()) as { fundamentals?: unknown };
      const fundamentals = body?.fundamentals;
      // A structurally-malformed-but-JSON-valid payload also degrades to {} (don't trust the upstream
      // shape never regresses) — exactly the strategy seam's "parse failure ⇒ {}" contract.
      if (!fundamentals || typeof fundamentals !== 'object') return {};
      return fundamentals as Record<string, PitPayload>;
    } catch (err) {
      log.warn(`[fundamentals/pit] read failed (fail-closed, no fallback): ${err instanceof Error ? err.message : String(err)}`);
      return {};
    } finally {
      clearTimeout(timer);
    }
  }
}

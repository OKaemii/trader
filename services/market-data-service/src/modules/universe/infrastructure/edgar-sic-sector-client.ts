// EDGAR-SIC sector client — the SECONDARY sector source for the active universe (epic
// pit-fundamentals-lake-rearchitecture, Thread C / Task 19). Sources a GICS-style sector label per
// US (`*_US_EQ`) name from the PIT-fundamentals lake's `entities.parquet` SIC, via fundamentals-api's
// in-cluster `GET /internal/api/fundamentals-pit/sectors` route. Replaces the deleted Yahoo
// `quoteSummary(assetProfile)` sector client.
//
// WHERE IT FITS. The PRIMARY sector source under the live `eodhd_scan` universe is the EODHD screener
// row (free, attached at scan time in UniverseManager.selectFromEodhdScan — no network here). THIS
// client is the secondary for the CURATED/US path (and any US name the screener didn't sector): the
// SIC is mapped to a GICS-style label (sic_sector.py) so it counts into the SAME 35%-per-sector cap
// bucket as the EODHD labels. A non-US name has no EDGAR presence and is never sent.
//
// GRACEFUL, NEVER REQUIRED. The lake's `entities.parquet` fills in over harvester sweeps, so it may be
// absent/partial right now — every failure mode degrades to an empty map (the caller leaves those
// names 'Unknown', cap-exempt, and retries next refresh):
//   1. a non-US name (filtered out before the call — no EDGAR);
//   2. a name the lake has no CIK/entity row for yet (omitted by the route — a partial lake);
//   3. a name whose SIC maps to no sector band (omitted by the route);
//   4. a fundamentals-api outage / non-200 / 503 cold-lake / malformed body (the whole slice → {}).
// Never throws into refresh() — a broken/cold fundamentals-api can't stall the universe build (the same
// resilience contract the Yahoo client had, minus Yahoo's session/crumb/cooldown machinery).

import { mintInternalJwt } from '@trader/shared-auth';
import { tryIdentityOf } from '../../../shared/identity.ts';
import { log } from '../../../logger.ts';

const CALLER = 'market-data-service';

export interface EdgarSicSectorClientOptions {
  // In-cluster base URL of fundamentals-api (FUNDAMENTALS_API_URL, default http://fundamentals-api:8011).
  baseUrl: string;
  // Total wall-clock budget for the call. The universe build wraps this in its own withTimeout too;
  // this is the per-call abort so a hung socket can't pin the slice. Default 25s mirrors the universe's
  // SECTOR_FETCH_TIMEOUT_MS so the inner abort never fires before the outer guard.
  timeoutMs?: number;
  // Injected for tests; default the global fetch + the real internal-JWT signer.
  fetchFn?: typeof fetch;
  mintToken?: (caller: string) => Promise<string>;
}

interface SectorsResponse {
  sectors?: Record<string, string>;
}

/** US (NYSE/NASDAQ) names route to the lake SIC; non-US has no EDGAR presence. Routed via the identity
 *  adapter (the same predicate PitFundamentalsProvider uses), so an `OTHER`/malformed ticker is dropped. */
function isUsTicker(ticker: string): boolean {
  return tryIdentityOf(ticker)?.market === 'US';
}

export class EdgarSicSectorClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly mintToken: (caller: string) => Promise<string>;

  constructor(opts: EdgarSicSectorClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 25_000;
    this.fetchFn = opts.fetchFn ?? ((globalThis.fetch) as typeof fetch);
    this.mintToken = opts.mintToken ?? mintInternalJwt;
  }

  /**
   * Fetch GICS-style sector labels for the given T212 tickers. Returns a PARTIAL `ticker → sector` map —
   * only the US names the lake could sector are present; non-US names (never sent), uncovered names, and
   * unmapped SICs are simply absent. Callers treat absence as "leave the existing sector as 'Unknown',
   * try again next refresh". One round-trip for the whole US slice; NEVER throws (any failure → {}).
   */
  async fetchSectors(tickers: string[]): Promise<Record<string, string>> {
    if (tickers.length === 0) return {};
    // Only US names have an EDGAR SIC; filter before the call so non-US names never hit the route.
    const usNames = tickers.filter(isUsTicker);
    if (usNames.length === 0) return {};

    const url = `${this.baseUrl}/internal/api/fundamentals-pit/sectors`
      + `?symbols=${encodeURIComponent(usNames.join(','))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const token = await this.mintToken(CALLER);
      const res = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      // A cold lake answers 503; any non-2xx fail-soft degrades the whole slice to "no EDGAR sectors"
      // (the universe leaves those names 'Unknown' and retries next refresh) — never a thrown refresh.
      if (!res.ok) {
        log.warn(`[edgar-sic-sector] fundamentals-api ${res.status} — no EDGAR sectors for ${usNames.length} US name(s) this refresh`);
        return {};
      }
      const body = (await res.json()) as SectorsResponse;
      const sectors = body?.sectors;
      if (!sectors || typeof sectors !== 'object') return {};
      // Keep only string sector values (defensive against an upstream shape regression).
      const out: Record<string, string> = {};
      for (const [ticker, sector] of Object.entries(sectors)) {
        if (typeof sector === 'string' && sector.trim() !== '') out[ticker] = sector;
      }
      return out;
    } catch (err) {
      log.warn(`[edgar-sic-sector] read failed (fail-soft, no sectors this refresh): ${err instanceof Error ? err.message : String(err)}`);
      return {};
    } finally {
      clearTimeout(timer);
    }
  }
}

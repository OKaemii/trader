import { setTimeout as sleep } from 'node:timers/promises';
import type { OHLCVBar } from '@trader/shared-types';
import { log } from '../../../logger.ts';

export interface T212Credentials {
    apiKey: string;
    apiKeyId: string;
    /** true → live.trading212.com, false → demo.trading212.com */
    live: boolean;
}

// Module-scope credentials, set once at bootstrap by configureT212Client(). Kept module-local
// (rather than threaded through every export) because every consumer in market-data-service
// is in the same process boundary; passing creds through every fetch helper would obscure
// the hot path.
let _creds: T212Credentials | null = null;

export function configureT212Client(creds: T212Credentials): void {
    _creds = creds;
}

function t212Base(): string {
    if (!_creds) throw new Error('t212-client: configureT212Client() must be called at boot');
    return _creds.live
        ? 'https://live.trading212.com/api/v0'
        : 'https://demo.trading212.com/api/v0';
}

function t212Auth(): string {
    if (!_creds) throw new Error('t212-client: configureT212Client() must be called at boot');
    return 'Basic ' + Buffer.from(`${_creds.apiKeyId}:${_creds.apiKey}`).toString('base64');
}

export async function fetchT212Prices(tickers: string[]): Promise<OHLCVBar[]> {
    const headers = { Authorization: t212Auth() };
    const now = Date.now();

    const results = await Promise.allSettled(
        tickers.map(async (ticker) => {
            const res = await fetch(
                `${t212Base()}/equity/history/orders?ticker=${ticker}&limit=1`,
                { headers },
            );
            if (!res.ok) throw new Error(`T212 ${ticker}: ${res.status}`);
            const data = await res.json();
            return mapT212ToBar(ticker, data, now);
        }),
    );

    return results
        .filter((r): r is PromiseFulfilledResult<OHLCVBar> => r.status === 'fulfilled')
        .map((r) => r.value);
}

function mapT212ToBar(ticker: string, data: unknown, ts: number): OHLCVBar {
    // T212 returns current quote; OHLCV approximation for MVP
    const quote = (data as { items: Array<{ fillPrice: number }> }).items?.[0];
    const price = quote?.fillPrice ?? 0;
    return {
        ticker,
        observation_ts: ts,
        timestamp:      ts,
        open: price, high: price, low: price, close: price, volume: 0,
    };
}

export interface T212Instrument {
    ticker: string;
    name: string;
    shortName?: string;
    currencyCode?: string;
    type?: string;
    sector?: string;
}

// Bound each instruments fetch. T212's endpoint can hold the connection open with no
// response (no 429, no body) when the IP is throttled; without an abort, a hung fetch
// stalls UniverseManager.refresh() and thus the entire poll loop (2026-05 incident:
// market:raw went stale for days because refresh() never returned past this call).
const T212_FETCH_TIMEOUT_MS = 15_000;

export async function fetchT212Instruments(): Promise<T212Instrument[]> {
    const headers = { Authorization: t212Auth() };
    // Retry with exponential backoff — 429s accumulate when pods restart frequently during debugging.
    for (let attempt = 0; attempt < 3; attempt++) {
        const ctrl = new AbortController();
        const abortTimer = setTimeout(() => ctrl.abort(), T212_FETCH_TIMEOUT_MS);
        let res: Response;
        try {
            res = await fetch(`${t212Base()}/equity/metadata/instruments`, { headers, signal: ctrl.signal });
        } finally {
            clearTimeout(abortTimer);
        }
        if (res.ok) return res.json() as Promise<T212Instrument[]>;
        if (res.status === 429) {
            const wait = 30_000 * 2 ** attempt;
            log.warn(`[t212] instruments rate-limited, retrying in ${wait / 1000}s`);
            await sleep(wait);
            continue;
        }
        throw new Error(`T212 instruments: ${res.status}`);
    }
    throw new Error('T212 instruments: exceeded retry limit (429)');
}

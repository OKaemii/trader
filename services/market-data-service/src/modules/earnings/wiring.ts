// Earnings composition root. The Yahoo `calendarEvents` source was dropped (epic
// pit-fundamentals-lake-rearchitecture, Thread C / decision I); no PIT-backed earnings-date source
// is wired yet, so the store is fed a stubbed provider that returns no dates — the overlap-detector
// degrades to a clean no-op. The `providerName` arg is retained (env-driven) for a later re-wire,
// but every value currently resolves to the stub. EODHD's earnings calendar remains a future paid
// path (not entitled).

import { EarningsStore } from './application/EarningsStore.ts';
import { StubEarningsProvider } from './infrastructure/StubEarningsProvider.ts';
import { log } from '../../logger.ts';

export function buildEarningsStore(
    providerName: 'yahoo' | 'eodhd',
    _opts: { requestSpacingMs?: number } = {},
): EarningsStore {
    if (providerName !== 'yahoo') {
        log.warn(`[earnings] provider '${providerName}' not implemented; using the no-op stub`);
    }
    // 'stub' source stamp; the stub never returns a date, so no doc is ever written with it.
    return new EarningsStore(new StubEarningsProvider(), 'stub');
}

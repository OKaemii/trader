// Earnings composition root. Yahoo `calendarEvents` (free) is the only implemented provider today;
// EODHD's earnings calendar is a future paid path, so `eodhd` logs and falls back to Yahoo rather
// than failing — mirrors how the EODHD fundamentals provider stays dormant.

import { EarningsStore } from './application/EarningsStore.ts';
import { YahooEarningsProvider } from './infrastructure/YahooEarningsProvider.ts';
import { log } from '../../logger.ts';

export function buildEarningsStore(
    providerName: 'yahoo' | 'eodhd',
    opts: { requestSpacingMs?: number } = {},
): EarningsStore {
    if (providerName === 'eodhd') {
        log.warn('[earnings] EODHD earnings calendar not implemented; using Yahoo calendarEvents');
    }
    return new EarningsStore(new YahooEarningsProvider(undefined, opts.requestSpacingMs), 'yahoo');
}

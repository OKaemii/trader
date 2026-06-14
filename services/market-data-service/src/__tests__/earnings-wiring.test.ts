import { describe, it, expect } from 'vitest';
import { selectEarningsProvider } from '../modules/earnings/wiring.ts';
import { IrCalendarEarningsProvider } from '../modules/earnings/infrastructure/IrCalendarEarningsProvider.ts';
import { StubEarningsProvider } from '../modules/earnings/infrastructure/StubEarningsProvider.ts';

describe('selectEarningsProvider (EARNINGS_PROVIDER wiring)', () => {
    it('selects the IR-calendar provider for "ir_calendar" with a Firecrawl URL', () => {
        const { provider, source } = selectEarningsProvider('ir_calendar', {
            firecrawlBaseUrl: 'http://192.168.50.2:3002',
        });
        expect(provider).toBeInstanceOf(IrCalendarEarningsProvider);
        expect(source).toBe('ir-calendar');
    });

    it('selects the stub for "stub"', () => {
        const { provider, source } = selectEarningsProvider('stub', {
            firecrawlBaseUrl: 'http://192.168.50.2:3002',
        });
        expect(provider).toBeInstanceOf(StubEarningsProvider);
        expect(source).toBe('stub');
    });

    it('falls back to the stub for "ir_calendar" when no Firecrawl URL is configured', () => {
        const { provider, source } = selectEarningsProvider('ir_calendar', { firecrawlBaseUrl: '' });
        expect(provider).toBeInstanceOf(StubEarningsProvider);
        expect(source).toBe('stub');
    });
});

import { describe, it, expect } from 'vitest';
import { buildFillsQuery } from '../modules/reconciliation/infrastructure/FillsHistoryStore.ts';

describe('buildFillsQuery', () => {
  it('no filters → no WHERE, just the clamped default limit param', () => {
    const { sql, params } = buildFillsQuery({});
    expect(sql).not.toContain('WHERE');
    expect(sql).toContain('ORDER BY filled_at DESC');
    expect(sql).toContain('LIMIT $1');
    expect(params).toEqual([200]);
  });

  it('uppercases ticker and parameterises ticker + side in order', () => {
    const { sql, params } = buildFillsQuery({ ticker: 'aapl_us_eq', side: 'BUY' });
    expect(params[0]).toBe('AAPL_US_EQ');
    expect(params[1]).toBe('BUY');
    expect(sql).toContain('ticker = $1');
    expect(sql).toContain('side = $2');
    expect(sql).toContain('LIMIT $3');
  });

  it('adds the time-window predicate when sinceMs is set', () => {
    const { sql, params } = buildFillsQuery({ sinceMs: 1_700_000_000_000 });
    expect(sql).toContain('filled_at >= to_timestamp($1/1000.0)');
    expect(params[0]).toBe(1_700_000_000_000);
  });

  it('clamps the limit to [1, 1000]', () => {
    expect(buildFillsQuery({ limit: 99_999 }).params).toEqual([1000]);
    expect(buildFillsQuery({ limit: 0 }).params).toEqual([1]);
  });

  it('combines all filters with AND in placeholder order', () => {
    const { sql, params } = buildFillsQuery({ ticker: 'x', side: 'SELL', sinceMs: 5, limit: 50 });
    expect(sql).toContain('WHERE ticker = $1 AND side = $2 AND filled_at >= to_timestamp($3/1000.0)');
    expect(params).toEqual(['X', 'SELL', 5, 50]);
  });
});

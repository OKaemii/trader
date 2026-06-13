// Task 16a — signals are stored + queried on the bare (symbol, market) identity, never the
// concatenated Trading212 ticker. These tests lock the behaviour that matters most:
//   - findOpenBuysByTicker (the FIFO entry-leg lookup) keys on (symbol, market) and stays
//     oldest-first, executed-BUYs-only — the failure invariant (only {executed} BUYs match)
//     and the cross-market disambiguation both hold;
//   - findByTicker (the audit trail) keys on (symbol, market) across all lifecycles;
//   - an un-routable ticker degrades to no-match (fail-soft), never a throw.
//
// We don't spin up a real Mongo: a small in-memory IDataManager executes the (symbol, market)
// filter + sort the repository relies on, against docs materialised through the real toSignalDoc
// (so the stored shape under test is exactly what production writes).

import { describe, it, expect } from 'vitest';
import { MongoSignalRepository } from '../modules/signals/infrastructure/MongoSignalRepository.ts';
import { TradeSignal, SignalLifecycle, type Action } from '../modules/signals/domain/TradeSignal.ts';
import { toSignalDoc, fromSignalDoc } from '../shared/data.ts';

// In-memory IDataManager that honours the filter/sort findOpenBuysByTicker + findByTicker pass.
class MemManager {
  rows: any[] = [];
  async insert(s: TradeSignal) { this.rows.push(toSignalDoc(s)); }
  async insertMany(_: TradeSignal[]) {}
  async findById(_id: string) { return null; }
  async update() {}
  async findMany(opts: { filter?: Record<string, unknown>; sortBy?: string; sortDir?: 'asc' | 'desc'; limit?: number }) {
    let out = this.rows.filter((r) => matches(r, opts.filter ?? {}));
    if (opts.sortBy) {
      const dir = opts.sortDir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => cmp(a[opts.sortBy!], b[opts.sortBy!]) * dir);
    }
    if (opts.limit) out = out.slice(0, opts.limit);
    return out.map((d) => fromSignalDoc(d));
  }
}
function matches(row: any, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => row[k] === v);
}
function cmp(a: any, b: any): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  return av > bv ? 1 : av < bv ? -1 : 0;
}

class NoopCache {
  async get() { return null; }
  async set() {}
  async getOrLoad(_k: string, loader: any) { return loader(); }
  async invalidate() {}
  async invalidatePattern() {}
}
class NoopBus { async publish() {} async subscribe() {} }

function repoWith(...signals: TradeSignal[]) {
  const manager = new MemManager();
  const repo = new MongoSignalRepository(manager as any, new NoopCache() as any, new NoopBus() as any);
  // Seed synchronously-enough for tests (insert is sync under the hood here).
  return { repo, seed: async () => { for (const s of signals) await manager.insert(s); } };
}

function buy(id: string, ticker: string, lifecycle: SignalLifecycle, executedAtMs?: number, executedQuantity?: number): TradeSignal {
  return new TradeSignal({
    id, timestamp: executedAtMs ?? Date.UTC(2026, 0, 1), ticker, strategy_id: 'test',
    action: 'BUY', confidence: 0.5, targetWeight: 0.02, rationale: '{}', lifecycle,
    ...(executedAtMs != null ? { executedAt: executedAtMs } : {}),
    ...(executedQuantity != null ? { executedQuantity } : {}),
  });
}
function sig(id: string, ticker: string, action: Action, lifecycle: SignalLifecycle, ts: number): TradeSignal {
  return new TradeSignal({ id, timestamp: ts, ticker, strategy_id: 'test', action,
    confidence: 0.5, targetWeight: action === 'SELL' ? 0 : 0.02, rationale: '{}', lifecycle });
}

describe('MongoSignalRepository.findOpenBuysByTicker — keyed on (symbol, market)', () => {
  it('returns executed BUYs for the name, oldest-first by executedAt (FIFO entry order)', async () => {
    const { repo, seed } = repoWith(
      buy('b3', 'AAPL_US_EQ', SignalLifecycle.Executed, 300, 3),
      buy('b1', 'AAPL_US_EQ', SignalLifecycle.Executed, 100, 1),
      buy('b2', 'AAPL_US_EQ', SignalLifecycle.Executed, 200, 2),
    );
    await seed();
    const open = await repo.findOpenBuysByTicker('AAPL_US_EQ');
    expect(open.map((s) => s.id)).toEqual(['b1', 'b2', 'b3']);   // FIFO: oldest executedAt first
    expect(open.every((s) => s.ticker === 'AAPL_US_EQ')).toBe(true);
  });

  it('excludes non-executed BUYs (failure invariant — only {executed} count as an open leg)', async () => {
    const { repo, seed } = repoWith(
      buy('exec',   'AAPL_US_EQ', SignalLifecycle.Executed, 100, 1),
      buy('queued', 'AAPL_US_EQ', SignalLifecycle.Queued),
      buy('failed', 'AAPL_US_EQ', SignalLifecycle.Failed),
      buy('closed', 'AAPL_US_EQ', SignalLifecycle.Closed, 50, 1),
    );
    await seed();
    const open = await repo.findOpenBuysByTicker('AAPL_US_EQ');
    expect(open.map((s) => s.id)).toEqual(['exec']);
  });

  it('disambiguates the same symbol across markets (US vs LSE never collide on one identity)', async () => {
    // A US Vodafone-shaped symbol and an LSE one share a bare symbol but differ on market.
    const { repo, seed } = repoWith(
      buy('us',  'VOD_US_EQ', SignalLifecycle.Executed, 100, 10),
      buy('lse', 'VODl_EQ',   SignalLifecycle.Executed, 100, 20),
    );
    await seed();
    const us  = await repo.findOpenBuysByTicker('VOD_US_EQ');
    const lse = await repo.findOpenBuysByTicker('VODl_EQ');
    expect(us.map((s) => s.id)).toEqual(['us']);
    expect(lse.map((s) => s.id)).toEqual(['lse']);
  });

  it('returns [] for an un-routable ticker (fail-soft, no throw)', async () => {
    const { repo, seed } = repoWith(buy('b1', 'AAPL_US_EQ', SignalLifecycle.Executed, 100, 1));
    await seed();
    await expect(repo.findOpenBuysByTicker('AAPL_CFD')).resolves.toEqual([]);
  });
});

describe('MongoSignalRepository.findByTicker — keyed on (symbol, market)', () => {
  it('returns every lifecycle for the name, newest-first (audit trail)', async () => {
    const { repo, seed } = repoWith(
      sig('s1', 'MSFT_US_EQ', 'BUY',  SignalLifecycle.Failed,   100),
      sig('s2', 'MSFT_US_EQ', 'BUY',  SignalLifecycle.Executed, 300),
      sig('s3', 'MSFT_US_EQ', 'SELL', SignalLifecycle.Closed,   200),
      sig('other', 'AAPL_US_EQ', 'BUY', SignalLifecycle.Executed, 250),
    );
    await seed();
    const rows = await repo.findByTicker('MSFT_US_EQ', 50);
    expect(rows.map((s) => s.id)).toEqual(['s2', 's3', 's1']);   // newest-first, MSFT only
  });

  it('returns [] for an un-routable ticker', async () => {
    const { repo, seed } = repoWith(sig('s1', 'MSFT_US_EQ', 'BUY', SignalLifecycle.Executed, 100));
    await seed();
    await expect(repo.findByTicker('not-a-ticker', 50)).resolves.toEqual([]);
  });
});

import type { T212HistoryItem } from '../../t212/infrastructure/Trading212Client.ts';

// Paginates T212's terminal-order history across a window, bounded by MAX_PAGES so a huge
// account can't make a cycle run unbounded. Returns the items whose order createdAt (or fill
// filledAt) falls in [startMs, endMs]. `complete=false` signals the window exceeded MAX_PAGES —
// the engine then refuses to auto-heal against incomplete broker truth.
export interface HistoryClient {
  getHistoricalOrders(opts?: { cursor?: string; limit?: number }): Promise<{
    items: T212HistoryItem[];
    nextPagePath: string | null;
  }>;
}

export class T212HistoryWalker {
  constructor(
    private readonly client: HistoryClient,
    private readonly maxPages = 50,
  ) {}

  async walkRange(startMs: number, endMs: number): Promise<{ items: T212HistoryItem[]; complete: boolean }> {
    const out: T212HistoryItem[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let reachedOlderThanWindow = false;

    while (pages < this.maxPages) {
      const { items, nextPagePath } = await this.client.getHistoricalOrders(cursor ? { cursor } : undefined);
      pages += 1;
      for (const it of items) {
        const ts = Date.parse(it.fill?.filledAt ?? it.order.createdAt);
        if (Number.isFinite(ts) && ts >= startMs && ts <= endMs) out.push(it);
        // History is newest-first; once we pass below the window start we can stop early.
        if (Number.isFinite(ts) && ts < startMs) reachedOlderThanWindow = true;
      }
      if (reachedOlderThanWindow || !nextPagePath) {
        return { items: out, complete: true };
      }
      cursor = nextPagePath;
    }
    // Hit the page cap with more history remaining — truth is incomplete.
    return { items: out, complete: false };
  }
}

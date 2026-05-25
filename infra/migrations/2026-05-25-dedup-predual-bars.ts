/**
 * ONE-OFF remediation (2026-05-25) — NOT a reusable migration.
 *
 * Context: during the three-database-split rollout, the new bi-temporal writer
 * ran ~6h against an un-migrated Mongo (old rows had no `observation_ts`, the
 * bi-temporal indexes hadn't built). In that window the writer re-fetched ~60d of
 * history, producing a NEW row (observation_ts set, is_superseded:false) for the
 * same logical bar as an existing OLD row (observation_ts missing). That makes the
 * 2026-05-15 backfill collide on `bar_latest_unique` when it sets is_superseded:false
 * on the old rows.
 *
 * This script deletes the OLD rows (observation_ts missing) whose (ticker,
 * timestamp→ms, interval) matches an existing is_superseded:false NEW row — i.e.
 * the rows the new writer already re-wrote. The new row is authoritative (latest
 * revision, proper bi-temporal fields); the old row is a redundant earlier print.
 * Old rows WITHOUT a new twin (true history older than the re-fetch window, or
 * untouched tickers) are left for 2026-05-15 to backfill.
 *
 * Safety: DRY_RUN=1 (default) counts only. Set DRY_RUN=0 to delete.
 *
 * Run (via port-forward + node type-strip):
 *   MONGODB_URL=mongodb://root:<pw>@localhost:27017/trader?authSource=admin&directConnection=true \
 *   DRY_RUN=1 node infra/migrations/2026-05-25-dedup-predual-bars.ts
 */

import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGODB_URL ?? 'mongodb://localhost:27017';
const DB_NAME   = process.env.MONGODB_DB  ?? 'trader';
const DRY_RUN   = process.env.DRY_RUN !== '0';

function tsToMs(ts: unknown): number | null {
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  return null;
}

async function main(): Promise<void> {
  console.log(`[dedup] mongo=${MONGO_URI.replace(/:[^@/]*@/, ':***@')} dryRun=${DRY_RUN}`);
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const coll = client.db(DB_NAME).collection('ohlcv_bars');

    // Pass 1: set of authoritative (is_superseded:false) new-row keys.
    console.log('[dedup] building new-key set …');
    const newKeys = new Set<string>();
    const newCur = coll.find(
      { is_superseded: false, observation_ts: { $exists: true } },
      { projection: { _id: 0, ticker: 1, observation_ts: 1, interval: 1 } },
    );
    for await (const d of newCur) newKeys.add(`${d.ticker}|${d.observation_ts}|${d.interval}`);
    console.log(`[dedup] new keys: ${newKeys.size}`);

    // Pass 2: scan old rows (no observation_ts); delete those whose derived key has a twin.
    const oldCur = coll.find(
      { observation_ts: { $exists: false } },
      { projection: { _id: 1, ticker: 1, timestamp: 1, interval: 1 } },
    );
    let scanned = 0, redundant = 0, deleted = 0, kept = 0, noTs = 0;
    let batch: unknown[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      if (!DRY_RUN) {
        const r = await coll.deleteMany({ _id: { $in: batch } });
        deleted += r.deletedCount ?? 0;
      }
      batch = [];
    };
    for await (const d of oldCur) {
      scanned++;
      const ms = tsToMs(d.timestamp);
      if (ms == null) { noTs++; kept++; continue; }
      if (newKeys.has(`${d.ticker}|${ms}|${d.interval}`)) {
        redundant++;
        batch.push(d._id);
        if (batch.length >= 2000) await flush();
      } else {
        kept++;
      }
      if (scanned % 100000 === 0) process.stdout.write(`\r[dedup] scanned=${scanned} redundant=${redundant} deleted=${deleted} kept=${kept}`);
    }
    await flush();
    process.stdout.write('\n');
    console.log(`[dedup] ${DRY_RUN ? 'DRY-RUN' : 'DELETED'} — scanned=${scanned} redundant=${redundant} deleted=${deleted} kept(historical)=${kept} noTimestamp=${noTs}`);
    if (DRY_RUN) console.log('[dedup] dry run only — re-run with DRY_RUN=0 to delete the redundant rows.');
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error('[dedup] FATAL', e); process.exit(1); });

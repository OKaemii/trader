import type { Collection, Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import type { Logger } from '@trader/core';
import type { HeldSetSnapshotDoc, IHeldSetSnapshotStore } from '../application/HeldSetSnapshot.ts';

// Append-only writer for held_set_snapshots (Task 11 §B). One doc per ranked universe name per
// cycle, written after the optimiser produces final weights. Best-effort: a Mongo failure logs
// and returns so it can never block signal emission (same contract as the feature/factor store).
//
// Indexes (Task 5 #58 documented their intent; created lazily here on first write):
//   (strategy_id, observation_ts)            — per-cycle / per-strategy time scans (T17 backfill)
//   (strategy_id, ticker, observation_ts)    — per-name inclusion history (T12 strategy-impact)
// createIndex is idempotent, so the once-flag is only an optimisation to skip the call after the
// first successful write — Mongo treats a repeat create of an existing index as a no-op.
export class MongoHeldSetSnapshotStore implements IHeldSetSnapshotStore {
  private readonly coll: Collection<HeldSetSnapshotDoc>;
  private indexesEnsured = false;

  constructor(db: Db, private readonly logger: Logger) {
    this.coll = db.collection<HeldSetSnapshotDoc>(COLLECTIONS.HELD_SET_SNAPSHOTS);
  }

  async write(docs: HeldSetSnapshotDoc[]): Promise<void> {
    if (docs.length === 0) return;
    try {
      await this.ensureIndexes();
      // ordered:false so a single bad doc doesn't abort the whole batch; this is an audit
      // ledger, partial writes are tolerable and better than dropping the cycle entirely.
      await this.coll.insertMany(docs, { ordered: false });
    } catch (err) {
      this.logger.warn({ err, count: docs.length }, 'held_set_snapshots write failed (continuing — emission not blocked)');
    }
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesEnsured) return;
    await this.coll.createIndex({ strategy_id: 1, observation_ts: 1 }, { name: 'held_strategy_obs' });
    await this.coll.createIndex(
      { strategy_id: 1, ticker: 1, observation_ts: 1 },
      { name: 'held_strategy_ticker_obs' },
    );
    this.indexesEnsured = true;
  }
}

-- 0011_bars_asof_lookup.sql — supporting index for the single-bar at-or-before read.
--
-- The PIT market-cap / dividend-yield enrichment (fundamentals-api) needs the latest daily bar
-- at/<= a knowledge instant for one ticker — `getBarAtOrBefore` in @trader/shared-bars. That read
-- is `WHERE ticker=$1 AND interval=$2 AND is_superseded=FALSE ORDER BY observation_ts DESC LIMIT 1`
-- (live) / the `observation_ts <= asOf` DESC-LIMIT-1 variant (as-of). It replaces the old
-- `range='max'` series scan, whose now-anchored `observation_ts >= sinceTs` lower bound matched
-- every chunk back to ~1926 → Timescale opened ~5,200 chunks → "out of shared memory" (lock-table
-- exhaustion) → a 500 to the enrichment caller.
--
-- This partial index lets the live DESC-LIMIT-1 read seek (ticker, interval) and walk
-- observation_ts DESC from the newest unsuperseded bar, stopping after one row — no full-chunk fan.
-- It aligns with the hypertable's `compress_orderby = 'observation_ts DESC, knowledge_ts DESC'`
-- (0002_bars.sql) so compressed chunks honour the same order. The as-of/replay variant is bounded
-- by `observation_ts <= asOf` + DESC + LIMIT and is additionally covered by `bars_knowledge_lookup`.
--
-- Idempotent (`IF NOT EXISTS`), forward-only; applied by the timescale-init Helm hook each release
-- via the @trader/shared-pg migration runner.
CREATE INDEX IF NOT EXISTS bars_asof_lookup
  ON bars (ticker, interval, observation_ts DESC)
  WHERE is_superseded = FALSE;

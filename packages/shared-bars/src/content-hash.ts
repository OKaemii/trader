// Deterministic SHA-1 of a bar's payload. Used by the bi-temporal write path to decide
// whether a re-poll is a genuine revision (insert new row, supersede prior) or a
// cosmetic duplicate (skip, no audit entry). Hashing — rather than struct-equality —
// neutralises two real-world issues:
//
//   1. Float-format jitter. Yahoo occasionally serves numerically-equal floats with
//      different binary representations across cycles; `n.toFixed(8)` canonicalises
//      them to a string before hashing.
//   2. Volume fractional dust. Providers sometimes report shares fractionally during
//      adjustment processing (e.g. 1234567.0001). We round volume to int before
//      hashing — fractional volume is noise, not a real revision.
//
// SHA-1 (160 bits) is overkill for collision-resistance here — a per-(ticker,
// observation_ts) namespace narrows the candidate space to one bar — but it's cheap
// and built into node:crypto. Hex (40 chars) keeps the Mongo doc small.
//
// See agent-docs/plans/point-in-time-bar-history.md §Design / Content hash.

import { createHash } from 'node:crypto';
import type { OHLCVBar } from '@trader/shared-types';

const fix = (n: number | undefined): string =>
  n == null || !Number.isFinite(n) ? '∅' : n.toFixed(8);

export function hashBarContent(
  bar: Pick<
    OHLCVBar,
    'open' | 'high' | 'low' | 'close' | 'volume' | 'rawClose' | 'adjustedClose' | 'adjustmentFactor'
  >,
): string {
  const canonical = [
    fix(bar.open),
    fix(bar.high),
    fix(bar.low),
    fix(bar.close),
    String(Math.round(bar.volume ?? 0)),
    fix(bar.rawClose),
    fix(bar.adjustedClose),
    fix(bar.adjustmentFactor),
  ].join('|');
  return createHash('sha1').update(canonical).digest('hex');
}

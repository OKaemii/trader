"""Per-name PIT coverage + freshness audit — the "is the curated US universe fully ingested, and how
current is each name?" surface (epic Task 4).

This is the gate that proves it is **safe to retire Yahoo** for US names: once every curated US name is
covered (`covered == universe`) and none is stale (`stale == 0`), `retirable` flips true and the live
strategy seam no longer needs the Yahoo fallback for US.

Distinct from `status.py` (which reports a GLOBAL coverage count + a single ingestion-lag number): this
walks the curated universe **name by name** so a single missing or stale filer is visible. The two
read the SAME canonical `fundamentals` table; this one joins it to the security master per instrument
and back to the curated universe via the reconstructed T212 ticker.

FOUR DISTINCT INSTANTS are surfaced per name — the bi-temporal model keeps them genuinely separate, so
the portal can label them honestly (period-end ≠ availability ≠ our-store-time):
  * `newest_period_end`   = MAX(observation_ts)  — the freshest fiscal **period_end** we hold (the
                            quarter/year the facts describe). Drives staleness.
  * `newest_knowledge_ts` = MAX(knowledge_ts)    — the freshest **availability** (derived: the next
                            trading-session open after the filing's acceptance). When the strategy COULD
                            first have read it.
  * `last_stored_at`      = MAX(fundamentals_revisions_log.logged_at) — the WALL-CLOCK our ingest last
                            persisted a row for this name. Advances ONLY on a real first-print/supersede:
                            the writer's hash-gate makes an unchanged re-poll a no-op (no revision-log
                            row), so an idempotent nightly sweep does NOT bump this. That is the whole
                            point — it answers "when did our store last actually CHANGE for this name",
                            not "when did a sweep last touch it".
  * `last_ingest_run` (aggregate) — the last full force-ingest sweep (from the run store). Read together,
                            `last_ingest_run` + `last_stored_at` say "last sweep" + "last real change".

`stale = (not covered) or (now - newest_period_end > stale_after_ms)` — a name with no canonical row is
stale by definition; a covered name is stale once its freshest fiscal period falls behind the staleness
window (≈ a reporting quarter + a filing-grace buffer, `FUNDAMENTALS_STALE_AFTER_DAYS`).

The curated universe is the SAME set the ingest walks — `instrument_registry {activeTo:null}`,
US-filtered to bare symbols — read by reusing `coverage.load_coverage(mode=universe_only, cap=None)` (no
index, uncapped) rather than re-implementing the Mongo read. A name in the curated universe but with no
security-master instrument row yet (never ingested) still appears, `covered:false` — never silently
dropped.
"""
from __future__ import annotations

import logging
from typing import Optional

from src.coverage import COVERAGE_UNIVERSE_ONLY, load_coverage

log = logging.getLogger("fundamentals-ingestion.freshness")

# T212 suffix for a US equity. The curated universe read returns BARE symbols (`AAPL`); the security
# master stores the reconstructed `<SYMBOL>_US_EQ` as `instruments.t212_ticker` (orchestrator.py does the
# same reconstruction). So the per-name join key is the T212 form, derived here from the bare symbol.
_US_EQ_SUFFIX = "_US_EQ"

_MS_PER_DAY = 86_400_000

# Default staleness window when FUNDAMENTALS_STALE_AFTER_DAYS is unset: ≈ a reporting quarter (~90d) plus
# a ~45d filing-grace buffer (a 10-Q lands weeks after period-end). 135 days. A covered name whose
# freshest fiscal period is older than this is flagged stale so the self-heal (Task 5) re-ingests it.
DEFAULT_STALE_AFTER_DAYS = 135


# Per-name newest fiscal period + availability off the canonical table, keyed by the T212 ticker the
# curated universe speaks. Joins `fundamentals` → `security_master.instruments` (instrument_id) and
# filters to the curated tickers + current rows. GROUP BY the ticker so one row per held name; a name
# with no canonical row simply does not appear (the caller marks it covered:false).
_NEWEST_BY_TICKER_SQL = """
SELECT
    inst.t212_ticker                              AS t212_ticker,
    MAX(f.instrument_id)                          AS instrument_id,
    MAX(f.observation_ts)                         AS newest_period_end,
    MAX(f.knowledge_ts)                           AS newest_knowledge_ts
FROM fundamentals f
JOIN security_master.instruments inst ON inst.instrument_id = f.instrument_id
WHERE f.is_superseded = FALSE
  AND inst.t212_ticker = ANY($1::text[])
GROUP BY inst.t212_ticker
"""

# Per-name wall-clock of the last persisted row, keyed by the T212 ticker. MAX(logged_at) on the
# append-only revisions log (one row per real first-print/supersede) → the instant our ingest last
# CHANGED this name. Converted to UTC-ms (EXTRACT EPOCH) so it matches the BIGINT-ms shape of the other
# instants. A separate query from the newest-fact read because the revisions log is a distinct
# (hypertable) ledger — joining it into the fact aggregate would multiply rows.
_LAST_STORED_BY_TICKER_SQL = """
SELECT
    inst.t212_ticker                                            AS t212_ticker,
    (EXTRACT(EPOCH FROM MAX(rl.logged_at)) * 1000)::bigint      AS last_stored_at
FROM fundamentals_revisions_log rl
JOIN security_master.instruments inst ON inst.instrument_id = rl.instrument_id
WHERE inst.t212_ticker = ANY($1::text[])
GROUP BY inst.t212_ticker
"""


def stale_after_ms_from_days(days: Optional[int]) -> int:
    """A staleness-window day count → milliseconds. `None`/non-positive ⇒ the default window (a name
    can never be "never stale" here — that would silently disable the safe-to-retire gate)."""
    if days is None or days <= 0:
        return DEFAULT_STALE_AFTER_DAYS * _MS_PER_DAY
    return days * _MS_PER_DAY


def _t212_us(symbol: str) -> str:
    """A bare US symbol → its reconstructed T212 ticker (`AAPL` → `AAPL_US_EQ`) — the join key the
    security master stores. Mirrors the orchestrator's reconstruction so the two agree."""
    return f"{symbol}{_US_EQ_SUFFIX}"


async def _curated_us_universe(mongo_db) -> list[str]:
    """The curated US universe as bare symbols — the SAME set the ingest walks. Reuses the Task-1
    coverage read (`instrument_registry {activeTo:null}`, US-filtered) in universe-only, uncapped mode so
    no index member and no cap leaks in. Degrades to [] inside `load_coverage` on a Mongo read error
    (partial/empty audit beats a 500)."""
    return await load_coverage(
        mongo_db, window_lo_ms=0, mode=COVERAGE_UNIVERSE_ONLY, cap=None
    )


async def freshness_audit(
    pool,
    mongo_db,
    *,
    now_ms: int,
    stale_after_ms: int,
    last_ingest_run: Optional[dict] = None,
) -> dict:
    """Per-curated-US-name PIT coverage + staleness + the ingest clocks.

    Walks the curated US universe (`instrument_registry {activeTo:null}`, bare-symbol US-filtered — the
    same set the ingest covers), then per name reads off `fundamentals` (current rows, joined to the
    security master via the reconstructed `<SYMBOL>_US_EQ` ticker):
      * `covered`             — has at least one current (`is_superseded=FALSE`) canonical row,
      * `newest_period_end`   — MAX(observation_ts) (freshest fiscal period_end),
      * `newest_knowledge_ts` — MAX(knowledge_ts) (freshest derived availability),
      * `last_stored_at`      — MAX(fundamentals_revisions_log.logged_at) as UTC-ms (the wall-clock our
                                ingest last persisted a row — advances only on a real write),
      * `staleness_days`      — (now − newest_period_end) in whole days (None when uncovered),
      * `stale`               — (not covered) OR (now − newest_period_end > stale_after_ms).

    Returns `{universe, covered, missing, stale, coverage_pct, retirable, last_ingest_run, names:[…]}`,
    where `retirable = (missing == 0 and stale == 0)` is the safe-to-retire-Yahoo gate. `last_ingest_run`
    is the run store's latest force-ingest payload (injected by the endpoint, not a DB read — mirrors
    `status.build_status`'s `last_run`).

    A cold (un-backfilled) warehouse yields every curated name uncovered/stale with zero coverage — that
    is the correct pre-backfill state, not an error. A Timescale-unreachable read raises (the endpoint
    turns it into a 503, mirroring `/status`)."""
    universe = await _curated_us_universe(mongo_db)
    universe_sorted = sorted(set(universe))
    # The T212 join keys for the per-name reads; map back to the bare symbol for the output.
    tickers = [_t212_us(sym) for sym in universe_sorted]

    newest_by_ticker: dict[str, dict] = {}
    last_stored_by_ticker: dict[str, Optional[int]] = {}
    if tickers:
        async with pool.acquire() as conn:
            for row in await conn.fetch(_NEWEST_BY_TICKER_SQL, tickers):
                newest_by_ticker[row["t212_ticker"]] = row
            for row in await conn.fetch(_LAST_STORED_BY_TICKER_SQL, tickers):
                last_stored_by_ticker[row["t212_ticker"]] = (
                    int(row["last_stored_at"]) if row["last_stored_at"] is not None else None
                )

    names: list[dict] = []
    covered_count = 0
    stale_count = 0
    for sym in universe_sorted:
        ticker = _t212_us(sym)
        agg = newest_by_ticker.get(ticker)
        covered = agg is not None
        newest_period_end = (
            int(agg["newest_period_end"]) if covered and agg["newest_period_end"] is not None else None
        )
        newest_knowledge_ts = (
            int(agg["newest_knowledge_ts"]) if covered and agg["newest_knowledge_ts"] is not None else None
        )
        instrument_id = int(agg["instrument_id"]) if covered and agg["instrument_id"] is not None else None
        last_stored_at = last_stored_by_ticker.get(ticker)

        # Staleness is anchored on the freshest fiscal period we hold. Uncovered (or a covered row with a
        # null period_end, which should not happen but is handled) ⇒ no age and stale by definition.
        if newest_period_end is not None:
            age_ms = max(0, now_ms - newest_period_end)
            staleness_days = age_ms // _MS_PER_DAY
            stale = age_ms > stale_after_ms
        else:
            staleness_days = None
            stale = True
        if not covered:
            stale = True

        if covered:
            covered_count += 1
        if stale:
            stale_count += 1

        names.append({
            "symbol": sym,
            "ticker": ticker,
            "instrument_id": instrument_id,
            "covered": covered,
            "newest_period_end": newest_period_end,
            "newest_knowledge_ts": newest_knowledge_ts,
            "last_stored_at": last_stored_at,
            "staleness_days": staleness_days,
            "stale": stale,
        })

    n = len(universe_sorted)
    missing = n - covered_count
    coverage_pct = round(100.0 * covered_count / n, 2) if n else 0.0
    return {
        "universe": n,
        "covered": covered_count,
        "missing": missing,
        "stale": stale_count,
        "coverage_pct": coverage_pct,
        # The headline gate: every curated US name ingested AND none stale ⇒ Yahoo can be retired for US.
        "retirable": missing == 0 and stale_count == 0,
        "last_ingest_run": last_ingest_run,
        "names": names,
    }

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
# This is the QUARTERLY window — correct for a 10-Q filer (4 reports/year).
DEFAULT_STALE_AFTER_DAYS = 135

# Staleness window for an ANNUAL filer (a foreign-private-issuer 20-F/40-F, or a domestic name that files
# only a 10-K). Such a name reports ONCE a year, so the freshest fiscal period_end is legitimately ~a year
# old between filings — the 135-day quarterly window would flag it stale every cycle and the self-heal
# would force-re-ingest it every 6h for nothing. ≈ 365 days + a ~35d filing-grace buffer (a 20-F lands
# months after fiscal year-end). 400 days. Keyed off the name's actual filing cadence (most-recent
# form_type), so a 10-Q filer keeps the tighter 135-day window.
DEFAULT_STALE_AFTER_DAYS_ANNUAL = 400

# Form types that mark an ANNUAL reporting cadence. 20-F / 40-F are the foreign-private-issuer annual
# reports (the TSM case); 10-K is the domestic annual. EDGAR amendments carry a `/A` suffix (`10-K/A`,
# `20-F/A`), so classification matches on the form PREFIX (before any `/A`). A name is treated as an
# annual filer when it has filed one of these AND has filed no recent 10-Q — NOT when one of these is the
# single newest filing (a 20-F filer posts newer 6-K/8-K/Form-4 current reports, so the annual form is
# rarely the latest). A name that files quarterly always has a recent 10-Q → it keeps the 135-day window
# even just after its 10-K.
_ANNUAL_FORM_PREFIXES = ("20-F", "40-F", "10-K")
_QUARTERLY_FORM_PREFIX = "10-Q"


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

# Per-name filing cadence off the security master's `filings` lineage (schema 0008), keyed by the T212
# ticker. Drives the staleness window: an annual filer (newest filing 20-F/40-F/10-K, no recent 10-Q)
# gets the 400-day window; a quarterly filer (any recent 10-Q) keeps 135. Read-only against 0008 — no
# new migration. The `filings_instrument_lookup (instrument_id, accepted_ts DESC)` index already covers
# the per-instrument acceptance ordering.
#
# What matters is the FILING CADENCE — does the name file 10-Qs? — not which single form is newest. A
# real 20-F/10-K filer's recent filings are dominated by NEWER 6-K/8-K/Form-4 current reports, so "the
# newest filing is the annual form" is almost never true and is the wrong test (it misclassified every
# real annual filer as quarterly). So rather than `DISTINCT ON … LIMIT 1`, this aggregates per ticker into
# the two presence-of-cadence timestamps the classifier needs:
#   * `newest_annual_ts`    = MAX(accepted_ts) of an annual form (20-F/40-F/10-K, amendments included via
#                             the `/A`-tolerant prefix match) — non-null ⇒ this name files annual reports.
#   * `newest_quarterly_ts` = MAX(accepted_ts) of a 10-Q (or 10-Q/A) — non-null ⇒ a quarterly cadence.
# The classifier (`_is_annual_cadence`) derives annual (has-annual ∧ no-recent-10-Q) vs quarterly from
# these two. A name with NO filing rows at all (never resolved a CIK, UK foreign issuer) simply does not
# appear → the caller falls back to the quarterly window, the pre-A2 behaviour (never widen on absent data).
_FILING_CADENCE_BY_TICKER_SQL = """
SELECT
    inst.t212_ticker                                                            AS t212_ticker,
    MAX(fl.accepted_ts) FILTER (
        WHERE split_part(fl.form_type, '/', 1) = ANY($2::text[])
    )                                                                           AS newest_annual_ts,
    MAX(fl.accepted_ts) FILTER (
        WHERE split_part(fl.form_type, '/', 1) = $3
    )                                                                           AS newest_quarterly_ts
FROM security_master.filings fl
JOIN security_master.instruments inst ON inst.instrument_id = fl.instrument_id
WHERE inst.t212_ticker = ANY($1::text[])
  AND fl.accepted_ts IS NOT NULL
GROUP BY inst.t212_ticker
"""


def stale_after_ms_from_days(days: Optional[int]) -> int:
    """A staleness-window day count → milliseconds. `None`/non-positive ⇒ the default window (a name
    can never be "never stale" here — that would silently disable the safe-to-retire gate)."""
    if days is None or days <= 0:
        return DEFAULT_STALE_AFTER_DAYS * _MS_PER_DAY
    return days * _MS_PER_DAY


def annual_stale_after_ms_from_days(days: Optional[int]) -> int:
    """The ANNUAL staleness-window day count → milliseconds. Mirrors `stale_after_ms_from_days` but with
    the 400-day annual default. `None`/non-positive ⇒ the default annual window (an annual filer can never
    be "never stale" either). The annual window is floored at the quarterly one where both are applied
    (`freshness_audit`), so a once-a-year filer is never treated as MORE time-sensitive than a quarterly
    one even if the env knobs are set inconsistently."""
    if days is None or days <= 0:
        return DEFAULT_STALE_AFTER_DAYS_ANNUAL * _MS_PER_DAY
    return days * _MS_PER_DAY


def _is_annual_cadence(cadence: Optional[dict], *, now_ms: int, annual_ms: int) -> bool:
    """Classify a name as an ANNUAL filer from its filing cadence (a `_FILING_CADENCE_BY_TICKER_SQL` row,
    or None when it has no filings on record).

    A name is annual when BOTH hold:
      * it has filed an annual form (`newest_annual_ts` present — a 10-K/20-F/40-F, amendments included),
        and
      * it has filed no 10-Q within the annual window (no `newest_quarterly_ts`, or that 10-Q is itself
        older than `annual_ms` — i.e. the name used to file quarterly but no longer does).

    Crucially this does NOT require the annual form to be the *newest filing overall*: a real 20-F/10-K
    filer's `filings.recent` is dominated by NEWER 6-K/8-K/Form-4 current reports, so the latest filing is
    almost never the annual report itself. Keying on "newest filing == the annual form" misclassified
    every real annual filer (TSM) as quarterly. The honest discriminator is filing CADENCE — does the name
    file 10-Qs? A name with an annual report and no recent 10-Q reports once a year (a 20-F foreign private
    issuer files 6-K interims, never a 10-Q); a name with a recent 10-Q reports quarterly.

    Everything else — a quarterly filer (recent 10-Q), or a name with no annual form / no filing rows at
    all — is treated as quarterly. Defaulting to quarterly on absent/ambiguous data is deliberate: A2 only
    ever WIDENS a window for a name we positively know files annually, never on missing data (which would
    silently let a stale quarterly name look fresh and break the safe-to-retire gate)."""
    if cadence is None:
        return False
    newest_annual = cadence.get("newest_annual_ts")
    newest_quarterly = cadence.get("newest_quarterly_ts")

    # No annual form on record ⇒ not an annual filer (a name that has only ever filed 6-K/8-K, or nothing).
    if newest_annual is None:
        return False
    # Files an annual report but ALSO a 10-Q within the annual window ⇒ still a quarterly cadence (a
    # domestic name files both a 10-K and 10-Qs; the recent 10-Q keeps it on the tighter window). Only the
    # absence of a *recent* 10-Q makes a name a once-a-year filer.
    if newest_quarterly is not None and (now_ms - newest_quarterly) <= annual_ms:
        return False
    return True


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
    annual_stale_after_ms: Optional[int] = None,
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
      * `filing_cadence`      — `'annual'` (20-F/40-F/10-K, no recent 10-Q) | `'quarterly'` (the default,
                                incl. a name with no filings on record) — which staleness window applies,
      * `staleness_days`      — (now − newest_period_end) in whole days (None when uncovered),
      * `stale`               — (not covered) OR (now − newest_period_end > the name's window).

    `stale_after_ms` is the QUARTERLY window (a 10-Q filer); `annual_stale_after_ms` the wider ANNUAL one
    (a 20-F/40-F/10-K filer reporting once a year). Per name, the window is chosen from the filing cadence
    in `security_master.filings` (read-only — no schema change), so a foreign annual filer (TSM) is not
    flagged stale every cycle by a quarter-shaped window while a quarterly filer (AAPL) keeps 135 days. An
    omitted `annual_stale_after_ms` defaults to the 400-day annual window; it is floored at the quarterly
    window so an annual filer is never treated as more time-sensitive than a quarterly one.

    Returns `{universe, covered, missing, stale, coverage_pct, retirable, last_ingest_run, names:[…]}`,
    where `retirable = (missing == 0 and stale == 0)` is the safe-to-retire-Yahoo gate. `last_ingest_run`
    is the run store's latest force-ingest payload (injected by the endpoint, not a DB read — mirrors
    `status.build_status`'s `last_run`).

    A cold (un-backfilled) warehouse yields every curated name uncovered/stale with zero coverage — that
    is the correct pre-backfill state, not an error. A Timescale-unreachable read raises (the endpoint
    turns it into a 503, mirroring `/status`)."""
    # The annual window defaults to 400d and is floored at the quarterly window (an annual filer is never
    # more time-sensitive than a quarterly one — guards a misconfigured override where annual < quarterly).
    annual_window_ms = (
        annual_stale_after_ms
        if annual_stale_after_ms is not None
        else DEFAULT_STALE_AFTER_DAYS_ANNUAL * _MS_PER_DAY
    )
    annual_window_ms = max(annual_window_ms, stale_after_ms)

    universe = await _curated_us_universe(mongo_db)
    universe_sorted = sorted(set(universe))
    # The T212 join keys for the per-name reads; map back to the bare symbol for the output.
    tickers = [_t212_us(sym) for sym in universe_sorted]

    newest_by_ticker: dict[str, dict] = {}
    last_stored_by_ticker: dict[str, Optional[int]] = {}
    cadence_by_ticker: dict[str, dict] = {}
    if tickers:
        async with pool.acquire() as conn:
            for row in await conn.fetch(_NEWEST_BY_TICKER_SQL, tickers):
                newest_by_ticker[row["t212_ticker"]] = row
            for row in await conn.fetch(_LAST_STORED_BY_TICKER_SQL, tickers):
                last_stored_by_ticker[row["t212_ticker"]] = (
                    int(row["last_stored_at"]) if row["last_stored_at"] is not None else None
                )
            # Newest filing cadence per name → the staleness window (annual vs quarterly). $2 is the
            # annual-form prefix set, $3 the quarterly (10-Q) prefix.
            for row in await conn.fetch(
                _FILING_CADENCE_BY_TICKER_SQL, tickers, list(_ANNUAL_FORM_PREFIXES), _QUARTERLY_FORM_PREFIX
            ):
                cadence_by_ticker[row["t212_ticker"]] = row

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

        # Pick the per-name staleness window from its filing cadence: an annual filer (20-F/40-F/10-K with
        # no recent 10-Q) gets the wider annual window; everything else (a quarterly filer, or a name with
        # no filings on record) keeps the quarterly window. Label + window derive from the same classifier
        # so they can never drift.
        is_annual = _is_annual_cadence(cadence_by_ticker.get(ticker), now_ms=now_ms, annual_ms=annual_window_ms)
        filing_cadence = "annual" if is_annual else "quarterly"
        name_window_ms = annual_window_ms if is_annual else stale_after_ms

        # Staleness is anchored on the freshest fiscal period we hold. Uncovered (or a covered row with a
        # null period_end, which should not happen but is handled) ⇒ no age and stale by definition.
        if newest_period_end is not None:
            age_ms = max(0, now_ms - newest_period_end)
            staleness_days = age_ms // _MS_PER_DAY
            stale = age_ms > name_window_ms
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
            "filing_cadence": filing_cadence,
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

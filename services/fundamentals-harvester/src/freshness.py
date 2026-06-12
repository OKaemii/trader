"""Per-name PIT coverage + freshness audit over the LAKE — "is this universe fully harvested, and how
current is each name?"

This is the gate that proves a US name has point-in-time fundamentals: once every **EDGAR-eligible**
name in the supplied universe is covered and none is stale (`missing == 0 and stale == 0` over that
denominator), `retirable` flips true. The denominator is `edgar_eligible = universe − NO_EDGAR`: a handful
of US-listed names genuinely file NOTHING with the SEC (an unsponsored ADR like TCEHY — `no_edgar.py`), so
they are FOREVER uncovered. Counting them `missing` would make the gate unreachable and read as a silent
coverage gap, so they are EXCLUDED from `missing`/`stale`/`retirable` and surfaced in a distinct
`no_edgar` block WITH reasons.

PORTED FROM THE TIMESCALE AUDIT, RE-AIMED AT THE LAKE. The retired `fundamentals-ingestion` audit read a
bi-temporal `fundamentals` hypertable + `security_master.filings` (SQL) and the curated universe from
Mongo (`instrument_registry`). The harvester is a pure EDGAR→lake service with **no Mongo and no
Timescale** — so:

  * The **universe is an INPUT** (`symbols=`), supplied by the caller (the portal passes the active
    instrument_registry universe via the `?symbols=` query param). When absent it DEFAULTS to every
    currently-listed bare ticker in the lake's `ticker_history.parquet` — so a bare `/freshness` call still
    returns a well-formed audit over what the lake knows, without the harvester reaching into Mongo.
  * Per name, the newest fiscal period, the freshest availability, and the filing cadence are read off the
    lake itself: `ticker_history.parquet` resolves the bare symbol → CIK (rename-aware, current listing
    preferred), then the single `facts/cik=<cik:010d>.parquet` file gives MAX(`end`) (newest period_end),
    MAX(`knowledge_ts`) (freshest availability), and the per-form `filed` recency that classifies the
    cadence. One file per name → O(one file) per read, no glob on the hot path.

PER-FORM STALENESS WINDOW (the A2 fix, preserved). A name's staleness window is keyed off its filing
CADENCE, not a flat window:
  * a QUARTERLY filer (a recent 10-Q) → 135 days (≈ a reporting quarter + a ~45d filing-grace buffer),
  * an ANNUAL filer (a 10-K/20-F/40-F and NO recent 10-Q — a foreign private issuer like TSM/ASML, or a
    domestic 10-K-only name) → 400 days (≈ a year + a ~35d filing-grace buffer).
A 20-F filer reports once a year, so its freshest period_end is legitimately ~a year old between filings;
the 135-day quarterly window would flag it stale every cycle. The cadence test is "does the name file
10-Qs?", NOT "which single form is newest" (a real annual filer's recent filings are dominated by newer
6-K/8-K current reports, so the annual form is rarely the latest — keying on newest-form misclassified
every annual filer as quarterly). Defaulting to the tighter quarterly window on absent/ambiguous data is
deliberate: the window only WIDENS for a name we positively know files annually.

FOUR DISTINCT INSTANTS keep the bi-temporal model honest so the portal can label them separately:
  * `newest_period_end`   = MAX(`end`)            — the freshest fiscal period_end (drives staleness).
  * `newest_knowledge_ts` = MAX(`knowledge_ts`)   — the freshest derived availability (next-session open).
  * `last_filed`          = MAX(`filed`)          — the most recent SEC filing date for the name.
Period-end ≠ availability ≠ filing date — the lake stores all three per fact.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

import pyarrow.parquet as pq

from no_edgar import NO_EDGAR

log = logging.getLogger("fundamentals-harvester.freshness")

_MS_PER_DAY = 86_400_000

# Default staleness window (a 10-Q filer): ≈ a reporting quarter (~90d) + a ~45d filing-grace buffer (a
# 10-Q lands weeks after period-end). 135 days. This is the QUARTERLY window — correct for a name filing 4
# reports a year.
DEFAULT_STALE_AFTER_DAYS = 135

# Staleness window for an ANNUAL filer (a foreign-private-issuer 20-F/40-F, or a domestic 10-K-only name).
# Such a name reports ONCE a year, so the freshest fiscal period_end is legitimately ~a year old between
# filings — the 135-day quarterly window would flag it stale every cycle. ≈ 365 days + a ~35d filing-grace
# buffer (a 20-F lands months after fiscal year-end). 400 days. Keyed off the name's actual filing cadence,
# so a 10-Q filer keeps the tighter 135-day window.
DEFAULT_STALE_AFTER_DAYS_ANNUAL = 400

# Form PREFIXES that mark an ANNUAL reporting cadence. 20-F / 40-F are the foreign-private-issuer annual
# reports (the TSM case); 10-K is the domestic annual. EDGAR amendments carry a `/A` suffix (`10-K/A`,
# `20-F/A`), so classification matches on the form PREFIX (before any `/A`). A name is treated as an annual
# filer when it has filed one of these AND has filed no recent 10-Q — NOT when one of these is the single
# newest filing.
_ANNUAL_FORM_PREFIXES = ("20-F", "40-F", "10-K")
_QUARTERLY_FORM_PREFIX = "10-Q"


def stale_after_ms_from_days(days: Optional[int]) -> int:
    """A quarterly staleness-window day count → milliseconds. `None`/non-positive ⇒ the 135-day default (a
    name can never be "never stale" here — that would silently disable the safe-to-retire gate)."""
    if days is None or days <= 0:
        return DEFAULT_STALE_AFTER_DAYS * _MS_PER_DAY
    return days * _MS_PER_DAY


def annual_stale_after_ms_from_days(days: Optional[int]) -> int:
    """The ANNUAL staleness-window day count → milliseconds. `None`/non-positive ⇒ the 400-day default. The
    annual window is floored at the quarterly one where both are applied (`freshness_audit`), so a once-a-
    year filer is never treated as MORE time-sensitive than a quarterly one even under inconsistent env
    knobs."""
    if days is None or days <= 0:
        return DEFAULT_STALE_AFTER_DAYS_ANNUAL * _MS_PER_DAY
    return days * _MS_PER_DAY


def _date_to_ms(d) -> Optional[int]:
    """A pyarrow `date32` (Python `date`) → UTC midnight epoch ms, or None. The lake stores `end`/`filed`
    as `date32`; the audit speaks UTC ms (matching `knowledge_ts`), so a period_end/filing date is anchored
    to its UTC-midnight instant."""
    if d is None:
        return None
    if isinstance(d, datetime):
        d = d.date()
    if not isinstance(d, date):
        return None
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp() * 1000)


def _form_prefix(form: Optional[str]) -> str:
    """The form type before any amendment suffix (`10-K/A` → `10-K`). Total — a None/empty form → ``."""
    if not form:
        return ""
    return form.split("/", 1)[0]


def lake_universe(lake: Path) -> list[str]:
    """Every currently-listed bare ticker in the lake's `ticker_history.parquet` — the DEFAULT universe
    when the caller supplies none.

    "Currently listed" == a ticker with an open validity range (`valid_to` is null): a delisted/renamed
    symbol's range is closed, so it is not part of the live audit set (its CIK's facts remain readable for
    a PIT as-of read, but it is not a name we expect to keep fresh). De-duplicated + sorted. An absent
    ticker_history (a cold lake before the first snapshot) yields [] — a well-formed empty audit, not an
    error."""
    path = lake / "ticker_history.parquet"
    if not path.exists():
        return []
    rows = pq.read_table(path, columns=["ticker", "valid_to"]).to_pylist()
    live = {r["ticker"].upper() for r in rows if r["ticker"] and r["valid_to"] is None}
    return sorted(live)


def _resolve_cik(lake: Path, symbol: str) -> Optional[int]:
    """Resolve a bare US symbol → its CIK off `ticker_history.parquet`. Prefers the currently-listed range
    (`valid_to` is null); falls back to the most recent historical range (max `valid_from`) so a symbol
    queried after a rename still resolves. None when the symbol is absent (never harvested / not a US
    filer)."""
    path = lake / "ticker_history.parquet"
    if not path.exists():
        return None
    rows = pq.read_table(path, columns=["cik", "ticker", "valid_from", "valid_to"]).to_pylist()
    sym = symbol.upper()
    matches = [r for r in rows if r["ticker"] and r["ticker"].upper() == sym]
    if not matches:
        return None
    open_ranges = [r for r in matches if r["valid_to"] is None]
    if open_ranges:
        return int(open_ranges[0]["cik"])
    # No open range (a symbol that has since been renamed/delisted) — take the most recent historical one.
    latest = max(matches, key=lambda r: r["valid_from"] or date.min)
    return int(latest["cik"])


def _cik_facts_summary(lake: Path, cik: int) -> Optional[dict]:
    """Read one CIK's `facts/cik=<cik:010d>.parquet` and reduce it to the freshness inputs, or None when
    the file is absent (the symbol resolved to a CIK but no facts have been harvested for it yet).

    Reads only the columns the audit needs (`end`, `knowledge_ts`, `filed`, `form`) — the per-CIK file is
    one company's facts (small), so a full column read is O(one file). Returns:
      * `newest_period_end`   — MAX(`end`) as UTC ms (the freshest fiscal period_end),
      * `newest_knowledge_ts` — MAX(`knowledge_ts`) (the freshest availability),
      * `last_filed`          — MAX(`filed`) as UTC ms (the most recent filing date),
      * `newest_annual_ts`    — MAX(`filed`) over annual forms (10-K/20-F/40-F, `/A`-tolerant) as UTC ms, or
                                None ⇒ no annual report on record,
      * `newest_quarterly_ts` — MAX(`filed`) over 10-Q (10-Q/A) as UTC ms, or None ⇒ no quarterly cadence.
    An empty fact file (zero rows) returns all-None — handled by the caller as covered-but-no-period (stale).
    """
    path = lake / "facts" / f"cik={cik:010d}.parquet"
    if not path.exists():
        return None
    rows = pq.read_table(path, columns=["end", "knowledge_ts", "filed", "form"]).to_pylist()
    if not rows:
        return {
            "newest_period_end": None,
            "newest_knowledge_ts": None,
            "last_filed": None,
            "newest_annual_ts": None,
            "newest_quarterly_ts": None,
        }

    def _max_ms(values) -> Optional[int]:
        vals = [v for v in values if v is not None]
        return max(vals) if vals else None

    period_end_ms = [_date_to_ms(r["end"]) for r in rows]
    filed_ms = [_date_to_ms(r["filed"]) for r in rows]
    knowledge = [int(r["knowledge_ts"]) for r in rows if r["knowledge_ts"] is not None]
    annual_filed = [
        _date_to_ms(r["filed"]) for r in rows if _form_prefix(r["form"]) in _ANNUAL_FORM_PREFIXES
    ]
    quarterly_filed = [
        _date_to_ms(r["filed"]) for r in rows if _form_prefix(r["form"]) == _QUARTERLY_FORM_PREFIX
    ]
    return {
        "newest_period_end": _max_ms(period_end_ms),
        "newest_knowledge_ts": max(knowledge) if knowledge else None,
        "last_filed": _max_ms(filed_ms),
        "newest_annual_ts": _max_ms(annual_filed),
        "newest_quarterly_ts": _max_ms(quarterly_filed),
    }


def _is_annual_cadence(summary: Optional[dict], *, now_ms: int, annual_ms: int) -> bool:
    """Classify a name as an ANNUAL filer from its per-CIK fact summary (or None when no facts exist).

    A name is annual when BOTH hold:
      * it has filed an annual form (`newest_annual_ts` present — a 10-K/20-F/40-F, amendments included),
        and
      * it has filed no 10-Q within the annual window (no `newest_quarterly_ts`, or that 10-Q is itself
        older than `annual_ms`).

    This does NOT require the annual form to be the *newest filing overall*: a real 20-F/10-K filer's recent
    filings are dominated by NEWER 6-K/8-K/Form-4 current reports, so the latest filing is almost never the
    annual report itself. Keying on "newest filing == the annual form" misclassified every real annual filer
    (TSM) as quarterly. The honest discriminator is filing CADENCE — does the name file 10-Qs?

    Everything else — a quarterly filer (recent 10-Q), or a name with no annual form / no facts at all — is
    treated as quarterly. Defaulting to quarterly on absent/ambiguous data is deliberate: the window only
    ever WIDENS for a name we positively know files annually, never on missing data (which would silently
    let a stale quarterly name look fresh and break the safe-to-retire gate)."""
    if summary is None:
        return False
    newest_annual = summary.get("newest_annual_ts")
    newest_quarterly = summary.get("newest_quarterly_ts")
    # No annual form on record ⇒ not an annual filer (a name that has only ever filed 6-K/8-K, or nothing).
    if newest_annual is None:
        return False
    # Files an annual report but ALSO a 10-Q within the annual window ⇒ still a quarterly cadence (a domestic
    # name files both a 10-K and 10-Qs; the recent 10-Q keeps it on the tighter window). Only the absence of
    # a *recent* 10-Q makes a name a once-a-year filer.
    if newest_quarterly is not None and (now_ms - newest_quarterly) <= annual_ms:
        return False
    return True


def freshness_audit(
    lake: Path,
    *,
    now_ms: int,
    symbols: Optional[list[str]] = None,
    stale_after_ms: Optional[int] = None,
    annual_stale_after_ms: Optional[int] = None,
) -> dict:
    """Per-name PIT coverage + staleness over the lake, for the supplied (or default) universe.

    `symbols` is the universe to audit — the BARE US symbols the caller (the portal) supplies. When None it
    defaults to every currently-listed bare ticker in the lake (`lake_universe`), so a bare call still
    returns a well-formed audit over what the lake knows without the harvester reading Mongo (the decoupling
    constraint: the universe is an INPUT, never a database hop inside the harvester).

    Per name: resolve the bare symbol → CIK via `ticker_history.parquet`, then read that CIK's per-CIK fact
    file for:
      * `covered`             — has at least one harvested fact with a period_end,
      * `newest_period_end`   — MAX(`end`) (freshest fiscal period_end),
      * `newest_knowledge_ts` — MAX(`knowledge_ts`) (freshest derived availability),
      * `last_filed`          — MAX(`filed`) (most recent SEC filing date),
      * `filing_cadence`      — `'annual'` (10-K/20-F/40-F, no recent 10-Q) | `'quarterly'` (the default,
                                incl. a name with no facts) — which staleness window applies,
      * `staleness_days`      — (now − newest_period_end) in whole days (None when uncovered),
      * `stale`               — (not covered) OR (now − newest_period_end > the name's window).

    `stale_after_ms` is the QUARTERLY window (a 10-Q filer; default 135d); `annual_stale_after_ms` the wider
    ANNUAL one (default 400d). The annual window is floored at the quarterly one so an annual filer is never
    treated as more time-sensitive than a quarterly one.

    The EDGAR-eligible denominator: `edgar_eligible = universe − NO_EDGAR`. `covered`/`missing`/`stale`/
    `coverage_pct`/`retirable` and `names[]` are computed over `edgar_eligible` ONLY, and `universe` is the
    eligible count — so a name that files nothing with the SEC (TCEHY) is NEVER counted `missing` (it would
    otherwise block `retirable` forever) and is surfaced in a distinct `no_edgar:[{symbol, reason}]` block.

    Returns `{universe, covered, missing, stale, coverage_pct, retirable, no_edgar_count, no_edgar:[…],
    names:[…]}`, where `retirable = (missing == 0 and stale == 0)` over the eligible denominator is the
    safe-to-harvest-completely gate. A cold lake yields every eligible name uncovered/stale with zero
    coverage — the correct pre-bootstrap state, not an error."""
    quarterly_window_ms = (
        stale_after_ms if stale_after_ms is not None else DEFAULT_STALE_AFTER_DAYS * _MS_PER_DAY
    )
    # The annual window defaults to 400d and is floored at the quarterly window (an annual filer is never
    # more time-sensitive than a quarterly one — guards a misconfigured override where annual < quarterly).
    annual_window_ms = (
        annual_stale_after_ms
        if annual_stale_after_ms is not None
        else DEFAULT_STALE_AFTER_DAYS_ANNUAL * _MS_PER_DAY
    )
    annual_window_ms = max(annual_window_ms, quarterly_window_ms)

    universe = symbols if symbols is not None else lake_universe(lake)
    universe_sorted = sorted({s.upper() for s in universe if s and s.strip()})

    # Partition into the EDGAR-eligible denominator and the excluded NO_EDGAR set. A NO_EDGAR name files
    # nothing with the SEC, so it can never be covered — excluding it keeps it OUT of
    # missing/stale/retirable and the per-name table, and surfaces it in its own block instead. Keys are
    # bare uppercase, the same alphabet the universe is normalised to.
    excluded = [sym for sym in universe_sorted if sym in NO_EDGAR]
    edgar_eligible = [sym for sym in universe_sorted if sym not in NO_EDGAR]
    no_edgar_names = [{"symbol": sym, "reason": NO_EDGAR[sym]} for sym in excluded]

    names: list[dict] = []
    covered_count = 0
    stale_count = 0
    for sym in edgar_eligible:
        cik = _resolve_cik(lake, sym)
        summary = _cik_facts_summary(lake, cik) if cik is not None else None
        newest_period_end = summary.get("newest_period_end") if summary else None
        covered = newest_period_end is not None

        # Pick the per-name staleness window from its filing cadence: an annual filer (10-K/20-F/40-F with no
        # recent 10-Q) gets the wider annual window; everything else (a quarterly filer, or a name with no
        # facts) keeps the quarterly window. Label + window derive from the same classifier so they never
        # drift.
        is_annual = _is_annual_cadence(summary, now_ms=now_ms, annual_ms=annual_window_ms)
        filing_cadence = "annual" if is_annual else "quarterly"
        name_window_ms = annual_window_ms if is_annual else quarterly_window_ms

        # Staleness is anchored on the freshest fiscal period we hold. Uncovered ⇒ no age, stale by
        # definition.
        if newest_period_end is not None:
            age_ms = max(0, now_ms - newest_period_end)
            staleness_days = age_ms // _MS_PER_DAY
            stale = age_ms > name_window_ms
        else:
            staleness_days = None
            stale = True

        if covered:
            covered_count += 1
        if stale:
            stale_count += 1

        names.append({
            "symbol": sym,
            "cik": cik,
            "covered": covered,
            "newest_period_end": newest_period_end,
            "newest_knowledge_ts": summary.get("newest_knowledge_ts") if summary else None,
            "last_filed": summary.get("last_filed") if summary else None,
            "filing_cadence": filing_cadence,
            "staleness_days": staleness_days,
            "stale": stale,
        })

    # The denominator is the EDGAR-eligible set (universe − NO_EDGAR), so coverage/missing/stale and the
    # retirable gate are computed only over names that CAN be harvested from EDGAR.
    n = len(edgar_eligible)
    missing = n - covered_count
    coverage_pct = round(100.0 * covered_count / n, 2) if n else 0.0
    return {
        "universe": n,
        "covered": covered_count,
        "missing": missing,
        "stale": stale_count,
        "coverage_pct": coverage_pct,
        # The headline gate: every EDGAR-eligible name harvested AND none stale.
        "retirable": missing == 0 and stale_count == 0,
        # The excluded set — names that file nothing with the SEC — surfaced with reasons so the portal
        # renders a documented exception, NOT a silent `missing`.
        "no_edgar_count": len(no_edgar_names),
        "no_edgar": no_edgar_names,
        "names": names,
    }

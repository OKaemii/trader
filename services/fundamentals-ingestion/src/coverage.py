"""Coverage resolver — which US tickers the ingestion run covers (epic Task 9).

The cron/backfill set is the plan's **active T212 universe ∪ point-in-time US S&P 500 members**
(Design §9 "Coverage"): the names the live platform trades plus every name that was *ever* an index
member over the window, so a survivorship-free research warehouse never references a name whose
fundamentals were never ingested. NOT the full ~15k-CIK market — that is research-confirmed out of
scope; a small default cap (`FUNDAMENTALS_COVERAGE_CAP`) keeps a first backfill bounded.

TWO MONGO SOURCES, one normalised output:
  * `instrument_registry` (active universe): the rows with `activeTo == null` carry a T212 `ticker`
    (e.g. `AAPL_US_EQ`). This is the SAME read the research-backfill migration does
    (`loadActiveUniverse` → `{activeTo:null}` projecting `ticker`).
  * `index_constituents` (US S&P point-in-time membership, ingested by
    `backtest-engine .../ingest_sp500_history.py`): interval rows `{index, ticker, effective_from,
    effective_to}` where `ticker` is a BARE symbol (`AAPL`). `quant_core.universe.active_union`
    resolves the every-name-over-the-window set from these — reused here, not re-implemented.

The two speak different alphabets — T212 suffixes vs bare S&P symbols — so this module NORMALISES both
to a **bare uppercase US symbol** (the alphabet EDGAR's `company_tickers.json` keys on, so the
orchestrator can map symbol→CIK). A T212 `AAPL_US_EQ` → `AAPL`; an S&P `AAPL` is already bare. Only US
names are in scope for the EDGAR (US) phase — a UK `*l_EQ` T212 ticker is dropped here (Companies House
is the gated UK phase, Tasks 16–19), never sent to EDGAR where it has no CIK.

COVERAGE TRACKS THE CURATED UNIVERSE — NEVER TRUNCATED. Fundamentals exist to back the names we
actually hold, so every curated-universe US symbol is ALWAYS in the coverage set: the cap NEVER drops a
held name. The cap bounds ONLY the extra S&P index-history remainder (the survivorship-free backtest
tail) — the part that can be large and is the only piece safe to bound on a first/bounded backfill. A
cap *below* the universe size therefore still covers the whole universe (the index remainder is simply
empty), rather than head-truncating the held set.

NO PRUNE — APPEND-ONLY. A name that drops OUT of `instrument_registry` (de-listed, re-curated away)
simply stops appearing here, so the nightly/heal walk stops *refreshing* it — but its already-ingested
bi-temporal `fundamentals` rows are NEVER deleted. The warehouse is append-only and hash-gated, so
re-curating the name returns it to this set and the next walk tops it up (writing only genuinely-new
facts), while an as-of read over the dropped-out gap still returns what was knowable then. Coverage is
the refresh frontier, not a retention policy — this module never removes anything; it only chooses what
to (re)fetch.

The pure functions (`bare_us_symbol`, `resolve_coverage`) carry the set logic and unit-test without a
database; `load_coverage` is the thin Mongo wrapper (motor) the cron calls at the composition root.
"""
from __future__ import annotations

import logging
import os
from typing import Iterable, Optional

from quant_core.fundamentals import MARKET_OTHER, market_of
from quant_core.universe import active_union

log = logging.getLogger("fundamentals-ingestion.coverage")

# Mongo collection names — mirrored from packages/shared-mongo/src/collections.ts
# (INSTRUMENT_REGISTRY / INDEX_CONSTITUENTS). The single source of truth is that file; these are the
# read-only names the cron joins against, kept as constants so the spelling is shared, not re-typed.
COLL_INSTRUMENT_REGISTRY = "instrument_registry"
COLL_INDEX_CONSTITUENTS = "index_constituents"

# The US S&P index key the sp500-history ingest stamps (`data_source='fja05680_sp500_csv'`, index='sp500').
INDEX_SP500 = "sp500"

# Default coverage cap — a first US backfill is bounded (the plan: "a small default cap is fine; full
# market is out of scope, research-confirmed"). 0/absent ⇒ uncapped (the operator opts into the full
# universe+index set once the per-name cost is understood). Overridable via FUNDAMENTALS_COVERAGE_CAP.
DEFAULT_COVERAGE_CAP = 64

# `fundamentalsCoverage` mode (global.env). The plan names `universe_plus_index`; the cron passes it
# through so a future mode (universe-only, index-only) is a values change, not a code change.
COVERAGE_UNIVERSE_PLUS_INDEX = "universe_plus_index"
COVERAGE_UNIVERSE_ONLY = "universe_only"
COVERAGE_INDEX_ONLY = "index_only"


def bare_us_symbol(ticker: str) -> Optional[str]:
    """A T212-or-bare ticker → its bare uppercase US symbol, or None when it is not a US name.

    `AAPL_US_EQ` → `AAPL`; a bare `AAPL` → `AAPL`; a UK `VODl_EQ` (or any other non-US T212 suffix) →
    None (out of scope for the EDGAR phase — it has no US CIK). The jurisdiction decision is taken on
    the RAW ticker via the shared `market_of` router (whose suffix matching is case-sensitive — `l_EQ`
    for UK — so it must see the un-uppercased symbol), THEN the US `_US_EQ` suffix is stripped and the
    result uppercased. A symbol with no recognised T212 suffix is treated as an already-bare US symbol
    (the alphabet the S&P `index_constituents` rows store)."""
    raw = ticker.strip()
    if not raw:
        return None
    # US `_US_EQ` is unambiguous → match case-insensitively + strip (instrument_registry stores it
    # uppercase, but tolerate any case). market_of's UK `l_EQ` check IS case-sensitive, so the UK/other
    # routing below operates on the raw symbol it expects.
    if raw.upper().endswith("_US_EQ"):
        return raw[: -len("_US_EQ")].upper() or None
    if market_of(raw) != MARKET_OTHER:
        # A recognised NON-US T212 suffix (UK `l_EQ`, …) → dropped (no US CIK).
        return None
    # market_of == OTHER: either a bare symbol (S&P alphabet) OR an unrecognised `*_EQ` T212 ticker we
    # can't route to the US. A residual `_EQ` marker ⇒ a non-US tradeable line → drop; otherwise bare.
    up = raw.upper()
    if "_EQ" in up:
        return None
    return up


def _bare_set(tickers: Iterable[str]) -> set[str]:
    """Map an iterable of tickers to the set of in-scope bare US symbols (dropping non-US names)."""
    out: set[str] = set()
    for t in tickers:
        sym = bare_us_symbol(t)
        if sym:
            out.add(sym)
    return out


def resolve_coverage(
    *,
    universe_tickers: Iterable[str],
    index_rows: Iterable[dict],
    window_lo_ms: int,
    window_hi_ms: Optional[int] = None,
    mode: str = COVERAGE_UNIVERSE_PLUS_INDEX,
    cap: Optional[int] = DEFAULT_COVERAGE_CAP,
) -> list[str]:
    """The coverage set — bare US symbols, sorted, de-duplicated; the cap bounds only the index tail.

    `universe_tickers` are the active T212 symbols (`instrument_registry.ticker`, `activeTo==null`);
    `index_rows` are the `index_constituents` interval docs. `active_union(index_rows, lo, hi)` gives
    the survivorship-free set of every S&P member over `[window_lo_ms, window_hi_ms]` (the same pure
    resolver the validator uses). The two are normalised to bare US symbols and unioned per `mode`:
      * `universe_plus_index` (default) — the full curated universe PLUS the index-history remainder;
      * `universe_only` / `index_only` — the single source.

    The cap (None/0 ⇒ uncapped) NEVER truncates the curated `universe`: fundamentals track what we
    hold, so the whole universe is always covered. The cap bounds ONLY the extra `index_only` remainder
    (the survivorship-free backtest tail), so a `cap < len(universe)` still keeps every held name and
    just yields an empty remainder — it never head-truncates the held set (the bug this replaces, which
    capped the *combined* list and dropped held names when `cap < |universe|`). The remainder budget is
    `max(0, cap - len(universe))`. In `index_only` mode (no universe to protect) the cap bounds the
    sorted index directly. The cap is applied AFTER sorting so the kept subset is deterministic
    (alphabetical) rather than dependent on Mongo iteration order. NO PRUNE: see the module docstring —
    a name leaving the universe stops being refreshed but keeps its bi-temporal rows."""
    universe = _bare_set(universe_tickers)
    index = _bare_set(active_union(index_rows, window_lo_ms, window_hi_ms))
    capped = cap is not None and cap > 0

    if mode == COVERAGE_UNIVERSE_ONLY:
        # The universe is never truncated — the cap has nothing to bound here.
        return sorted(universe)
    if mode == COVERAGE_INDEX_ONLY:
        # No held universe to protect → the cap bounds the sorted index directly.
        index_sorted = sorted(index)
        return index_sorted[:cap] if capped else index_sorted

    # universe_plus_index (default + any unrecognised mode → the safe superset): the full universe is
    # always covered; the cap bounds ONLY the index-only remainder via its leftover budget. Both halves
    # are alphabetised so the kept set is deterministic.
    universe_sorted = sorted(universe)
    index_only = sorted(index - universe)
    if capped:
        budget = max(0, cap - len(universe_sorted))
        return universe_sorted + index_only[:budget]
    return universe_sorted + index_only


def coverage_cap_from_env() -> Optional[int]:
    """The coverage cap from `FUNDAMENTALS_COVERAGE_CAP` (falls back to `DEFAULT_COVERAGE_CAP`).
    `0` (or a negative / unparseable value) ⇒ uncapped (None) — the operator's explicit opt-in to the
    full universe+index set."""
    raw = os.getenv("FUNDAMENTALS_COVERAGE_CAP", "")
    if not raw:
        return DEFAULT_COVERAGE_CAP
    try:
        n = int(raw)
    except ValueError:
        return DEFAULT_COVERAGE_CAP
    return n if n > 0 else None


async def load_coverage(
    mongo_db,
    *,
    window_lo_ms: int,
    window_hi_ms: Optional[int] = None,
    mode: str = COVERAGE_UNIVERSE_PLUS_INDEX,
    cap: Optional[int] = DEFAULT_COVERAGE_CAP,
    index: str = INDEX_SP500,
) -> list[str]:
    """Read the two Mongo sources and resolve the coverage set (the cron's composition-root call).

    `mongo_db` is a motor database handle. Reads the active universe (`instrument_registry`,
    `activeTo==null`, projecting `ticker`) and the US S&P membership intervals (`index_constituents`,
    `index==index`), then delegates to the pure `resolve_coverage`. Network/read errors degrade to the
    other source rather than aborting (a missing index collection still yields the universe; a missing
    universe still yields the index) — partial coverage beats no coverage, and the next run retries."""
    universe_tickers: list[str] = []
    index_rows: list[dict] = []

    if mode != COVERAGE_INDEX_ONLY:
        try:
            cursor = mongo_db[COLL_INSTRUMENT_REGISTRY].find(
                {"activeTo": None}, {"_id": 0, "ticker": 1}
            )
            async for doc in cursor:
                tk = doc.get("ticker")
                if isinstance(tk, str) and tk:
                    universe_tickers.append(tk)
        except Exception as exc:  # noqa: BLE001 — degrade to the index source, never abort the run
            log.warning("[coverage] instrument_registry read failed (%s): %s", type(exc).__name__, exc)

    if mode != COVERAGE_UNIVERSE_ONLY:
        try:
            cursor = mongo_db[COLL_INDEX_CONSTITUENTS].find(
                {"index": index},
                {"_id": 0, "ticker": 1, "effective_from": 1, "effective_to": 1},
            )
            async for doc in cursor:
                index_rows.append(doc)
        except Exception as exc:  # noqa: BLE001 — degrade to the universe source, never abort the run
            log.warning("[coverage] index_constituents read failed (%s): %s", type(exc).__name__, exc)

    coverage = resolve_coverage(
        universe_tickers=universe_tickers,
        index_rows=index_rows,
        window_lo_ms=window_lo_ms,
        window_hi_ms=window_hi_ms,
        mode=mode,
        cap=cap,
    )
    log.info(
        "[coverage] resolved %d US symbols (mode=%s, universe=%d, index_rows=%d, cap=%s)",
        len(coverage), mode, len(universe_tickers), len(index_rows), cap,
    )
    return coverage

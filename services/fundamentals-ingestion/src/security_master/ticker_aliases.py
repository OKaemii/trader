"""Curated ticker → CIK alias table — the rename / ADR / new-IPO bridge for the no_cik path.

The stable EDGAR key is the **CIK**, which is rename-invariant: when a filer renames its ticker
(Facebook → Meta) the SEC's bulk `company_tickers.json` map carries ONLY the current symbol, so the
legacy symbol resolves to nothing and the orchestrator skips it `no_cik` — even though the issuer's
filings (and therefore its fundamentals) are still right there under the unchanged CIK. This module is
the small, explicit, append-only bridge the orchestrator consults BEFORE giving up on a symbol the SEC
ticker snapshot misses: a legacy/renamed symbol, or a freshly-listed name (a new IPO / a newly-sponsored
ADR) that post-dates even a daily SEC snapshot.

WHY A CURATED TABLE, NOT A HEURISTIC. There is no programmatic "what was this ticker before" feed in the
free tier; a rename is a discrete, auditable fact (Meta's 2022-06-09 rebrand). So each bridge is an
explicit, dated, commented entry an operator added — never a guessed CIK. A symbol we cannot map to a
real CIK is NOT invented here; it either resolves natively from the SEC map (e.g. SPCX, which the bulk
map already carries) or it genuinely files nothing with the SEC and belongs in the enumerated
`NO_EDGAR` exception set (a later card), where it is surfaced as a documented degrade-to-Yahoo name —
not silently counted `missing`.

CONTRACT WITH THE SECURITY MASTER. An alias hit ingests the filer under the resolved CIK; the rename
itself is then recorded append-only via the effective-dated `ID_TICKER` identifiers — the PRIOR symbol's
interval closed at `since_ms`, the CURRENT symbol open from it (`SecurityMasterWriter.record_ticker_change`).
That is a *resolution* concern: it never rewrites a `fundamentals` fact. `since_ms` is the instant the
current symbol became effective (the rename date for a rename; the first-listing date for a new filer),
which is exactly the boundary the as-of interval resolver needs so a replay before the rename still
resolves the legacy symbol.

BOTH SYMBOLS ARE KEYED. The map carries the legacy symbol (so a historical/replay reference to `FB`
bridges) AND the current symbol (so the live universe's `META` bridges should the SEC snapshot ever lag
the rename). Both point at the same CIK; the `note` records which side of the rename each is.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional


def _ts(date_str: str) -> int:
    """A `YYYY-MM-DD` calendar date → UTC-midnight ms — the `since_ms` an alias entry is dated with.
    Kept tiny + total so the table reads as dated facts rather than magic integers."""
    return int(datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


@dataclass(frozen=True)
class TickerAlias:
    """One curated bridge from a T212/legacy symbol to its stable EDGAR CIK.

    `cik` is the zero-padded 10-digit EDGAR central index key (rename-invariant). `since_ms` is the
    UTC-ms instant the CURRENT symbol became effective (the rename date, or a new filer's first-listing
    date) — the boundary the effective-dated identifier interval is closed/opened at. `note` is a short,
    human-auditable reason (`renamed_to META` / `rename_target` / `new_ipo` / `adr`)."""

    cik: str
    since_ms: int
    note: str


# Seeded with the operator-named cases. KEY is the BARE uppercase symbol (the orchestrator upper-cases
# the coverage symbol before the lookup, matching `build_ticker_cik_map`'s normalisation).
#
# Verified against the live SEC `company_tickers.json` during this task (2026-06-10):
#   * FB    — ABSENT from the bulk map (the rename dropped the legacy symbol) ⇒ the bridge is load-bearing.
#   * META  — present in the map at this same CIK; kept here too so a snapshot that ever lags the rename
#             still resolves it, and so the rename is recorded from either ingestion order.
#   * SPCX  — the bulk map ALREADY carries it (CIK 0001181412, Space Exploration Technologies); it resolves
#             natively, so it needs NO alias entry (this table is only for symbols the SEC map misses).
#   * TCEHY — Tencent's UNSPONSORED ADR files nothing with the SEC (ABSENT from the map and no CIK to
#             bridge to) ⇒ it belongs in the enumerated NO_EDGAR exception set (a later card), NOT here:
#             we never fabricate a CIK for a name that genuinely does not file.
TICKER_ALIASES: dict[str, TickerAlias] = {
    "FB":   TickerAlias(cik="0001326801", since_ms=_ts("2022-06-09"), note="renamed_to META"),
    "META": TickerAlias(cik="0001326801", since_ms=_ts("2022-06-09"), note="rename_target"),
}


def resolve_alias(symbol: str) -> Optional[TickerAlias]:
    """The bare/cased symbol → its curated `TickerAlias`, or None when there is no bridge.

    Total + side-effect-free (the orchestrator's no_cik path calls it after the SEC map misses); the
    caller upper-cases the coverage symbol, but we upper-case here too so a direct caller is tolerant."""
    return TICKER_ALIASES.get(symbol.strip().upper())

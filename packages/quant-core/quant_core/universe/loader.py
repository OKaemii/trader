"""Resolve point-in-time index membership from `index_constituents` interval rows.

Pure over an injected list of rows (the caller does the Mongo read), so the as-of logic is
unit-testable without a database. A row is `{ticker, effective_from, effective_to|None}`;
membership at instant t is `effective_from <= t < effective_to` (open-ended when effective_to
is None). The validator uses `active_union` to decide which names to *fetch* over the whole
window, and `load_constituents` to decide who is *held* at each rebalance instant.
"""
from __future__ import annotations

from typing import Iterable, Optional


def _member_at(row: dict, as_of_ms: int) -> bool:
    frm = row.get("effective_from")
    if frm is None or as_of_ms < frm:
        return False
    to = row.get("effective_to")
    return to is None or as_of_ms < to


def load_constituents(rows: Iterable[dict], as_of_ms: int) -> list[str]:
    """Tickers that were index members at `as_of_ms`, sorted and de-duplicated."""
    return sorted({row["ticker"] for row in rows if _member_at(row, as_of_ms)})


def active_union(rows: Iterable[dict], lo_ms: int, hi_ms: Optional[int] = None) -> list[str]:
    """Every ticker that was a member at *any* point in [lo_ms, hi_ms] — the set to prefetch so a
    survivorship-free walk never references a name whose history was never loaded. An interval
    overlaps the window iff it starts before the window ends and ends after the window starts."""
    out: set[str] = set()
    for row in rows:
        frm = row.get("effective_from")
        if frm is None:
            continue
        to = row.get("effective_to")
        starts_before_end = hi_ms is None or frm <= hi_ms
        ends_after_start = to is None or to > lo_ms
        if starts_before_end and ends_after_start:
            out.add(row["ticker"])
    return sorted(out)

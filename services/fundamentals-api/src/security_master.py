"""Read-side ticker → instrument_id resolution over the shared `security_master` schema.

The `fundamentals` PK keys on `instrument_id`, but the read API's callers (the live seam, the headline
`/pit` endpoint) speak T212 tickers. This module resolves a ticker to the instrument it identifies,
as-of aware, by reading the effective-dated `security_master.identifiers` rows the write-side service
(epic Task 4) lands — the canonical FB→META case: `resolve_instrument("META", 2019-01-01)` reaches the
FB-era instrument so a past-date read picks the right fundamentals.

WHY a focused copy here rather than importing the write-side service's resolver: services do not import
each other's `src/` (the deployed image COPYies only THIS service's `src`), so the read API carries its
own thin resolver over the SAME shared schema. It reproduces the relevant slice of
`services/fundamentals-ingestion/src/security_master/resolver.py` — the `resolve_instrument` path the
fact-read uses — keeping the resolution RULE pure (`_resolve_interval`, exhaustively unit-tested without
a DB) and this class to the thin candidate SELECT + delegation. SELECT-only (the `secmaster_reader`
surface); it never writes.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

ID_TICKER = "ticker"


@dataclass(frozen=True)
class _Interval:
    """One effective-dated identifier interval joined to its instrument's columns."""

    instrument_id: int
    identifier_value: str
    effective_from: int
    effective_to: Optional[int]
    company_id: int
    t212_ticker: Optional[str]


@dataclass(frozen=True)
class ResolvedInstrument:
    """The instrument a ticker resolved to at an as-of instant. `instrument_id` is rename-invariant —
    the whole point of the effective-dated security master, so a past-date fundamentals read joins on
    the right id regardless of a later ticker rename."""

    instrument_id: int
    company_id: int
    t212_ticker: Optional[str]


def _effective_to_closed(intervals: list[_Interval], queried_value: str) -> dict[int, Optional[int]]:
    """Per identifier-interval of `queried_value`, the read-time-closed upper bound. The write side
    stores a prior ticker's interval open (`effective_to=NULL`) and closes it on read: a NULL upper
    bound is closed at the NEXT interval's `effective_from` on the SAME instrument (so FB's implicit end
    is META's start). Keyed by the row's identity within `intervals` (its index)."""
    closed: dict[int, Optional[int]] = {}
    for idx, iv in enumerate(intervals):
        if iv.identifier_value != queried_value:
            continue
        if iv.effective_to is not None:
            closed[idx] = iv.effective_to
            continue
        # NULL upper bound — close at the soonest later interval start on the same instrument.
        successor = min(
            (
                o.effective_from
                for o in intervals
                if o.instrument_id == iv.instrument_id and o.effective_from > iv.effective_from
            ),
            default=None,
        )
        closed[idx] = successor
    return closed


def _resolve_interval(
    intervals: list[_Interval], queried_value: str, as_of_ms: int
) -> Optional[_Interval]:
    """Strict in-interval match: the interval of `queried_value` in force at `as_of_ms`
    (`effective_from <= as_of < effective_to`, with the read-time-closed upper bound). None if the
    queried value wasn't the live identifier at as_of."""
    closed = _effective_to_closed(intervals, queried_value)
    best: Optional[_Interval] = None
    for idx, iv in enumerate(intervals):
        if iv.identifier_value != queried_value:
            continue
        if iv.effective_from > as_of_ms:
            continue
        upper = closed.get(idx)
        if upper is not None and as_of_ms >= upper:
            continue
        if best is None or iv.effective_from > best.effective_from:
            best = iv
    return best


def _resolve_instrument_id(
    intervals: list[_Interval], queried_value: str, as_of_ms: int
) -> Optional[int]:
    """The instrument `queried_value` names, with the present-identity fallback: a strict match first
    (the value was live at as_of), else the instrument carried by this value's most-recent interval (the
    `resolve_instrument("META", 2019)` → FB-era instrument case — META is today's name, asked about a
    past date)."""
    strict = _resolve_interval(intervals, queried_value, as_of_ms)
    if strict is not None:
        return strict.instrument_id
    latest = max(
        (iv for iv in intervals if iv.identifier_value == queried_value),
        key=lambda iv: iv.effective_from,
        default=None,
    )
    return latest.instrument_id if latest is not None else None


class SecurityMasterResolver:
    """As-of ticker → instrument resolution. Inject an asyncpg.Pool; SELECT-only."""

    def __init__(self, pool) -> None:
        self._pool = pool

    async def _candidate_intervals(self, identifier_value: str) -> list[_Interval]:
        """Every `ticker`-typed interval on any instrument that ever carried `identifier_value`, joined
        to instruments. Including the siblings is what gives the rule the successor it needs to close an
        open prior interval on read."""
        async with self._pool.acquire() as conn:
            records = await conn.fetch(
                """
                SELECT
                    i.instrument_id,
                    i.identifier_value,
                    i.effective_from,
                    i.effective_to,
                    inst.company_id,
                    inst.t212_ticker
                FROM security_master.identifiers i
                JOIN security_master.instruments inst ON inst.instrument_id = i.instrument_id
                WHERE i.identifier_type = $1
                  AND i.instrument_id IN (
                      SELECT instrument_id FROM security_master.identifiers
                      WHERE identifier_type = $1 AND identifier_value = $2
                  )
                """,
                ID_TICKER, identifier_value,
            )
        return [
            _Interval(
                instrument_id=int(r["instrument_id"]),
                identifier_value=r["identifier_value"],
                effective_from=int(r["effective_from"]),
                effective_to=(int(r["effective_to"]) if r["effective_to"] is not None else None),
                company_id=int(r["company_id"]),
                t212_ticker=r["t212_ticker"],
            )
            for r in records
        ]

    async def _direct_t212(self, t212_ticker: str) -> Optional[ResolvedInstrument]:
        """The fallback join: a pure T212 symbol may have no `ticker`-typed identifier row (identifiers
        carry display tickers; the t212 symbol lives on `instruments.t212_ticker`), so resolve it
        directly off the instrument when the effective-dated path misses."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT inst.instrument_id, inst.company_id, inst.t212_ticker
                   FROM security_master.instruments inst
                   WHERE inst.t212_ticker = $1
                   LIMIT 1""",
                t212_ticker,
            )
        if row is None:
            return None
        return ResolvedInstrument(
            instrument_id=int(row["instrument_id"]),
            company_id=int(row["company_id"]),
            t212_ticker=row["t212_ticker"],
        )

    async def resolve_instrument(
        self, ticker: str, as_of_ms: Optional[int] = None
    ) -> Optional[ResolvedInstrument]:
        """Resolve a T212 ticker to its instrument row, as-of aware.

        With `as_of_ms`: route through the effective-dated ticker resolution first (so a renamed/ reused
        symbol resolves to the right era), then fall back to the direct `instruments.t212_ticker` join.
        Without `as_of_ms` (live): the direct join (the current instrument carrying the symbol). None
        when the ticker doesn't resolve at all — the caller degrades that name to `{}`."""
        if as_of_ms is not None:
            intervals = await self._candidate_intervals(ticker)
            instrument_id = _resolve_instrument_id(intervals, ticker, as_of_ms)
            if instrument_id is not None:
                match = next((iv for iv in intervals if iv.instrument_id == instrument_id), None)
                if match is not None:
                    return ResolvedInstrument(
                        instrument_id=instrument_id,
                        company_id=match.company_id,
                        t212_ticker=match.t212_ticker,
                    )
            # Fall through to the direct join (a pure t212 symbol with no ticker-typed identifier row).
        return await self._direct_t212(ticker)

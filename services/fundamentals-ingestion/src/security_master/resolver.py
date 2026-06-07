"""Effective-dated entity resolution — the headline of epic Task 4.

`resolve_symbol(ticker, as_of)` answers "which instrument did this ticker point at on this date?"
by reading the effective-dated `security_master.identifiers` rows. The canonical case is the FB→META
rename: `resolve_symbol("FB", 2019-01-01)` and `resolve_symbol("META", 2023-01-01)` BOTH resolve to
the *same* instrument, while `resolve_symbol("META", 2019-01-01)` resolves it too (META is the name
the instrument carries today, asked about a past date) and `resolve_symbol("FB", 2023-01-01)` does
NOT (FB's interval had closed by then).

SEPARATION OF CONCERNS — the resolution RULE lives in `intervals.py` (pure, exhaustively unit-tested
without a DB); THIS module does only the thin candidate SELECT + delegation. The SELECT pulls every
interval for the instrument(s) that ever carried the queried value, so the queried value's SUCCESSOR
interval is present for the read-time closure that `resolve_interval` performs (see intervals.py for
the rule + why the FB row's implicit end is META's `effective_from`).

The `secmaster_writer` role is append-only (no UPDATE), so a prior ticker interval may be stored open
(`effective_to=NULL`) and only closed on read — which is exactly what the pure resolver handles.

All methods take an injected `asyncpg.Pool` and only SELECT (`secmaster_reader` surface)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .intervals import IdentifierInterval, resolve_instrument_id, resolve_interval
from .writers import ID_FIGI, ID_TICKER


@dataclass(frozen=True)
class ResolvedInstrument:
    """The instrument an identifier resolved to at an as-of instant, with the matched interval and
    the owning company's CIK (for the EDGAR fact join). `effective_to` is the row's STORED upper
    bound (NULL ⇒ it was open in storage; the read-time successor close is applied during matching
    but not back-written, since the table is append-only).

    `valid_at_as_of` distinguishes the two resolution paths the headline needs: True when the queried
    identifier string was itself in force at `as_of` (the strict interval match — `resolve_symbol("FB",
    2019)`); False when the instrument was reached by its PRESENT identity for a past `as_of` at which
    that string wasn't yet the ticker (`resolve_symbol("META", 2019)` → the FB-era instrument). Either
    way `instrument_id`/`cik` are correct (they are rename-invariant); the flag just tells a caller
    whether the matched_value was the literal as-of ticker."""

    instrument_id: int
    company_id: int
    t212_ticker: Optional[str]
    cik: Optional[str]
    matched_value: str
    effective_from: int
    effective_to: Optional[int]
    valid_at_as_of: bool = True


def _to_resolved(interval: IdentifierInterval, *, valid_at_as_of: bool) -> ResolvedInstrument:
    return ResolvedInstrument(
        instrument_id=interval.instrument_id,
        company_id=interval.company_id,
        t212_ticker=interval.t212_ticker,
        cik=interval.cik,
        matched_value=interval.identifier_value,
        effective_from=interval.effective_from,
        effective_to=interval.effective_to,
        valid_at_as_of=valid_at_as_of,
    )


class SecurityMasterResolver:
    """As-of reads over the effective-dated identifiers. Inject an asyncpg.Pool."""

    def __init__(self, pool) -> None:
        self._pool = pool

    async def _candidate_intervals(
        self, identifier_type: str, identifier_value: str
    ) -> list[IdentifierInterval]:
        """Fetch every interval of `identifier_type` belonging to any instrument that ever carried
        `identifier_value`. Including the siblings (other values on the same instrument) is what gives
        `resolve_interval` the successor it needs to close an open-ended prior interval on read."""
        async with self._pool.acquire() as conn:
            records = await conn.fetch(
                """
                SELECT
                    i.instrument_id,
                    i.identifier_type,
                    i.identifier_value,
                    i.effective_from,
                    i.effective_to,
                    inst.company_id,
                    inst.t212_ticker,
                    c.cik
                FROM security_master.identifiers i
                JOIN security_master.instruments inst ON inst.instrument_id = i.instrument_id
                JOIN security_master.companies   c    ON c.company_id      = inst.company_id
                WHERE i.identifier_type = $1
                  AND i.instrument_id IN (
                      SELECT instrument_id FROM security_master.identifiers
                      WHERE identifier_type = $1 AND identifier_value = $2
                  )
                """,
                identifier_type, identifier_value,
            )
        return [
            IdentifierInterval(
                instrument_id=int(r["instrument_id"]),
                identifier_type=r["identifier_type"],
                identifier_value=r["identifier_value"],
                effective_from=int(r["effective_from"]),
                effective_to=(int(r["effective_to"]) if r["effective_to"] is not None else None),
                company_id=int(r["company_id"]),
                t212_ticker=r["t212_ticker"],
                cik=r["cik"],
            )
            for r in records
        ]

    async def _resolve_by_identifier(
        self, identifier_type: str, identifier_value: str, as_of_ms: int
    ) -> Optional[ResolvedInstrument]:
        """Resolve `identifier_value` to its instrument with the headline as-of fallback:
        strict in-interval match first (the string was the live identifier at `as_of`), else the
        instrument named by this value's most-recent interval (present identity → past as_of)."""
        rows = await self._candidate_intervals(identifier_type, identifier_value)
        # Strict: was this exact value in force at as_of?
        strict = resolve_interval(rows, identifier_value, as_of_ms)
        if strict is not None:
            return _to_resolved(strict, valid_at_as_of=True)
        # Fallback: the instrument this value names today (or in its latest interval). Pull that
        # interval out so the returned row still carries the instrument's join columns.
        instrument_id = resolve_instrument_id(rows, identifier_value, as_of_ms)
        if instrument_id is None:
            return None
        latest = max(
            (r for r in rows if r.identifier_value == identifier_value),
            key=lambda r: r.effective_from,
            default=None,
        )
        return _to_resolved(latest, valid_at_as_of=False) if latest is not None else None

    async def resolve_symbol(self, ticker: str, as_of_ms: int) -> Optional[ResolvedInstrument]:
        """Resolve a *ticker* to the instrument it identifies, honouring the headline FB→META case.

        `resolve_symbol("FB", 2019)` and `resolve_symbol("META", 2019)` BOTH return the same FB-era
        instrument (META reaches it via the present-identity fallback; the returned
        `valid_at_as_of=False` flags that "META" wasn't the literal 2019 ticker); `resolve_symbol("FB",
        2023)` ALSO returns it (FB names the instrument; valid_at_as_of=False since FB closed in 2022).
        The instrument + CIK are rename-invariant, so the caller reads the right fundamentals as-of
        whichever date — the whole point of the effective-dated security master."""
        return await self._resolve_by_identifier(ID_TICKER, ticker, as_of_ms)

    async def resolve_figi(self, figi: str, as_of_ms: int) -> Optional[ResolvedInstrument]:
        """Resolve a FIGI as-of `as_of_ms`. FIGI is share-class-stable across a ticker rename, so it
        is the identifier that survives FB→META unchanged — the rename-proof join key."""
        return await self._resolve_by_identifier(ID_FIGI, figi, as_of_ms)

    async def resolve_cik(self, ticker: str, as_of_ms: int) -> Optional[str]:
        """The EDGAR CIK for the company the *ticker* resolved to as-of `as_of_ms`, zero-padded to
        the 10-digit form EDGAR's `submissions`/`companyfacts` paths expect (`CIK##########`). The
        fact tables join on instrument_id, but the EDGAR downloader (epic Task 5) keys on CIK, so the
        as-of ticker → CIK hop lives here. Returns None when the ticker doesn't resolve or its company
        has no CIK (a non-US name)."""
        resolved = await self.resolve_symbol(ticker, as_of_ms)
        if resolved is None or resolved.cik is None:
            return None
        return pad_cik(resolved.cik)

    async def resolve_instrument(
        self, t212_ticker: str, as_of_ms: Optional[int] = None
    ) -> Optional[ResolvedInstrument]:
        """Resolve a live-universe `t212_ticker` to its instrument row.

        This is the join the fact-write path uses: the live universe speaks t212 symbols, and
        `instruments.t212_ticker` is the stable join key (it does not change when the *display* ticker
        renames — the effective-dated `identifiers` carry that history). When `as_of_ms` is given the
        result is first routed through the effective-dated ticker resolution (so a symbol that itself
        was reused resolves to the right era); on miss, or when `as_of_ms` is omitted, it returns the
        current instrument carrying that t212 symbol."""
        if as_of_ms is not None:
            resolved = await self.resolve_symbol(t212_ticker, as_of_ms)
            if resolved is not None:
                return resolved
            # Fall through: a pure t212 join key may have no `ticker`-typed identifier row (identifiers
            # carry display tickers; the t212 symbol lives on instruments).
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT inst.instrument_id, inst.company_id, inst.t212_ticker, c.cik
                   FROM security_master.instruments inst
                   JOIN security_master.companies c ON c.company_id = inst.company_id
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
            cik=row["cik"],
            matched_value=t212_ticker,
            effective_from=0,
            effective_to=None,
        )


def pad_cik(cik: str) -> str:
    """Zero-pad a CIK to EDGAR's 10-digit `CIK##########`-path form. Accepts a bare or already-padded
    CIK and an int-like string; non-numeric input is returned unchanged (the caller stored what EDGAR
    gave, and EDGAR CIKs are numeric — a malformed value is surfaced, not silently mangled)."""
    digits = cik.strip().lstrip("0") or "0"
    if not digits.isdigit():
        return cik
    return digits.zfill(10)

"""DuckDB-over-Parquet read engine for the PIT fundamentals lake (read-only, in-process).

The whole point-in-time guarantee is two clauses (the lake is the immutable source of truth, so
nothing is precomputed and a standardization change never requires a refetch):

    WHERE   knowledge_ts <= :as_of_ms              -- only what was knowable at the cutoff
    QUALIFY row_number() OVER (
        PARTITION BY <period> ORDER BY knowledge_ts DESC, accession DESC
    ) = 1                                          -- latest knowledge wins (restatements supersede)

This differs from the prototype on TWO points that matter for correctness and scale:

  * **The PIT axis is `knowledge_ts`, not `filed`.** `filed` is the SEC filing DATE (day-granularity,
    look-ahead-leaky for an after-hours filing); `knowledge_ts` is the DERIVED next-NYSE-session-open
    availability instant (`lake.calendar.derive_knowledge_ts`, written by the harvester). Filtering and
    ordering on `knowledge_ts` is what makes an as-of read truly look-ahead-free — an 18:12-ET 10-K is
    not knowable same-day. `as_of_ms` is a UTC-ms epoch (int), matching the schema's `knowledge_ts`
    (Task 3) and the axis-agnostic `metric_series` (Task 4, `AsOf = int | date`).

  * **The hot path targets the single per-CIK file — NO glob.** `pit_series` reads
    `read_parquet('facts/cik=<cik:010d>.parquet')` for the ONE CIK and returns `[]` when that file is
    absent (a cold lake or an unknown CIK must degrade, never crash). The prototype opened a
    `facts/*.parquet` view over the whole lake; on a ~15k-entity lake that reintroduces a fan-out (and
    its OOM/lock-table failure mode). A per-name read here is O(one file).

The store also keeps `profile(cik)` (entity metadata for the `/profile` route) and `facts(...)` (a
raw-concept escape hatch for the `/facts` route) — both PIT-filtered the same way as `pit_series`.

DuckDB connections are NOT thread-safe, so every query holds a process-wide lock (fine at personal
scale; pool for more). The in-memory connection is built eagerly, but NO views are created at
construction (a glob view over an empty/partial lake would either crash or fan out) — each query
parameterizes `read_parquet(?)` against the concrete file it needs and short-circuits when that file
is missing, so the store constructs cleanly over a cold lake (no files at all).

pyarrow + duckdb are the `quant-core[lake]` extra (the live strategy host installs only `[http]`).
"""
from __future__ import annotations

import json
import threading
from datetime import date, datetime, time, timezone
from pathlib import Path

import duckdb

from quant_core.ticker_identity import Market

# Only US listings file with SEC EDGAR, so only `market == 'US'` can resolve to a CIK. A non-US
# (LSE/foreign) identity has no EDGAR presence and `resolve` returns None for it — the contract layer
# (Task 6) turns that into a fail-closed `{}` (no Yahoo fallback, per Thread C).
_EDGAR_MARKET: Market = "US"


def _as_of_ms(as_of: int | date) -> int:
    """Normalize a knowledge cutoff to the UTC-ms epoch the `knowledge_ts` column stores.

    The hot path passes an `int` (already epoch-ms) — returned unchanged, zero cost. The axis-agnostic
    `metric_series` types its cutoff as `AsOf = int | date` (so a fixture / the future contract layer
    may hand a `date`/`datetime`), and `knowledge_ts` is int64-ms — so binding a bare `date` into
    `knowledge_ts <= ?` would compare a date to a bigint and silently mis-filter every row. Convert
    instead: a `datetime` → its exact UTC ms; a `date` → the END of that calendar day in UTC
    (23:59:59.999), so "as of 2024-03-01" admits any fact knowable at any point THAT day (a date is a
    whole-day cutoff, not midnight). `bool` is rejected (a `bool` is an `int` subclass — guard against
    `pit_series(..., True)` silently meaning epoch 1). Keeps the store honest regardless of caller axis.
    """
    if isinstance(as_of, bool):  # bool is a subclass of int — reject before the int branch
        raise TypeError(f"as_of must be epoch-ms int or a date, not bool: {as_of!r}")
    if isinstance(as_of, int):
        return as_of
    if isinstance(as_of, datetime):
        dt = as_of if as_of.tzinfo is not None else as_of.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    if isinstance(as_of, date):
        eod = datetime.combine(as_of, time(23, 59, 59, 999_000), tzinfo=timezone.utc)
        return int(eod.timestamp() * 1000)
    raise TypeError(f"as_of must be epoch-ms int or a date, not {type(as_of).__name__}: {as_of!r}")


def _cik_facts_path(lake: Path, cik: int) -> Path:
    """The single per-CIK fact file. The harvester writes exactly this name (`cik=<cik:010d>.parquet`,
    zero-padded to 10 digits) via tmpfile + os.replace, so the file is the atomic unit of refresh and
    the unit the read targets — no glob over the whole `facts/` directory on the hot path."""
    return lake / "facts" / f"cik={int(cik):010d}.parquet"


class Store:
    """Read-only DuckDB view over the per-CIK Parquet lake.

    Construction succeeds over ANY lake state — including a cold lake with no files at all (the
    harvester hasn't bootstrapped yet) — because no glob view is built up front; the missing-file
    checks live in each query. This is the opposite of the prototype, which raised if `facts/` was
    empty: a cold lake must degrade to empty reads, not crash the read-API at boot.
    """

    def __init__(self, lake: Path):
        self.lake = Path(lake)
        # duckdb connections aren't thread-safe → one lock guards every execute. In-memory connection
        # (no on-disk DB file); the data lives in the Parquet lake, read via `read_parquet`.
        self._lock = threading.Lock()
        self.con = duckdb.connect(":memory:")

    def _rows(self, sql: str, params: list) -> list[dict]:
        with self._lock:
            cur = self.con.execute(sql, params)
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]

    # ------------------------------------------------------------------ #
    # Identity                                                           #
    # ------------------------------------------------------------------ #
    def resolve(self, symbol: str, market: Market, as_of: date) -> dict | None:
        """Bare symbol (+ market) → entity, as of a date — rename-aware so history is continuous
        across a ticker change.

        Only `market == 'US'` resolves to an EDGAR CIK; a non-US listing returns None (no SEC
        presence). Rename handling: prefer the listing whose `[valid_from, valid_to)` window contains
        `as_of`; failing that, fall back to the most recent listing that had ALREADY STARTED by
        `as_of` (e.g. asking for the OLD symbol *today*, like `FB` now → its window closed at the
        rename, so resolve forward to its successor's CIK). Because the CIK is stable across a rename
        (FB and META both → CIK 1326801), the old symbol at an old date and the new symbol today both
        resolve to the same entity.

        The fallback is FORWARD-ONLY (`valid_from <= as_of`): a symbol queried at a date BEFORE it was
        ever listed returns None, never a CIK. Without that floor the fallback would resolve a symbol
        backward to a date it did not yet trade under — a look-ahead leak in the identity layer (the
        prototype omitted it; it is intended only for the resolve-a-retired-symbol-forward case).

        A cold lake (no `ticker_history.parquet`) or an unknown symbol → None (degrade, never crash).
        """
        if market != _EDGAR_MARKET:
            return None  # non-US: no EDGAR, no CIK
        hist = self.lake / "ticker_history.parquet"
        if not hist.exists():
            return None  # cold lake — harvester hasn't snapshotted tickers yet
        sym = (symbol or "").strip().upper()
        if not sym:
            return None
        # One scan, forward-only: among this symbol's listings that had started by `as_of`
        # (`valid_from <= as_of`), prefer one whose window still CONTAINS `as_of` (`valid_to` open or
        # in the future) — the boolean sorts those listings first (DESC: True before False) — then the
        # most recent `valid_from`. So an in-window listing wins; otherwise the latest era already
        # begun at `as_of` (the FB-today fallback); and a pre-listing `as_of` matches nothing → None.
        rows = self._rows(
            """SELECT cik FROM read_parquet(?)
               WHERE ticker = ? AND valid_from <= ?
               ORDER BY (valid_to IS NULL OR valid_to > ?) DESC, valid_from DESC
               LIMIT 1""",
            [str(hist), sym, as_of, as_of],
        )
        if not rows:
            return None
        cik = rows[0]["cik"]
        out = {"cik": cik, "symbol": sym, "market": market, "name": None, "former_names": []}
        ent = self._entity_row(cik)
        if ent is not None:
            out["name"] = ent["name"]
            out["former_names"] = json.loads(ent["former_names"] or "[]")
        return out

    def _entity_row(self, cik: int) -> dict | None:
        """One raw `entities.parquet` row for a CIK, or None when the file is absent (cold lake — the
        harvester writes entities from /submissions) or the CIK has no entity record. Centralised so
        `resolve` and `profile` share the same missing-file degradation."""
        ent_path = self.lake / "entities.parquet"
        if not ent_path.exists():
            return None
        rows = self._rows("SELECT * FROM read_parquet(?) WHERE cik = ?", [str(ent_path), cik])
        return rows[0] if rows else None

    def profile(self, cik: int) -> dict | None:
        """Entity metadata for one CIK (the `/profile` route): name, SIC, exchanges, tickers, former
        names. None when there is no entity record (or a cold lake). JSON-list columns are decoded."""
        r = self._entity_row(cik)
        if r is None:
            return None
        return {
            "cik": r["cik"],
            "name": r["name"],
            "sic": r["sic"],
            "sic_description": r["sic_desc"],
            "exchanges": json.loads(r["exchanges"] or "[]"),
            "tickers": json.loads(r["tickers"] or "[]"),
            "former_names": json.loads(r["former_names"] or "[]"),
        }

    # ------------------------------------------------------------------ #
    # The point-in-time query                                            #
    # ------------------------------------------------------------------ #
    def pit_series(self, cik: int, taxonomy: str, concept: str, unit: str,
                   as_of_ms: int | date, instant: bool) -> list[dict]:
        """The PIT read for one standardized concept: the latest-known value per fiscal period at the
        `as_of_ms` knowledge cutoff.

        `as_of_ms` is normally an epoch-ms `int`; a `date`/`datetime` is also accepted (the
        axis-agnostic `metric_series` types its cutoff `int | date`) and normalized to UTC ms by
        `_as_of_ms` — a date is treated as a whole-day (end-of-day UTC) cutoff — so a bare date never
        silently mis-filters against the int64 `knowledge_ts` column.

        Targets the single `facts/cik=<cik>.parquet` file (no glob) and returns `[]` when it is absent
        (cold lake / unknown CIK). `knowledge_ts <= as_of_ms` admits only rows knowable at the cutoff;
        `row_number() OVER (PARTITION BY <period> ORDER BY knowledge_ts DESC, accession DESC) = 1`
        keeps the latest-known revision per period, so a restatement (extra row, later `knowledge_ts`)
        supersedes the first print at a later as-of while the original date still returns the first
        print. `instant` partitions on `end` alone (balance-sheet facts have no `start`); a duration
        fact partitions on `(start, end)`. Rows carry `filed` (the field `metric_series` propagates as
        `filed = max(inputs)` for derived Q4/TTM) and `knowledge_ts` (provenance for the read-API).
        """
        path = _cik_facts_path(self.lake, cik)
        if not path.exists():
            return []  # cold lake or unknown CIK — degrade to empty, never crash
        partition = '"end"' if instant else '"start", "end"'
        return self._rows(
            f"""
            SELECT "start", "end", value, filed, knowledge_ts, accession, form
            FROM (
                SELECT *, row_number() OVER (
                    PARTITION BY {partition}
                    ORDER BY knowledge_ts DESC, accession DESC
                ) AS rn
                FROM read_parquet(?)
                WHERE taxonomy = ? AND concept = ?
                  AND unit = ? AND knowledge_ts <= ?
            )
            WHERE rn = 1
            ORDER BY "end"
            """,
            [str(path), taxonomy, concept, unit, _as_of_ms(as_of_ms)],
        )

    def facts(self, cik: int, taxonomy: str, concept: str, unit: str,
              as_of_ms: int | date, instant: bool) -> list[dict]:
        """Raw-concept escape hatch for the `/facts` route: any XBRL concept, PIT-filtered exactly as
        `pit_series` (no standardization / tag-fallback). A thin alias so the read-API has a named,
        intent-revealing entry point distinct from the standardized-metric path; both honour the same
        per-CIK targeting + `knowledge_ts` cutoff (and the same `int | date` cutoff normalization)."""
        return self.pit_series(cik, taxonomy, concept, unit, as_of_ms, instant)

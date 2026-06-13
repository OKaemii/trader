"""FactorStore — the Mongo writer/reader for the ``factor_scores`` research-factor store.

Each cycle the host computes the strategy-independent research factor set (momentum, quality,
value, volatility) over the FULL active universe and persists one append-only doc per ticker per
cycle here. This is the linchpin store the Research surface reads through: T10 builds the
``GET /admin/api/strategy/scores`` + ``factor-history`` endpoints directly on this reader.

DOC SHAPE (the verbatim contract from T5 / COLLECTIONS.FACTOR_SCORES — never hardcode the
collection-name string, import it as the literal below to stay in lockstep):

    { ticker, observation_ts,
      factors: { momentum:   {raw, pct, source},
                 volatility: {raw, pct, source},
                 value:      {raw, pct, source},
                 quality:    {raw, pct, source} } }

- ``observation_ts`` = the cycle's ``as_of_ms`` (the knowledge time the factors were computed at).
- ``pct`` = cross-sectional percentile in [0, 100]; ``raw`` = the cross-sectional z-score.
- ``source`` ∈ ``'eod' | 'div' | 'yahoo-snapshot' | 'pit-edgar' | 'pit-companies-house' | null``
  (the T5 allowed set). A factor with no finite value is stored as the honest no-source cell
  ``{raw: null, pct: null, source: null}`` — never a fabricated 0 (so a later PIT re-backfill can
  upgrade exactly the rows that were genuinely missing, matched by ``(ticker, observation_ts)`` and
  guarded by ``source``).

SOURCE STAMP RULES (drawn ONLY from the T5 allowed set, applied by ``stamp_factor_sources``):
- momentum / volatility → ``eod``     (our own EODHD-fed persisted daily series — price factors).
- quality              → the FundamentalsAsOf provider's ``source_for(ticker)`` (``yahoo-snapshot``
                          today; ``pit-edgar`` / ``pit-companies-house`` when the future PIT
                          warehouse drops in behind the same seam).
- value                → ``div`` when the point-in-time dividend-yield leg was present for the name
                          this cycle (the only honestly-backfillable Value component), else the
                          provider's ``source_for(ticker)`` (the forward-only earnings/book leg).
- a factor whose cell is the no-source cell → ``source: null`` (we never stamp a source onto a
  factor we couldn't compute).

INDEXES (created here by ``ensure_indexes``, NOT by T5):
- ``(ticker asc, observation_ts desc)`` — ONE compound index serving all three reads. Its ``ticker``
  prefix + ``observation_ts`` descending order makes ``latest_for`` / ``as_of`` (ticker equality →
  newest-first by ``observation_ts``) index-only, and matches ``latest_all``'s ``{ticker:1,
  observation_ts:-1}`` aggregation sort exactly (no in-memory sort). A second "latest per ticker"
  index would need an ``is_latest`` flag on the docs to be a *partial* index that adds anything —
  we don't write such a flag (the compound prefix already fronts the latest reads), so a second
  same-key index would only double write cost for no read benefit. One index, intentionally.

READER API (T10 builds endpoints on these):
- ``latest_all()``                              → newest row per ticker across the universe.
- ``latest_for(ticker)``                        → newest row for one ticker, or None.
- ``as_of(ticker, as_of_ms)``                   → newest row for one ticker with
                                                  ``observation_ts <= as_of_ms`` (point-in-time
                                                  read; the signal "Why?" reads as-of
                                                  ``signal.timestamp`` for honesty), or None.
- ``history(ticker, limit=...)``                → the ticker's factor rows as a TIME-SERIES, oldest
                                                  → newest by ``observation_ts`` (so a chart plots
                                                  left-to-right without re-sorting). Backs
                                                  ``GET .../factor-history?ticker=`` (Factor
                                                  Evolution). Empty list when the ticker is unseen.

BEST-EFFORT INVARIANT (the most important contract): the WRITE path mirrors the feature-store
persist — a Mongo blip logs and returns False at the host, but NEVER raises into the cycle. Signal
emission is never on the persistence path. The host call site wraps ``persist_cycle`` in the same
best-effort guard the feature store uses.
"""

from __future__ import annotations

import os
from typing import Any, Callable, Iterable, Optional

import motor.motor_asyncio
from pymongo import ASCENDING, DESCENDING, UpdateOne

from quant_core.ticker_identity import Trading212TickerAdapter

# Mirrors COLLECTIONS.FACTOR_SCORES in packages/shared-mongo/src/collections.ts. The collection
# name is the cross-service contract from T5 — keep this literal in lockstep with that constant
# (Python has no import of the TS module; this single literal is the one source on this side).
COLLECTION = "factor_scores"

# The storage-boundary ticker↔identity bridge (Thread A, Task 16b). Each factor_scores doc is keyed on
# the bare (symbol, market) identity, never the concatenated T212 ticker. The reader endpoints take a
# T212 ticker from the portal and the cycle host hands compute_research_factors rows keyed on the T212
# ticker — this single adapter splits a ticker to (symbol, market) before any Mongo touch and re-joins
# it on the way out, so the portal contract (a `ticker` on each row) is unchanged. fromT212 throws on a
# non-US/LSE form; on the WRITE side a freshly-emitted name is always tradable (a parse failure is a
# real bug worth surfacing — we skip+log rather than poison the cycle), and on the READ/query side the
# split is fail-soft (an un-routable name simply matches nothing).
_ADAPTER = Trading212TickerAdapter()


def _split_ticker(ticker: str) -> Optional[tuple[str, str]]:
    """Split a T212 ticker into (symbol, market) fail-soft — None when it isn't a US/LSE form."""
    try:
        ident = _ADAPTER.from_t212(ticker)
        return ident.symbol, ident.market
    except Exception:  # noqa: BLE001 — an un-routable ticker degrades to no-match, never throws
        return None


def _join_ticker(symbol: Any, market: Any) -> Optional[str]:
    """Re-derive the T212 ticker from a stored (symbol, market) — None when it can't be re-joined."""
    if not isinstance(symbol, str) or not isinstance(market, str):
        return None
    try:
        from quant_core.ticker_identity import TickerIdentity

        return _ADAPTER.to_t212(TickerIdentity(symbol=symbol, market=market))  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001 — a stored value outside US/LSE is dropped, never throws
        return None


def _with_ticker(doc: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Attach a re-derived `ticker` to a read doc (from its stored symbol/market) so the reader's
    return shape carries the same `ticker` the portal contract expects. None passes through."""
    if doc is None:
        return None
    ticker = _join_ticker(doc.get("symbol"), doc.get("market"))
    if ticker is not None:
        doc["ticker"] = ticker
    return doc

# The four research factors in a fixed order — every persisted doc carries the same factor keys.
RESEARCH_FACTORS = ("momentum", "quality", "value", "volatility")

# Per-factor source stamps, drawn ONLY from the T5 allowed set. 'eod' is fixed for the price
# factors; quality/value resolve their source at persist time (provider + dividend-yield presence).
SOURCE_EOD = "eod"
SOURCE_DIV = "div"

# The honest "no source" cell — a factor we could not compute this cycle. Never a fabricated 0.
_NULL_CELL: dict[str, Any] = {"raw": None, "pct": None, "source": None}


def _db():
    """The default database off MONGODB_URL — same access pattern as strategy_config.py.

    strategy-engine already has Mongo access (it reads portal_runtime_config / portal_strategy_config
    through this same client), so persisting factor_scores needs no new infra (RESUME gotcha)."""
    url = os.environ.get("MONGODB_URL", "mongodb://localhost:27017/trader")
    client = motor.motor_asyncio.AsyncIOMotorClient(url, serverSelectionTimeoutMS=2000)
    return client.get_default_database()


def stamp_factor_sources(
    row: dict[str, dict[str, Optional[float]]],
    *,
    fundamentals_source: str,
    div_yield_tickers: set[str],
    ticker: str,
) -> dict[str, dict[str, Any]]:
    """Project one ticker's compute_research_factors row onto the persisted ``factors`` block,
    stamping each factor's ``source`` from the T5 allowed set.

    ``row`` is the per-ticker FactorRow compute_research_factors returns verbatim:
    ``{ momentum:{raw,pct}, quality:{raw,pct}, value:{raw,pct}, volatility:{raw,pct} }`` — cells are
    native Python ``float | None`` (JSON-/Mongo-clean, no numpy types leak).

    ``fundamentals_source`` is the FundamentalsAsOf provider's ``source_for(ticker)`` for THIS name —
    ``pit-edgar`` on the live PIT-only seam (a non-US name fail-closes to no fundamentals, so its
    quality factor is None and this stamp is never attached to it). Historical rows may carry the
    retired ``yahoo-snapshot`` / ``pit-companies-house`` stamps (read, never freshly written).

    Rules (see module docstring):
      - a cell whose ``raw`` is None ⇒ the no-source cell ``{raw:null, pct:null, source:null}``
        (we never stamp a source onto a factor we couldn't compute);
      - momentum / volatility ⇒ ``eod``;
      - quality ⇒ ``fundamentals_source``;
      - value ⇒ ``div`` when this ticker had a point-in-time dividend-yield leg this cycle, else
        ``fundamentals_source`` (the forward-only earnings/book leg's representative source).
    """
    out: dict[str, dict[str, Any]] = {}
    for factor in RESEARCH_FACTORS:
        cell = row.get(factor) or {}
        raw = cell.get("raw")
        if raw is None:
            # No finite value this cycle — honest no-source cell, never a fabricated source.
            out[factor] = dict(_NULL_CELL)
            continue
        if factor in ("momentum", "volatility"):
            source = SOURCE_EOD
        elif factor == "quality":
            source = fundamentals_source
        else:  # value
            source = SOURCE_DIV if ticker in div_yield_tickers else fundamentals_source
        out[factor] = {"raw": raw, "pct": cell.get("pct"), "source": source}
    return out


def build_docs(
    factor_rows: dict[str, dict[str, dict[str, Optional[float]]]],
    *,
    observation_ts: int,
    fundamentals_source_for: Callable[[str], str],
    div_yield_tickers: set[str],
) -> list[dict[str, Any]]:
    """Build the one-doc-per-ticker payload for ``observation_ts`` from a compute_research_factors
    result, stamping per-factor sources. Pure — the host calls this, then hands the docs to
    ``persist_cycle``. Kept separate so the source-stamping logic is unit-testable without Mongo.

    ``fundamentals_source_for`` is the provider's ``source_for`` (resolved per ticker so a future
    per-jurisdiction PIT provider can stamp ``pit-edgar`` for US and ``pit-companies-house`` for UK
    in the same cycle); ``div_yield_tickers`` is the set of names whose point-in-time dividend-yield
    leg was present this cycle (those get value source ``div``)."""
    docs: list[dict[str, Any]] = []
    for ticker in sorted(factor_rows.keys()):
        split = _split_ticker(ticker)
        if split is None:
            # An un-routable name (not a US/LSE form) can't be stored on the (symbol, market) key —
            # skip it rather than poison the cycle. A freshly-emitted name is always tradable, so this
            # is only hit by a stray/legacy ticker; log so it surfaces without breaking emission.
            print(f"[strategy-engine:factor-store] skip un-routable ticker (no symbol/market): {ticker!r}", flush=True)
            continue
        symbol, market = split
        docs.append({
            "symbol": symbol,
            "market": market,
            "observation_ts": observation_ts,
            "factors": stamp_factor_sources(
                factor_rows[ticker],
                fundamentals_source=fundamentals_source_for(ticker),
                div_yield_tickers=div_yield_tickers,
                ticker=ticker,
            ),
        })
    return docs


def factor_history_points(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flatten ``history`` rows to the lean time-series the Factor-Evolution chart plots: one point
    per cycle carrying ``observation_ts`` + each factor's PERCENTILE (``pct`` in [0,100], or ``None``
    for a factor that couldn't be computed that cycle — a charted gap, never a fabricated 0). Pure,
    so the endpoint's projection is unit-testable without the FastAPI host. The raw z-score + source
    stay in the latest/as-of ``scores`` reads; this is the charting projection only."""
    points: list[dict[str, Any]] = []
    for row in rows:
        factors = row.get("factors") or {}
        point: dict[str, Any] = {"observation_ts": row.get("observation_ts")}
        for factor in RESEARCH_FACTORS:
            cell = factors.get(factor) or {}
            point[factor] = cell.get("pct")
        points.append(point)
    return points


# ── PIT re-backfill (upgrade previously-None fundamentals factors in place) ──────────────────────
#
# A fundamentals fact the lake has no row for at a PAST as_of yields {} (and the now-removed Yahoo seam
# did the same for any past as_of), so the fundamentals-derived factors (quality, and value's
# earnings/book leg) were persisted as the honest no-source cell ``{raw:null, pct:null, source:null}``
# for those cycles. Once the PIT lake covers those past as_ofs (as the harvester backfills filing
# depth), a re-backfill recomputes those cycles with PIT fundamentals and upgrades
# EXACTLY the rows that were genuinely missing — matched by ``(ticker, observation_ts)`` and GUARDED BY
# ``source``: a cell is upgraded only when its stored ``source`` is None (the no-source cell). A cell
# that already carries ANY source (``eod`` price factors, a ``div`` value leg, a prior ``yahoo-snapshot``
# / ``pit-*`` value) is a genuine value and is NEVER overwritten. This is the guard the T5 doc shape was
# designed for (the no-source cell is the upgrade target; a sourced cell is immutable history).

# The set of source stamps that mark a GENUINE (immutable) factor value — a cell carrying any of these
# is never touched by the re-backfill. The only upgradeable state is ``source: None`` (the no-source
# cell). Kept as a frozenset so the guard is a cheap membership test and the intent is explicit.
_GENUINE_SOURCES: frozenset[Optional[str]] = frozenset(
    {SOURCE_EOD, SOURCE_DIV, "yahoo-snapshot", "pit-edgar", "pit-companies-house"}
)


def upgrade_null_cells(
    stored_factors: dict[str, dict[str, Any]],
    fresh_factors: dict[str, dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], int]:
    """Merge freshly-recomputed PIT ``fresh_factors`` onto a row's ``stored_factors``, upgrading ONLY
    the cells whose stored ``source`` is None (the no-source cell) to the fresh cell — and only when the
    fresh cell actually has a finite value (a fresh no-source cell is not an upgrade). Returns the merged
    factors block + the number of cells upgraded.

    GUARD (the contract): a stored cell with ANY source in ``_GENUINE_SOURCES`` is a genuine value and is
    left exactly as-is — the re-backfill never overwrites real history, only fills the gaps the
    forward-only seam left as ``source: null``. Pure (no Mongo) so the guard is unit-testable; the store
    method below does the matched in-place update from this result.

    ``stored_factors`` / ``fresh_factors`` are both the persisted ``factors`` block shape
    (``{factor: {raw, pct, source}}``). A factor present in ``stored`` but absent from ``fresh`` is kept
    unchanged (the PIT recompute didn't produce it this pass); a factor in ``fresh`` but not ``stored`` is
    ignored (we only upgrade cells that already exist in the row — the row's factor set is fixed at
    write time)."""
    merged: dict[str, dict[str, Any]] = {}
    upgraded = 0
    for factor, stored_cell in stored_factors.items():
        cell = dict(stored_cell) if isinstance(stored_cell, dict) else {}
        if cell.get("source") in _GENUINE_SOURCES:
            # Genuine value — immutable history. Keep verbatim.
            merged[factor] = cell
            continue
        # Stored cell is the no-source cell (source is None / unknown) — eligible for upgrade.
        fresh_cell = fresh_factors.get(factor)
        if (
            isinstance(fresh_cell, dict)
            and fresh_cell.get("raw") is not None
            and fresh_cell.get("source") in _GENUINE_SOURCES
        ):
            merged[factor] = {
                "raw": fresh_cell.get("raw"),
                "pct": fresh_cell.get("pct"),
                "source": fresh_cell.get("source"),
            }
            upgraded += 1
        else:
            # No finite fresh value (PIT still has nothing for this name/as_of) — leave the gap honest.
            merged[factor] = cell
    return merged, upgraded


class FactorStore:
    """Mongo writer/reader for ``factor_scores``. One instance per host process; reuses the shared
    MONGODB_URL client. All methods are async (motor)."""

    def __init__(self, db: Any | None = None) -> None:
        self._db = db if db is not None else _db()

    @property
    def _coll(self):
        return self._db[COLLECTION]

    async def ensure_indexes(self) -> None:
        """Create the factor_scores index (T5 documents the intent; the writer task — this one —
        creates it). Idempotent: Mongo no-ops a create on an existing index.

        ONE compound ``(symbol asc, market asc, observation_ts desc)`` index serves every read path
        (the store is keyed on the bare (symbol, market) identity since Task 16b):
        - ``latest_for`` / ``as_of`` — (symbol, market) equality on the prefix, newest-first by the
          descending ``observation_ts`` (index-only, no fetch-then-sort);
        - ``latest_all`` — matches the ``{symbol:1, market:1, observation_ts:-1}`` aggregation sort.
        A second index keyed the same way would only double write cost for no read benefit (a
        genuinely-useful "latest per name" partial index would need an ``is_latest`` flag we don't
        write), so this is deliberately the single index.
        """
        await self._coll.create_index(
            [("symbol", ASCENDING), ("market", ASCENDING), ("observation_ts", DESCENDING)],
            name="factor_scores_symbol_market_obs",
        )

    # ── Write path ───────────────────────────────────────────────────────────────────────────
    async def persist_cycle(self, docs: list[dict[str, Any]]) -> int:
        """Upsert one doc per name for this cycle, idempotent per ``(symbol, market, observation_ts)``
        (a replay of the same cycle overwrites rather than duplicating). Returns the number of docs
        written. Raises on a Mongo failure — the HOST wraps this in the best-effort guard (mirroring
        the feature-store persist), so a store outage logs but never blocks signal emission."""
        if not docs:
            return 0
        ops = [
            UpdateOne(
                {"symbol": d["symbol"], "market": d["market"], "observation_ts": d["observation_ts"]},
                {"$set": d},
                upsert=True,
            )
            for d in docs
        ]
        await self._coll.bulk_write(ops, ordered=False)
        return len(ops)

    # ── Read path (T10 builds endpoints on these) ────────────────────────────────────────────
    async def latest_all(self) -> dict[str, dict[str, Any]]:
        """Newest factor row per name across the whole universe — powers the Overview factor bars for
        any symbol + entity-search enrichment. Keyed on (symbol, market) since Task 16b; the dict key
        is the re-derived T212 ticker so the callers (``build_fundamentals_source_response``'s
        by_ticker, the ``/scores`` no-ticker response) stay keyed exactly as before. A row whose
        (symbol, market) can't be re-joined to a US/LSE ticker is dropped (fail-soft). Empty ``{}``
        pre-backfill (the scores endpoint then returns ``{}``)."""
        # One aggregation: newest observation_ts wins per (symbol, market) (descending sort + $first).
        pipeline = [
            {"$sort": {"symbol": 1, "market": 1, "observation_ts": DESCENDING}},
            {"$group": {
                "_id": {"symbol": "$symbol", "market": "$market"},
                "observation_ts": {"$first": "$observation_ts"},
                "factors": {"$first": "$factors"},
            }},
        ]
        out: dict[str, dict[str, Any]] = {}
        async for row in self._coll.aggregate(pipeline):
            key = row.get("_id") or {}
            ticker = _join_ticker(key.get("symbol"), key.get("market"))
            if ticker is None:
                continue
            out[ticker] = {"observation_ts": row["observation_ts"], "factors": row["factors"]}
        return out

    async def latest_for(self, ticker: str) -> Optional[dict[str, Any]]:
        """Newest factor row for one ticker, or None. Backs ``GET .../scores?ticker=`` (no asOf). The
        input T212 ticker is split to (symbol, market) for the query; the returned doc carries a
        re-derived ``ticker`` so the portal contract is unchanged. An un-routable ticker → None."""
        split = _split_ticker(ticker)
        if split is None:
            return None
        symbol, market = split
        doc = await self._coll.find_one(
            {"symbol": symbol, "market": market},
            sort=[("observation_ts", DESCENDING)],
            projection={"_id": False},
        )
        return _with_ticker(doc)

    async def as_of(self, ticker: str, as_of_ms: int) -> Optional[dict[str, Any]]:
        """Newest factor row for ``ticker`` with ``observation_ts <= as_of_ms`` — the point-in-time
        read (the signal "Why?" reads as-of ``signal.timestamp`` for honesty). None when nothing was
        known at that knowledge time. Backs ``GET .../scores?ticker=&asOf=``. The input ticker is
        split to (symbol, market); the returned doc carries a re-derived ``ticker``."""
        split = _split_ticker(ticker)
        if split is None:
            return None
        symbol, market = split
        doc = await self._coll.find_one(
            {"symbol": symbol, "market": market, "observation_ts": {"$lte": as_of_ms}},
            sort=[("observation_ts", DESCENDING)],
            projection={"_id": False},
        )
        return _with_ticker(doc)

    async def history(self, ticker: str, *, limit: int = 365) -> list[dict[str, Any]]:
        """The ticker's factor rows as a TIME-SERIES, oldest → newest by ``observation_ts`` — the
        four factor percentiles over time for the Factor-Evolution chart. Backs
        ``GET .../factor-history?ticker=``. Empty list for an unseen ticker.

        We pull the most-recent ``limit`` rows newest-first off the ``(symbol, market, observation_ts
        desc)`` index (so a long-lived name returns the latest window, not the oldest), then reverse to
        chronological order so the consumer plots left-to-right with no re-sort. Each row carries
        ``{observation_ts, factors}`` (``_id`` projected out) — the same per-row shape as the latest
        reads, so a chart can reuse the same cell-extraction. The input T212 ticker is split to
        (symbol, market) since Task 16b (an un-routable ticker → empty list). ``limit`` is the doc cap
        (≈ a year of daily cycles by default); the host clamps the query value to a sane bound."""
        split = _split_ticker(ticker)
        if split is None:
            return []
        symbol, market = split
        cursor = self._coll.find(
            {"symbol": symbol, "market": market},
            sort=[("observation_ts", DESCENDING)],
            projection={"_id": False},
        ).limit(limit)
        rows = [doc async for doc in cursor]
        rows.reverse()   # newest-first off the index → chronological for the time-series consumer
        return rows

    # ── PIT re-backfill (upgrade previously-None fundamentals cells in place) ──────────────────────
    async def rows_needing_rebackfill(
        self, *, factors: Iterable[str] = ("quality", "value"), limit: int = 10_000
    ) -> list[dict[str, Any]]:
        """Historical rows with AT LEAST ONE upgradeable (no-source) cell among ``factors`` — the
        re-backfill candidate set. A cell is upgradeable iff its ``source`` is null (the honest
        no-source cell the forward-only seam left). Returns ``{symbol, market, ticker, observation_ts,
        factors}`` per candidate (``_id`` projected out; ``ticker`` re-derived from (symbol, market) so
        the driver's ``recompute_fn`` keeps its ticker contract), oldest → newest so a long backfill
        makes monotonic progress. A row whose (symbol, market) can't be re-joined is dropped (fail-soft).

        Only the fundamentals-derived factors are candidates by default (``quality`` + ``value``); the
        price factors (``momentum``/``volatility``) are ``eod`` and were never null for lack of
        fundamentals. The ``$or`` matches a doc where any named factor's ``source`` is null."""
        clauses = [{f"factors.{f}.source": None} for f in factors]
        if not clauses:
            return []
        cursor = self._coll.find(
            {"$or": clauses},
            sort=[("observation_ts", ASCENDING)],
            projection={"_id": False},
        ).limit(limit)
        out: list[dict[str, Any]] = []
        async for doc in cursor:
            row = _with_ticker(doc)
            if row is not None and row.get("ticker"):
                out.append(row)
        return out

    async def rebackfill_row(
        self, ticker: str, observation_ts: int, merged_factors: dict[str, dict[str, Any]]
    ) -> bool:
        """Write the upgraded ``factors`` block back to the row matched by
        ``(symbol, market, observation_ts)``. The input T212 ticker is split to (symbol, market) since
        Task 16b (an un-routable ticker → no-op, returns False).
        Returns True iff a row was actually modified (no-op when the merge changed nothing). The match
        key is the same idempotency key the writer uses, so this never creates a row (``upsert=False``)
        — it only upgrades an existing historical row in place."""
        split = _split_ticker(ticker)
        if split is None:
            return False
        symbol, market = split
        res = await self._coll.update_one(
            {"symbol": symbol, "market": market, "observation_ts": observation_ts},
            {"$set": {"factors": merged_factors}},
        )
        return bool(getattr(res, "modified_count", 0))


async def persist_research_cycle(
    store: FactorStore,
    factor_rows: dict[str, dict[str, dict[str, Optional[float]]]],
    *,
    observation_ts: int,
    fundamentals_source_for: Callable[[str], str],
    div_yield_tickers: set[str],
) -> int:
    """Best-effort: stamp sources, build the per-ticker docs, and write them — swallowing ANY store
    failure (logs, returns 0). This is the write leg's best-effort guard, mirroring the
    feature-store persist contract: a Mongo blip must NEVER raise into the signal-emission path. The
    host's _persist_research_factors wraps the compute + cross-service legs in its own outer guard;
    this guards the store write specifically so the invariant is unit-testable without importing the
    full FastAPI host. Returns the number of docs written (0 on any failure)."""
    try:
        docs = build_docs(
            factor_rows,
            observation_ts=observation_ts,
            fundamentals_source_for=fundamentals_source_for,
            div_yield_tickers=div_yield_tickers,
        )
        return await store.persist_cycle(docs)
    except Exception as exc:  # noqa: BLE001 — persistence is never on the emission path
        print(f"[strategy-engine:factor-store] persist failed (continuing): {exc!r}", flush=True)
        return 0


async def rebackfill_factor_sources(
    store: FactorStore,
    recompute_fn: Callable[[str, int], Any],
    *,
    factors: Iterable[str] = ("quality", "value"),
    limit: int = 10_000,
) -> dict[str, int]:
    """Re-backfill entry point: upgrade previously-``None`` fundamentals cells in historical
    ``factor_scores`` rows in place, using freshly-recomputed PIT factors.

    This is the offline upgrade the epic runs once the PIT warehouse can answer a past ``as_of``: it
    finds every row with a no-source ``quality``/``value`` cell (``rows_needing_rebackfill``), asks
    ``recompute_fn(ticker, observation_ts)`` for that row's PIT-recomputed ``factors`` block, merges with
    the ``source`` guard (``upgrade_null_cells`` — only no-source cells, only when the fresh cell has a
    finite value), and writes the upgraded block back matched by ``(ticker, observation_ts)``. A genuine
    (sourced) cell is NEVER overwritten; a row whose PIT recompute still has nothing is left untouched.

    ``recompute_fn`` is INJECTED (it carries the strategy/compute machinery + the PIT provider, which
    live in the host — keeping this store module free of numpy/strategy deps). It may be sync or async
    and returns the persisted ``factors`` block shape (``{factor:{raw,pct,source}}``) for that row, or an
    empty/None result when PIT has nothing (then nothing is upgraded for that row).

    Best-effort and idempotent: a per-row failure is logged and skipped (the run continues); a second run
    over already-upgraded rows is a no-op (the upgraded cells now carry a genuine source, so the guard
    rejects them and the candidate query no longer matches). Returns a summary
    ``{scanned, rows_upgraded, cells_upgraded}``."""
    import inspect

    summary = {"scanned": 0, "rows_upgraded": 0, "cells_upgraded": 0}
    try:
        candidates = await store.rows_needing_rebackfill(factors=factors, limit=limit)
    except Exception as exc:  # noqa: BLE001 — never raise out of a maintenance entry point
        print(f"[strategy-engine:factor-store] re-backfill candidate scan failed: {exc!r}", flush=True)
        return summary

    for row in candidates:
        summary["scanned"] += 1
        ticker = row.get("ticker")
        observation_ts = row.get("observation_ts")
        stored_factors = row.get("factors") or {}
        if not ticker or observation_ts is None:
            continue
        try:
            fresh = recompute_fn(ticker, observation_ts)
            if inspect.isawaitable(fresh):
                fresh = await fresh
            fresh_factors = fresh or {}
            if not isinstance(fresh_factors, dict):
                continue
            merged, upgraded = upgrade_null_cells(stored_factors, fresh_factors)
            if upgraded == 0:
                continue
            if await store.rebackfill_row(ticker, observation_ts, merged):
                summary["rows_upgraded"] += 1
                summary["cells_upgraded"] += upgraded
        except Exception as exc:  # noqa: BLE001 — skip a bad row, keep the backfill going
            print(
                f"[strategy-engine:factor-store] re-backfill row failed "
                f"({ticker}@{observation_ts}, continuing): {exc!r}",
                flush=True,
            )
    print(
        f"[strategy-engine:factor-store] re-backfill done — scanned={summary['scanned']} "
        f"rows_upgraded={summary['rows_upgraded']} cells_upgraded={summary['cells_upgraded']}",
        flush=True,
    )
    return summary

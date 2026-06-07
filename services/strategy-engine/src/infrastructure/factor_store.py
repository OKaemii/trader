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

BEST-EFFORT INVARIANT (the most important contract): the WRITE path mirrors the feature-store
persist — a Mongo blip logs and returns False at the host, but NEVER raises into the cycle. Signal
emission is never on the persistence path. The host call site wraps ``persist_cycle`` in the same
best-effort guard the feature store uses.
"""

from __future__ import annotations

import os
from typing import Any, Callable, Optional

import motor.motor_asyncio
from pymongo import ASCENDING, DESCENDING, UpdateOne

# Mirrors COLLECTIONS.FACTOR_SCORES in packages/shared-mongo/src/collections.ts. The collection
# name is the cross-service contract from T5 — keep this literal in lockstep with that constant
# (Python has no import of the TS module; this single literal is the one source on this side).
COLLECTION = "factor_scores"

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

    ``fundamentals_source`` is the FundamentalsAsOf provider's ``source_for(ticker)`` for THIS name
    (``yahoo-snapshot`` for the live impl; ``pit-edgar`` / ``pit-companies-house`` for the future
    per-jurisdiction PIT provider).

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
        docs.append({
            "ticker": ticker,
            "observation_ts": observation_ts,
            "factors": stamp_factor_sources(
                factor_rows[ticker],
                fundamentals_source=fundamentals_source_for(ticker),
                div_yield_tickers=div_yield_tickers,
                ticker=ticker,
            ),
        })
    return docs


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

        ONE compound ``(ticker asc, observation_ts desc)`` index serves every read path:
        - ``latest_for`` / ``as_of`` — ticker equality on the prefix, newest-first by the descending
          ``observation_ts`` (index-only, no fetch-then-sort);
        - ``latest_all`` — matches the ``{ticker:1, observation_ts:-1}`` aggregation sort exactly.
        A second index keyed the same way would only double write cost for no read benefit (a
        genuinely-useful "latest per ticker" partial index would need an ``is_latest`` flag we don't
        write), so this is deliberately the single index.
        """
        await self._coll.create_index(
            [("ticker", ASCENDING), ("observation_ts", DESCENDING)],
            name="factor_scores_ticker_obs",
        )

    # ── Write path ───────────────────────────────────────────────────────────────────────────
    async def persist_cycle(self, docs: list[dict[str, Any]]) -> int:
        """Upsert one doc per ticker for this cycle, idempotent per ``(ticker, observation_ts)``
        (a replay of the same cycle overwrites rather than duplicating). Returns the number of docs
        written. Raises on a Mongo failure — the HOST wraps this in the best-effort guard (mirroring
        the feature-store persist), so a store outage logs but never blocks signal emission."""
        if not docs:
            return 0
        ops = [
            UpdateOne(
                {"ticker": d["ticker"], "observation_ts": d["observation_ts"]},
                {"$set": d},
                upsert=True,
            )
            for d in docs
        ]
        await self._coll.bulk_write(ops, ordered=False)
        return len(ops)

    # ── Read path (T10 builds endpoints on these) ────────────────────────────────────────────
    async def latest_all(self) -> dict[str, dict[str, Any]]:
        """Newest factor row per ticker across the whole universe — powers the Overview factor
        bars for any symbol + entity-search enrichment. Returns ``{ ticker: {observation_ts,
        factors} }``. Empty ``{}`` pre-backfill (the scores endpoint then returns ``{}``)."""
        # One aggregation: newest observation_ts wins per ticker (descending sort + $first).
        pipeline = [
            {"$sort": {"ticker": 1, "observation_ts": DESCENDING}},
            {"$group": {
                "_id": "$ticker",
                "observation_ts": {"$first": "$observation_ts"},
                "factors": {"$first": "$factors"},
            }},
        ]
        out: dict[str, dict[str, Any]] = {}
        async for row in self._coll.aggregate(pipeline):
            out[row["_id"]] = {"observation_ts": row["observation_ts"], "factors": row["factors"]}
        return out

    async def latest_for(self, ticker: str) -> Optional[dict[str, Any]]:
        """Newest factor row for one ticker, or None. Backs ``GET .../scores?ticker=`` (no asOf)."""
        doc = await self._coll.find_one(
            {"ticker": ticker},
            sort=[("observation_ts", DESCENDING)],
            projection={"_id": False},
        )
        return doc

    async def as_of(self, ticker: str, as_of_ms: int) -> Optional[dict[str, Any]]:
        """Newest factor row for ``ticker`` with ``observation_ts <= as_of_ms`` — the point-in-time
        read (the signal "Why?" reads as-of ``signal.timestamp`` for honesty). None when nothing was
        known at that knowledge time. Backs ``GET .../scores?ticker=&asOf=``."""
        doc = await self._coll.find_one(
            {"ticker": ticker, "observation_ts": {"$lte": as_of_ms}},
            sort=[("observation_ts", DESCENDING)],
            projection={"_id": False},
        )
        return doc


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

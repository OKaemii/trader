"""Tests for the factor_scores store: the per-factor source stamping, the persisted doc shape, the
writer/reader, and the best-effort guard (a failing store must NEVER raise into the cycle).

Deps-light by construction (motor is installed in the gate; numpy is not needed here): the source
stamping is pure, and the writer/reader are tested against a tiny in-memory fake motor collection.
The compute_research_factors output is fed as canned FactorRow dicts (the verbatim T7 return shape),
so this suite never imports numpy or the FastAPI host.
"""
from __future__ import annotations

import pytest

from src.infrastructure.factor_store import (
    SOURCE_DIV,
    SOURCE_EOD,
    FactorStore,
    build_docs,
    factor_history_points,
    persist_research_cycle,
    stamp_factor_sources,
)

SOURCE_YAHOO = "yahoo-snapshot"


def _op_filter(op) -> dict:
    """The match filter from a pymongo UpdateOne (private attr name is stable in 4.x: `_filter`)."""
    return getattr(op, "_filter")


def _op_set(op) -> dict:
    """The `$set` payload from a pymongo UpdateOne (the update doc is on `_doc`)."""
    return getattr(op, "_doc")["$set"]


def _yahoo_for(_ticker: str) -> str:
    """The forward-only Yahoo provider's source_for — constant yahoo-snapshot for every name."""
    return SOURCE_YAHOO


# A compute_research_factors row carries all four factors; cells are {raw, pct} (native float|None).
def _full_row() -> dict:
    return {
        "momentum":   {"raw": 1.83, "pct": 92.0},
        "quality":    {"raw": 0.70, "pct": 84.0},
        "value":      {"raw": -0.40, "pct": 31.0},
        "volatility": {"raw": -0.20, "pct": 61.0},
    }


# ── Source stamping ──────────────────────────────────────────────────────────────────────────
def test_stamp_price_factors_are_eod():
    """momentum + volatility always stamp `eod` (our own EODHD-fed persisted daily series)."""
    out = stamp_factor_sources(_full_row(), fundamentals_source=SOURCE_YAHOO, div_yield_tickers=set(), ticker="AAPL_US_EQ")
    assert out["momentum"] == {"raw": 1.83, "pct": 92.0, "source": SOURCE_EOD}
    assert out["volatility"] == {"raw": -0.20, "pct": 61.0, "source": SOURCE_EOD}


def test_stamp_quality_uses_provider_source():
    """quality takes the FundamentalsAsOf provider's source_for(ticker) (yahoo-snapshot today)."""
    out = stamp_factor_sources(_full_row(), fundamentals_source=SOURCE_YAHOO, div_yield_tickers=set(), ticker="AAPL_US_EQ")
    assert out["quality"]["source"] == SOURCE_YAHOO


def test_stamp_value_is_div_when_yield_present():
    """value stamps `div` when this ticker had a point-in-time dividend-yield leg this cycle."""
    out = stamp_factor_sources(
        _full_row(), fundamentals_source=SOURCE_YAHOO, div_yield_tickers={"AAPL_US_EQ"}, ticker="AAPL_US_EQ",
    )
    assert out["value"]["source"] == SOURCE_DIV


def test_stamp_value_falls_back_to_provider_when_no_yield():
    """No dividend-yield leg ⇒ value's representative source is the provider's forward-only one."""
    out = stamp_factor_sources(
        _full_row(), fundamentals_source=SOURCE_YAHOO, div_yield_tickers=set(), ticker="AAPL_US_EQ",
    )
    assert out["value"]["source"] == SOURCE_YAHOO


def test_stamp_missing_factor_is_null_cell_no_source():
    """A factor with raw=None (no finite value) becomes the honest no-source cell — never a
    fabricated 0 or a stamped source on a factor we couldn't compute."""
    row = _full_row()
    row["quality"] = {"raw": None, "pct": None}        # e.g. zero-denominator / absent fundamentals
    out = stamp_factor_sources(row, fundamentals_source=SOURCE_YAHOO, div_yield_tickers=set(), ticker="X_US_EQ")
    assert out["quality"] == {"raw": None, "pct": None, "source": None}
    # Other factors still carry their values + sources (the missing-factor invariant is per-factor).
    assert out["momentum"]["source"] == SOURCE_EOD


def test_stamp_source_only_from_allowed_set():
    """Every stamped source is drawn ONLY from the T5 allowed set (eod | div | yahoo-snapshot |
    pit-* | null). With a Yahoo provider + a div leg, we expect exactly {eod, yahoo-snapshot, div}."""
    out = stamp_factor_sources(
        _full_row(), fundamentals_source=SOURCE_YAHOO, div_yield_tickers={"AAPL_US_EQ"}, ticker="AAPL_US_EQ",
    )
    allowed = {"eod", "div", "yahoo-snapshot", "pit-edgar", "pit-companies-house", None}
    assert all(cell["source"] in allowed for cell in out.values())


# ── Doc shape ────────────────────────────────────────────────────────────────────────────────
def test_build_docs_shape_and_per_ticker_source():
    """One doc per ticker, the exact T5 doc shape, with per-ticker source resolution (div for the
    payer, the provider source for the non-payer)."""
    rows = {"AAPL_US_EQ": _full_row(), "BP_US_EQ": _full_row()}
    docs = build_docs(
        rows, observation_ts=1717718400000,
        fundamentals_source_for=_yahoo_for, div_yield_tickers={"AAPL_US_EQ"},
    )
    assert {d["ticker"] for d in docs} == {"AAPL_US_EQ", "BP_US_EQ"}
    by_ticker = {d["ticker"]: d for d in docs}
    # Shape: top-level ticker/observation_ts + the four-factor `factors` block.
    aapl = by_ticker["AAPL_US_EQ"]
    assert aapl["observation_ts"] == 1717718400000
    assert set(aapl["factors"].keys()) == {"momentum", "quality", "value", "volatility"}
    assert set(aapl["factors"]["momentum"].keys()) == {"raw", "pct", "source"}
    # Per-ticker value source: payer → div, non-payer → yahoo-snapshot.
    assert aapl["factors"]["value"]["source"] == SOURCE_DIV
    assert by_ticker["BP_US_EQ"]["factors"]["value"]["source"] == SOURCE_YAHOO


# ── Writer + reader (against a tiny in-memory fake motor collection) ────────────────────────────
class _FakeCursor:
    """Async cursor over a list of docs — `.limit(n)` truncates, `async for` yields. Mirrors the
    slice of motor's cursor API the history() reader touches."""

    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    def limit(self, n: int) -> "_FakeCursor":
        self._rows = self._rows[:n]
        return self

    def __aiter__(self):
        async def _gen():
            for r in self._rows:
                yield r
        return _gen()


class _FakeCollection:
    """In-memory stand-in for a motor collection: applies bulk_write upserts by (ticker,
    observation_ts), answers find_one over the stored docs (newest observation_ts first, optional
    $lte filter), and tracks create_index. Reads the UpdateOne's public payload via the operator's
    own `_filter`/`_doc` — kept isolated here so the brittleness is one helper, not the store code."""

    def __init__(self) -> None:
        self.docs: list[dict] = []
        self.indexes: list[str] = []

    async def create_index(self, _keys, *, name: str):
        self.indexes.append(name)
        return name

    async def bulk_write(self, ops, *, ordered=True):
        for op in ops:
            flt, update = _op_filter(op), _op_set(op)
            existing = next((d for d in self.docs if all(d.get(k) == v for k, v in flt.items())), None)
            if existing is not None:
                existing.update(update)
            else:
                self.docs.append(dict(update))

    async def find_one(self, query, *, sort=None, projection=None):
        matches = [d for d in self.docs if self._match(d, query)]
        if sort:
            key, direction = sort[0]
            matches.sort(key=lambda d: d.get(key, 0), reverse=direction < 0)
        if not matches:
            return None
        doc = dict(matches[0])
        if projection and projection.get("_id") is False:
            doc.pop("_id", None)
        return doc

    def find(self, query, *, sort=None, projection=None):
        """A tiny async cursor supporting `.limit(n)` + `async for` — mirrors the motor
        find().limit() shape the history() reader uses."""
        matches = [d for d in self.docs if self._match(d, query)]
        if sort:
            key, direction = sort[0]
            matches.sort(key=lambda d: d.get(key, 0), reverse=direction < 0)
        rows = []
        for d in matches:
            doc = dict(d)
            if projection and projection.get("_id") is False:
                doc.pop("_id", None)
            rows.append(doc)
        return _FakeCursor(rows)

    @staticmethod
    def _match(doc, query) -> bool:
        for k, v in query.items():
            if isinstance(v, dict) and "$lte" in v:
                if not (doc.get(k) is not None and doc[k] <= v["$lte"]):
                    return False
            elif doc.get(k) != v:
                return False
        return True


class _FakeDb:
    def __init__(self, coll: _FakeCollection) -> None:
        self._coll = coll

    def __getitem__(self, _name):
        return self._coll


@pytest.mark.asyncio
async def test_ensure_indexes_creates_the_compound_index():
    """One compound (ticker asc, observation_ts desc) index serves all three reads — a second
    same-key index would only double write cost, so ensure_indexes creates exactly one."""
    coll = _FakeCollection()
    store = FactorStore(db=_FakeDb(coll))
    await store.ensure_indexes()
    assert coll.indexes == ["factor_scores_ticker_obs"]


@pytest.mark.asyncio
async def test_persist_then_latest_for_and_as_of():
    coll = _FakeCollection()
    store = FactorStore(db=_FakeDb(coll))

    rows = {"AAPL_US_EQ": _full_row()}
    docs_t1 = build_docs(rows, observation_ts=1000, fundamentals_source_for=_yahoo_for, div_yield_tickers=set())
    docs_t2 = build_docs(rows, observation_ts=2000, fundamentals_source_for=_yahoo_for, div_yield_tickers={"AAPL_US_EQ"})
    assert await store.persist_cycle(docs_t1) == 1
    assert await store.persist_cycle(docs_t2) == 1

    # latest_for → the newest (t2) row.
    latest = await store.latest_for("AAPL_US_EQ")
    assert latest is not None and latest["observation_ts"] == 2000
    assert latest["factors"]["value"]["source"] == SOURCE_DIV   # t2 had a div leg
    assert "_id" not in latest                                  # projection drops _id

    # as_of(1500) → the t1 row (newest with observation_ts <= 1500).
    asof = await store.as_of("AAPL_US_EQ", 1500)
    assert asof is not None and asof["observation_ts"] == 1000
    assert asof["factors"]["value"]["source"] == SOURCE_YAHOO   # t1 had no div leg

    # as_of before any row → None.
    assert await store.as_of("AAPL_US_EQ", 500) is None
    # latest_for an unknown ticker → None.
    assert await store.latest_for("NOPE_US_EQ") is None


@pytest.mark.asyncio
async def test_history_is_chronological_and_limited():
    """history() returns the ticker's rows oldest → newest (chronological for the time-series
    chart), capped to the most-recent `limit` rows; an unseen ticker → []."""
    coll = _FakeCollection()
    store = FactorStore(db=_FakeDb(coll))
    rows = {"AAPL_US_EQ": _full_row()}
    for ts in (1000, 2000, 3000):
        await store.persist_cycle(
            build_docs(rows, observation_ts=ts, fundamentals_source_for=_yahoo_for, div_yield_tickers=set())
        )

    series = await store.history("AAPL_US_EQ")
    assert [r["observation_ts"] for r in series] == [1000, 2000, 3000]   # chronological
    assert "_id" not in series[0]                                        # projection drops _id
    assert series[0]["factors"]["momentum"]["pct"] == 92.0              # full per-factor cell kept

    # limit keeps the MOST-RECENT n, still chronological.
    last_two = await store.history("AAPL_US_EQ", limit=2)
    assert [r["observation_ts"] for r in last_two] == [2000, 3000]

    # Unseen ticker → empty series.
    assert await store.history("NOPE_US_EQ") == []


# ── Factor-history charting projection (pure) ──────────────────────────────────────────────────
def test_factor_history_points_flattens_to_percentiles():
    """factor_history_points → one point/cycle of observation_ts + each factor's PERCENTILE; a
    no-value factor (raw=None ⇒ pct=None) becomes a charted gap (None), never a fabricated 0."""
    row = stamp_factor_sources(_full_row(), fundamentals_source=SOURCE_YAHOO, div_yield_tickers=set(), ticker="X")
    gap = _full_row()
    gap["quality"] = {"raw": None, "pct": None}
    row_gap = stamp_factor_sources(gap, fundamentals_source=SOURCE_YAHOO, div_yield_tickers=set(), ticker="X")
    rows = [
        {"observation_ts": 1000, "factors": row},
        {"observation_ts": 2000, "factors": row_gap},
    ]
    points = factor_history_points(rows)
    assert points[0] == {"observation_ts": 1000, "momentum": 92.0, "quality": 84.0, "value": 31.0, "volatility": 61.0}
    # The no-value quality factor is a None gap; the others still carry their percentile.
    assert points[1]["quality"] is None
    assert points[1]["momentum"] == 92.0


def test_factor_history_points_empty_is_empty():
    assert factor_history_points([]) == []


@pytest.mark.asyncio
async def test_persist_cycle_empty_is_noop():
    store = FactorStore(db=_FakeDb(_FakeCollection()))
    assert await store.persist_cycle([]) == 0


@pytest.mark.asyncio
async def test_persist_cycle_idempotent_per_ticker_cycle():
    """Re-persisting the same (ticker, observation_ts) overwrites — one row, not a duplicate."""
    coll = _FakeCollection()
    store = FactorStore(db=_FakeDb(coll))
    docs = build_docs({"AAPL_US_EQ": _full_row()}, observation_ts=1000, fundamentals_source_for=_yahoo_for, div_yield_tickers=set())
    await store.persist_cycle(docs)
    await store.persist_cycle(docs)   # replay of the same cycle
    assert len(coll.docs) == 1


# ── Best-effort guard (the most important invariant) ───────────────────────────────────────────
class _RaisingStore:
    """A FactorStore whose write raises — to prove persist_research_cycle swallows it (the store
    failure must never propagate into the signal-emission path)."""

    async def persist_cycle(self, _docs):
        raise RuntimeError("mongo down")


@pytest.mark.asyncio
async def test_persist_research_cycle_swallows_store_failure():
    """A failing store does NOT raise — it returns 0 and logs. This is the cycle's safety contract:
    persistence is never on the emission path."""
    written = await persist_research_cycle(
        _RaisingStore(),                       # type: ignore[arg-type]
        {"AAPL_US_EQ": _full_row()},
        observation_ts=1000,
        fundamentals_source_for=_yahoo_for,
        div_yield_tickers=set(),
    )
    assert written == 0   # swallowed, never raised


@pytest.mark.asyncio
async def test_persist_research_cycle_writes_through_on_success():
    """Happy path: persist_research_cycle builds docs + writes them, returning the count."""
    coll = _FakeCollection()
    store = FactorStore(db=_FakeDb(coll))
    written = await persist_research_cycle(
        store,
        {"AAPL_US_EQ": _full_row(), "BP_US_EQ": _full_row()},
        observation_ts=1000,
        fundamentals_source_for=_yahoo_for,
        div_yield_tickers={"AAPL_US_EQ"},
    )
    assert written == 2
    assert len(coll.docs) == 2

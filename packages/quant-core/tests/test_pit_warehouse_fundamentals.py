"""WarehousePitFundamentals (replay PIT source) + PitFundamentalsBarsReader.

The python gate installs `quant-core[http,test]`, NOT `[warehouse]` — so DuckDB is not available
here (mirrors how the fundamentals-api suite injects a FakeTimescale rather than a live Postgres).
`WarehousePitFundamentals` takes the connection by injection and only calls `.execute(sql, params)
.fetchall()/.fetchone()`, so a faithful fake connection that implements the SAME bi-temporal as-of
filter the SQL expresses lets us prove the contract end-to-end (no-look-ahead, restatement
original-vs-restated, the `_prev` YoY derivation, and the price×shares×fx market cap) with no DuckDB.
The literal SQL string is validated against real DuckDB at the warehouse-integration task (Task 15),
exactly as `WarehouseBarsReader`'s SQL is reconciled against real snapshotter output.
"""
import asyncio

from quant_core.bars.fundamentals_reader import (
    FundamentalsBarsReader,
    PitFundamentalsBarsReader,
)
from quant_core.fundamentals import SOURCE_PIT_COMPANIES_HOUSE, SOURCE_PIT_EDGAR
from quant_core.fundamentals.warehouse import (
    WarehousePitFundamentals,
    _compute_market_cap_gbp,
)
from quant_core.fundamentals.contract import FundamentalsAsOf
from quant_core.strategy.contract import HistoryView


# --- a faithful fake DuckDB connection -------------------------------------------------------
#
# Holds the raw `fundamentals` + `bars` fact rows and reproduces the two queries' semantics: the
# as-of fact pick (latest knowledge_ts ≤ as_of per logical fact, consolidated, newest-obs-first) and
# the as-of close pick (latest bar at/≤ as_of, latest knowledge_ts). The point is to exercise MY
# pivot/`_prev`/restatement logic over rows shaped EXACTLY as the SQL would hand them back.

class _FactRow:
    __slots__ = ("instrument_id", "metric", "observation_ts", "knowledge_ts", "dim_signature", "value")

    def __init__(self, instrument_id, metric, observation_ts, knowledge_ts, value, dim_signature=""):
        self.instrument_id = instrument_id
        self.metric = metric
        self.observation_ts = observation_ts
        self.knowledge_ts = knowledge_ts
        self.dim_signature = dim_signature
        self.value = value


class _BarRow:
    __slots__ = ("ticker", "observation_ts", "knowledge_ts", "close")

    def __init__(self, ticker, observation_ts, knowledge_ts, close):
        self.ticker = ticker
        self.observation_ts = observation_ts
        self.knowledge_ts = knowledge_ts
        self.close = close


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class FakeWarehouseConn:
    """Implements the as-of fact + close reads the warehouse SQL expresses, over injected rows."""

    def __init__(self, facts=None, bars=None):
        self._facts = list(facts or [])
        self._bars = list(bars or [])

    def execute(self, sql, params):
        if "FROM fundamentals" in sql:
            return _Result(self._as_of_facts(*params))
        if "FROM bars" in sql:
            return _Result(self._as_of_close(*params))
        raise AssertionError(f"unexpected SQL: {sql!r}")

    def _as_of_facts(self, instrument_id, as_of_ms):
        # Consolidated rows for this instrument knowable as-of, latest revision per logical fact.
        candidates = [
            r for r in self._facts
            if r.instrument_id == instrument_id and r.dim_signature == "" and r.knowledge_ts <= as_of_ms
        ]
        latest_per_logical = {}
        for r in candidates:
            key = (r.metric, r.observation_ts)
            cur = latest_per_logical.get(key)
            if cur is None or r.knowledge_ts > cur.knowledge_ts:
                latest_per_logical[key] = r
        rows = list(latest_per_logical.values())
        # ORDER BY metric, observation_ts DESC (the reader relies on newest-obs-first per metric).
        rows.sort(key=lambda r: (r.metric, -r.observation_ts))
        return [(r.metric, r.observation_ts, r.value) for r in rows]

    def _as_of_close(self, ticker, obs_cutoff, knowledge_cutoff):
        candidates = [
            b for b in self._bars
            if b.ticker == ticker and b.observation_ts <= obs_cutoff and b.knowledge_ts <= knowledge_cutoff
        ]
        if not candidates:
            return []
        # Latest revision per observation_ts, then the most-recent observation (LIMIT 1).
        latest_per_obs = {}
        for b in candidates:
            cur = latest_per_obs.get(b.observation_ts)
            if cur is None or b.knowledge_ts > cur.knowledge_ts:
                latest_per_obs[b.observation_ts] = b
        newest = max(latest_per_obs.values(), key=lambda b: b.observation_ts)
        return [(newest.close,)]


# Two annual observations (FY2018, FY2019) + a knowledge lag (a 10-K is knowable months after the
# fiscal period-end). All in UTC ms.
FY2018 = 1_546_300_000_000   # ~2019-01 period-end stand-in
FY2019 = 1_577_800_000_000   # ~2020-01 period-end stand-in
KNOWN_2018 = 1_551_000_000_000   # FY2018 became knowable here
KNOWN_2019 = 1_582_000_000_000   # FY2019 became knowable here
AS_OF_AFTER_2019 = 1_590_000_000_000
AS_OF_BETWEEN = 1_560_000_000_000   # after FY2018 known, before FY2019 known


def _aapl_facts(instrument_id=1):
    """AAPL: two annual obs of total_assets/total_equity/shares + net_income, each with its lag."""
    return [
        _FactRow(instrument_id, "total_assets", FY2018, KNOWN_2018, 1000.0),
        _FactRow(instrument_id, "total_assets", FY2019, KNOWN_2019, 1100.0),   # +10% YoY
        _FactRow(instrument_id, "total_equity", FY2018, KNOWN_2018, 400.0),
        _FactRow(instrument_id, "total_equity", FY2019, KNOWN_2019, 420.0),    # +5% YoY
        _FactRow(instrument_id, "net_income", FY2019, KNOWN_2019, 90.0),
        _FactRow(instrument_id, "shares_outstanding", FY2019, KNOWN_2019, 10.0),
    ]


def _resolver(mapping):
    return lambda ticker, _as_of: mapping.get(ticker)


def test_as_of_pivot_latest_annual_plus_prior_year_prev():
    """As-of after FY2019 → latest annual line items + the prior-year value under `<key>_prev`."""
    conn = FakeWarehouseConn(facts=_aapl_facts())
    wh = WarehousePitFundamentals(conn, resolve_instrument=_resolver({"AAPL_US_EQ": 1}))
    out = asyncio.run(wh.fetch_many(["AAPL_US_EQ"], AS_OF_AFTER_2019))
    f = out["AAPL_US_EQ"]
    # Latest annual observation per metric.
    assert f["total_assets"] == 1100.0
    assert f["total_equity"] == 420.0
    assert f["net_income"] == 90.0
    # Prior-year (second-latest annual obs) for the YoY-growth metrics ONLY.
    assert f["total_assets_prev"] == 1000.0
    assert f["total_equity_prev"] == 400.0
    # No `_prev` for a non-growth metric (we don't bloat the dict).
    assert "net_income_prev" not in f
    assert "shares_outstanding_prev" not in f


def test_no_look_ahead_knowledge_ts_filter():
    """As-of BETWEEN the two filings → only FY2018 is knowable; FY2019 is invisible (no _prev yet)."""
    conn = FakeWarehouseConn(facts=_aapl_facts())
    wh = WarehousePitFundamentals(conn, resolve_instrument=_resolver({"AAPL_US_EQ": 1}))
    out = asyncio.run(wh.fetch_many(["AAPL_US_EQ"], AS_OF_BETWEEN))
    f = out["AAPL_US_EQ"]
    assert f["total_assets"] == 1000.0          # FY2018 — the only knowable observation
    assert f["total_equity"] == 400.0
    # FY2019's knowledge_ts is in the future of as_of → never returned, so there is no prior year.
    assert "total_assets_prev" not in f
    assert "total_equity_prev" not in f


def test_restatement_original_vs_restated_by_as_of():
    """A restatement of FY2019 total_assets lands later. An as-of BEFORE the restatement's
    knowledge_ts returns the FIRST-PRINT value; an as-of AFTER returns the RESTATED value."""
    restated_known = AS_OF_AFTER_2019 + 5_000_000_000
    facts = _aapl_facts() + [
        # Same logical fact (instrument, metric, observation_ts), newer knowledge_ts, revised value.
        _FactRow(1, "total_assets", FY2019, restated_known, 1150.0),
    ]
    conn = FakeWarehouseConn(facts=facts)
    wh = WarehousePitFundamentals(conn, resolve_instrument=_resolver({"AAPL_US_EQ": 1}))
    before = asyncio.run(wh.fetch_many(["AAPL_US_EQ"], AS_OF_AFTER_2019))
    after = asyncio.run(wh.fetch_many(["AAPL_US_EQ"], restated_known + 1_000_000_000))
    assert before["AAPL_US_EQ"]["total_assets"] == 1100.0   # first-print (restatement not yet known)
    assert after["AAPL_US_EQ"]["total_assets"] == 1150.0    # restated (now knowable)


def test_market_cap_computed_price_times_shares_for_lse_gbp_name():
    """A GBP (LSE) name's market cap is COMPUTED off the warehouse bars view (price × shares × 1.0),
    fully in replay — no live FX needed (GBP is the identity multiplier)."""
    facts = [
        _FactRow(2, "total_equity", FY2019, KNOWN_2019, 50.0),
        _FactRow(2, "shares_outstanding", FY2019, KNOWN_2019, 4.0),
    ]
    bars = [_BarRow("HSBAl_EQ", FY2019, KNOWN_2019, 6.5)]   # adjusted close, GBP (pence already killed)
    conn = FakeWarehouseConn(facts=facts, bars=bars)
    wh = WarehousePitFundamentals(conn, resolve_instrument=_resolver({"HSBAl_EQ": 2}))
    out = asyncio.run(wh.fetch_many(["HSBAl_EQ"], AS_OF_AFTER_2019))
    assert out["HSBAl_EQ"]["market_cap_gbp"] == 6.5 * 4.0 * 1.0   # price × shares × fx(GBP)=1


def test_market_cap_dropped_for_usd_name_without_injected_fx():
    """A USD name has no FX rate in the default replay path (no historical GBP/USD series), so its
    market cap is DROPPED (absent), never fabricated — the Value legs NaN-exclude it."""
    facts = [
        _FactRow(3, "total_equity", FY2019, KNOWN_2019, 100.0),
        _FactRow(3, "shares_outstanding", FY2019, KNOWN_2019, 10.0),
    ]
    bars = [_BarRow("AAPL_US_EQ", FY2019, KNOWN_2019, 300.0)]
    conn = FakeWarehouseConn(facts=facts, bars=bars)
    wh = WarehousePitFundamentals(conn, resolve_instrument=_resolver({"AAPL_US_EQ": 3}))
    out = asyncio.run(wh.fetch_many(["AAPL_US_EQ"], AS_OF_AFTER_2019))
    assert "market_cap_gbp" not in out["AAPL_US_EQ"]


def test_market_cap_computed_for_usd_name_with_injected_fx():
    """With an injected FX callable (Task 15's path), a USD name's market cap becomes computable."""
    facts = [
        _FactRow(3, "shares_outstanding", FY2019, KNOWN_2019, 10.0),
        _FactRow(3, "net_income", FY2019, KNOWN_2019, 5.0),
    ]
    bars = [_BarRow("AAPL_US_EQ", FY2019, KNOWN_2019, 300.0)]
    conn = FakeWarehouseConn(facts=facts, bars=bars)
    wh = WarehousePitFundamentals(
        conn,
        resolve_instrument=_resolver({"AAPL_US_EQ": 3}),
        fx_to_gbp=lambda ccy: 0.8 if ccy == "USD" else (1.0 if ccy == "GBP" else None),
    )
    out = asyncio.run(wh.fetch_many(["AAPL_US_EQ"], AS_OF_AFTER_2019))
    assert out["AAPL_US_EQ"]["market_cap_gbp"] == 300.0 * 10.0 * 0.8


def test_unresolved_or_uncovered_name_absent_never_fabricated():
    """A ticker that doesn't resolve, or resolves to an instrument with no fact ≤ as_of, is ABSENT
    from the map (the forward-only degrade) — never a fabricated value."""
    conn = FakeWarehouseConn(facts=_aapl_facts())
    wh = WarehousePitFundamentals(conn, resolve_instrument=_resolver({"AAPL_US_EQ": 1}))
    # UNKNOWN doesn't resolve; AAPL as-of BEFORE its first filing has no fact ≤ as_of.
    out = asyncio.run(wh.fetch_many(["UNKNOWN_US_EQ", "AAPL_US_EQ"], FY2018 - 1))
    assert "UNKNOWN_US_EQ" not in out
    assert "AAPL_US_EQ" not in out
    assert out == {}


def test_source_for_routes_by_jurisdiction():
    """source_for stamps pit-edgar for US, pit-companies-house for UK (mirror the live resolver)."""
    wh = WarehousePitFundamentals(FakeWarehouseConn())
    assert wh.source_for("AAPL_US_EQ") == SOURCE_PIT_EDGAR
    assert wh.source_for("HSBAl_EQ") == SOURCE_PIT_COMPANIES_HOUSE


def test_warehouse_provider_satisfies_fundamentals_as_of_protocol():
    """WarehousePitFundamentals is a structural FundamentalsAsOf (fetch_many/fetch/source_for)."""
    assert isinstance(WarehousePitFundamentals(FakeWarehouseConn()), FundamentalsAsOf)


def test_compute_market_cap_gbp_drops_on_any_missing_or_non_positive_input():
    """The pure identity returns None (→ key dropped) on any missing/non-finite/non-positive input,
    never a fabricated 0 — same semantics as fundamentals-api's compute_market_cap_gbp."""
    assert _compute_market_cap_gbp(10.0, 2.0, 0.8) == 10.0 * 2.0 * 0.8
    assert _compute_market_cap_gbp(None, 2.0, 0.8) is None
    assert _compute_market_cap_gbp(10.0, None, 0.8) is None
    assert _compute_market_cap_gbp(10.0, 2.0, None) is None
    assert _compute_market_cap_gbp(0.0, 2.0, 0.8) is None       # non-positive price
    assert _compute_market_cap_gbp(10.0, -2.0, 0.8) is None     # non-positive shares
    assert _compute_market_cap_gbp(float("inf"), 2.0, 0.8) is None


# --- PitFundamentalsBarsReader (per-step as-of, stamps point_in_time) -------------------------

class _StubBars:
    async def history_as_of(self, tickers, as_of_ms, lookback_bars):
        return HistoryView(closes={t: [1.0, 1.1] for t in tickers}, volumes={}, timestamps={})

    async def daily_bars(self, ticker, start_ms, end_ms=None):
        return []


class _StubProvider:
    """A FundamentalsAsOf stub that returns covered names only, recording each as_of it was asked."""

    def __init__(self, by_as_of):
        self._by_as_of = by_as_of          # {as_of_ms: {ticker: line_items}}
        self.calls = []

    async def fetch_many(self, tickers, as_of_ms):
        self.calls.append((tuple(tickers), as_of_ms))
        return self._by_as_of.get(as_of_ms, {})

    async def fetch(self, ticker, as_of_ms):
        return (await self.fetch_many([ticker], as_of_ms)).get(ticker, {})

    def source_for(self, ticker):
        return SOURCE_PIT_EDGAR


def test_pit_reader_fetches_per_step_as_of_and_passes_bars_through():
    """The reader re-resolves fundamentals at EACH step's as_of (not one static snapshot) and leaves
    the bars untouched."""
    provider = _StubProvider({
        100: {"AAA_US_EQ": {"total_assets": 1.0}},
        200: {"AAA_US_EQ": {"total_assets": 2.0}},   # a later step sees a different (newer) value
    })
    reader = PitFundamentalsBarsReader(_StubBars(), provider)
    hv1 = asyncio.run(reader.history_as_of(["AAA_US_EQ"], 100, 10))
    hv2 = asyncio.run(reader.history_as_of(["AAA_US_EQ"], 200, 10))
    assert hv1.fundamentals["AAA_US_EQ"]["total_assets"] == 1.0
    assert hv2.fundamentals["AAA_US_EQ"]["total_assets"] == 2.0      # per-step, not reused
    assert hv1.closes["AAA_US_EQ"] == [1.0, 1.1]                      # bars passed through
    assert provider.calls == [(("AAA_US_EQ",), 100), (("AAA_US_EQ",), 200)]


def test_pit_reader_degrades_uncovered_names_to_empty():
    """Uncovered names (the provider omits them) arrive `{}` to the strategy — never a proxy."""
    provider = _StubProvider({100: {"COVERED_US_EQ": {"total_assets": 1.0}}})
    reader = PitFundamentalsBarsReader(_StubBars(), provider)
    hv = asyncio.run(reader.history_as_of(["COVERED_US_EQ", "UNCOVERED_US_EQ"], 100, 10))
    assert hv.fundamentals["COVERED_US_EQ"] == {"total_assets": 1.0}
    assert hv.fundamentals.get("UNCOVERED_US_EQ", {}) == {}          # the .get(t, {}) degrade
    assert "UNCOVERED_US_EQ" not in hv.fundamentals


def test_pit_reader_stamps_point_in_time_not_approximate():
    """The PIT reader advertises 'point_in_time'; the static reader stays 'point_in_time_approximate'
    — the caller reads these constants so the report stamp can't drift from the reader."""
    assert PitFundamentalsBarsReader.FUNDAMENTALS_DATA_QUALITY == "point_in_time"
    assert FundamentalsBarsReader.FUNDAMENTALS_DATA_QUALITY == "point_in_time_approximate"

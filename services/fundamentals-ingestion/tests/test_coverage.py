"""Coverage resolver tests — the active-universe ∪ S&P-PIT-members set (epic Task 9).

Proves the pure set logic (`bare_us_symbol`, `resolve_coverage`) over fixture inputs — T212→bare
symbol normalisation, the survivorship-free index union, mode selection, and the never-truncate cap
(the curated universe is always fully covered; the cap bounds only the index-history remainder) — and
the thin Mongo wrapper (`load_coverage`) against a tiny fake motor db. No network, no DB.
"""
from __future__ import annotations

import pytest

from src.coverage import (
    COVERAGE_INDEX_ONLY,
    COVERAGE_UNIVERSE_ONLY,
    COVERAGE_UNIVERSE_PLUS_INDEX,
    bare_us_symbol,
    coverage_cap_from_env,
    load_coverage,
    resolve_coverage,
)

_DAY = 86_400_000


# ── bare_us_symbol ───────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "ticker,expected",
    [
        ("AAPL_US_EQ", "AAPL"),     # T212 US suffix stripped
        ("aapl_us_eq", "AAPL"),     # case-normalised
        ("AAPL", "AAPL"),           # already-bare S&P symbol
        ("BRK.B", "BRK.B"),         # dotted class symbol kept (EDGAR maps these)
        ("VODl_EQ", None),          # UK (LSE) → out of scope for the EDGAR phase
        ("SHELl_EQ", None),         # UK → dropped
        ("  MSFT_US_EQ ", "MSFT"),  # whitespace tolerated
        ("", None),                 # empty → None
        ("FOO_DE_EQ", None),        # a non-US, non-UK suffix → dropped (no US CIK)
    ],
)
def test_bare_us_symbol(ticker, expected) -> None:
    assert bare_us_symbol(ticker) == expected


# ── resolve_coverage (pure) ──────────────────────────────────────────────────────
def _idx(ticker: str, frm: int, to=None) -> dict:
    return {"ticker": ticker, "effective_from": frm, "effective_to": to}


def test_union_of_universe_and_index_normalised() -> None:
    # Universe carries T212 suffixes + a UK name (dropped); index carries bare symbols incl. a former
    # member (effective_to closed) that must still be in the survivorship-free union over the window.
    universe = ["AAPL_US_EQ", "MSFT_US_EQ", "VODl_EQ"]
    index = [
        _idx("AAPL", 0),                       # still a member (open)
        _idx("YHOO", 1_000 * _DAY, 2_000 * _DAY),  # left the index — but inside the window → included
        _idx("GE", 0),
    ]
    out = resolve_coverage(
        universe_tickers=universe, index_rows=index,
        window_lo_ms=0, window_hi_ms=3_000 * _DAY, cap=None,
    )
    # UK dropped; the set is universe-first (priority under a cap), then the alphabetical index-only
    # remainder: [AAPL, MSFT] (universe, sorted) + [GE, YHOO] (index-only, sorted).
    assert out == ["AAPL", "MSFT", "GE", "YHOO"]
    assert set(out) == {"AAPL", "MSFT", "GE", "YHOO"}


def test_index_member_outside_window_excluded() -> None:
    index = [_idx("OLD", 0, 100 * _DAY)]   # left long before the window opens
    out = resolve_coverage(
        universe_tickers=[], index_rows=index,
        window_lo_ms=1_000 * _DAY, window_hi_ms=2_000 * _DAY, cap=None,
    )
    assert out == []


def test_mode_universe_only_ignores_index() -> None:
    out = resolve_coverage(
        universe_tickers=["AAPL_US_EQ"], index_rows=[_idx("MSFT", 0)],
        window_lo_ms=0, window_hi_ms=None, mode=COVERAGE_UNIVERSE_ONLY, cap=None,
    )
    assert out == ["AAPL"]


def test_mode_index_only_ignores_universe() -> None:
    out = resolve_coverage(
        universe_tickers=["AAPL_US_EQ"], index_rows=[_idx("MSFT", 0)],
        window_lo_ms=0, window_hi_ms=None, mode=COVERAGE_INDEX_ONLY, cap=None,
    )
    assert out == ["MSFT"]


def test_cap_prioritises_the_active_universe() -> None:
    # 1 universe name + several index-only names, cap=2: the live-traded universe name is ALWAYS kept,
    # then the alphabetical index remainder fills the budget. ZZZ (universe) must survive a cap that
    # would drop it under a naive alphabetical sort of the whole union.
    out = resolve_coverage(
        universe_tickers=["ZZZ_US_EQ"],
        index_rows=[_idx("AAA", 0), _idx("BBB", 0), _idx("CCC", 0)],
        window_lo_ms=0, window_hi_ms=None, mode=COVERAGE_UNIVERSE_PLUS_INDEX, cap=2,
    )
    assert "ZZZ" in out and len(out) == 2
    assert out == ["ZZZ", "AAA"]   # universe first, then the alphabetical index remainder


def test_cap_below_universe_size_keeps_all_universe_names() -> None:
    # The cap NEVER truncates the curated universe — fundamentals track what we hold. With 4 held names
    # and cap=2 (< |universe|), ALL FOUR universe names survive and the index remainder is empty (the
    # leftover budget max(0, 2-4) == 0). This is the bug the fix targets: the old combined-list cap
    # would have head-truncated the held set to ["AAPL","GOOG"].
    universe = ["MSFT_US_EQ", "GOOG_US_EQ", "AAPL_US_EQ", "TSLA_US_EQ"]
    index = [_idx("AAA", 0), _idx("BBB", 0), _idx("ZZZ", 0)]
    out = resolve_coverage(
        universe_tickers=universe, index_rows=index,
        window_lo_ms=0, window_hi_ms=None, mode=COVERAGE_UNIVERSE_PLUS_INDEX, cap=2,
    )
    assert out == ["AAPL", "GOOG", "MSFT", "TSLA"]            # every held name, alphabetised
    assert set(out) == {bare_us_symbol(t) for t in universe}  # nothing dropped
    assert not (set(out) & {"AAA", "BBB", "ZZZ"})             # index remainder bounded to empty


def test_cap_equal_universe_size_yields_empty_index_remainder() -> None:
    # cap == |universe| → the whole universe, no index tail (budget max(0, 3-3) == 0).
    out = resolve_coverage(
        universe_tickers=["AAA_US_EQ", "BBB_US_EQ", "CCC_US_EQ"],
        index_rows=[_idx("DDD", 0), _idx("EEE", 0)],
        window_lo_ms=0, window_hi_ms=None, mode=COVERAGE_UNIVERSE_PLUS_INDEX, cap=3,
    )
    assert out == ["AAA", "BBB", "CCC"]


def test_cap_above_universe_bounds_only_the_index_remainder() -> None:
    # cap > |universe|: the universe is whole, and the index-only remainder fills the leftover budget
    # (cap - |universe|), still bounded. 2 held + cap=4 ⇒ 2 universe + the first 2 index-only names.
    out = resolve_coverage(
        universe_tickers=["ZUNI_US_EQ", "YUNI_US_EQ"],
        index_rows=[_idx(t, 0) for t in ("AAA", "BBB", "CCC", "DDD")],
        window_lo_ms=0, window_hi_ms=None, mode=COVERAGE_UNIVERSE_PLUS_INDEX, cap=4,
    )
    assert out == ["YUNI", "ZUNI", "AAA", "BBB"]              # full universe + bounded remainder
    assert len(out) == 4


def test_mode_index_only_now_applies_the_cap() -> None:
    # index_only has no held universe to protect, so the cap bounds the sorted index directly.
    rows = [_idx(t, 0) for t in ("AAA", "BBB", "CCC", "DDD")]
    out = resolve_coverage(
        universe_tickers=["MSFT_US_EQ"],  # ignored in index_only mode
        index_rows=rows, window_lo_ms=0, window_hi_ms=None,
        mode=COVERAGE_INDEX_ONLY, cap=2,
    )
    assert out == ["AAA", "BBB"]
    # Uncapped index_only is unchanged (the whole sorted index).
    assert resolve_coverage(
        universe_tickers=[], index_rows=rows, window_lo_ms=0,
        mode=COVERAGE_INDEX_ONLY, cap=None,
    ) == ["AAA", "BBB", "CCC", "DDD"]


def test_mode_universe_only_is_never_capped() -> None:
    # The universe is never truncated — a cap below the held count is a no-op in universe_only mode.
    out = resolve_coverage(
        universe_tickers=["MSFT_US_EQ", "AAPL_US_EQ", "GOOG_US_EQ"],
        index_rows=[_idx("ZZZ", 0)], window_lo_ms=0, window_hi_ms=None,
        mode=COVERAGE_UNIVERSE_ONLY, cap=1,
    )
    assert out == ["AAPL", "GOOG", "MSFT"]


def test_cap_zero_or_none_is_uncapped() -> None:
    rows = [_idx(t, 0) for t in ("AAA", "BBB", "CCC", "DDD")]
    full = resolve_coverage(universe_tickers=[], index_rows=rows, window_lo_ms=0, cap=None)
    assert full == ["AAA", "BBB", "CCC", "DDD"]
    assert resolve_coverage(universe_tickers=[], index_rows=rows, window_lo_ms=0, cap=0) == full


def test_dedup_universe_and_index_overlap() -> None:
    # A name in BOTH the universe and the index appears once (universe wins its slot, no duplicate).
    out = resolve_coverage(
        universe_tickers=["AAPL_US_EQ"], index_rows=[_idx("AAPL", 0), _idx("MSFT", 0)],
        window_lo_ms=0, window_hi_ms=None, cap=None,
    )
    assert out == ["AAPL", "MSFT"]


def test_coverage_cap_from_env(monkeypatch) -> None:
    monkeypatch.delenv("FUNDAMENTALS_COVERAGE_CAP", raising=False)
    assert coverage_cap_from_env() == 64               # default
    monkeypatch.setenv("FUNDAMENTALS_COVERAGE_CAP", "10")
    assert coverage_cap_from_env() == 10
    monkeypatch.setenv("FUNDAMENTALS_COVERAGE_CAP", "0")
    assert coverage_cap_from_env() is None             # explicit uncapped
    monkeypatch.setenv("FUNDAMENTALS_COVERAGE_CAP", "junk")
    assert coverage_cap_from_env() == 64               # unparseable → default


# ── load_coverage (fake motor db) ────────────────────────────────────────────────
class _FakeCursor:
    """An async-iterable over a fixed row list (motor's find() cursor surface)."""

    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    def __aiter__(self):
        async def gen():
            for r in self._rows:
                yield r
        return gen()


class _FakeCollection:
    def __init__(self, rows: list[dict], *, raise_on_find: bool = False) -> None:
        self._rows = rows
        self._raise = raise_on_find

    def find(self, query, projection=None):  # noqa: ARG002 — query/projection unused by the fake
        if self._raise:
            raise RuntimeError("mongo down")
        return _FakeCursor(self._rows)


class _FakeDb:
    def __init__(self, registry_rows, index_rows, *, registry_raises=False, index_raises=False):
        self._cols = {
            "instrument_registry": _FakeCollection(registry_rows, raise_on_find=registry_raises),
            "index_constituents": _FakeCollection(index_rows, raise_on_find=index_raises),
        }

    def __getitem__(self, name):
        return self._cols[name]


@pytest.mark.asyncio
async def test_load_coverage_reads_both_collections() -> None:
    db = _FakeDb(
        registry_rows=[{"ticker": "AAPL_US_EQ"}, {"ticker": "VODl_EQ"}],  # UK dropped
        index_rows=[_idx("MSFT", 0), _idx("AAPL", 0)],
    )
    out = await load_coverage(db, window_lo_ms=0, window_hi_ms=10_000 * _DAY, cap=None)
    assert out == ["AAPL", "MSFT"]


@pytest.mark.asyncio
async def test_load_coverage_degrades_when_index_read_fails() -> None:
    # A missing/broken index collection still yields the universe (partial coverage beats none).
    db = _FakeDb(registry_rows=[{"ticker": "AAPL_US_EQ"}], index_rows=[], index_raises=True)
    out = await load_coverage(db, window_lo_ms=0, cap=None)
    assert out == ["AAPL"]


@pytest.mark.asyncio
async def test_load_coverage_degrades_when_universe_read_fails() -> None:
    db = _FakeDb(registry_rows=[], index_rows=[_idx("MSFT", 0)], registry_raises=True)
    out = await load_coverage(db, window_lo_ms=0, cap=None)
    assert out == ["MSFT"]

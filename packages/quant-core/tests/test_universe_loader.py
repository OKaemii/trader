"""Point-in-time membership resolution — as-of correctness, including a rejoined ticker."""
from quant_core.universe import active_union, load_constituents

ROWS = [
    {"ticker": "AAA", "effective_from": 1000, "effective_to": 3000},   # member [1000, 3000)
    {"ticker": "BBB", "effective_from": 2000, "effective_to": None},   # member [2000, ∞)
    {"ticker": "AAA", "effective_from": 5000, "effective_to": None},   # AAA rejoined [5000, ∞)
]


def test_load_constituents_as_of():
    assert load_constituents(ROWS, 500) == []                # before anything
    assert load_constituents(ROWS, 1500) == ["AAA"]
    assert load_constituents(ROWS, 2500) == ["AAA", "BBB"]
    assert load_constituents(ROWS, 3000) == ["BBB"]          # AAA left at 3000 (exclusive)
    assert load_constituents(ROWS, 4000) == ["BBB"]          # AAA's gap
    assert load_constituents(ROWS, 6000) == ["AAA", "BBB"]   # AAA rejoined


def test_active_union_over_window():
    assert active_union(ROWS, 1500, 1800) == ["AAA"]         # only AAA active in window
    assert active_union(ROWS, 1500, 6000) == ["AAA", "BBB"]  # both, ever
    assert active_union(ROWS, 3500, 4500) == ["BBB"]         # inside AAA's gap
    assert active_union(ROWS, 6000, 7000) == ["AAA", "BBB"]  # AAA's second interval + BBB

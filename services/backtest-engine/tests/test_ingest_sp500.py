"""S&P 500 history ingester — the snapshot→interval diff, the survivorship-free core.

Pure functions over fixture CSV/snapshots; no network or Mongo. The interval math is what makes
membership point-in-time, so a wrong diff = a wrong (survivorship-biased) universe."""
from src.scripts.ingest_sp500_history import _to_ms, build_intervals, parse_snapshots


def test_parse_snapshots_handles_header_and_quoted_list():
    csv = 'date,tickers\n2016-01-04,"AAA,BBB"\n2017-01-04,"BBB,CCC"\n'
    snaps = parse_snapshots(csv)
    assert [s[1] for s in snaps] == [{"AAA", "BBB"}, {"BBB", "CCC"}]
    assert snaps[0][0] == _to_ms("2016-01-04") and snaps[0][0] < snaps[1][0]


def test_to_ms_tolerates_formats():
    assert _to_ms("2016-01-04") == _to_ms("01/04/2016") == _to_ms("01-04-2016")


def test_build_intervals_open_and_closed():
    s0, s1, s2 = _to_ms("2016-01-04"), _to_ms("2017-01-04"), _to_ms("2018-01-04")
    rows = build_intervals([(s0, {"AAA", "BBB"}), (s1, {"BBB", "CCC"}), (s2, {"BBB", "CCC"})])
    by = {r["ticker"]: r for r in rows}
    assert by["AAA"]["effective_from"] == s0 and by["AAA"]["effective_to"] == s1   # left at s1
    assert by["BBB"]["effective_from"] == s0 and by["BBB"]["effective_to"] is None  # never left
    assert by["CCC"]["effective_from"] == s1 and by["CCC"]["effective_to"] is None  # joined at s1


def test_rejoin_yields_two_intervals():
    s0, s1, s2 = _to_ms("2016-01-04"), _to_ms("2017-01-04"), _to_ms("2018-01-04")
    rows = build_intervals([(s0, {"X", "Y"}), (s1, {"Y"}), (s2, {"X", "Y"})])
    x = sorted([r for r in rows if r["ticker"] == "X"], key=lambda r: r["effective_from"])
    assert len(x) == 2
    assert x[0]["effective_from"] == s0 and x[0]["effective_to"] == s1   # left at s1
    assert x[1]["effective_from"] == s2 and x[1]["effective_to"] is None  # rejoined at s2

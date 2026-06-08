"""FTSE membership ingester — the snapshot→interval diff (the UK survivorship-free twin of the S&P
path) PLUS the loader resolution + the shared-collection index isolation the card calls out.

Pure functions over fixture CSV/snapshots; a tiny in-memory async Mongo fake for the upsert path —
no network, no Mongo in CI. The interval math is what makes membership point-in-time; the index tag
is what keeps FTSE rows from bleeding into the S&P rows in the one `index_constituents` collection.
"""
import asyncio

import pytest

from quant_core.universe import active_union, load_constituents
from src.scripts.ingest_ftse_history import (
    build_intervals,
    ingest,
    months_in_range,
    parse_constituents_csv,
    yahoo_lse_to_t212,
    _month_to_ms,
)

# ----- ticker convention: Yahoo .L → T212 *l_EQ -----------------------------------------------


def test_yahoo_lse_to_t212_maps_to_platform_convention():
    assert yahoo_lse_to_t212("AAL.L") == "AALl_EQ"      # Anglo American
    assert yahoo_lse_to_t212("aal.l") == "AALl_EQ"      # case-insensitive
    assert yahoo_lse_to_t212("BA/.L") == "BAl_EQ"       # BAE — Yahoo class slash dropped
    assert yahoo_lse_to_t212("HL/.L") == "HLl_EQ"
    assert yahoo_lse_to_t212("TW/.L") == "TWl_EQ"
    assert yahoo_lse_to_t212("AAPL") is None            # not a .L symbol → skipped
    assert yahoo_lse_to_t212("") is None


def test_parse_constituents_csv_skips_header_and_maps():
    csv = "Symbol,Name\nAAL.L,Anglo American PLC\nBA/.L,BAE Systems PLC\nVOD.L,Vodafone\n"
    assert parse_constituents_csv(csv) == {"AALl_EQ", "BAl_EQ", "VODl_EQ"}


def test_months_in_range_inclusive_and_wraps_year():
    assert months_in_range("2023-11", "2024-02") == [(2023, 11), (2023, 12), (2024, 1), (2024, 2)]
    assert months_in_range("2024-03", "2024-03") == [(2024, 3)]
    with pytest.raises(ValueError):
        months_in_range("2024-05", "2024-01")


# ----- interval diff (same semantics as the S&P path, fed snapshot-per-file) -------------------


def test_build_intervals_open_closed_and_index_tag():
    s0, s1, s2 = _month_to_ms(2023, 7), _month_to_ms(2024, 1), _month_to_ms(2025, 1)
    rows = build_intervals(
        [(s0, {"AALl_EQ", "BAl_EQ"}), (s1, {"BAl_EQ", "VODl_EQ"}), (s2, {"BAl_EQ", "VODl_EQ"})],
        index="FTSE100",
    )
    by = {r["ticker"]: r for r in rows}
    assert by["AALl_EQ"]["effective_from"] == s0 and by["AALl_EQ"]["effective_to"] == s1  # left at s1
    assert by["BAl_EQ"]["effective_from"] == s0 and by["BAl_EQ"]["effective_to"] is None   # never left
    assert by["VODl_EQ"]["effective_from"] == s1 and by["VODl_EQ"]["effective_to"] is None  # joined s1
    assert all(r["index"] == "FTSE100" for r in rows)


def test_rejoin_yields_two_intervals():
    s0, s1, s2 = _month_to_ms(2023, 7), _month_to_ms(2024, 1), _month_to_ms(2025, 1)
    rows = build_intervals([(s0, {"Xl_EQ", "Yl_EQ"}), (s1, {"Yl_EQ"}), (s2, {"Xl_EQ", "Yl_EQ"})])
    x = sorted([r for r in rows if r["ticker"] == "Xl_EQ"], key=lambda r: r["effective_from"])
    assert len(x) == 2
    assert x[0]["effective_from"] == s0 and x[0]["effective_to"] == s1   # left at s1
    assert x[1]["effective_from"] == s2 and x[1]["effective_to"] is None  # rejoined at s2


# ----- loader resolves the ingested FTSE rows AS-OF (card requirement) -------------------------


def test_load_constituents_resolves_ftse_membership_as_of():
    """A name that joined the FTSE 100 at s1 is absent before s1 and present after — point-in-time."""
    s0, s1, s2 = _month_to_ms(2023, 7), _month_to_ms(2024, 6), _month_to_ms(2025, 1)
    rows = build_intervals(
        [(s0, {"AALl_EQ", "BAl_EQ"}), (s1, {"BAl_EQ", "VODl_EQ"}), (s2, {"BAl_EQ", "VODl_EQ"})],
        index="FTSE100",
    )
    # VODl_EQ joins at s1: not a member just before s1, a member just after.
    assert "VODl_EQ" not in load_constituents(rows, s1 - 1)
    assert "VODl_EQ" in load_constituents(rows, s1 + 1)
    # AALl_EQ left at s1: a member at s0, gone after s1.
    assert "AALl_EQ" in load_constituents(rows, s0)
    assert "AALl_EQ" not in load_constituents(rows, s1)
    # active_union over the whole window keeps every name that was ever a member (survivorship-free).
    assert set(active_union(rows, s0, s2)) == {"AALl_EQ", "BAl_EQ", "VODl_EQ"}


# ----- shared collection: the FTSE index filter does NOT bleed into SP500 ----------------------


class _Coll:
    """In-memory async stand-in for a Mongo collection with the upsert-by-key path ingest() uses."""

    def __init__(self):
        self.docs: list[dict] = []

    async def update_one(self, filt, update, upsert=False):
        for d in self.docs:
            if all(d.get(k) == v for k, v in filt.items()):
                d.update(update.get("$set", {}))
                return
        if upsert:
            self.docs.append({**filt, **update.get("$set", {})})

    async def insert_one(self, doc):
        self.docs.append(dict(doc))

    def find(self, filt, projection=None):
        rows = [dict(d) for d in self.docs if all(d.get(k) == v for k, v in filt.items())]

        class _Cursor:
            async def to_list(self_inner, length=None):
                return rows

        return _Cursor()


class _Db:
    def __init__(self):
        self._c: dict[str, _Coll] = {}

    def __getitem__(self, name):
        return self._c.setdefault(name, _Coll())


async def _ingest_with_snaps(db, snaps, index, monkeypatch):
    """Run ingest() against the fake DB with fetch_snapshots stubbed (no network)."""
    import src.scripts.ingest_ftse_history as mod

    async def _fake_fetch(base_url, idx, months):
        return snaps

    monkeypatch.setattr(mod, "fetch_snapshots", _fake_fetch)
    return await mod.ingest(db, index=index, start_ym="2023-07", end_ym="2025-01")


def test_ingest_idempotent_and_index_isolated(monkeypatch):
    s0, s1 = _month_to_ms(2023, 7), _month_to_ms(2024, 1)
    db = _Db()

    # Seed an existing S&P row in the SHARED collection — it must survive the FTSE ingest untouched.
    asyncio.run(db["index_constituents"].insert_one(
        {"index": "sp500", "ticker": "AAPL", "effective_from": s0, "effective_to": None}))

    ftse_snaps = [(s0, {"AALl_EQ", "BAl_EQ"}), (s1, {"BAl_EQ", "VODl_EQ"})]
    r1 = asyncio.run(_ingest_with_snaps(db, ftse_snaps, "FTSE100", monkeypatch))
    after_first = len(db["index_constituents"].docs)

    # Re-ingest the identical snapshots → upsert-by-(index,ticker,effective_from) ⇒ no new rows.
    r2 = asyncio.run(_ingest_with_snaps(db, ftse_snaps, "FTSE100", monkeypatch))
    after_second = len(db["index_constituents"].docs)
    assert after_first == after_second, "re-ingest must be idempotent (no duplicate rows)"
    assert r1["intervals"] == r2["intervals"]

    docs = db["index_constituents"].docs
    ftse_rows = [d for d in docs if d["index"] == "FTSE100"]
    sp_rows = [d for d in docs if d["index"] == "sp500"]

    # The UK index filter resolves ONLY FTSE rows; the S&P row is present but excluded by the filter.
    assert all(t.endswith("l_EQ") for t in {d["ticker"] for d in ftse_rows})
    assert load_constituents(ftse_rows, s1 + 1) == ["BAl_EQ", "VODl_EQ"]      # FTSE as-of
    assert "AAPL" not in load_constituents(ftse_rows, s1 + 1)                 # no SP500 bleed-in
    # And the S&P row is untouched / still resolvable on its own filter.
    assert len(sp_rows) == 1 and sp_rows[0]["ticker"] == "AAPL"
    assert load_constituents(sp_rows, s1) == ["AAPL"]

    # data_source provenance stamped (forensic) + audit row written.
    assert all(d.get("data_source") == "yfiua_index_constituents_csv" for d in ftse_rows)
    assert len(db["index_constituents_audit"].docs) == 2  # one per ingest run

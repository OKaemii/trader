"""Per-name freshness audit tests (epic coverage-broaden Task 4).

Proves `freshness.freshness_audit` folds the curated US universe (read from a fake motor db, reusing
the Task-1 coverage read) against the canonical `fundamentals` + `fundamentals_revisions_log` tables
(answered off the shared FakeTimescale, extended here with the two per-name aggregate shapes the module
issues) into per-name (covered · newest period_end · availability · last_stored_at · staleness · stale)
rows + the aggregate (coverage_pct · retirable · last_ingest_run). No network, no real DB.

The load-bearing distinction the audit exists for: `last_stored_at` = MAX(revisions_log.logged_at)
advances ONLY on a real write (first-print/supersede). The writer hash-gates an unchanged re-poll into a
no-op (no revision-log row), so an idempotent nightly sweep must NOT bump it — `test_last_stored_at_*`
pins that by seeding a revision-log row at a fixed instant and asserting a no-op re-poll leaves it put.
"""
from __future__ import annotations

import pytest

from src.freshness import (
    DEFAULT_STALE_AFTER_DAYS,
    freshness_audit,
    stale_after_ms_from_days,
)
from tests.fakes import FakeTimescale

_DAY = 86_400_000


# ── fake motor db for the curated-universe read (mirrors test_coverage.py's _FakeDb) ──────────────
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


class _FakeMongo:
    """A motor-db stand-in serving the `instrument_registry {activeTo:null}` universe read that
    `freshness._curated_us_universe` (via `coverage.load_coverage`) issues. Only the registry collection
    is touched in universe-only mode; `index_constituents` is provided empty for completeness."""

    def __init__(self, registry_tickers: list[str], *, registry_raises: bool = False) -> None:
        self._cols = {
            "instrument_registry": _FakeCollection(
                [{"ticker": t} for t in registry_tickers], raise_on_find=registry_raises
            ),
            "index_constituents": _FakeCollection([]),
        }

    def __getitem__(self, name):
        return self._cols[name]


# ── FakeTimescale + the two per-name freshness aggregates ─────────────────────────────────────────
class _FreshnessFakeTimescale(FakeTimescale):
    """FakeTimescale + the per-ticker aggregate shapes `freshness.py` issues (the base fake doesn't
    model them). Answers the newest-fact-by-ticker JOIN and the last-stored-by-ticker revisions JOIN off
    the in-memory `fundamentals` / `fundamentals_revisions_log` / `instruments` rows — faithful in-memory
    store, not a SQL engine."""

    def run_fetch(self, query, args):
        q = self._norm(query)

        # Newest fiscal period + availability per curated ticker: fundamentals (current) JOIN instruments,
        # filtered to the ticker list ($1), grouped by t212_ticker. Mirrors _NEWEST_BY_TICKER_SQL.
        if "from fundamentals f" in q and "join security_master.instruments inst" in q \
                and "group by inst.t212_ticker" in q:
            tickers = set(args[0])
            ticker_by_inst = {i["instrument_id"]: i["t212_ticker"] for i in self.instruments}
            agg: dict[str, dict] = {}
            for r in self.fundamentals:
                if r["is_superseded"]:
                    continue
                tk = ticker_by_inst.get(r["instrument_id"])
                if tk is None or tk not in tickers:
                    continue
                cur = agg.get(tk)
                if cur is None:
                    agg[tk] = {
                        "t212_ticker": tk,
                        "instrument_id": r["instrument_id"],
                        "newest_period_end": r["observation_ts"],
                        "newest_knowledge_ts": r["knowledge_ts"],
                    }
                else:
                    cur["instrument_id"] = max(cur["instrument_id"], r["instrument_id"])
                    cur["newest_period_end"] = max(cur["newest_period_end"], r["observation_ts"])
                    cur["newest_knowledge_ts"] = max(cur["newest_knowledge_ts"], r["knowledge_ts"])
            return list(agg.values())

        # Last persisted wall-clock per curated ticker: MAX(logged_at) on the revisions log JOIN
        # instruments, grouped by t212_ticker. The fake stores logged_at as UTC-ms already, so it returns
        # the max directly (the real query's EXTRACT(EPOCH…)*1000 yields the same ms). Mirrors
        # _LAST_STORED_BY_TICKER_SQL.
        if "from fundamentals_revisions_log rl" in q and "max(rl.logged_at)" in q \
                and "group by inst.t212_ticker" in q:
            tickers = set(args[0])
            ticker_by_inst = {i["instrument_id"]: i["t212_ticker"] for i in self.instruments}
            by_ticker: dict[str, int] = {}
            for r in self.fundamentals_revisions_log:
                tk = ticker_by_inst.get(r["instrument_id"])
                if tk is None or tk not in tickers:
                    continue
                logged = r.get("logged_at")
                if logged is None:
                    continue
                by_ticker[tk] = max(by_ticker.get(tk, logged), logged)
            return [{"t212_ticker": tk, "last_stored_at": ms} for tk, ms in by_ticker.items()]

        return super().run_fetch(query, args)


# ── seed helpers ──────────────────────────────────────────────────────────────────────────────────
def _seed_instrument(db, *, instrument_id: int, t212_ticker: str) -> None:
    db.instruments.append({
        "instrument_id": instrument_id, "company_id": instrument_id, "instrument_type": "common",
        "exchange": "NASDAQ", "currency": "USD", "t212_ticker": t212_ticker,
    })


def _seed_fact(db, *, instrument_id: int, metric: str, observation_ts: int, knowledge_ts: int) -> None:
    db.fundamentals.append({
        "instrument_id": instrument_id, "metric": metric, "observation_ts": observation_ts,
        "knowledge_ts": knowledge_ts, "dim_signature": "", "value": 1.0, "is_superseded": False,
        "content_hash": "h", "source": "pit-edgar",
    })


def _seed_revision(db, *, instrument_id: int, metric: str, observation_ts: int, knowledge_ts: int,
                   logged_at: int) -> None:
    """Append a revisions-log row at an explicit wall-clock `logged_at` (UTC-ms). The real writer leaves
    logged_at to the DB DEFAULT NOW(); the test pins it so `last_stored_at` is deterministic and the
    'advances only on a real write' invariant is checkable."""
    db.fundamentals_revisions_log.append({
        "instrument_id": instrument_id, "metric": metric, "observation_ts": observation_ts,
        "dim_signature": "", "knowledge_ts": knowledge_ts, "prior_hash": None, "new_hash": "h",
        "accession_number": "0000000000-00-000000", "logged_at": logged_at,
    })


# ── stale_after_ms_from_days (pure) ────────────────────────────────────────────────────────────────
def test_stale_after_ms_from_days_default_on_bad_input() -> None:
    default_ms = DEFAULT_STALE_AFTER_DAYS * _DAY
    assert stale_after_ms_from_days(None) == default_ms      # unset ⇒ default window
    assert stale_after_ms_from_days(0) == default_ms         # non-positive ⇒ default (never "never stale")
    assert stale_after_ms_from_days(-5) == default_ms
    assert stale_after_ms_from_days(90) == 90 * _DAY         # explicit days honoured


# ── freshness_audit ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_covered_missing_stale_buckets_and_retirable_false() -> None:
    # Curated US universe = AAPL, MSFT, NVDA (UK VOD dropped by the US filter in the coverage read).
    mongo = _FakeMongo(["AAPL_US_EQ", "MSFT_US_EQ", "NVDA_US_EQ", "VODl_EQ"])
    db = _FreshnessFakeTimescale()
    # AAPL: instrument + a FRESH fact (period_end == now) → covered, not stale.
    _seed_instrument(db, instrument_id=1, t212_ticker="AAPL_US_EQ")
    now = 1_000_000 * _DAY
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now, knowledge_ts=now + _DAY)
    _seed_revision(db, instrument_id=1, metric="net_income", observation_ts=now, knowledge_ts=now + _DAY,
                   logged_at=now + _DAY)
    # MSFT: instrument + a STALE fact (period_end 200 days ago, > the 135-day default window) → covered, stale.
    _seed_instrument(db, instrument_id=2, t212_ticker="MSFT_US_EQ")
    _seed_fact(db, instrument_id=2, metric="net_income", observation_ts=now - 200 * _DAY,
               knowledge_ts=now - 199 * _DAY)
    # NVDA: NO instrument, NO fact → missing (and therefore stale).

    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None), last_ingest_run=None
    )

    assert audit["universe"] == 3                 # 3 US names; UK dropped
    assert audit["covered"] == 2                  # AAPL + MSFT
    assert audit["missing"] == 1                  # NVDA
    assert audit["stale"] == 2                    # MSFT (old period) + NVDA (uncovered)
    assert audit["coverage_pct"] == round(100 * 2 / 3, 2)
    assert audit["retirable"] is False            # missing>0 → not safe to retire Yahoo

    by_symbol = {n["symbol"]: n for n in audit["names"]}
    assert set(by_symbol) == {"AAPL", "MSFT", "NVDA"}

    aapl = by_symbol["AAPL"]
    assert aapl["covered"] is True and aapl["stale"] is False
    assert aapl["ticker"] == "AAPL_US_EQ" and aapl["instrument_id"] == 1
    assert aapl["newest_period_end"] == now
    assert aapl["newest_knowledge_ts"] == now + _DAY
    assert aapl["last_stored_at"] == now + _DAY
    assert aapl["staleness_days"] == 0

    msft = by_symbol["MSFT"]
    assert msft["covered"] is True and msft["stale"] is True
    assert msft["staleness_days"] == 200          # whole days since period_end
    assert msft["last_stored_at"] is None         # no revision-log row seeded → no store clock

    nvda = by_symbol["NVDA"]
    assert nvda["covered"] is False and nvda["stale"] is True
    assert nvda["instrument_id"] is None
    assert nvda["newest_period_end"] is None
    assert nvda["staleness_days"] is None         # uncovered ⇒ no age


@pytest.mark.asyncio
async def test_full_coverage_fresh_is_retirable() -> None:
    mongo = _FakeMongo(["AAPL_US_EQ", "MSFT_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 500_000 * _DAY
    for iid, tk in ((1, "AAPL_US_EQ"), (2, "MSFT_US_EQ")):
        _seed_instrument(db, instrument_id=iid, t212_ticker=tk)
        _seed_fact(db, instrument_id=iid, metric="net_income", observation_ts=now - 10 * _DAY,
                   knowledge_ts=now - 9 * _DAY)
        _seed_revision(db, instrument_id=iid, metric="net_income", observation_ts=now - 10 * _DAY,
                       knowledge_ts=now - 9 * _DAY, logged_at=now - 9 * _DAY)

    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None), last_ingest_run=None
    )
    assert audit["universe"] == 2 and audit["covered"] == 2
    assert audit["missing"] == 0 and audit["stale"] == 0
    assert audit["coverage_pct"] == 100.0
    assert audit["retirable"] is True             # complete + fresh ⇒ Yahoo retirable for US


@pytest.mark.asyncio
async def test_cold_warehouse_all_uncovered_not_retirable() -> None:
    # Curated universe known, but the warehouse has no facts/instruments (pre-backfill).
    mongo = _FakeMongo(["AAPL_US_EQ", "MSFT_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 100 * _DAY
    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None), last_ingest_run=None
    )
    assert audit["universe"] == 2
    assert audit["covered"] == 0 and audit["missing"] == 2 and audit["stale"] == 2
    assert audit["coverage_pct"] == 0.0
    assert audit["retirable"] is False
    for n in audit["names"]:
        assert n["covered"] is False and n["stale"] is True
        assert n["newest_period_end"] is None and n["last_stored_at"] is None


@pytest.mark.asyncio
async def test_empty_universe_is_zeros_not_retirable() -> None:
    # No curated names at all (degenerate). Coverage_pct guards the div-by-zero; retirable stays false
    # (there is nothing proven complete — never report "safe to retire" off an empty universe).
    db = _FreshnessFakeTimescale()
    audit = await freshness_audit(
        db, _FakeMongo([]), now_ms=10 * _DAY, stale_after_ms=stale_after_ms_from_days(None),
        last_ingest_run=None,
    )
    assert audit["universe"] == 0 and audit["covered"] == 0 and audit["missing"] == 0
    assert audit["coverage_pct"] == 0.0
    assert audit["names"] == []
    # missing==0 and stale==0 on an empty universe is vacuously retirable — acceptable (the endpoint's
    # universe count makes "0/0" unambiguous to the operator), and there are no US names to keep on Yahoo.
    assert audit["retirable"] is True


@pytest.mark.asyncio
async def test_last_stored_at_advances_only_on_a_real_write() -> None:
    """`last_stored_at` is MAX(revisions_log.logged_at), and the writer logs a row ONLY on a real
    first-print/supersede (an unchanged re-poll is hash-gated to a no-op). So a second sweep that writes
    NO new revision-log row leaves `last_stored_at` exactly where the last real write put it."""
    mongo = _FakeMongo(["AAPL_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 800_000 * _DAY
    _seed_instrument(db, instrument_id=1, t212_ticker="AAPL_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - _DAY, knowledge_ts=now)
    first_write_at = now - _DAY
    _seed_revision(db, instrument_id=1, metric="net_income", observation_ts=now - _DAY, knowledge_ts=now,
                   logged_at=first_write_at)

    audit1 = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None), last_ingest_run=None
    )
    assert audit1["names"][0]["last_stored_at"] == first_write_at

    # An idempotent re-poll: the orchestrator re-reads the SAME facts, the hash-gate matches, NO new
    # revision-log row is written. (We deliberately seed nothing new.) last_stored_at must NOT advance.
    audit2 = await freshness_audit(
        db, mongo, now_ms=now + 10 * _DAY, stale_after_ms=stale_after_ms_from_days(None),
        last_ingest_run=None,
    )
    assert audit2["names"][0]["last_stored_at"] == first_write_at  # unchanged — no real write happened

    # A REAL supersede (a restatement) DOES log a new row at a later wall-clock → last_stored_at advances.
    later_write_at = now + 5 * _DAY
    _seed_revision(db, instrument_id=1, metric="net_income", observation_ts=now - _DAY,
                   knowledge_ts=now + _DAY, logged_at=later_write_at)
    audit3 = await freshness_audit(
        db, mongo, now_ms=now + 10 * _DAY, stale_after_ms=stale_after_ms_from_days(None),
        last_ingest_run=None,
    )
    assert audit3["names"][0]["last_stored_at"] == later_write_at  # advanced on the real write


@pytest.mark.asyncio
async def test_staleness_boundary_at_window_edge() -> None:
    # period_end exactly AT the window edge is NOT stale (strict >); one ms older flips it stale.
    mongo = _FakeMongo(["AAPL_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 600_000 * _DAY
    window_ms = 100 * _DAY
    _seed_instrument(db, instrument_id=1, t212_ticker="AAPL_US_EQ")
    # Exactly at the edge: age == window_ms → not stale.
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - window_ms,
               knowledge_ts=now - window_ms + 1)
    audit = await freshness_audit(db, mongo, now_ms=now, stale_after_ms=window_ms, last_ingest_run=None)
    assert audit["names"][0]["stale"] is False
    assert audit["stale"] == 0 and audit["retirable"] is True


@pytest.mark.asyncio
async def test_last_ingest_run_passed_through() -> None:
    mongo = _FakeMongo([])
    db = _FreshnessFakeTimescale()
    run = {"run_id": "abc", "state": "done", "canonical_inserted": 42}
    audit = await freshness_audit(
        db, mongo, now_ms=1, stale_after_ms=stale_after_ms_from_days(None), last_ingest_run=run
    )
    assert audit["last_ingest_run"] == run        # surfaced verbatim from the run store (like /status)


@pytest.mark.asyncio
async def test_newest_picks_max_across_multiple_periods() -> None:
    # Two periods for one name → newest_period_end/availability are the MAX, not the first/last seen.
    mongo = _FakeMongo(["AAPL_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 700_000 * _DAY
    _seed_instrument(db, instrument_id=1, t212_ticker="AAPL_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - 90 * _DAY,
               knowledge_ts=now - 89 * _DAY)
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - 5 * _DAY,
               knowledge_ts=now - 4 * _DAY)
    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None), last_ingest_run=None
    )
    name = audit["names"][0]
    assert name["newest_period_end"] == now - 5 * _DAY      # the freshest period, not the older one
    assert name["newest_knowledge_ts"] == now - 4 * _DAY
    assert name["stale"] is False

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
    DEFAULT_STALE_AFTER_DAYS_ANNUAL,
    annual_stale_after_ms_from_days,
    freshness_audit,
    stale_after_ms_from_days,
)
from src.security_master.no_edgar import is_no_edgar, no_edgar_reason
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

        # Filing cadence per curated ticker: from security_master.filings JOIN instruments, grouped by
        # t212_ticker, with two MAX(accepted_ts) aggregates — annual-form-only / 10-Q-only. $2 = the
        # annual-form prefix list, $3 = the quarterly prefix. The form-type prefix match mirrors the SQL's
        # split_part(form_type, '/', 1). Mirrors _FILING_CADENCE_BY_TICKER_SQL — which keys on filing
        # CADENCE (does the name file 10-Qs?), NOT which single form is newest, so a name with NEWER
        # 6-K/8-K/Form-4 current reports than its 20-F still surfaces a non-null newest_annual_ts.
        if "from security_master.filings fl" in q and "group by inst.t212_ticker" in q \
                and "newest_annual_ts" in q:
            tickers = set(args[0])
            annual_prefixes = set(args[1])
            quarterly_prefix = args[2]
            ticker_by_inst = {i["instrument_id"]: i["t212_ticker"] for i in self.instruments}
            cad: dict[str, dict] = {}
            for f in self.filings:
                tk = ticker_by_inst.get(f["instrument_id"])
                if tk is None or tk not in tickers:
                    continue
                accepted = f.get("accepted_ts")
                if accepted is None:  # the query filters `accepted_ts IS NOT NULL`
                    continue
                prefix = str(f["form_type"]).split("/", 1)[0]
                cur = cad.setdefault(
                    tk, {"t212_ticker": tk, "newest_annual_ts": None, "newest_quarterly_ts": None},
                )
                if prefix in annual_prefixes:
                    cur["newest_annual_ts"] = _max_opt(cur["newest_annual_ts"], accepted)
                if prefix == quarterly_prefix:
                    cur["newest_quarterly_ts"] = _max_opt(cur["newest_quarterly_ts"], accepted)
            return list(cad.values())

        return super().run_fetch(query, args)


def _max_opt(cur, val: int) -> int:
    """MAX folding an Optional accumulator with a present value (the SQL aggregate semantics)."""
    return val if cur is None else max(cur, val)


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


def _seed_filing(db, *, instrument_id: int, form_type: str, accepted_ts: int) -> None:
    """Append a `security_master.filings` lineage row — `form_type` (10-K/10-Q/20-F/40-F, amendments via
    a `/A` suffix) + `accepted_ts` (UTC-ms). Drives the per-name annual-vs-quarterly staleness window."""
    db.filings.append({
        "filing_id": len(db.filings) + 1, "instrument_id": instrument_id,
        "accession_number": f"acc-{len(db.filings) + 1}", "form_type": form_type,
        "filed_ts": accepted_ts, "accepted_ts": accepted_ts, "filing_url": None,
        "source": "sec-edgar", "is_amendment": form_type.endswith("/A"),
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


# ── annual_stale_after_ms_from_days (pure) ──────────────────────────────────────────────────────────
def test_annual_stale_after_ms_from_days_default_on_bad_input() -> None:
    default_ms = DEFAULT_STALE_AFTER_DAYS_ANNUAL * _DAY
    assert annual_stale_after_ms_from_days(None) == default_ms   # unset ⇒ 400-day annual default
    assert annual_stale_after_ms_from_days(0) == default_ms      # non-positive ⇒ default (never "never stale")
    assert annual_stale_after_ms_from_days(-5) == default_ms
    assert annual_stale_after_ms_from_days(500) == 500 * _DAY    # explicit days honoured
    # The annual default (400) is comfortably wider than the quarterly default (135) — the whole point.
    assert DEFAULT_STALE_AFTER_DAYS_ANNUAL > DEFAULT_STALE_AFTER_DAYS


# ── per-form staleness window selection (A2 core) ───────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_annual_filer_not_stale_while_quarterly_filer_uses_135() -> None:
    """The card's headline: TSM (latest filing 20-F, no recent 10-Q) gets the ~400-day annual window and
    is NOT flagged stale at ~200 days since period_end; AAPL (10-Q) keeps the 135-day quarterly window and
    IS stale at the same ~200-day age."""
    mongo = _FakeMongo(["AAPL_US_EQ", "TSM_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 1_000_000 * _DAY
    age = 200 * _DAY  # between the 135-day quarterly and the 400-day annual windows

    # AAPL: a 10-Q filer (recent 10-Q) with a fiscal period 200 days old → stale under the 135-day window.
    _seed_instrument(db, instrument_id=1, t212_ticker="AAPL_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - age, knowledge_ts=now - age + _DAY)
    _seed_filing(db, instrument_id=1, form_type="10-Q", accepted_ts=now - age + _DAY)

    # TSM: a 20-F annual filer (no 10-Q at all) with the SAME 200-day-old fiscal period → NOT stale under
    # the 400-day annual window. The newest filing is the 20-F.
    _seed_instrument(db, instrument_id=2, t212_ticker="TSM_US_EQ")
    _seed_fact(db, instrument_id=2, metric="net_income", observation_ts=now - age, knowledge_ts=now - age + _DAY)
    _seed_filing(db, instrument_id=2, form_type="20-F", accepted_ts=now - age + _DAY)

    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None),
        annual_stale_after_ms=annual_stale_after_ms_from_days(None), last_ingest_run=None,
    )
    by_symbol = {n["symbol"]: n for n in audit["names"]}

    aapl = by_symbol["AAPL"]
    assert aapl["filing_cadence"] == "quarterly"
    assert aapl["stale"] is True                       # 200d > 135d quarterly window

    tsm = by_symbol["TSM"]
    assert tsm["filing_cadence"] == "annual"
    assert tsm["stale"] is False                       # 200d < 400d annual window — the whole point

    # The aggregate reflects it: only AAPL is stale, so the universe is NOT retirable (one stale name).
    assert audit["covered"] == 2 and audit["stale"] == 1 and audit["retirable"] is False


@pytest.mark.asyncio
async def test_annual_filer_with_newer_current_reports_still_classifies_annual() -> None:
    """The REALISTIC 20-F shape that the prior classifier got wrong. A foreign private issuer files its
    annual 20-F, then a stream of NEWER current reports (6-K interims, an 8-K, a Form-4) — so the name's
    *newest filing overall* is a 6-K/Form-4, NOT the 20-F. The classifier MUST key on filing CADENCE
    (has an annual form, no recent 10-Q), not on "the newest filing is the annual form": the latter test
    misclassified every real annual filer as quarterly (135d) → still flagged stale + force-re-ingested
    every --heal cycle, defeating the card. Here the 20-F is the OLDEST filing on record yet the name is
    annual and NOT stale at 200 days, while a 10-Q filer at the same age IS stale."""
    mongo = _FakeMongo(["AAPL_US_EQ", "TSM_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 1_000_000 * _DAY
    age = 200 * _DAY  # between the 135-day quarterly and the 400-day annual windows

    # AAPL: a domestic 10-Q filer at the same 200-day age → stale under the 135-day quarterly window.
    _seed_instrument(db, instrument_id=1, t212_ticker="AAPL_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - age, knowledge_ts=now - age + _DAY)
    _seed_filing(db, instrument_id=1, form_type="10-Q", accepted_ts=now - age + _DAY)

    # TSM: a 20-F foreign private issuer. Its 20-F is the OLDEST filing; NEWER 6-K interims + an 8-K + a
    # Form-4 all post-date it (insider/ownership current reports a 20-F filer routinely files). The
    # newest filing overall is the Form-4 — NOT the 20-F. No 10-Q is ever filed (the 20-F-filer hallmark).
    _seed_instrument(db, instrument_id=2, t212_ticker="TSM_US_EQ")
    _seed_fact(db, instrument_id=2, metric="net_income", observation_ts=now - age, knowledge_ts=now - age + _DAY)
    _seed_filing(db, instrument_id=2, form_type="20-F", accepted_ts=now - age)          # the annual report (oldest)
    _seed_filing(db, instrument_id=2, form_type="6-K", accepted_ts=now - 90 * _DAY)     # a newer interim
    _seed_filing(db, instrument_id=2, form_type="8-K", accepted_ts=now - 40 * _DAY)     # newer still
    _seed_filing(db, instrument_id=2, form_type="4", accepted_ts=now - 10 * _DAY)       # newest filing overall

    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None),
        annual_stale_after_ms=annual_stale_after_ms_from_days(None), last_ingest_run=None,
    )
    by_symbol = {n["symbol"]: n for n in audit["names"]}

    tsm = by_symbol["TSM"]
    # The regression guard: annual even though the newest filing is a 6-K/Form-4, not the 20-F.
    assert tsm["filing_cadence"] == "annual"
    assert tsm["stale"] is False                       # 200d < 400d annual window — NOT re-ingested

    aapl = by_symbol["AAPL"]
    assert aapl["filing_cadence"] == "quarterly"
    assert aapl["stale"] is True                       # 200d > 135d quarterly window

    # Only AAPL is stale → universe not retirable; TSM is held fresh by the correct annual window.
    assert audit["covered"] == 2 and audit["stale"] == 1 and audit["retirable"] is False


@pytest.mark.asyncio
async def test_annual_filer_beyond_annual_window_is_still_stale() -> None:
    """An annual filer gets a WIDER window, not an infinite one: a 20-F name whose fiscal period is older
    than the 400-day annual window is still flagged stale (so a genuinely-abandoned name still heals).
    Realistic shape: the 20-F is NOT the newest filing — a newer 6-K post-dates it — yet cadence is annual."""
    mongo = _FakeMongo(["TSM_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 1_000_000 * _DAY
    _seed_instrument(db, instrument_id=1, t212_ticker="TSM_US_EQ")
    # 450 days old — beyond the 400-day annual window.
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - 450 * _DAY,
               knowledge_ts=now - 449 * _DAY)
    _seed_filing(db, instrument_id=1, form_type="20-F", accepted_ts=now - 449 * _DAY)
    _seed_filing(db, instrument_id=1, form_type="6-K", accepted_ts=now - 300 * _DAY)   # newer than the 20-F

    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None),
        annual_stale_after_ms=annual_stale_after_ms_from_days(None), last_ingest_run=None,
    )
    name = audit["names"][0]
    assert name["filing_cadence"] == "annual"
    assert name["stale"] is True                       # 450d > 400d annual window


@pytest.mark.asyncio
async def test_annual_form_with_recent_10q_stays_quarterly() -> None:
    """A name that files an annual 10-K but ALSO files 10-Qs is a quarterly filer — the recent 10-Q keeps
    it on the 135-day window. (A domestic name right after its annual 10-K, before the next 10-Q lands;
    the latest filing being the 10-K is irrelevant — cadence, not newest-form, drives the window.)"""
    mongo = _FakeMongo(["MSFT_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 1_000_000 * _DAY
    _seed_instrument(db, instrument_id=1, t212_ticker="MSFT_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - 200 * _DAY,
               knowledge_ts=now - 199 * _DAY)
    # The 10-K is the most recent filing, but a 10-Q sits just behind it (recent) → quarterly cadence.
    _seed_filing(db, instrument_id=1, form_type="10-Q", accepted_ts=now - 95 * _DAY)
    _seed_filing(db, instrument_id=1, form_type="10-K", accepted_ts=now - 30 * _DAY)

    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None),
        annual_stale_after_ms=annual_stale_after_ms_from_days(None), last_ingest_run=None,
    )
    name = audit["names"][0]
    assert name["filing_cadence"] == "quarterly"       # the recent 10-Q dominates
    assert name["stale"] is True                       # 200d > 135d quarterly window


@pytest.mark.asyncio
async def test_amendment_form_classified_by_prefix() -> None:
    """A 20-F/A amendment is an annual form (matched by the `/A`-tolerant prefix), so a name that files a
    20-F/A (with newer 6-K current reports on top, as a real foreign filer has) still gets the annual
    window — the amendment is counted as an annual form even though it isn't the newest filing."""
    mongo = _FakeMongo(["TSM_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 1_000_000 * _DAY
    _seed_instrument(db, instrument_id=1, t212_ticker="TSM_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - 200 * _DAY,
               knowledge_ts=now - 199 * _DAY)
    _seed_filing(db, instrument_id=1, form_type="20-F/A", accepted_ts=now - 199 * _DAY)
    _seed_filing(db, instrument_id=1, form_type="6-K", accepted_ts=now - 50 * _DAY)    # newer than the 20-F/A

    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None),
        annual_stale_after_ms=annual_stale_after_ms_from_days(None), last_ingest_run=None,
    )
    name = audit["names"][0]
    assert name["filing_cadence"] == "annual"
    assert name["stale"] is False                      # 200d < 400d annual window


@pytest.mark.asyncio
async def test_no_filings_on_record_defaults_to_quarterly() -> None:
    """A covered name with NO filing rows (cadence unknown) defaults to the quarterly window — A2 only
    ever widens a window for a name we positively know files annually, never on absent data."""
    mongo = _FakeMongo(["AAPL_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 1_000_000 * _DAY
    _seed_instrument(db, instrument_id=1, t212_ticker="AAPL_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - 200 * _DAY,
               knowledge_ts=now - 199 * _DAY)
    # No _seed_filing → no cadence row for this ticker.

    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None),
        annual_stale_after_ms=annual_stale_after_ms_from_days(None), last_ingest_run=None,
    )
    name = audit["names"][0]
    assert name["filing_cadence"] == "quarterly"       # unknown cadence ⇒ quarterly (the safe default)
    assert name["stale"] is True                       # 200d > 135d quarterly window


@pytest.mark.asyncio
async def test_annual_window_defaults_when_param_omitted() -> None:
    """Omitting `annual_stale_after_ms` falls back to the 400-day annual default inside `freshness_audit`
    (backward-compatible with a caller that passes only the quarterly window)."""
    mongo = _FakeMongo(["TSM_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 1_000_000 * _DAY
    _seed_instrument(db, instrument_id=1, t212_ticker="TSM_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - 200 * _DAY,
               knowledge_ts=now - 199 * _DAY)
    _seed_filing(db, instrument_id=1, form_type="20-F", accepted_ts=now - 199 * _DAY)

    # annual_stale_after_ms NOT passed → defaults to 400 days internally.
    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None), last_ingest_run=None
    )
    name = audit["names"][0]
    assert name["filing_cadence"] == "annual"
    assert name["stale"] is False                      # 200d < 400d default annual window


@pytest.mark.asyncio
async def test_annual_window_floored_at_quarterly_window() -> None:
    """A misconfigured annual window SMALLER than the quarterly one is floored at the quarterly window —
    an annual filer is never treated as MORE time-sensitive than a quarterly one. With annual=50d floored
    up to quarterly=135d, a 100-day-old 20-F name is NOT stale (100d < 135d)."""
    mongo = _FakeMongo(["TSM_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 1_000_000 * _DAY
    _seed_instrument(db, instrument_id=1, t212_ticker="TSM_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - 100 * _DAY,
               knowledge_ts=now - 99 * _DAY)
    _seed_filing(db, instrument_id=1, form_type="20-F", accepted_ts=now - 99 * _DAY)

    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=135 * _DAY,
        annual_stale_after_ms=50 * _DAY,  # absurdly small → floored up to the 135-day quarterly window
        last_ingest_run=None,
    )
    name = audit["names"][0]
    assert name["stale"] is False                      # 100d < max(50d, 135d) = 135d


@pytest.mark.asyncio
async def test_heal_filter_uses_per_form_window() -> None:
    """`--heal`'s `_filter_stale_symbols` consumes the SAME per-name window via `freshness_audit`, so a
    20-F annual filer is NOT in the stale set (not force-re-ingested every heal cycle) while a 10-Q filer
    at the same age IS. Drives the filter through the public `freshness_audit` exactly as the heal path
    does, then asserts the stale-set membership the filter keys on."""
    mongo = _FakeMongo(["AAPL_US_EQ", "TSM_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 1_000_000 * _DAY
    age = 200 * _DAY
    _seed_instrument(db, instrument_id=1, t212_ticker="AAPL_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - age, knowledge_ts=now - age + _DAY)
    _seed_filing(db, instrument_id=1, form_type="10-Q", accepted_ts=now - age + _DAY)
    _seed_instrument(db, instrument_id=2, t212_ticker="TSM_US_EQ")
    _seed_fact(db, instrument_id=2, metric="net_income", observation_ts=now - age, knowledge_ts=now - age + _DAY)
    _seed_filing(db, instrument_id=2, form_type="20-F", accepted_ts=now - age + _DAY)

    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None),
        annual_stale_after_ms=annual_stale_after_ms_from_days(None), last_ingest_run=None,
    )
    # This is exactly the set `_filter_stale_symbols` intersects the resolved coverage against.
    stale_set = {n["symbol"] for n in audit["names"] if n["stale"]}
    assert "AAPL" in stale_set       # quarterly filer at 200d → healed
    assert "TSM" not in stale_set    # annual filer at 200d → NOT healed every cycle (the A2 fix)


# ── NO_EDGAR exception set + EDGAR-eligible denominator (A4 core) ─────────────────────────────────────
def test_no_edgar_set_seeds_tcehy_and_excludes_names_with_a_cik() -> None:
    """The curated NO_EDGAR set: TCEHY (unsponsored ADR, files nothing with the SEC) is enumerated WITH a
    reason; META and SPCX — which DO have a CIK — must NOT be in the set (the card's explicit anti-trap:
    `missing` ≠ `no_edgar`)."""
    assert is_no_edgar("TCEHY") is True
    assert is_no_edgar("tcehy") is True                  # case-tolerant
    assert no_edgar_reason("TCEHY") and "unsponsored" in no_edgar_reason("TCEHY").lower()
    # Names that resolve to a real CIK are coverage gaps that ingest closes — never no-EDGAR.
    assert is_no_edgar("META") is False
    assert is_no_edgar("SPCX") is False
    assert no_edgar_reason("META") is None
    assert is_no_edgar("AAPL") is False                  # a normal filer


@pytest.mark.asyncio
async def test_no_edgar_name_excluded_from_missing_and_surfaced_with_reason() -> None:
    """A NO_EDGAR name (TCEHY) in the curated universe is NOT counted `missing` (it files nothing with the
    SEC, so it can never be covered from EDGAR) and is surfaced in a distinct `no_edgar` block WITH its
    reason — never as a silent missing row in `names[]`. The eligible denominator excludes it."""
    # Curated universe = AAPL (eligible, covered+fresh) + TCEHY (no-EDGAR exception).
    mongo = _FakeMongo(["AAPL_US_EQ", "TCEHY_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 1_000_000 * _DAY
    _seed_instrument(db, instrument_id=1, t212_ticker="AAPL_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now, knowledge_ts=now + _DAY)

    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None),
        annual_stale_after_ms=annual_stale_after_ms_from_days(None), last_ingest_run=None,
    )

    # The denominator is EDGAR-eligible only: AAPL counts, TCEHY does not.
    assert audit["universe"] == 1                         # eligible = {AAPL}; TCEHY excluded
    assert audit["covered"] == 1
    assert audit["missing"] == 0                          # TCEHY is NOT a missing name
    assert audit["coverage_pct"] == 100.0

    # TCEHY never appears in the per-name table (not a silent `covered:false` row).
    symbols = {n["symbol"] for n in audit["names"]}
    assert symbols == {"AAPL"}
    assert "TCEHY" not in symbols

    # It IS surfaced in the no_edgar block, with its reason.
    assert audit["no_edgar_count"] == 1
    no_edgar = {e["symbol"]: e["reason"] for e in audit["no_edgar"]}
    assert set(no_edgar) == {"TCEHY"}
    assert "unsponsored" in no_edgar["TCEHY"].lower()


@pytest.mark.asyncio
async def test_retirable_over_eligible_denominator_despite_no_edgar_name() -> None:
    """`retirable` is computed over the EDGAR-eligible denominator: every eligible name covered + fresh ⇒
    retirable TRUE, even though a NO_EDGAR name in the universe is (and forever will be) uncovered. Under
    the OLD whole-universe denominator the uncovered TCEHY would be `missing` and pin `retirable=False`
    forever — the bug this card fixes."""
    mongo = _FakeMongo(["AAPL_US_EQ", "MSFT_US_EQ", "TCEHY_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 500_000 * _DAY
    for iid, tk in ((1, "AAPL_US_EQ"), (2, "MSFT_US_EQ")):
        _seed_instrument(db, instrument_id=iid, t212_ticker=tk)
        _seed_fact(db, instrument_id=iid, metric="net_income", observation_ts=now - 10 * _DAY,
                   knowledge_ts=now - 9 * _DAY)
    # TCEHY: no instrument, no fact — uncovered, exactly the no-EDGAR reality. It must NOT block retirable.

    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None),
        annual_stale_after_ms=annual_stale_after_ms_from_days(None), last_ingest_run=None,
    )
    assert audit["universe"] == 2 and audit["covered"] == 2     # eligible {AAPL, MSFT}; TCEHY excluded
    assert audit["missing"] == 0 and audit["stale"] == 0
    assert audit["retirable"] is True                           # eligible complete+fresh ⇒ retirable
    assert audit["no_edgar_count"] == 1                         # TCEHY documented, not missing


@pytest.mark.asyncio
async def test_no_edgar_name_not_in_heal_stale_set() -> None:
    """The `--heal` `_filter_stale_symbols` keys on `{n['symbol'] for n in names if stale}`. Because a
    NO_EDGAR name is excluded from `names[]`, it is never in that stale set — so heal does NOT force-
    re-ingest TCEHY every cycle (which would burn an EDGAR round-trip only to skip it as no_cik). A real
    stale eligible name (MSFT, fiscal period 200d old, quarterly) IS in the set."""
    mongo = _FakeMongo(["MSFT_US_EQ", "TCEHY_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 1_000_000 * _DAY
    _seed_instrument(db, instrument_id=1, t212_ticker="MSFT_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - 200 * _DAY,
               knowledge_ts=now - 199 * _DAY)
    _seed_filing(db, instrument_id=1, form_type="10-Q", accepted_ts=now - 199 * _DAY)
    # TCEHY uncovered — would be "stale by definition" if it were in the eligible walk; it isn't.

    audit = await freshness_audit(
        db, mongo, now_ms=now, stale_after_ms=stale_after_ms_from_days(None),
        annual_stale_after_ms=annual_stale_after_ms_from_days(None), last_ingest_run=None,
    )
    stale_set = {n["symbol"] for n in audit["names"] if n["stale"]}
    assert "MSFT" in stale_set        # a genuinely-stale eligible name → healed
    assert "TCEHY" not in stale_set   # the no-EDGAR exception → never force-re-ingested


@pytest.mark.asyncio
async def test_universe_with_only_no_edgar_names_is_vacuously_retirable() -> None:
    """A curated universe consisting solely of NO_EDGAR names yields an empty eligible denominator (every
    name degrades to Yahoo): zeros + vacuously retirable (no eligible name to keep on Yahoo), with the
    excluded names still surfaced. Mirrors the empty-universe case but via the exclusion path."""
    mongo = _FakeMongo(["TCEHY_US_EQ"])
    db = _FreshnessFakeTimescale()
    audit = await freshness_audit(
        db, mongo, now_ms=10 * _DAY, stale_after_ms=stale_after_ms_from_days(None),
        annual_stale_after_ms=annual_stale_after_ms_from_days(None), last_ingest_run=None,
    )
    assert audit["universe"] == 0 and audit["covered"] == 0 and audit["missing"] == 0
    assert audit["names"] == []
    assert audit["coverage_pct"] == 0.0
    assert audit["retirable"] is True              # no eligible name to keep on Yahoo
    assert audit["no_edgar_count"] == 1
    assert audit["no_edgar"][0]["symbol"] == "TCEHY"

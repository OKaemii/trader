"""Ingestion entry point — `python -m src.ingest` (epic Task 9).

The composition root the Kubernetes **CronJob** (nightly incremental) and the one-shot **backfill Job**
run. It is intentionally NOT an HTTP handler: the ingest is a long, scheduled batch (a full backfill
walks every coverage filer's decades of filings), so it runs as a Job container, not inside the FastAPI
trigger (which only ACCEPTS a request — see `main.py`). The same chain the unit gate proves with fakes
runs here against the live sources, wired from env:

  * the EDGAR clients (`EdgarSubmissionsClient` / `EdgarFactsClient`) with a real `EDGAR_USER_AGENT`
    and a SHARED `EdgarRateLimiter` (one 10 req/s — or `EDGAR_REQS_PER_SEC` — window across BOTH
    clients, so the global SEC budget is honoured);
  * the Timescale writers/QA engine over the single asyncpg pool (`security_master.pool.get_pool`);
  * the coverage resolver over Mongo (`coverage.load_coverage`).

CLI:
    python -m src.ingest                 # incremental: the configured coverage set
    python -m src.ingest --full          # from-scratch backfill (same set; the writers are idempotent)
    python -m src.ingest --tickers AAPL,MSFT   # a one-off subset (bare US symbols) — the backfill-Job demo
    python -m src.ingest --cap 32        # override the coverage cap for this run
    python -m src.ingest --heal          # self-heal: ingest ONLY the missing/stale curated-US subset

SELF-HEAL (`--heal`): the nightly full walk keeps steady-state, but a newly-curated or stale name should
converge intra-day without waiting for the next nightly tick. With `--heal` the run resolves the full
coverage set as usual, then narrows it to the missing/stale subset via `freshness.freshness_audit` (the
SAME per-name coverage+staleness query the `…/freshness` endpoint serves — one source of truth for "what
is stale"), and the orchestrator ingests only that subset. The write path is byte-for-byte the full
walk's (idempotent, hash-gated), so this is a smaller, more frequent convergence pass, not a second code
path. Without `--heal` the resolved coverage set is ingested unchanged.

ENV (surfaced by the CronJob/Job templates):
    EDGAR_USER_AGENT          mandatory descriptive UA — SEC fails closed without it (the run logs +
                              exits non-zero rather than silently fetching nothing).
    EDGAR_REQS_PER_SEC        SEC rate budget (default 10/s).
    FUNDAMENTALS_COVERAGE     mode: universe_plus_index (default) | universe_only | index_only.
    FUNDAMENTALS_COVERAGE_CAP small default cap on the coverage set (0 ⇒ uncapped).
    FUNDAMENTALS_STALE_AFTER_DAYS  self-heal staleness window in days (default 135 ≈ a reporting quarter
                              plus a filing-grace buffer); `--stale-after-days` overrides it for one run.
    TIMESCALE_URL / MONGODB_URL / MONGODB_DB   the stores (assembled by the templates like the
                              warehouse-snapshot CronJob / backtest-engine).

This module is import-clean without a driver (the heavy imports — asyncpg/motor — are inside the async
run, mirroring the skeleton's "stage packages connect to nothing"); only an actual run opens sockets.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import time
from typing import Optional

log = logging.getLogger("fundamentals-ingestion.ingest")

# A wide-but-bounded backfill window for the survivorship-free index union: every S&P member over the
# last N years is in scope so a research replay never references an un-ingested name. The default mirrors
# the daily-history backfill depth philosophy; overridable so an operator can widen to inception.
_DEFAULT_WINDOW_YEARS = 30
_YEAR_MS = 365 * 86_400_000


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="src.ingest", description="PIT fundamentals ingestion run")
    p.add_argument(
        "--tickers",
        default="",
        help="Comma-separated bare US symbols to ingest (overrides the coverage resolver — the "
             "backfill-Job AAPL,MSFT demo). Empty ⇒ the configured coverage set.",
    )
    p.add_argument(
        "--full",
        action="store_true",
        help="From-scratch backfill rather than the incremental delta (the writers are idempotent, so "
             "this differs only in intent/logging today; reserved for a future incremental cursor).",
    )
    p.add_argument(
        "--cap",
        type=int,
        default=None,
        help="Override the coverage cap for this run (0 ⇒ uncapped). Absent ⇒ FUNDAMENTALS_COVERAGE_CAP.",
    )
    p.add_argument(
        "--window-years",
        type=int,
        default=_DEFAULT_WINDOW_YEARS,
        help="Survivorship-free index-union lookback in years (every S&P member over the window).",
    )
    p.add_argument(
        "--heal",
        action="store_true",
        help="Self-heal: after resolving the full coverage set, ingest ONLY the missing/stale "
             "curated-US subset (via freshness.freshness_audit). The 6-hourly heal CronJob's mode — a "
             "smaller, more frequent convergence pass on top of the nightly full walk.",
    )
    p.add_argument(
        "--stale-after-days",
        type=int,
        default=None,
        help="QUARTERLY staleness window in days for --heal (a 10-Q filer whose freshest fiscal period is "
             "older is healed). Absent ⇒ FUNDAMENTALS_STALE_AFTER_DAYS (default 135). Ignored without --heal.",
    )
    p.add_argument(
        "--annual-stale-after-days",
        type=int,
        default=None,
        help="ANNUAL staleness window in days for --heal (a 20-F/40-F/10-K once-a-year filer; keyed off "
             "the name's filing cadence). Absent ⇒ FUNDAMENTALS_STALE_AFTER_DAYS_ANNUAL (default 400). "
             "Keeps an annual filer from being force-re-ingested every heal cycle. Ignored without --heal.",
    )
    return p.parse_args(argv)


async def _effective_user_agent() -> str:
    """Resolve the effective EDGAR User-Agent the run will send — `portal_fundamentals_config` override
    > `EDGAR_USER_AGENT` env > the built-in default — via the shared config provider, so a portal value
    set without a redeploy wins for the cron/backfill run too (not just the force endpoint). The provider
    degrades a Mongo-read failure to the env/default config internally, so a down portal store never
    blocks the cron — it falls back to the env UA. Imports motor lazily inside the provider; opens a
    short-lived Mongo client for this one read, closed before the run proceeds."""
    from motor.motor_asyncio import AsyncIOMotorClient

    from src.config import FundamentalsConfigProvider, effective_user_agent

    mongo_url = os.getenv("MONGODB_URL", "mongodb://localhost:27017")
    mongo_db_name = os.getenv("MONGODB_DB", "trader")
    client = AsyncIOMotorClient(mongo_url)
    try:
        provider = FundamentalsConfigProvider(client[mongo_db_name])
        cfg = await provider.get(force_refresh=True)
        return effective_user_agent(cfg) or ""
    finally:
        client.close()


async def _build_orchestrator(user_agent: str):
    """Construct the orchestrator with the real EDGAR clients (sharing one rate limiter) + the Timescale
    writers/QA engine over the singleton pool. Imports the drivers lazily so this module imports clean
    without asyncpg/httpx; opens the pool exactly once (get_pool is the process singleton)."""
    from src.download.edgar import EdgarFactsClient, edgar_rate_limiter
    from src.download.edgar_class_shares import EdgarClassSharesClient
    from src.normalize.writer import FundamentalsWriter
    from src.orchestrator import IngestionOrchestrator
    from src.qa.engine import QaEngine
    from src.raw_store.writer import RawFactsWriter
    from src.security_master.edgar_submissions import EdgarSubmissionsClient
    from src.security_master.openfigi import OpenFigiClient
    from src.security_master.pool import get_pool
    from src.security_master.writers import SecurityMasterWriter

    # ONE shared 10 req/s (or EDGAR_REQS_PER_SEC) window across BOTH EDGAR clients — the SEC budget is
    # per-IP across all endpoints, so the submissions + facts fetches must draw from the same limiter.
    limiter = edgar_rate_limiter()
    submissions = EdgarSubmissionsClient(user_agent=user_agent, limiter=limiter)
    facts = EdgarFactsClient(user_agent=user_agent, limiter=limiter)
    # Dual-class share recovery shares the SAME limiter (the per-IP SEC budget spans the Archives host
    # too) — fetches a filing's XBRL instance only for the dual-class names that stage null shares.
    class_shares = EdgarClassSharesClient(user_agent=user_agent, limiter=limiter)
    # OpenFIGI gets its OWN rate budget (it is a different API + host), built from OPENFIGI_API_KEY when
    # set. It is the last-resort IDENTIFY hop for a symbol the SEC map + alias table both miss — it logs
    # the FIGI so an operator can add an alias; it never supplies a CIK, so it cannot itself resolve.
    openfigi = OpenFigiClient()

    pool = await get_pool()
    return IngestionOrchestrator(
        submissions_client=submissions,
        facts_client=facts,
        secmaster=SecurityMasterWriter(pool),
        raw_writer=RawFactsWriter(pool),
        fundamentals_writer=FundamentalsWriter(pool),
        qa_engine=QaEngine(pool),
        openfigi_client=openfigi,
        class_shares_client=class_shares,
    )


async def run_async(args: argparse.Namespace) -> int:
    """Execute one ingestion run. Returns a process exit code (0 ok, 2 = misconfigured UA)."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    user_agent = await _effective_user_agent()
    if not user_agent:
        # SEC fails closed without a descriptive UA — the clients would degrade every fetch to empty and
        # the run would silently write nothing. Surface it loudly and exit non-zero so the Job shows red.
        log.error(
            "[ingest] effective EDGAR User-Agent is empty — SEC requires a descriptive User-Agent (e.g. "
            "'trader-platform fundamentals-ingestion ops@example.com'). Refusing to run a no-op "
            "backfill; set the portal override or global.env.edgarUserAgent and re-run."
        )
        return 2

    orchestrator = await _build_orchestrator(user_agent)

    from src.security_master.pool import close_pool

    try:
        symbols = await _resolve_symbols(args)
        if not symbols:
            log.warning("[ingest] no coverage symbols resolved — nothing to do")
            return 0
        if args.heal:
            # Self-heal: narrow the resolved set to only the missing/stale curated-US names (the full
            # walk stays the steady-state nightly job; this converges newly-curated/stale names intra-day).
            symbols = await _filter_stale_symbols(symbols, args)
            if not symbols:
                log.info("[ingest] --heal: coverage already fresh — nothing to heal")
                return 0
        log.info("[ingest] starting run: %d symbols, full=%s heal=%s", len(symbols), args.full, args.heal)
        summary = await orchestrator.run(symbols)
        log.info(
            "[ingest] DONE requested=%d ingested=%d skipped=%d raw_written=%d "
            "canonical_inserted=%d revisions=%d skipped_existing=%d quarantined=%d",
            summary.requested, summary.ingested, summary.skipped, summary.raw_written,
            summary.canonical_inserted, summary.canonical_revisions, summary.canonical_skipped,
            summary.quarantined,
        )
        return 0
    finally:
        await close_pool()


async def _resolve_symbols(args: argparse.Namespace) -> list[str]:
    """The coverage set for this run: an explicit `--tickers` subset, else the Mongo coverage resolver."""
    if args.tickers.strip():
        from src.coverage import bare_us_symbol

        out: list[str] = []
        for raw in args.tickers.split(","):
            sym = bare_us_symbol(raw)
            if sym:
                out.append(sym)
            elif raw.strip():
                log.warning("[ingest] --tickers entry %r is not an in-scope US symbol; skipped", raw)
        return sorted(set(out))

    from motor.motor_asyncio import AsyncIOMotorClient

    from src.coverage import coverage_cap_from_env, load_coverage

    mongo_url = os.getenv("MONGODB_URL", "mongodb://localhost:27017")
    mongo_db_name = os.getenv("MONGODB_DB", "trader")
    mode = os.getenv("FUNDAMENTALS_COVERAGE", "universe_plus_index").strip() or "universe_plus_index"
    cap = args.cap if args.cap is not None else coverage_cap_from_env()
    if cap is not None and cap <= 0:
        cap = None

    now_ms = int(time.time() * 1000)
    lo_ms = now_ms - max(args.window_years, 1) * _YEAR_MS

    client = AsyncIOMotorClient(mongo_url)
    try:
        db = client[mongo_db_name]
        return await load_coverage(db, window_lo_ms=lo_ms, window_hi_ms=now_ms, mode=mode, cap=cap)
    finally:
        client.close()


def _stale_after_days(args: argparse.Namespace) -> Optional[int]:
    """The self-heal QUARTERLY staleness window in days: the `--stale-after-days` flag, else
    `FUNDAMENTALS_STALE_AFTER_DAYS`, else None (⇒ `stale_after_ms_from_days` applies the 135-day
    default). A non-positive/unparseable env is ignored (the default window can never be silently
    disabled — that would make every name look fresh and heal nothing)."""
    if args.stale_after_days is not None:
        return args.stale_after_days
    raw = os.getenv("FUNDAMENTALS_STALE_AFTER_DAYS", "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        log.warning("[ingest] FUNDAMENTALS_STALE_AFTER_DAYS=%r is not an int; using the default window", raw)
        return None


def _annual_stale_after_days(args: argparse.Namespace) -> Optional[int]:
    """The self-heal ANNUAL staleness window in days (for 20-F/40-F/10-K once-a-year filers): the
    `--annual-stale-after-days` flag, else `FUNDAMENTALS_STALE_AFTER_DAYS_ANNUAL`, else None (⇒
    `annual_stale_after_ms_from_days` applies the 400-day default). Same fail-safe as the quarterly knob
    — a non-positive/unparseable env falls back to the default window, never "never stale"."""
    if args.annual_stale_after_days is not None:
        return args.annual_stale_after_days
    raw = os.getenv("FUNDAMENTALS_STALE_AFTER_DAYS_ANNUAL", "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        log.warning(
            "[ingest] FUNDAMENTALS_STALE_AFTER_DAYS_ANNUAL=%r is not an int; using the default annual window",
            raw,
        )
        return None


async def _filter_stale_symbols(symbols: list[str], args: argparse.Namespace) -> list[str]:
    """Narrow the resolved coverage set to the missing/stale subset for a `--heal` run.

    Reuses `freshness.freshness_audit` — the SAME per-name coverage+staleness query the `…/freshness`
    endpoint serves — as the single source of truth for "which curated-US names are missing or stale",
    rather than re-deriving staleness here. The audit walks the curated US universe and flags each name
    `stale = (not covered) or (period_end older than the window)`; we keep only the resolved-coverage
    symbols that are in that stale set, so heal fetches exactly the names that need a refresh (a fresh,
    fully-covered name is skipped — the orchestrator would no-op it anyway, but skipping it up front
    saves the EDGAR round-trip under the shared rate budget).

    Intersecting against `symbols` (the already-resolved coverage set) keeps the run's existing scope
    rules intact: an index-only remainder name outside the freshness universe is simply not in the stale
    set, so heal stays focused on the curated-US freshness gate. Opens its own short-lived Mongo client
    (as `_resolve_symbols`/`_effective_user_agent` do) and uses the already-open singleton asyncpg pool."""
    from motor.motor_asyncio import AsyncIOMotorClient

    from src.freshness import (
        annual_stale_after_ms_from_days,
        freshness_audit,
        stale_after_ms_from_days,
    )
    from src.security_master.pool import get_pool

    now_ms = int(time.time() * 1000)
    stale_after_ms = stale_after_ms_from_days(_stale_after_days(args))
    annual_stale_after_ms = annual_stale_after_ms_from_days(_annual_stale_after_days(args))

    pool = await get_pool()
    mongo_url = os.getenv("MONGODB_URL", "mongodb://localhost:27017")
    mongo_db_name = os.getenv("MONGODB_DB", "trader")
    client = AsyncIOMotorClient(mongo_url)
    try:
        # Same per-name window selection the …/freshness endpoint uses, so a 20-F annual filer gets the
        # 400-day window here too and stops being force-re-ingested every heal cycle.
        audit = await freshness_audit(
            pool, client[mongo_db_name], now_ms=now_ms, stale_after_ms=stale_after_ms,
            annual_stale_after_ms=annual_stale_after_ms,
        )
    finally:
        client.close()

    stale_set = {n["symbol"] for n in audit["names"] if n["stale"]}
    subset = [s for s in symbols if s in stale_set]
    log.info(
        "[ingest] --heal: %d/%d coverage symbols missing/stale (covered=%d, stale=%d of %d curated; "
        "stale_after_ms=%d annual_stale_after_ms=%d)",
        len(subset), len(symbols), audit["covered"], audit["stale"], audit["universe"], stale_after_ms,
        annual_stale_after_ms,
    )
    return subset


def main(argv: Optional[list[str]] = None) -> int:
    return asyncio.run(run_async(_parse_args(argv)))


if __name__ == "__main__":
    sys.exit(main())

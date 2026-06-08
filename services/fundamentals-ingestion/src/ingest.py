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

ENV (surfaced by the CronJob/Job templates):
    EDGAR_USER_AGENT          mandatory descriptive UA — SEC fails closed without it (the run logs +
                              exits non-zero rather than silently fetching nothing).
    EDGAR_REQS_PER_SEC        SEC rate budget (default 10/s).
    FUNDAMENTALS_COVERAGE     mode: universe_plus_index (default) | universe_only | index_only.
    FUNDAMENTALS_COVERAGE_CAP small default cap on the coverage set (0 ⇒ uncapped).
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
    return p.parse_args(argv)


async def _build_orchestrator(user_agent: str):
    """Construct the orchestrator with the real EDGAR clients (sharing one rate limiter) + the Timescale
    writers/QA engine over the singleton pool. Imports the drivers lazily so this module imports clean
    without asyncpg/httpx; opens the pool exactly once (get_pool is the process singleton)."""
    from src.download.edgar import EdgarFactsClient, edgar_rate_limiter
    from src.normalize.writer import FundamentalsWriter
    from src.orchestrator import IngestionOrchestrator
    from src.qa.engine import QaEngine
    from src.raw_store.writer import RawFactsWriter
    from src.security_master.edgar_submissions import EdgarSubmissionsClient
    from src.security_master.pool import get_pool
    from src.security_master.writers import SecurityMasterWriter

    # ONE shared 10 req/s (or EDGAR_REQS_PER_SEC) window across BOTH EDGAR clients — the SEC budget is
    # per-IP across all endpoints, so the submissions + facts fetches must draw from the same limiter.
    limiter = edgar_rate_limiter()
    submissions = EdgarSubmissionsClient(user_agent=user_agent, limiter=limiter)
    facts = EdgarFactsClient(user_agent=user_agent, limiter=limiter)

    pool = await get_pool()
    return IngestionOrchestrator(
        submissions_client=submissions,
        facts_client=facts,
        secmaster=SecurityMasterWriter(pool),
        raw_writer=RawFactsWriter(pool),
        fundamentals_writer=FundamentalsWriter(pool),
        qa_engine=QaEngine(pool),
    )


async def run_async(args: argparse.Namespace) -> int:
    """Execute one ingestion run. Returns a process exit code (0 ok, 2 = misconfigured UA)."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    user_agent = os.getenv("EDGAR_USER_AGENT", "").strip()
    if not user_agent:
        # SEC fails closed without a descriptive UA — the clients would degrade every fetch to empty and
        # the run would silently write nothing. Surface it loudly and exit non-zero so the Job shows red.
        log.error(
            "[ingest] EDGAR_USER_AGENT is empty — SEC requires a descriptive User-Agent (e.g. "
            "'trader-platform fundamentals-ingestion ops@example.com'). Refusing to run a no-op "
            "backfill; set global.env.edgarUserAgent and re-run."
        )
        return 2

    orchestrator = await _build_orchestrator(user_agent)

    from src.security_master.pool import close_pool

    try:
        symbols = await _resolve_symbols(args)
        if not symbols:
            log.warning("[ingest] no coverage symbols resolved — nothing to do")
            return 0
        log.info("[ingest] starting run: %d symbols, full=%s", len(symbols), args.full)
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


def main(argv: Optional[list[str]] = None) -> int:
    return asyncio.run(run_async(_parse_args(argv)))


if __name__ == "__main__":
    sys.exit(main())

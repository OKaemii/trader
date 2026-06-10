"""fundamentals-ingestion — the write-side of the PIT Fundamentals Warehouse.

This is the **skeleton** of the service that owns the US (and later UK) ingestion chain:
download (SEC EDGAR / Companies House) → raw-fact store → stage (metric registry) → normalize →
QA/quarantine → the append-only, bi-temporal `fundamentals` writer in Timescale. The real per-stage
logic lands in later epic tasks (security master, EDGAR downloader, metric registry, normalizer, QA
engine, CronJob/backfill); here the FastAPI app, its `/health`, and an admin trigger stub exist so the
image builds, deploys, comes up healthy, and the module tree imports cleanly.

The app is deliberately thin (mirrors backtest-engine's `main.py`): the stage modules under
`src/{security_master,download,raw_store,stage,normalize,qa}` are side-effect-free so a future worker
imports them rather than this FastAPI app. The ingest run is a long, scheduled job (a Kubernetes
CronJob + a one-shot backfill Job), so the HTTP trigger only **accepts** a request — it never runs the
multi-minute pipeline inside the handler.
"""
import os
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, Gauge, Histogram, generate_latest
from pydantic import BaseModel

from src.config import FundamentalsConfigProvider, effective_user_agent
from src.run_store import IngestRunStore

# Connection coordinates the real pipeline will use (read here so a missing var surfaces at boot, not
# mid-ingest). The skeleton does not open a pool yet — the writer/store modules own that once they
# exist (epic Tasks 5 and 7). Timescale holds the bi-temporal `fundamentals` facts (the write target);
# Mongo holds `security_master`-adjacent singletons + the job/quarantine bookkeeping.
TIMESCALE_URL = os.getenv("TIMESCALE_URL", "postgresql://localhost:5432/trader_ts")
MONGODB_URL = os.getenv("MONGODB_URL", "mongodb://localhost:27017")
MONGODB_DB = os.getenv("MONGODB_DB", "trader")
# SEC requires a descriptive User-Agent on every EDGAR request; the downloader (Task 5) fails closed
# without it. Read at boot so the value is visibly wired even while the downloader is a stub.
EDGAR_USER_AGENT = os.getenv("EDGAR_USER_AGENT", "")

SERVICE_NAME = "fundamentals-ingestion"

app = FastAPI(title=SERVICE_NAME, version="0.1.0")

# ── Prometheus metrics (epic Task 20) ─────────────────────────────────────────────
# The write-side ServiceMonitor (templates/servicemonitors.yaml) scrapes /metrics off the always-on
# FastAPI Deployment. This Deployment is thin (the admin trigger + the quarantine read); the heavy
# ingest counters (filings/facts ingested, ingestion lag, factor-gen duration) belong to the SEPARATE
# `fundamentals-ingest` CronJob/backfill-Job pods — short-lived batch containers a ServiceMonitor
# cannot reliably scrape. Those are a documented follow-up (push the last-run gauges to a Pushgateway
# or persist a last_run table the API surfaces); see CLAUDE.md "Fundamentals (PIT warehouse)". Here we
# expose the always-on liveness gauge + the request-latency histogram (also the API p50/p95 source).
_up = Gauge("fundamentals_ingestion_up", "1 while the fundamentals-ingestion app is serving.")
_up.set(1)
_request_latency = Histogram(
    "fundamentals_ingestion_request_duration_seconds",
    "fundamentals-ingestion HTTP request duration by route + status class (p50/p95 source).",
    ["route", "status"],
)


@app.middleware("http")
async def _observe_latency(request: Request, call_next):
    """Time every request into `_request_latency`, keyed on the matched route TEMPLATE (not the raw
    path) so the histogram's label cardinality stays bounded. The /metrics scrape is skipped."""
    start = time.perf_counter()
    response = await call_next(request)
    # `scope["route"]` is only set when a route MATCHED; an unmatched path (404) leaves it absent — so
    # fall back to a STABLE sentinel, never the raw URL (a burst of 404s on distinct random paths would
    # otherwise spawn one histogram series per path = unbounded label cardinality).
    route = request.scope.get("route")
    template = getattr(route, "path", None) or "<unmatched>"
    if template != "/metrics":
        _request_latency.labels(route=template, status=f"{response.status_code // 100}xx").observe(
            time.perf_counter() - start
        )
    return response


@app.get("/metrics", response_class=PlainTextResponse)
def metrics() -> Response:
    """Prometheus exposition (scraped by the write-side ServiceMonitor). Liveness gauge + request-
    latency histogram. The deep ingest counters live in the CronJob (see the metrics note above)."""
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.exception_handler(Exception)
async def _json_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Always answer with JSON. Starlette's default 500 is a *plain-text* body, which the portal
    proxy mislabels as JSON and the browser then fails to parse (same guard as backtest-engine)."""
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})


class IngestRequest(BaseModel):
    """Admin trigger payload. `tickers` scopes a one-off re-ingest to a subset (the CronJob runs the
    full coverage set); absent ⇒ "the whole configured coverage set". `full` requests a from-scratch
    backfill rather than the incremental delta. The fields are accepted now and honoured once the
    pipeline lands — keeping the contract stable so the portal trigger doesn't change shape later."""

    tickers: list[str] | None = None
    full: bool = False


class ConfigPatch(BaseModel):
    """PUT body for `portal_fundamentals_config`. Every field is optional — only the ones present are
    persisted, and an explicit `null` clears that override back to the env/default (per-field fall-back,
    matching `portal_market_config`). `edgarUserAgent` is the headline knob (a real SEC contact string);
    `coverageCap` overrides the coverage cap for portal-triggered runs (0 ⇒ uncapped); `ingestEnabled`
    is the soft kill switch for the force-ingest endpoint."""

    edgarUserAgent: Optional[str] = None
    coverageCap: Optional[int] = None
    ingestEnabled: Optional[bool] = None

    def to_patch(self) -> dict:
        """Project ONLY the explicitly-set fields onto the override patch (so an omitted field is left
        untouched in Mongo, while a field set to `null` is written as a clear). Uses pydantic's
        `exclude_unset` so 'absent' and 'explicitly null' are distinguishable — the per-field fall-back
        contract depends on that distinction."""
        return self.model_dump(exclude_unset=True)


# ── composition root: singleton config provider + force-ingest run store ───────────
# Process singletons, built lazily on first use (the module imports stay socket-free). The config
# provider fronts `portal_fundamentals_config` (override > env > default, 15s cache); the run store owns
# the single-flight background force-ingest. Both share the lazily-built Mongo handle + Redis client.
_config_provider: Optional[FundamentalsConfigProvider] = None
_run_store: Optional[IngestRunStore] = None


def get_config_provider() -> FundamentalsConfigProvider:
    """The process-wide config provider. Built with a shared Redis client (for the `config:invalidated`
    cross-pod publish) when REDIS_URL resolves; a Redis-build failure degrades to a publish-less provider
    (the 15s TTL still bounds peer staleness, and the Deployment is replicas:1 so the local bust is the
    load-bearing path)."""
    global _config_provider
    if _config_provider is None:
        _config_provider = FundamentalsConfigProvider(redis=_build_redis())
    return _config_provider


def _build_redis():
    """A best-effort shared `redis.asyncio` client for the invalidation publish, or None. Lazy import +
    swallow any construction error — the config write must not depend on Redis being up."""
    try:
        import redis.asyncio as aioredis

        url = os.getenv("REDIS_URL", "redis://redis:6379")
        return aioredis.from_url(url, decode_responses=True)
    except Exception:  # noqa: BLE001 — no Redis ⇒ publish-less provider (cache TTL still bounds staleness)
        return None


async def _build_orchestrator(user_agent: str):
    """Build the REAL Task-9 orchestrator for a force-ingest run — the same composition as
    `ingest.py`'s `_build_orchestrator` (one shared EDGAR rate limiter across both clients, the Timescale
    writers/QA over the singleton pool). Imported lazily so the module-import smoke test needs no
    asyncpg/httpx. The effective UA is passed in (already resolved override > env > default by the run
    store) — NOT re-read from env here, so a portal UA wins."""
    from src.download.edgar import EdgarFactsClient, edgar_rate_limiter
    from src.normalize.writer import FundamentalsWriter
    from src.orchestrator import IngestionOrchestrator
    from src.qa.engine import QaEngine
    from src.raw_store.writer import RawFactsWriter
    from src.security_master.edgar_submissions import EdgarSubmissionsClient
    from src.security_master.pool import get_pool
    from src.security_master.writers import SecurityMasterWriter

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


async def _resolve_coverage(tickers: Optional[list[str]], cap: Optional[int]) -> list[str]:
    """The coverage set for a force-ingest run: an explicit `tickers` subset (normalised to bare US
    symbols), else the Mongo coverage resolver (active universe ∪ index, capped). Mirrors `ingest.py`'s
    `_resolve_symbols`; imported lazily (motor/quant-core only when a run actually starts)."""
    from src.coverage import bare_us_symbol

    if tickers:
        out: list[str] = []
        for raw in tickers:
            sym = bare_us_symbol(raw)
            if sym:
                out.append(sym)
        return sorted(set(out))

    import time as _time

    from motor.motor_asyncio import AsyncIOMotorClient

    from src.coverage import load_coverage

    mongo_url = os.getenv("MONGODB_URL", "mongodb://localhost:27017")
    mongo_db_name = os.getenv("MONGODB_DB", "trader")
    mode = os.getenv("FUNDAMENTALS_COVERAGE", "universe_plus_index").strip() or "universe_plus_index"
    now_ms = int(_time.time() * 1000)
    window_years = 30
    lo_ms = now_ms - window_years * 365 * 86_400_000

    client = AsyncIOMotorClient(mongo_url)
    try:
        db = client[mongo_db_name]
        return await load_coverage(db, window_lo_ms=lo_ms, window_hi_ms=now_ms, mode=mode, cap=cap)
    finally:
        client.close()


def get_run_store() -> IngestRunStore:
    """The process-wide force-ingest run store (single-flight). Wires the real orchestrator factory +
    coverage resolver + the shared config provider; the heavy run executes in a background asyncio task,
    so the endpoint returns a run_id immediately."""
    global _run_store
    if _run_store is None:
        _run_store = IngestRunStore(
            orchestrator_factory=_build_orchestrator,
            coverage_resolver=_resolve_coverage,
            config_provider=get_config_provider(),
        )
    return _run_store


def _health() -> dict:
    return {"status": "ok", "service": SERVICE_NAME}


@app.get("/health")
async def health() -> dict:
    return _health()


@app.get("/admin/api/fundamentals-ingest/health")
async def ingest_health_aliased() -> dict:
    # Prefix-aliased health for the portal fan-out (nginx-ingress routes by prefix only, so the bare
    # /health is not reachable through the admin ingress — this alias is).
    return _health()


@app.post("/admin/api/fundamentals-ingest")
async def trigger_ingest(req: IngestRequest) -> JSONResponse:
    """Manual ingest trigger — now a REAL run (no longer the accept-only skeleton). Starts the Task-9
    orchestrator over the coverage set IN-CLUSTER as a single-flight BACKGROUND task and returns its
    `run_id` immediately (the handler never blocks on the multi-minute backfill). A second trigger while
    a run is in flight is a no-op accept (`started=False`, returns the in-flight run) — a heavy backfill
    is never duplicated. The historical accept-shape keys (`accepted`/`scope`/`ticker_count`/`full`) are
    preserved so the portal trigger contract doesn't change; the run fields are added alongside.

    The same single-flight run is exposed by the explicit `…/force` alias below; this endpoint keeps the
    original path the portal already calls. On a config/store error it degrades to a JSON 503 (never a
    bare 500)."""
    try:
        store = get_run_store()
        record, started = await store.start(tickers=req.tickers)
        return JSONResponse(
            content={
                "accepted": True,
                "service": SERVICE_NAME,
                "scope": "subset" if req.tickers else "all",
                "ticker_count": len(req.tickers) if req.tickers else None,
                "full": req.full,
                "received_at": datetime.now(timezone.utc).isoformat(),
                "started": started,
                "run": record.to_payload(),
            }
        )
    except Exception as exc:  # noqa: BLE001 — a config/store error degrades to 503, never a bare 500
        return JSONResponse(
            status_code=503,
            content={"detail": f"ingest trigger unavailable: {type(exc).__name__}: {exc}"},
        )


@app.post("/admin/api/fundamentals-ingest/force")
async def force_ingest(req: IngestRequest) -> JSONResponse:
    """Explicit force-ingest alias — identical single-flight behaviour to `POST …/fundamentals-ingest`,
    named for the portal Operations panel's "force ingest now" control (card 134). Starts the Task-9
    orchestrator in the background, returns the `run_id` immediately, and single-flights a concurrent
    trigger. The run record (state running|done|failed + counts) is polled via `…/status` (or
    `…/runs/{run_id}`)."""
    try:
        store = get_run_store()
        record, started = await store.start(tickers=req.tickers)
        return JSONResponse(
            content={
                "service": SERVICE_NAME,
                "started": started,
                "run_id": record.run_id,
                "run": record.to_payload(),
            }
        )
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            status_code=503,
            content={"detail": f"force-ingest unavailable: {type(exc).__name__}: {exc}"},
        )


@app.get("/admin/api/fundamentals-ingest/runs/{run_id}")
async def get_run(run_id: str) -> JSONResponse:
    """Fetch one force-ingest run's record (state + counts + timing) by id — the poll target after a
    force trigger. 404 when the id is unknown to THIS process (the run store is in-process; a CronJob run
    is in a separate pod and not tracked here — see card 135's notes)."""
    record = get_run_store().get(run_id)
    if record is None:
        return JSONResponse(status_code=404, content={"detail": f"unknown run_id: {run_id}"})
    return JSONResponse(content=record.to_payload())


@app.get("/admin/api/fundamentals-ingest/config")
async def get_config() -> JSONResponse:
    """The EFFECTIVE `portal_fundamentals_config` (override > env > default, per field) — the operator's
    view of what the next run will use. `edgar_user_agent` + its provenance (override/env/default),
    whether it is usable (the fail-closed signal), the coverage cap, and the soft ingest-enabled switch.
    A Mongo read error degrades inside the provider to the env/default config (never a 500)."""
    cfg = await get_config_provider().get()
    return JSONResponse(
        content={
            "edgarUserAgent": cfg.edgar_user_agent,
            "edgarUserAgentSource": cfg.edgar_user_agent_source,
            "edgarUserAgentUsable": effective_user_agent(cfg) is not None,
            "coverageCap": cfg.coverage_cap,
            "ingestEnabled": cfg.ingest_enabled,
        }
    )


@app.put("/admin/api/fundamentals-ingest/config")
async def put_config(patch: ConfigPatch) -> JSONResponse:
    """Upsert the `portal_fundamentals_config` singleton (the portal's "change the EDGAR User-Agent"
    write), invalidate the local cache, publish `config:invalidated` cross-pod, and return the freshly-
    resolved effective config. Only the recognised fields are persisted; an explicit `null` clears that
    override back to env/default. A Mongo write error surfaces as a JSON 503."""
    try:
        cfg = await get_config_provider().put(patch.to_patch())
        return JSONResponse(
            content={
                "updated": True,
                "edgarUserAgent": cfg.edgar_user_agent,
                "edgarUserAgentSource": cfg.edgar_user_agent_source,
                "edgarUserAgentUsable": effective_user_agent(cfg) is not None,
                "coverageCap": cfg.coverage_cap,
                "ingestEnabled": cfg.ingest_enabled,
            }
        )
    except Exception as exc:  # noqa: BLE001 — a Mongo write error degrades to 503, never a bare 500
        return JSONResponse(
            status_code=503,
            content={"detail": f"config update unavailable: {type(exc).__name__}: {exc}"},
        )


@app.get("/admin/api/fundamentals-ingest/status")
async def ingest_status(
    quarantine_since_ms: Optional[int] = Query(
        default=None, description="Only count quarantine events at/after this UTC-ms instant (omit = all time)."
    ),
) -> JSONResponse:
    """Aggregated ops status for the portal Operations PIT-fundamentals panel (card 134): coverage
    (covered instruments + current facts + oldest period), ingestion lag (now − newest knowledge_ts),
    the last force-ingest run, the quarantine summary, and feed-health (effective UA + provenance +
    coverage cap + ingest-enabled). Reads coverage/quarantine off the canonical `fundamentals` warehouse
    DIRECTLY (no cross-service hop), so a cold warehouse degrades to zeros (200), and a Timescale-
    unreachable error to a JSON 503."""
    try:
        from src.security_master.pool import get_pool
        from src.status import build_status

        cfg = await get_config_provider().get()
        last = get_run_store().latest()
        pool = await get_pool()
        payload = await build_status(
            pool,
            config=cfg,
            last_run=last.to_payload() if last is not None else None,
            quarantine_since_ms=quarantine_since_ms,
        )
        return JSONResponse(content=payload)
    except Exception as exc:  # noqa: BLE001 — a warehouse outage degrades to 503, never a bare 500
        return JSONResponse(
            status_code=503,
            content={"detail": f"status unavailable: {type(exc).__name__}: {exc}"},
        )


def _stale_after_days() -> Optional[int]:
    """The staleness window in days from `FUNDAMENTALS_STALE_AFTER_DAYS`. Absent/unparseable/non-positive
    ⇒ None so `freshness.stale_after_ms_from_days` applies its default (≈ quarter + filing grace) — a
    bad value must never silently disable the safe-to-retire gate by making everything "never stale"."""
    raw = os.getenv("FUNDAMENTALS_STALE_AFTER_DAYS", "")
    if not raw:
        return None
    try:
        n = int(raw)
    except ValueError:
        return None
    return n if n > 0 else None


def _annual_stale_after_days() -> Optional[int]:
    """The ANNUAL staleness window in days from `FUNDAMENTALS_STALE_AFTER_DAYS_ANNUAL` (for 20-F/40-F/10-K
    once-a-year filers). Absent/unparseable/non-positive ⇒ None so `annual_stale_after_ms_from_days`
    applies its 400-day default. Same fail-safe as the quarterly knob: a bad value falls back to the
    default window, never to "never stale"."""
    raw = os.getenv("FUNDAMENTALS_STALE_AFTER_DAYS_ANNUAL", "")
    if not raw:
        return None
    try:
        n = int(raw)
    except ValueError:
        return None
    return n if n > 0 else None


@app.get("/admin/api/fundamentals-ingest/freshness")
async def ingest_freshness() -> JSONResponse:
    """Per-name PIT coverage + freshness audit (epic coverage-broaden Task 4) — the "is the curated US
    universe fully ingested, and how current is each name?" surface, and the gate that proves it is safe
    to retire Yahoo for US (`retirable`).

    Walks the curated US universe (`instrument_registry {activeTo:null}`, US-filtered — the same set the
    ingest covers) and, per name, joins the canonical `fundamentals` table for: `covered`, the freshest
    fiscal period (`newest_period_end`), the freshest availability (`newest_knowledge_ts`), the wall-clock
    our ingest last persisted a row (`last_stored_at` = MAX(fundamentals_revisions_log.logged_at)), and
    `stale`. The aggregate carries `coverage_pct`, `retirable` (no missing + no stale), and the last
    force-ingest sweep (`last_ingest_run`, from the run store — like `/status`'s `last_run`).

    Reads the warehouse DIRECTLY (no cross-service hop): a cold (un-backfilled) warehouse degrades to
    every curated name uncovered/stale at 200, and a Timescale-unreachable read to a JSON 503 — mirrors
    `/status`. `stale_after_ms` derives from `FUNDAMENTALS_STALE_AFTER_DAYS` (default ≈ quarter + grace)."""
    try:
        from motor.motor_asyncio import AsyncIOMotorClient

        from src.freshness import (
            annual_stale_after_ms_from_days,
            freshness_audit,
            stale_after_ms_from_days,
        )
        from src.security_master.pool import get_pool

        pool = await get_pool()
        last = get_run_store().latest()
        stale_after_ms = stale_after_ms_from_days(_stale_after_days())
        annual_stale_after_ms = annual_stale_after_ms_from_days(_annual_stale_after_days())
        client = AsyncIOMotorClient(MONGODB_URL)
        try:
            payload = await freshness_audit(
                pool,
                client[MONGODB_DB],
                now_ms=int(time.time() * 1000),
                stale_after_ms=stale_after_ms,
                annual_stale_after_ms=annual_stale_after_ms,
                last_ingest_run=last.to_payload() if last is not None else None,
            )
        finally:
            client.close()
        return JSONResponse(content=payload)
    except Exception as exc:  # noqa: BLE001 — a warehouse outage degrades to 503, never a bare 500
        return JSONResponse(
            status_code=503,
            content={"detail": f"freshness audit unavailable: {type(exc).__name__}: {exc}"},
        )


# Sentinel instrument_id for an unresolvable `?symbol=` lookup. A real BIGSERIAL instrument_id is always
# positive, so -1 matches NO quarantine row — the per-name predicate then yields an HONEST EMPTY summary
# rather than silently widening to the full unfiltered set (which would mislead the operator into reading
# every name's counts as the one they asked for). Paired with `resolved: false` so the caller can tell an
# empty-because-unknown name from an empty-because-clean one.
_UNRESOLVED_INSTRUMENT_ID = -1


@app.get("/admin/api/fundamentals-ingest/quarantine")
async def quarantine_report(
    since_ms: Optional[int] = Query(
        default=None,
        description="Only count quarantine events at/after this UTC-ms instant (omit = all time).",
    ),
    limit: int = Query(
        default=50, ge=1, le=500,
        description="Max recent quarantine rows to sample (the counts are unbounded over the window).",
    ),
    symbol: Optional[str] = Query(
        default=None,
        description="Scope the report to one name by ticker (T212 `AAPL_US_EQ` or bare `AAPL`). Resolved "
                    "to its instrument_id via the security master; an unknown/non-US symbol yields an "
                    "honest empty summary with resolved:false. A directly-passed instrument_id wins.",
    ),
    instrument_id: Optional[int] = Query(
        default=None,
        description="Scope the report to one name by instrument_id directly (skips symbol resolution; "
                    "takes precedence over `symbol`).",
    ),
) -> JSONResponse:
    """QA report — summarize `fundamentals_quarantine` by reason + sector + a recent sample (epic Task 8).

    The operator-facing read surface for the quarantine review queue: how many facts/filings the QA
    engine (identity_break / outlier / missing_data) and the Task-7 writer (value_disagreement) held out
    of the canonical PIT table, grouped so the financials-are-the-hotspot pattern is visible. Reuses the
    Task-3 `/admin/api/fundamentals-ingest` ingress prefix (no new ingress). On a Timescale-unreachable
    error this answers 503 with JSON (the report is a read over a possibly-cold warehouse — a DB blip
    must not surface as an unhandled 500), so `/health` stays independent of the warehouse being up.

    Per-name lookup (epic coverage-broaden Task 3): pass `instrument_id` to scope every count + the
    sample to one name, or pass `symbol` to resolve a ticker to its instrument_id first. A directly-given
    `instrument_id` wins over `symbol`. When a `symbol` doesn't resolve to a US instrument (unknown name,
    or a non-US ticker with no EDGAR identity), the report is scoped to the unmatchable sentinel so it
    returns an honest EMPTY summary (`resolved: false`) — never the full unfiltered set. The response adds
    `symbol`/`resolved` only when a `symbol` was supplied; `instrument_id` is always echoed (the applied
    scope), matching `quarantine_summary`'s contract."""
    # Local imports keep the module-import smoke test driver-free (asyncpg/qa are only needed to serve
    # this endpoint, not to import the app).
    try:
        from src.coverage import bare_us_symbol
        from src.qa.report import quarantine_summary
        from src.security_master.pool import get_pool
        from src.security_master.resolver import SecurityMasterResolver

        pool = await get_pool()

        # Resolve the per-name scope. A directly-passed instrument_id wins; otherwise a `symbol` is
        # routed through the security master (bare US symbol → as-of resolution at "now"). An unknown
        # or non-US symbol becomes the unmatchable sentinel so the summary is an honest empty, flagged
        # resolved:false. `resolved` is only meaningful (and only echoed) when a symbol was supplied.
        scope = instrument_id
        resolved: Optional[bool] = None
        if scope is None and symbol is not None:
            bare = bare_us_symbol(symbol)
            hit = None
            if bare is not None:
                hit = await SecurityMasterResolver(pool).resolve_symbol(bare, int(time.time() * 1000))
            if hit is not None:
                scope = hit.instrument_id
                resolved = True
            else:
                scope = _UNRESOLVED_INSTRUMENT_ID
                resolved = False

        summary = await quarantine_summary(
            pool, since_ms=since_ms, sample_limit=limit, instrument_id=scope
        )
        if symbol is not None:
            summary["symbol"] = symbol
            summary["resolved"] = resolved
        return JSONResponse(content=summary)
    except Exception as exc:  # noqa: BLE001 — degrade a warehouse outage to a 503, never a bare 500
        return JSONResponse(
            status_code=503,
            content={"detail": f"quarantine report unavailable: {type(exc).__name__}: {exc}"},
        )

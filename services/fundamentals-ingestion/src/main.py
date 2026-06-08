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
    route = request.scope.get("route")
    template = getattr(route, "path", request.url.path)
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
async def trigger_ingest(req: IngestRequest) -> dict:
    """Accept a manual ingest trigger. SKELETON: records intent and returns immediately — the real
    pipeline (download → raw → stage → normalize → QA → bi-temporal write) is enqueued/run by the
    CronJob worker in a later epic task. The handler must never run the multi-minute job inline."""
    return {
        "accepted": True,
        "service": SERVICE_NAME,
        "scope": "subset" if req.tickers else "all",
        "ticker_count": len(req.tickers) if req.tickers else None,
        "full": req.full,
        "received_at": datetime.now(timezone.utc).isoformat(),
        "note": "ingestion pipeline not yet wired — skeleton accepts the trigger only",
    }


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
) -> JSONResponse:
    """QA report — summarize `fundamentals_quarantine` by reason + sector + a recent sample (epic Task 8).

    The operator-facing read surface for the quarantine review queue: how many facts/filings the QA
    engine (identity_break / outlier / missing_data) and the Task-7 writer (value_disagreement) held out
    of the canonical PIT table, grouped so the financials-are-the-hotspot pattern is visible. Reuses the
    Task-3 `/admin/api/fundamentals-ingest` ingress prefix (no new ingress). On a Timescale-unreachable
    error this answers 503 with JSON (the report is a read over a possibly-cold warehouse — a DB blip
    must not surface as an unhandled 500), so `/health` stays independent of the warehouse being up."""
    # Local imports keep the module-import smoke test driver-free (asyncpg/qa are only needed to serve
    # this endpoint, not to import the app).
    try:
        from src.qa.report import quarantine_summary
        from src.security_master.pool import get_pool

        pool = await get_pool()
        summary = await quarantine_summary(pool, since_ms=since_ms, sample_limit=limit)
        return JSONResponse(content=summary)
    except Exception as exc:  # noqa: BLE001 — degrade a warehouse outage to a 503, never a bare 500
        return JSONResponse(
            status_code=503,
            content={"detail": f"quarantine report unavailable: {type(exc).__name__}: {exc}"},
        )

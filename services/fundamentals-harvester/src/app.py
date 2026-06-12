"""FastAPI surface for the fundamentals-harvester — the portal's window into the lake's write path, a
force-sweep trigger, AND (in the deployed pod) the host process for the bootstrap+sweep write loop.

The harvester's real work is the bootstrap-then-loop in `src/main.py` (the lake's single writer). In the
deployed Deployment (replicas:1) that loop runs on a DEDICATED BACKGROUND THREAD started by this app on
startup — gated on `HARVESTER_RUN_LOOP`, which the Helm chart sets — so `uvicorn app:app` is the one
entrypoint that both owns the lake RW mount AND serves this status API. The loop runs on its OWN thread
(not uvicorn's event loop) precisely so the bootstrap's CPU-bound synchronous Parquet writes never starve
the `/health` handler — otherwise a long normalize burst would block the serving loop, the liveness probe
would time out, and the kubelet would kill the pod mid-bootstrap (losing all progress). The status routes
themselves read the lake's on-disk state (`status.py`) + the per-CIK fact recency (`freshness.py`) — both
pure over the lake `Path`, so the read surface has no database and (apart from the loop + the force-sweep
trigger) never constructs the EDGAR client. With `HARVESTER_RUN_LOOP` unset (the TestClient suite), this
module is a thin read-only status shell — the loop is not launched and no EDGAR client / network is
touched on import.

Routes — all under the `/admin/api/fundamentals-ingest` ingress prefix the portal already fans out to (no
new ingress; the bare `/health` is aliased under the prefix because nginx-ingress routes by prefix only):

  GET  /admin/api/fundamentals-ingest/status      lake state: bootstrap-complete?, covered-CIK count, last
                                                   sweep date, lake byte size.
  GET  /admin/api/fundamentals-ingest/config       the harvester's effective env knobs (lake dir, sweep
                                                   cadence, watchlist, EDGAR rps, UA-set flag).
  GET  /admin/api/fundamentals-ingest/freshness    per-name PIT coverage + staleness + `retirable` over the
                                                   universe (a `?symbols=` input, default = lake entities),
                                                   with the `no_edgar` exception block.
  GET  /admin/api/fundamentals-ingest/runs         recent sweep history from `harvester_state.json`.
  POST /admin/api/fundamentals-ingest/force-sweep  single-flight: trigger an immediate sweep in the
                                                   background (or accept a no-op when one is in flight).

`/admin/api/fundamentals-ingest/quarantine` is DELIBERATELY ABSENT — the lake design drops QA/quarantine
(decision D); a name with a dirty fact is fail-closed-omitted at write time, never quarantined.
"""
from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, Gauge, Histogram, generate_latest

import freshness
import status as status_mod

SERVICE_NAME = "fundamentals-harvester"

# The lake the status surface reads — the SAME path the write path uses (src/main.py LAKE). Read at module
# load (the Deployment env is fixed for the pod lifetime); tests monkeypatch `LAKE` directly.
LAKE = Path(os.environ.get("LAKE_DIR", "/data"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fundamentals-harvester.app")

app = FastAPI(title=SERVICE_NAME, version="0.1.0")

# ── Prometheus metrics ────────────────────────────────────────────────────────────
# The central ServiceMonitor (infra/helm/trader/templates/servicemonitors.yaml) scrapes /metrics on
# every trader FastAPI service. `_up` is the always-on liveness signal (1 while the app serves);
# `_request_latency` is the per-route request-duration histogram (the status-surface p50/p95 source).
# Labelled by route TEMPLATE + status class so the cardinality stays bounded (no raw path in the labels).
# Mirrors fundamentals-api / strategy-engine's /metrics shape. The harvest LOOP's deep counters
# (entities normalized, sweep CIK counts) are NOT exposed here — they live in the lake's on-disk state,
# surfaced by /status + /runs; this scrape covers process liveness + status-API request latency.
_up = Gauge("fundamentals_harvester_up", "1 while the fundamentals-harvester process is serving.")
_up.set(1)
_request_latency = Histogram(
    "fundamentals_harvester_request_duration_seconds",
    "fundamentals-harvester HTTP request duration by route + status class (p50/p95 source).",
    ["route", "status"],
)


@app.middleware("http")
async def _observe_latency(request: Request, call_next):
    """Time every request into `_request_latency`, keyed on the matched route TEMPLATE (not the raw path)
    so the histogram's label cardinality is bounded. An unmatched path (404) falls back to a stable
    sentinel; the /metrics scrape itself is skipped (self-measurement is noise)."""
    start = time.perf_counter()
    response = await call_next(request)
    route = request.scope.get("route")
    template = getattr(route, "path", None) or "<unmatched>"
    if template != "/metrics":
        _request_latency.labels(route=template, status=f"{response.status_code // 100}xx").observe(
            time.perf_counter() - start
        )
    return response


@app.get("/metrics", response_class=PlainTextResponse)
def metrics() -> Response:
    """Prometheus exposition (scraped by the central ServiceMonitor). Liveness gauge + the request-latency
    histogram. Mirrors fundamentals-api's /metrics shape."""
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.exception_handler(Exception)
async def _json_error_handler(_request, exc: Exception) -> JSONResponse:
    """Any unhandled error degrades to a JSON 500 with the exception class (mirrors the read-side services)
    — never a bare HTML stack trace the portal can't parse."""
    log.exception("unhandled error")
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})


# --------------------------------------------------------------------------- #
# Harvest loop — co-hosted with the status surface in ONE process             #
# --------------------------------------------------------------------------- #
# The deployed harvester is a SINGLE Deployment (replicas:1 — the lake's single writer) that must do two
# jobs at once: (1) own the lake RW mount and run the bootstrap-then-sweep write loop (`src/main.py`), and
# (2) serve this thin status API the portal Operations panel reads.
#
# The loop runs in a DEDICATED BACKGROUND OS THREAD with its OWN asyncio event loop — NOT as a task on
# uvicorn's serving loop. This is load-bearing: the bulk bootstrap's normalize step does CPU-bound,
# SYNCHRONOUS pyarrow Parquet writes per CIK (write_company_facts), which would block a shared event loop
# for long stretches and starve the `/health` handler — the kubelet's liveness probe then times out and
# kills the pod mid-bootstrap, losing all progress (the sentinel is written only after a FULL pass) →
# an indefinite crash-loop that never completes. Running the loop on a separate thread keeps uvicorn's
# HTTP loop free, so `/health` always answers instantly regardless of how busy the harvest is.
#
# The thread is a daemon (it must not block process shutdown) and is started once. Gated on
# `HARVESTER_RUN_LOOP` (the chart sets it; tests never do) so importing this module for the TestClient
# status-surface suite does NOT launch the write loop or construct the EDGAR client (which fails closed
# without a real EDGAR_USER_AGENT and would hit the network). `main` is imported lazily inside the thread
# target for the same reason — module import stays network-free.
_loop_thread: Optional[threading.Thread] = None


def _run_loop_enabled() -> bool:
    return os.environ.get("HARVESTER_RUN_LOOP", "").strip().lower() in {"1", "true", "yes"}


def _harvest_loop_thread() -> None:
    """Thread target: run the bootstrap+sweep loop on this thread's own event loop.

    `main.main()` already owns the bootstrap-unless-sentinel + the infinite per-sweep loop with its own
    per-iteration error guard, so a transient sweep failure never ends it. An unexpected fatal that
    escapes `main()` is logged here; the loop ending leaves the status API serving (the pod stays up so
    the failure is observable via logs/status, rather than crash-looping) until the next deploy/restart,
    which re-runs an unfinished bootstrap (crash-safe via the sentinel)."""
    import main as harvester_main  # lazy: no EDGAR client / network at module import

    try:
        asyncio.run(harvester_main.main())
    except Exception:  # noqa: BLE001 — surface a fatal in logs; do NOT take the HTTP server down with it
        log.exception("harvest loop exited unexpectedly — status API stays up; restart resumes bootstrap")


@app.on_event("startup")
def _start_harvest_loop() -> None:
    """Launch the harvest loop on a dedicated daemon thread (single-writer Deployment, HARVESTER_RUN_LOOP
    set). A sync hook is fine — it only spawns the thread and returns immediately, so uvicorn startup is
    not blocked by the bootstrap."""
    global _loop_thread
    if not _run_loop_enabled():
        log.info("harvest loop disabled (HARVESTER_RUN_LOOP unset) — status surface only")
        return
    log.info("starting harvest loop (bootstrap-then-sweep) on a dedicated background thread")
    _loop_thread = threading.Thread(target=_harvest_loop_thread, name="harvest-loop", daemon=True)
    _loop_thread.start()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _health() -> dict:
    """Liveness only — the harvester app is healthy as a process whether or not the lake is bootstrapped
    yet (a cold lake is the correct pre-bootstrap state, not unhealthy). The lake's actual coverage is the
    `/status` surface, not a health gate."""
    return {"status": "ok", "service": SERVICE_NAME}


@app.get("/health")
async def health() -> dict:
    return _health()


@app.get("/admin/api/fundamentals-ingest/health")
async def health_aliased() -> dict:
    # Prefix-aliased health for the portal fan-out (the bare /health is not reachable through the admin
    # ingress, which routes by prefix only — this alias is).
    return _health()


@app.get("/admin/api/fundamentals-ingest/status")
async def get_status() -> JSONResponse:
    """The lake state behind the harvester panel: bootstrap-complete?, covered-CIK count, last sweep date,
    lake byte size. Pure read off the lake's on-disk state — a cold lake returns the zero/pre-bootstrap
    shape, never an error."""
    return JSONResponse(content=status_mod.build_status(LAKE, now_ms=_now_ms()))


@app.get("/admin/api/fundamentals-ingest/config")
async def get_config() -> JSONResponse:
    """The harvester's effective env knobs (lake dir, sweep cadence, watchlist, EDGAR rps, UA-set flag).
    The UA is surfaced only as a boolean — the status surface never echoes the contact string itself."""
    return JSONResponse(content=status_mod.build_config())


@app.get("/admin/api/fundamentals-ingest/runs")
async def get_runs(limit: int = Query(10, ge=1, le=100)) -> JSONResponse:
    """Recent sweep history from `harvester_state.json` (newest-first `{date, ciks}` rows). A lake that has
    never swept returns an empty list — the correct pre-sweep state."""
    return JSONResponse(content=status_mod.build_runs(LAKE, limit=limit))


def _stale_after_days() -> Optional[int]:
    """The quarterly staleness window (days) from `FUNDAMENTALS_STALE_AFTER_DAYS`, or None (⇒ the 135-day
    default). A non-int env degrades to None rather than crashing the audit."""
    raw = os.environ.get("FUNDAMENTALS_STALE_AFTER_DAYS", "")
    if not raw.strip():
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _annual_stale_after_days() -> Optional[int]:
    """The annual staleness window (days) from `FUNDAMENTALS_STALE_AFTER_DAYS_ANNUAL`, or None (⇒ the
    400-day default). A non-int env degrades to None."""
    raw = os.environ.get("FUNDAMENTALS_STALE_AFTER_DAYS_ANNUAL", "")
    if not raw.strip():
        return None
    try:
        return int(raw)
    except ValueError:
        return None


@app.get("/admin/api/fundamentals-ingest/freshness")
async def get_freshness(
    symbols: Optional[str] = Query(
        None,
        description=(
            "Comma-separated BARE US symbols (the universe to audit). When omitted, defaults to every "
            "currently-listed ticker in the lake. The harvester has no Mongo, so the active "
            "instrument_registry universe is supplied by the caller (the portal)."
        ),
    )
) -> JSONResponse:
    """Per-name PIT coverage + staleness + `retirable` over the supplied (or default) universe, with the
    `no_edgar` exception block.

    The UNIVERSE IS AN INPUT (the decoupling constraint): the portal passes the active universe via
    `?symbols=AAPL,MSFT,…`; absent, it defaults to the lake's currently-listed tickers. The harvester never
    reads Mongo to compute coverage."""
    parsed = (
        [s.strip().upper() for s in symbols.split(",") if s.strip()] if symbols is not None else None
    )
    audit = freshness.freshness_audit(
        LAKE,
        now_ms=_now_ms(),
        symbols=parsed,
        stale_after_ms=freshness.stale_after_ms_from_days(_stale_after_days()),
        annual_stale_after_ms=freshness.annual_stale_after_ms_from_days(_annual_stale_after_days()),
    )
    return JSONResponse(content=audit)


# --------------------------------------------------------------------------- #
# Force-sweep — single-flight background trigger                              #
# --------------------------------------------------------------------------- #
# A force-sweep runs the SAME sweep the loop runs, just immediately. It is single-flight: a concurrent
# trigger while a sweep is in flight is a no-op accept (`started=False`), so an operator double-click never
# launches two overlapping EDGAR sweeps (which would burn the shared rate budget). The in-flight task is
# held at module scope. The EDGAR client is constructed LAZILY inside the trigger (it fails closed without a
# real EDGAR_USER_AGENT — so a misconfigured UA surfaces as a clean 503, and the status routes above never
# trip that guard).
_sweep_task: Optional[asyncio.Task] = None


def _sweep_in_flight() -> bool:
    return _sweep_task is not None and not _sweep_task.done()


async def _run_one_sweep() -> None:
    """Construct the EDGAR client and run a single sweep, then close the client. Imported lazily so the
    module loads (and the read routes serve) without the EDGAR_USER_AGENT the client construction requires."""
    import main as harvester_main  # lazy: avoids constructing Edgar at import (fail-closed UA guard)
    from edgar import Edgar

    edgar = Edgar()
    try:
        await harvester_main.sweep(edgar)
    finally:
        await edgar.aclose()


@app.post("/admin/api/fundamentals-ingest/force-sweep")
async def force_sweep() -> JSONResponse:
    """Trigger an immediate sweep in the background (single-flight). Returns `started=True` when this call
    launched the sweep, `started=False` when one was already in flight (a no-op accept — never a duplicate
    overlapping sweep). The sweep's progress lands in `harvester_state.json` → visible via `/status` +
    `/runs`. A construction error (e.g. a placeholder EDGAR_USER_AGENT, which fails closed) degrades to a
    JSON 503."""
    global _sweep_task
    if _sweep_in_flight():
        return JSONResponse(
            content={
                "service": SERVICE_NAME,
                "started": False,
                "detail": "a sweep is already in flight",
            }
        )
    try:
        _sweep_task = asyncio.create_task(_run_one_sweep())
        return JSONResponse(content={"service": SERVICE_NAME, "started": True})
    except Exception as exc:  # noqa: BLE001 — a construction/scheduling error degrades to 503, never a 500
        return JSONResponse(
            status_code=503,
            content={"detail": f"force-sweep unavailable: {type(exc).__name__}: {exc}"},
        )

"""fundamentals-api — the read-side of the PIT Fundamentals **lake** (epic Task 10).

Serves the point-in-time fundamentals the live seam (strategy-engine) and the headline
`get_pit_fundamentals(symbols, as_of)` guarantee read off the per-CIK Parquet **lake** the harvester
lands — the Timescale `fundamentals` hypertable (the old `fundamentals-ingestion` write-side) is
retired. The HTTP contract is BYTE-COMPATIBLE: the seam consumers parse the same `{fundamentals:{ticker:
{<14 snake_case line_items>, source, observation_ts, knowledge_ts}}, asOf, count}` shape; only the engine
under it changed. The look-ahead guard is still in SQL (`knowledge_ts <= as_of` in the lake store's
DuckDB query — `quant_core.fundamentals.lake.store`), never in app code.

INGRESS — the chosen collision-free mount (the card's critical constraint). The read API mounts under a
DISTINCT prefix `/admin/api/fundamentals-pit` (admin) + `/internal/api/fundamentals-pit` (the seam hot
path) so it:
  * does NOT steal `/internal/api/fundamentals`, which market-data-service serves today, nor
  * collide with `/admin/api/fundamentals-ingest` (the harvester's status surface, epic Task 9), nor
  * the bare `/admin/api/fundamentals` (which 307s to the portal today).
nginx ingress longest-prefix matching keeps all three distinct. The live seam calls this service
IN-CLUSTER (`http://fundamentals-api:8011/internal/api/fundamentals-pit?…`), not through the ingress;
exposing `/internal/api/fundamentals-pit` on the ingress too is harmless (and lets the headline `/pit`
QA run).

GAP-2 MARKET CAP. `market_cap_gbp` is NOT a stored scalar — for every covered name it is COMPUTED
point-in-time as `adjusted_close(as_of) × shares_outstanding(as_of) × fx_to_gbp` (the same adjusted
price series momentum uses, the dei cover-page shares fact from the lake, and the platform's GBP/USD
rate) inside the resolver's enrichment step, and the PIT `dividend_yield` leg is wired in alongside so
Value's three legs share one as-of basis. The in-cluster read paths (market-data-service internal bars
for the as-of close, shared Redis for FX, market-data-service `/internal/api/dividend-yield` for the
yield) live in `src/market_cap.py` (LAKE-AGNOSTIC, kept verbatim); the value/quality factor-input
computation behind `/admin/api/fundamentals-pit/factors` lives in `src/factors.py` (also verbatim).

The app is thin: the resolver + store + market-cap modules are side-effect-light and open no socket on
import; the lake drivers (duckdb/pyarrow via quant-core's `[lake]` extra) + the HTTP/Redis drivers
(httpx, redis) are imported lazily/at-construction inside `src/store.py` + the request handlers, so the
module-import smoke test stays driver-light and `/health` is independent of the lake being populated.
The lake is partially populated while the harvester bootstraps, so a not-yet-normalized name
legitimately returns `{}` per name (200) — that is correct, not a failure; the resolver's correctness is
proven by the unit suite over a fixture lake.
"""
from __future__ import annotations

import os
import time
from typing import Optional

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, Gauge, Histogram, generate_latest

# Coordinates the read path uses, read at boot purely so a missing/odd var is VISIBLE here at startup.
# The app opens no socket on import — the authoritative reads + the singleton lake-Store/redis-client
# construction live in `src/store.py` (`get_store`/`get_redis`), which re-read these envs; these module
# constants are the boot-visibility surface only.
FUNDAMENTALS_LAKE_DIR = os.getenv("FUNDAMENTALS_LAKE_DIR", "/srv/fundamentals-lake")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")

SERVICE_NAME = "fundamentals-api"

app = FastAPI(title=SERVICE_NAME, version="0.1.0")

# ── Prometheus metrics (epic Task 20) ─────────────────────────────────────────────
# The read-side ServiceMonitor (templates/servicemonitors.yaml) scrapes /metrics. `_up` is the
# always-on liveness signal (1 while the app serves); `_request_latency` is the per-route request-
# duration histogram whose buckets give the API p50/p95 the monitoring card asks for (Prometheus
# `histogram_quantile(0.50|0.95, …)` over `_bucket`). Labelled by route TEMPLATE + status class so the
# cardinality stays bounded (no raw path/symbols in the label set).
_up = Gauge("fundamentals_api_up", "1 while the fundamentals-api process is serving.")
_up.set(1)
_request_latency = Histogram(
    "fundamentals_api_request_duration_seconds",
    "fundamentals-api HTTP request duration by route + status class (p50/p95 source).",
    ["route", "status"],
)


@app.middleware("http")
async def _observe_latency(request: Request, call_next):
    """Time every request into `_request_latency`, keyed on the matched route TEMPLATE (not the raw
    path — `/internal/api/fundamentals-pit`, never the per-call tickers) so the histogram's label
    cardinality is bounded. The /metrics scrape itself is skipped (self-measurement is noise)."""
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
    """Prometheus exposition (scraped by the read-side ServiceMonitor). Liveness gauge + the request-
    latency histogram (the p50/p95 source). Mirrors strategy-engine's /metrics shape."""
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.exception_handler(Exception)
async def _json_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Always answer with JSON. Starlette's default 500 is a *plain-text* body, which the portal proxy
    mislabels as JSON and the browser then fails to parse (same guard as backtest-engine / ingestion)."""
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})


def _health() -> dict:
    return {"status": "ok", "service": SERVICE_NAME}


@app.get("/health")
async def health() -> dict:
    return _health()


@app.get("/admin/api/fundamentals-pit/health")
async def admin_health_aliased() -> dict:
    # Prefix-aliased health for the portal fan-out (nginx-ingress routes by prefix only, so the bare
    # /health is not reachable through the admin ingress — this alias is).
    return _health()


def _parse_tickers(raw: Optional[str]) -> list[str]:
    """Split a comma-separated tickers/symbols query param into a de-duplicated, order-preserving list.
    Empty/None → []."""
    if not raw:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for tok in raw.split(","):
        t = tok.strip()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


async def _build_resolver():
    """Construct the as-of resolver with the SINGLETON lake `Store` + Redis client + the Gap-2
    market-data reader. The lake `Store` (`get_store`) and the Redis client (`get_redis`) are process
    singletons — the Store owns a (non-thread-safe) DuckDB connection and the Redis client owns a
    connection pool, so both MUST be reused across requests (building a Redis client per request, on the
    seam hot path, would leak a connection pool each call). Lazy imports keep the module-import smoke
    test driver-light (duckdb/pyarrow/redis/httpx are only needed to serve a read, not to import the
    app); a Redis-build failure inside `get_redis` degrades to an uncached (still-correct) resolver,
    never a failed request.

    The `MarketDataReader` shares the singleton Redis client (for the published GBP/USD rate — the
    consumer-side FX path) and calls market-data-service's internal bars + dividend-yield endpoints
    in-cluster (with the internal JWT) for the as-of adjusted close + the PIT dividend-yield leg, so the
    resolver can override `market_cap_gbp` with the computed PIT value (price×shares×fx). The reader is
    UNCHANGED from the Timescale build — it is lake-agnostic (it operates on the resolved line items)."""
    from src.market_cap import MarketDataReader
    from src.resolver import FundamentalsResolver
    from src.store import get_redis, get_store

    store = get_store()
    redis = get_redis()
    market_data = MarketDataReader(redis=redis)
    return FundamentalsResolver(store, redis=redis, market_data=market_data)


async def _resolve_payload(tickers: list[str], as_of_ms: Optional[int]) -> dict:
    """Resolve `tickers` as-of and shape the `{ "fundamentals": { ticker: {<line items>, source,
    observation_ts, knowledge_ts} } }` response (the plan §5 shape). Names that don't resolve / have no
    fact ≤ asOf are present with an empty line-item dict + null provenance — never dropped silently, never
    fabricated."""
    resolver = await _build_resolver()
    resolved = await resolver.get_pit_fundamentals(tickers, as_of_ms)
    return {
        "fundamentals": {ticker: tf.to_payload() for ticker, tf in resolved.items()},
        "asOf": as_of_ms,
        "count": len(resolved),
    }


@app.get("/internal/api/fundamentals-pit")
async def internal_fundamentals(
    tickers: Optional[str] = Query(
        default=None,
        description="Comma-separated tickers — legacy T212 (AAPL_US_EQ) OR bare (AAPL); the adapter "
        "accepts both during the storage-migration transition.",
    ),
    asOf: Optional[int] = Query(  # noqa: N803 — the wire param is camelCase asOf (matches bars/pg-bar-reader)
        default=None,
        description="Knowledge-time cutoff (UTC ms). Omit = 'as of now' (live).",
    ),
) -> JSONResponse:
    """The seam HOT PATH (the live strategy host calls this in-cluster). Per-ticker point-in-time line
    items as known at `asOf` (omit for live). Look-ahead is impossible: the lake store's read filters
    `knowledge_ts <= asOf` in SQL. Degrades a cold-lake error to a JSON 503 (a read over a partially-
    populated lake must not surface as a bare 500); `/health` stays independent of the lake."""
    try:
        payload = await _resolve_payload(_parse_tickers(tickers), asOf)
        return JSONResponse(content=payload)
    except Exception as exc:  # noqa: BLE001 — degrade a warehouse/cache outage to 503, never a bare 500
        return JSONResponse(
            status_code=503,
            content={"detail": f"fundamentals read unavailable: {type(exc).__name__}: {exc}"},
        )


@app.get("/admin/api/fundamentals-pit/pit")
async def admin_pit(
    symbols: Optional[str] = Query(
        default=None,
        description="Comma-separated symbols — legacy T212 (AAPL_US_EQ) OR bare (AAPL).",
    ),
    as_of: Optional[int] = Query(
        default=None,
        description="Knowledge-time cutoff (UTC ms). Omit = live. Returns ONLY facts with knowledge_ts ≤ as_of.",
    ),
) -> JSONResponse:
    """THE HEADLINE — `get_pit_fundamentals(symbols, as_of)`. Returns only facts whose `knowledge_ts ≤
    as_of` (no look-ahead — the guard is in the lake store's SQL). Same backing resolver as the internal
    seam path; this admin surface is the operator/QA view of the PIT guarantee. Accepts both `as_of` (the
    headline spelling) here; the internal seam uses `asOf` (the bars/pg-bar-reader spelling)."""
    try:
        payload = await _resolve_payload(_parse_tickers(symbols), as_of)
        return JSONResponse(content=payload)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            status_code=503,
            content={"detail": f"pit read unavailable: {type(exc).__name__}: {exc}"},
        )


@app.get("/admin/api/fundamentals-pit/factors")
async def admin_factors(
    universe: Optional[str] = Query(
        default=None,
        description="Comma-separated tickers (T212 or bare) to compute factor inputs for.",
    ),
    as_of: Optional[int] = Query(
        default=None,
        description="Knowledge-time cutoff (UTC ms). Omit = live. Factor inputs use ONLY facts knowable ≤ as_of.",
    ),
) -> JSONResponse:
    """The computed value/quality factor INPUTS per name — the operator/QA view of the point-in-time
    legs the Value/Quality factors z-score. For each name: the resolved PIT line items (with
    `market_cap_gbp` already OVERRIDDEN by the computed price×shares×fx value — Gap 2 — and the PIT
    `dividend_yield` leg wired in), the six factor legs (earnings_yield/book_to_market/dividend_yield/
    roe/gross_margin/leverage) computed with the EXACT `_safe_ratio` semantics the live factor uses, plus
    the raw drivers + provenance. A leg whose inputs are unavailable is `null` (the factor NaN-excludes
    it — never a fabricated 0). A not-yet-normalized name (the lake still bootstrapping) legitimately
    returns empty factor inputs (200, not an error)."""
    try:
        from src.factors import compute_factor_inputs

        tickers = _parse_tickers(universe)
        resolver = await _build_resolver()
        resolved = await resolver.get_pit_fundamentals(tickers, as_of)
        factors = {
            ticker: {
                "factors": compute_factor_inputs(tf.line_items),
                "line_items": tf.line_items,
                "source": tf.source,
                "observation_ts": tf.observation_ts,
                "knowledge_ts": tf.knowledge_ts,
            }
            for ticker, tf in resolved.items()
        }
        return JSONResponse(content={"factors": factors, "asOf": as_of, "count": len(factors)})
    except Exception as exc:  # noqa: BLE001 — a warehouse/market-data outage degrades to 503, never a bare 500
        return JSONResponse(
            status_code=503,
            content={"detail": f"factors unavailable: {type(exc).__name__}: {exc}"},
        )


@app.get("/admin/api/fundamentals-pit/coverage")
async def admin_coverage() -> JSONResponse:
    """Coverage summary over the lake: the number of covered CIKs (one `facts/cik=*.parquet` file per
    name the harvester has normalized) + the entity count. The operator's "how much has the harvester
    landed" headline — read as a file count, no per-file parse and no glob on the hot read path. Degrades
    a cold lake (no `facts/` dir yet — the harvester is still bootstrapping) to a 200 with zeroes (the
    correct pre-bootstrap state, not an error) and any unexpected filesystem error to a 503.

    The DEEP coverage/freshness view (per-name staleness, `retirable`, the `no_edgar` block) lives on the
    harvester's `/admin/api/fundamentals-ingest/freshness` (epic Task 9) — that reads each file's MAX
    period_end; this headline stays a cheap file-count so the seam service never fans out over the lake.
    The `oldest_observation_ts`/`newest_knowledge_ts` keys are retained (None) for shape continuity with
    the pre-cutover surface; a deep period scan is intentionally the harvester's job, not this hot path's.
    """
    try:
        from src.store import lake_dir

        from pathlib import Path

        lake = Path(lake_dir())
        facts = lake / "facts"
        covered = sum(1 for _ in facts.glob("cik=*.parquet")) if facts.is_dir() else 0
        entities = (lake / "entities.parquet").exists()
        return JSONResponse(
            content={
                "instruments": covered,
                "facts": covered,  # one per-CIK fact file per covered name (the cheap headline count)
                "entities_present": entities,
                "oldest_observation_ts": None,  # deep period scan is the harvester /freshness surface
                "newest_knowledge_ts": None,
            }
        )
    except Exception as exc:  # noqa: BLE001 — an unexpected filesystem error degrades to 503, never a bare 500
        return JSONResponse(
            status_code=503,
            content={"detail": f"coverage unavailable: {type(exc).__name__}: {exc}"},
        )

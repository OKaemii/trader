import os
import json
import asyncio
import dataclasses
from fastapi import FastAPI, Response, Request
from fastapi.responses import PlainTextResponse, JSONResponse
import redis.asyncio as aioredis
from prometheus_client import Counter, Gauge, generate_latest, CONTENT_TYPE_LATEST
# Strategy code is the single source of truth in the shared quant-core package — the live
# host (here) and the backtest replay both import it, so they cannot drift. The host depends
# only on the `Strategy` Protocol + `make_strategy` factory, never on a concrete strategy.
from quant_core.strategy.factory import make_strategy, known_strategies
from quant_core.strategy.contract import HistoryView, PortfolioState, StrategyParams
from quant_core.research_factors import compute_research_factors
from quant_core.wiring import build_feature_store
from .domain.dataclasses import OHLCVBar
from .infrastructure.market_data_client import MarketDataClient, range_for_bars
from .infrastructure import strategy_config
from .infrastructure.factor_store import FactorStore, factor_history_points, persist_research_cycle
from .infrastructure.fundamentals_as_of import YahooFundamentalsAsOf
from .infrastructure.lru_cache import TTLCache, scores_cache_key
from .pipeline import build_pipeline_stages, snapshot_from_state

# Live decide() takes default params + an empty portfolio (none of the current strategies'
# decide() reads portfolio — sizing happens in signal-service). Phase 1 wires a real
# PortfolioProvider if/when a strategy needs portfolio-aware decisions.
_LIVE_PARAMS = StrategyParams(values={})
_EMPTY_PORTFOLIO = PortfolioState(current_weights={}, nav=0.0, cash=0.0)

app = FastAPI()
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")
# Bi-temporal feature store (audit + backtest replay). Unset TIMESCALE_URL → NullFeatureStore
# (no-op) so the engine still emits signals; persistence is never on the signal-correctness path.
TIMESCALE_URL = os.getenv("TIMESCALE_URL", "")

# Start with the simplest validated strategy. Enable topology only after
# OOS ablation confirms it adds statistically significant IC (see PROGRESS.md).
ACTIVE_STRATEGY = os.getenv("ACTIVE_STRATEGY", "factor_rank_v1")
BAR_FREQUENCY   = os.getenv("BAR_FREQUENCY", "daily")   # daily | intraday

# Rolling window in bars. Daily: 300 trading days — a floor covering 12-1 momentum (252+21)
# with headroom, fed by the persisted long-range daily series. Intraday: 60 bars.
# Strategy classes read ROLLING_WINDOW_BARS from this module so the env var flows through.
ROLLING_WINDOW_BARS = 300 if BAR_FREQUENCY == "daily" else 60

# ── Prometheus metrics ──────────────────────────────────────────────────────
_signals_published = Counter(
    'strategy_signals_published_total',
    'Total StrategyOutput messages published to signals:strategy',
    ['strategy_id'],
)
_processing_errors = Counter(
    'strategy_processing_errors_total',
    'Total errors during market:raw processing',
    ['strategy_id'],
)
_regime_confidence = Gauge(
    'strategy_regime_confidence',
    'Latest regime confidence score [0, 1]',
    ['strategy_id'],
)
_bars_processed = Counter(
    'strategy_bars_processed_total',
    'Total OHLCV bars consumed from market:raw',
    ['strategy_id'],
)

# WP2: stream wiring is now per-worker. Defaults preserve single-deployment behaviour
# (legacy `market:raw` + shared `signals:strategy`) so a chart that doesn't set the new
# env vars keeps working through the cutover. WP2 helm sets these to literal stream names
# like `market:raw:5m` and `signals:strategy:5m:factor_rank_v1`.
INPUT_STREAM   = os.getenv("INPUT_STREAM",   "market:raw")
OUTPUT_STREAM  = os.getenv("OUTPUT_STREAM",  "signals:strategy")
CONSUMER_GROUP = os.getenv("CONSUMER_GROUP", "strategy-engine")
CONSUMER_NAME  = f"{CONSUMER_GROUP}-{os.getenv('POD_NAME', 'local')}"

# ── Engine singletons ──────────────────────────────────────────────────────
# Lifted to module scope so the admin /replay endpoint can call into the same
# strategy instance + history cache that the live runLoop uses. Both code paths
# share an asyncio.Lock to serialise strategy.update() calls — RegimeEngine and
# FeatureStabilityAnalyser carry cross-cycle state that mustn't race.
#
# All three are populated by startup() before either runLoop or replay can run;
# the None sentinels exist purely for type-checker clarity.
_strategy = None          # type: ignore[var-annotated]
_bars_client = None       # type: ignore[var-annotated]
_redis = None             # type: ignore[var-annotated]
_feature_store = None     # type: ignore[var-annotated]  # FeatureStore (Timescale or Null)
_pg_pool = None           # type: ignore[var-annotated]  # asyncpg pool, or None
_feature_persist_logged = False  # one-shot "first feature row written" log
_factor_store = None      # type: ignore[var-annotated]  # FactorStore (Mongo factor_scores writer)
_fundamentals_provider = None  # type: ignore[var-annotated]  # FundamentalsAsOf seam (PIT socket)
_factor_persist_logged = False   # one-shot "first factor_scores row written" log

# In-process TTL+LRU fronting the factor_scores reads (T10 scores endpoint). Keyed by
# (ticker, asOf-bucket); short TTL so a read is at most one cycle stale and concurrent reads for the
# same key coalesce onto one Mongo query. Module-scope (not a startup singleton) so the read
# handlers can use it before/independently of the engine singletons.
_FACTOR_SCORES_TTL_S = float(os.getenv("FACTOR_SCORES_CACHE_TTL_S", "10"))
_factor_scores_cache = TTLCache(maxsize=512, ttl_s=_FACTOR_SCORES_TTL_S)
_history_interval: str = "daily"
_history_range:    str = "30d"
_needed:           int = 20
_prewarmed:        bool = False
_cycle_lock = asyncio.Lock()

# Shared state exposed by /status — written by process_loop, read by HTTP handlers.
# `ticker_bars`/`ready_tickers` used to be derived from arrivals counting; now they
# reflect Mongo-backed history. Population happens after each cycle's batch fetch.
_engine_state: dict = {
    "strategy":         ACTIVE_STRATEGY,
    "rolling_window":   ROLLING_WINDOW_BARS,
    "bars_needed":      ROLLING_WINDOW_BARS,
    "cycles":           0,
    "signals_emitted":  0,
    "last_cycle_ts":    None,
    "active_universe":  [],   # tickers that arrived on the stream this cycle
    "ready_tickers":    [],   # tickers with >= rolling_window bars in Mongo this cycle
    "last_signal":      None,
    # Per-cycle pipeline-funnel counts (Universe → filter → scoring → Top-K → Rebalance), recorded
    # at cycle end for the Strategy-Lab funnel (/admin/api/strategy/<id>/pipeline). PipelineSnapshot
    # shape; empty until the first cycle, where the endpoint degrades to labelled zero-count stages.
    "last_pipeline":    {},
}


def _health():
    return {"status": "ok", "active_strategy": ACTIVE_STRATEGY, "bar_frequency": BAR_FREQUENCY, "rolling_window_bars": ROLLING_WINDOW_BARS}


def _recompute_history_window() -> None:
    """Derive the per-cycle read window (_needed / _history_interval / _history_range) from the
    current _strategy + BAR_FREQUENCY. Shared by startup AND the live hot-swap so both compute the
    window identically (DRY — a switch to a strategy with a different rolling_window stays correct)."""
    global _needed, _history_interval, _history_range
    _needed = _strategy.config.rolling_window
    if BAR_FREQUENCY == "daily":
        _history_interval = "daily"
        # _needed counts DAILY bars; map to the smallest range key that covers it (the persisted
        # daily series serves the long keys), so e.g. a 300-bar window reaches ~2y back.
        _history_range = range_for_bars(_needed)
    else:
        _history_interval = "15m"
        _history_range = "60d"   # 60d of 15m bars comfortably covers the 60-bar intraday window


def _apply_active_strategy(sid: str) -> None:
    """Build `sid` as the in-process strategy and re-derive its read window + cross-cycle state.
    Used at startup and on a LIVE switch (portal selection) — selecting a strategy in the portal
    therefore needs no restart. Cheap because history is re-fetched per cycle from market-data, so
    there is no in-engine warming buffer to lose; RegimeEngine/FeatureStability state is rebuilt by
    forcing a re-prewarm (`_prewarmed=False`) on the next cycle. Raises ValueError for an unknown id."""
    global _strategy, ACTIVE_STRATEGY, _prewarmed
    _strategy = make_strategy(sid)
    ACTIVE_STRATEGY = sid
    _engine_state["strategy"] = sid
    _engine_state["rolling_window"] = _strategy.config.rolling_window
    _recompute_history_window()
    _prewarmed = False


@app.get("/health")
def health():
    return _health()


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/admin/api/strategy/health")
def strategy_health_aliased():
    # Prefix-aliased health for the portal fan-out (nginx-ingress routes by prefix only).
    return _health()


@app.get("/admin/api/strategy/list")
def list_strategies():
    return {"available": known_strategies(), "active": ACTIVE_STRATEGY}


@app.get("/admin/api/strategy/features")
async def feature_audit(strategy_id: str = "", as_of_ms: int = 0):
    """As-of feature read for the portal 'Feature audit' panel.

    Given a signal's strategy_id + timestamp, returns the exact FeatureVector the strategy
    saw at that instant (latest live revision with observation_ts <= as_of_ms). 404 when the
    feature store isn't wired (NullFeatureStore) or no row exists.
    """
    if _feature_store is None or not strategy_id or as_of_ms <= 0:
        return {"found": False, "reason": "missing strategy_id/as_of_ms or store unavailable"}
    fv = await _feature_store.read_at(strategy_id, as_of_ms, is_replay=False)
    if fv is None:
        return {"found": False, "strategy_id": strategy_id, "as_of_ms": as_of_ms}
    return {"found": True, "feature_vector": dataclasses.asdict(fv)}


@app.get("/admin/api/strategy/status")
def status():
    s = _engine_state
    ready   = len(s["ready_tickers"])
    total   = len(s["active_universe"])
    warming = [t for t in s["active_universe"] if t not in s["ready_tickers"]]
    return {
        "strategy":        s["strategy"],
        "rolling_window":  s["rolling_window"],
        "cycles_received": s["cycles"],
        "signals_emitted": s["signals_emitted"],
        "last_cycle_ts":   s["last_cycle_ts"],
        "last_signal":     s["last_signal"],
        "universe_size":   total,
        "ready_tickers":   ready,
        "warming_up":      len(warming),
        "warming_detail":  warming,
    }


@app.get("/admin/api/strategy/config")
async def get_strategy_config():
    """Per-strategy tunable surface for the portal editor: the grid schema (parameter_space),
    the single-value live defaults (parameter_defaults), and any portal overrides."""
    out = []
    for sid in known_strategies():
        s = make_strategy(sid)
        doc = await strategy_config.get_strategy_config_doc(sid)
        updated_at = (doc or {}).get("updatedAt")
        out.append({
            "strategy_id": sid,
            "schema":      s.parameter_space(),
            "defaults":    s.parameter_defaults(),
            "liveParams":  (doc or {}).get("liveParams"),
            "searchGrid":  (doc or {}).get("searchGrid"),
            "updatedAt":   updated_at.isoformat() if hasattr(updated_at, "isoformat") else None,
        })
    return {"strategies": out, "active": ACTIVE_STRATEGY}


@app.put("/admin/api/strategy/config")
async def put_strategy_config(req: Request):
    body = await req.json()
    sid = body.get("strategy_id")
    if sid not in known_strategies():
        return JSONResponse({"error": f"unknown strategy_id: {sid!r}"}, status_code=400)
    s = make_strategy(sid)
    allowed = set(s.parameter_space()) | set(s.parameter_defaults())   # defence-in-depth allowlist

    live: dict[str, float] = {}
    for k, v in (body.get("liveParams") or {}).items():
        if k not in allowed:
            continue
        try:
            live[k] = float(v)
        except (TypeError, ValueError):
            return JSONResponse({"error": f"liveParams[{k}] not numeric"}, status_code=400)

    grid: dict[str, list[float]] = {}
    product = 1
    for k, v in (body.get("searchGrid") or {}).items():
        if k not in allowed or not isinstance(v, list) or not v:
            continue
        try:
            vals = [float(x) for x in v]
        except (TypeError, ValueError):
            return JSONResponse({"error": f"searchGrid[{k}] not numeric"}, status_code=400)
        grid[k] = vals
        product *= len(vals)
    if product > 256:
        return JSONResponse(
            {"error": f"search grid too large ({product} points > 256) — MCPT cost is product × ~2000 replays"},
            status_code=400,
        )

    await strategy_config.upsert_strategy_config(sid, live or None, grid or None, str(body.get("userId", "unknown")))
    # upsert already invalidated this pod's cache; publish for any other subscribers.
    try:
        if _redis is not None:
            await _redis.publish("config:invalidated", sid)
    except Exception:   # noqa: BLE001 — pubsub is best-effort; the 15s TTL is the backstop
        pass
    return {"ok": True, "strategy_id": sid, "liveParams": live or None, "searchGrid": grid or None}


@app.put("/admin/api/strategy/active")
async def put_active_strategy(req: Request):
    """Portal dropdown — persist the active strategy AND apply it live (no restart). The choice is
    persisted to PORTAL_RUNTIME_CONFIG (so it also survives a restart), then the in-process strategy
    is rebuilt under the cycle lock so the very next cycle emits from the new strategy."""
    body = await req.json()
    sid = body.get("strategy_id")
    if sid not in known_strategies():
        return JSONResponse({"error": f"unknown strategy_id: {sid!r}"}, status_code=400)
    await strategy_config.set_active_strategy(sid, str(body.get("userId", "unknown")))

    # Apply live on the serving pod. Hold the cycle lock so we never swap _strategy mid-compute.
    applied_live = False
    if _strategy is not None:
        try:
            async with _cycle_lock:
                _apply_active_strategy(sid)
            applied_live = True
            if _redis is not None:
                await _redis.publish("config:invalidated", sid)   # nudge any other replica's cache
        except Exception as exc:   # noqa: BLE001 — fall back to the per-cycle check on any hiccup
            print(f"[strategy-engine] live strategy apply failed (will apply on next cycle): {exc!r}", flush=True)

    return {"ok": True, "selected": sid, "applied": ACTIVE_STRATEGY,
            "restartRequired": False, "appliedLive": applied_live,
            "note": "applied live — no restart required"}


# Cap on factor-history rows returned (≈ two years of daily cycles); bounds the Mongo read + payload.
_FACTOR_HISTORY_MAX = 730


@app.get("/admin/api/strategy/scores")
async def strategy_scores(ticker: str = "", asOf: int = 0):
    """Factor scores read for the Research surface (T24 FactorBars, T25 WhyPanel as-of, entity
    search). Three shapes off the SAME factor_scores store (T9), fronted by a short-TTL in-process
    LRU keyed by (ticker, asOf-bucket):

    - no ``ticker``                  → latest_all(): ``{ ticker: {observation_ts, factors} }`` over
                                       the whole universe.
    - ``?ticker=X``                  → latest_for(X): the newest row ``{ticker, observation_ts,
                                       factors}`` for one name.
    - ``?ticker=X&asOf=<ms>``        → as_of(X, ms): the point-in-time row (newest with
                                       ``observation_ts <= asOf``) — the signal "Why?" reads as-of
                                       ``signal.timestamp`` so it shows the scores the signal
                                       actually saw, not today's.

    Empty/pre-backfill store, or an unknown ticker → ``{}`` (degrade, never error). The store is
    best-effort: if the FactorStore singleton isn't wired yet (very early boot) the endpoint also
    returns ``{}`` rather than 500-ing the Research page."""
    if _factor_store is None:
        return {}
    as_of_ms = asOf if asOf > 0 else None

    async def _compute():
        if not ticker:
            return await _factor_store.latest_all()
        if as_of_ms is not None:
            return await _factor_store.as_of(ticker, as_of_ms)
        return await _factor_store.latest_for(ticker)

    key = scores_cache_key(ticker, as_of_ms)
    result = await _factor_scores_cache.get_or_compute(key, _compute)
    # latest_for / as_of return None for an unseen name (or unseen-at-asOf) — degrade to {} so the
    # caller never has to distinguish None from "no factors", consistent with the empty-store path.
    return result if result is not None else {}


@app.get("/admin/api/strategy/factor-history")
async def strategy_factor_history(ticker: str = "", limit: int = _FACTOR_HISTORY_MAX):
    """Time-series of the four factor PERCENTILES for one ticker over ``observation_ts``, oldest →
    newest — the data behind the Factor-Evolution chart (T28).

    Returns ``{ ticker, points: [{ observation_ts, momentum, quality, value, volatility }, …] }``
    where each factor value is that cycle's cross-sectional percentile in [0, 100] (``None`` for a
    factor the strategy couldn't compute that cycle — plotted as a gap, never a fabricated 0). The
    full per-factor cell (raw/source) stays in the latest/as-of ``scores`` reads; this endpoint is
    the lean charting shape. Empty ``points`` for a missing ticker or a pre-backfill store (degrade,
    never error)."""
    if _factor_store is None or not ticker:
        return {"ticker": ticker, "points": []}
    capped = max(1, min(int(limit), _FACTOR_HISTORY_MAX))
    rows = await _factor_store.history(ticker, limit=capped)
    return {"ticker": ticker, "points": factor_history_points(rows)}


@app.get("/admin/api/strategy/{strategy_id}/pipeline")
def strategy_pipeline(strategy_id: str):
    """Strategy-Lab pipeline funnel (T37 §G) — declarative stages + LIVE counts for one strategy.

    Returns ``{ strategy_id, active, stages: [{ key, label, count }, …] }`` widest→narrowest
    (Universe → filter(s) → Factor scoring → Top-K → Rebalance), the exact shape the portal
    ``PipelineFunnel`` consumes. Stages are the strategy's *known* shape (declarative); counts come
    from the last cycle's snapshot recorded in ``_engine_state['last_pipeline']``.

    ``strategy_id`` is informational — the live engine runs ONE strategy at a time, so the counts are
    always the active strategy's most recent cycle. ``active`` echoes the running strategy so the UI
    can flag a mismatch (e.g. a funnel requested for a non-active strategy shows the active engine's
    counts, not a stale per-strategy cache). Degrades gracefully: no cycle yet ⇒ the labelled stages
    at count 0 (best-effort), never a 404/500 — the funnel always renders its shape."""
    snap = snapshot_from_state(_engine_state)
    # The funnel reflects the ENGINE's last cycle, which is always the active strategy. We still
    # build stages for the *requested* id's shape so a future per-strategy view reads sensibly; for
    # the active id (the live case) the shape + counts line up exactly.
    sid = strategy_id or ACTIVE_STRATEGY
    return {
        "strategy_id": sid,
        "active": ACTIVE_STRATEGY,
        "stages": build_pipeline_stages(sid, snap),
    }


@app.get("/metrics", response_class=PlainTextResponse)
def metrics():
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


async def ensure_consumer_group(r: aioredis.Redis, stream: str, group: str) -> None:
    try:
        await r.xgroup_create(stream, group, id='$', mkstream=True)
    except Exception as e:
        if 'BUSYGROUP' not in str(e):
            raise  # group already exists — safe to ignore


def bars_from_json(data: list) -> list[OHLCVBar]:
    return [
        OHLCVBar(
            ticker=b['ticker'],
            timestamp=b['timestamp'],
            open=b['open'],
            high=b['high'],
            low=b['low'],
            close=b['close'],
            volume=b['volume'],
        )
        for b in data
    ]


def _history_view(closes_of, tickers: list[str], ts_of=None, fundamentals=None) -> HistoryView:
    """Build the pure HistoryView the strategy contract consumes. closes always; timestamps when
    `ts_of` is given (the RebalanceClock needs them for monthly strategies); fundamentals when the
    host attaches them (quality-screening strategies). Bars-only strategies pass neither."""
    closes = {t: list(closes_of(t)) for t in tickers}
    timestamps = {t: list(ts_of(t)) for t in tickers} if ts_of is not None else {}
    return HistoryView(closes=closes, volumes={}, timestamps=timestamps, fundamentals=fundamentals or {})


async def _persist_research_factors(
    active_tickers: list[str],
    history_map: dict,
    as_of_ms: int,
    cycle_n: int,
) -> None:
    """Compute the strategy-independent research factor set over the FULL active universe and persist
    one factor_scores doc per ticker for this cycle (the linchpin store the Research UI reads).

    ENTIRELY best-effort — this is wrapped in a single guard so NOTHING here (compute, the
    cross-service dividend-yield call, the Mongo write) can raise into process_cycle and block signal
    emission. That is the most important invariant (same contract as the feature-store persist).

    Fundamentals reach the compute only via HistoryView.fundamentals, filled from two PIT-honest
    legs:
      - the FundamentalsAsOf seam (Quality + the forward-only earnings/book leg of Value), stamped
        with the provider's source (yahoo-snapshot today);
      - the cross-service dividend-yield leg (the only backfillable Value component), merged in as
        `dividend_yield` and stamped `div`. Its fetch degrades INDEPENDENTLY: a failure leaves the
        leg None for all names (value source then falls back to the provider source) — it never
        aborts the persist.
    """
    if _factor_store is None or _fundamentals_provider is None:
        return
    global _factor_persist_logged
    try:
        # Quality + forward-only Value legs via the PIT seam (one round-trip for the whole universe).
        fundamentals: dict[str, dict[str, float]] = await _fundamentals_provider.fetch_many(
            active_tickers, as_of_ms,
        )

        # Cross-service dividend-yield leg (Task 14). Degrades on its own: a failure → no leg, never
        # an abort. market-data-service authorizes 'strategy-engine' on this route, so no 403 trap.
        div_yields: dict[str, float] = {}
        try:
            div_yields = await _bars_client.fetch_dividend_yields(active_tickers, as_of_ms=as_of_ms)
        except Exception as exc:  # noqa: BLE001 — div-yield leg is independently best-effort
            print(f"[strategy-engine] cycle {cycle_n} dividend-yield fetch failed (value div leg None): {exc!r}", flush=True)

        # Merge the dividend-yield leg into each name's fundamentals dict (the ValueFactor reads
        # `dividend_yield` off HistoryView.fundamentals[t]). A name with a finite yield gets the leg;
        # absent ⇒ ValueFactor NaN-excludes it (never a fabricated 0). div_yield_tickers drives the
        # per-name `div` value-source stamp.
        div_yield_tickers: set[str] = set()
        for t, dy in div_yields.items():
            fundamentals.setdefault(t, {})["dividend_yield"] = float(dy)
            div_yield_tickers.add(t)

        # Closes come from the cycle's already-fetched history_map — no extra fetch. Price factors
        # (momentum, volatility) read these; quality/value read the fundamentals above.
        def _closes(t: str, _m=history_map) -> list[float]:
            return [b.close for b in _m.get(t, [])]
        history = _history_view(_closes, active_tickers, fundamentals=fundamentals)

        # window=_needed matches the cycle's rolling window (the price-factor lookback the host sized
        # the daily fetch to). compute_research_factors returns native float|None cells (no numpy
        # types leak) → safe for Mongo verbatim.
        factor_rows = compute_research_factors(history, window=_needed)
        if not factor_rows:
            return

        # persist_research_cycle is itself best-effort (swallows store failures) — the inner write
        # guard, complementing this function's outer compute/cross-service guard.
        written = await persist_research_cycle(
            _factor_store,
            factor_rows,
            observation_ts=as_of_ms,
            fundamentals_source_for=_fundamentals_provider.source_for,
            div_yield_tickers=div_yield_tickers,
        )
        # One-shot success log — only when rows actually landed. A swallowed store failure returns
        # written=0 (persist_research_cycle already logged it); don't latch the flag or print a
        # misleading "OK" then, so the genuine first-write still gets logged on a later good cycle.
        if written > 0 and not _factor_persist_logged:
            print(f"[strategy-engine] factor_scores persist OK — first cycle written "
                  f"(observation_ts={as_of_ms} tickers={written} "
                  f"div_yield_legs={len(div_yield_tickers)} fundamentals_names={len(fundamentals)})", flush=True)
            _factor_persist_logged = True
    except Exception as exc:  # noqa: BLE001 — persistence is never on the emission path
        print(f"[strategy-engine] cycle {cycle_n} factor_scores persist failed (continuing): {exc!r}", flush=True)


def _pick_prewarm_range(calendar_days: int) -> str:
    """Smallest RangeKey that covers `calendar_days`. Matches shared-bars enum."""
    if calendar_days <= 30:  return "30d"
    if calendar_days <= 60:  return "60d"
    if calendar_days <= 90:  return "90d"
    return "180d"


async def historical_prewarm(
    strategy,
    bars_client: MarketDataClient,
    history_interval: str,
    active_tickers: list[str],
) -> None:
    """
    Replay `strategy.prewarm_cycles` historical bars-as-of-each-date through
    strategy.update() so cross-cycle state (RegimeEngine returns history,
    FeatureStabilityAnalyser buffers) reaches steady state BEFORE the first
    live cycle.

    Mongo-deterministic: every boot recomputes the same state from the same bar
    history. No Redis persistence required. Mode-swap-safe: replays whichever
    interval the booted mode requested.

    No-op when strategy.prewarm_cycles == 0 (strategies without cross-cycle state).
    """
    needed = strategy.config.prewarm_cycles
    if needed <= 0:
        print(f"[strategy-engine] prewarm: skipped (strategy.config.prewarm_cycles=0)", flush=True)
        return
    if not active_tickers:
        print(f"[strategy-engine] prewarm: skipped (empty universe)", flush=True)
        return

    # Pick a range that covers `needed` cycles worth of history with a margin.
    # Daily: ~1.4 calendar days per trading day, plus a week for holidays.
    # Intraday (15m): 126 cycles = ~32 trading hours; the smallest RangeKey (30d)
    # over-fetches but the payload is still small.
    if history_interval == "daily":
        calendar_days = int(needed * 1.5) + 7
    else:
        calendar_days = 30
    range_key = _pick_prewarm_range(calendar_days)

    import time as _t
    t0 = _t.time()
    print(
        f"[strategy-engine] prewarm: requesting {range_key} of {history_interval} bars "
        f"for {len(active_tickers)} tickers (target_cycles={needed})",
        flush=True,
    )
    bars_client.start_cycle("prewarm")
    history_map = await bars_client.fetch_bars_batch(
        tickers=active_tickers,
        interval=history_interval,
        range_key=range_key,
    )
    fetch_ms = int((_t.time() - t0) * 1000)

    # Build a per-timestamp bucket: ts -> [bars at that ts across all tickers].
    by_ts: dict[int, list[OHLCVBar]] = {}
    for t, bars in history_map.items():
        for b in bars:
            by_ts.setdefault(b.timestamp, []).append(b)

    timestamps = sorted(by_ts.keys())
    # Take only the most recent `needed` timestamps — RegimeEngine self-caps at
    # HISTORY_MIN * 2 and would pop anything older immediately anyway.
    replay = timestamps[-needed:]
    if not replay:
        print(f"[strategy-engine] prewarm: no historical bars returned — skipping", flush=True)
        return

    print(
        f"[strategy-engine] prewarm: fetched {sum(len(v) for v in history_map.values())} bars "
        f"in {fetch_ms}ms; replaying {len(replay)} cycles",
        flush=True,
    )

    t1 = _t.time()
    skipped = 0
    for ts in replay:
        tickers_at_ts = sorted(set(b.ticker for b in by_ts[ts]))

        # Strategy lookup: closes oldest-first, up to and including this timestamp.
        # Replaces the live cycle's market-data-service round-trip with a slice
        # of the already-fetched history_map. No I/O.
        def closes_at_ts(t: str, _ts=ts, _hist=history_map) -> list[float]:
            return [b.close for b in _hist.get(t, []) if b.timestamp <= _ts]

        try:
            # compute_features() warms the composed RegimeEngine / FeatureStabilityAnalyser
            # state exactly as the old update() did; decide() is unnecessary for prewarm.
            strategy.compute_features(_history_view(closes_at_ts, tickers_at_ts), ts, _LIVE_PARAMS)
        except Exception as exc:
            skipped += 1
            if skipped <= 3:
                print(f"[strategy-engine] prewarm ts={ts} skipped: {exc!r}", flush=True)

    replay_ms = int((_t.time() - t1) * 1000)
    print(
        f"[strategy-engine] prewarm: replayed {len(replay) - skipped}/{len(replay)} cycles in "
        f"{replay_ms}ms — strategy now at steady state (skipped={skipped})",
        flush=True,
    )


async def _init_engine_singletons() -> None:
    """
    Called once from startup(). Constructs the strategy + clients + derives mode-
    dependent config. Idempotent: safe to no-op if called twice.
    """
    global _strategy, _bars_client, _redis, _history_interval, _history_range, _needed
    global _feature_store, _pg_pool, ACTIVE_STRATEGY, _factor_store, _fundamentals_provider
    if _strategy is not None:
        return
    _redis = await aioredis.from_url(REDIS_URL)
    await ensure_consumer_group(_redis, INPUT_STREAM, CONSUMER_GROUP)

    # Feature store. Best-effort: a Timescale outage must not stop signal emission, so a
    # failed pool create degrades to the no-op NullFeatureStore (logged).
    if TIMESCALE_URL:
        try:
            import asyncpg
            _pg_pool = await asyncpg.create_pool(dsn=TIMESCALE_URL, min_size=1, max_size=4)
        except Exception as exc:  # noqa: BLE001
            print(f"[strategy-engine] feature store pool create failed (features disabled): {exc!r}", flush=True)
            _pg_pool = None
    _feature_store = build_feature_store(_pg_pool)
    # Loud state line so the operator can tell from logs alone whether features will persist.
    if _pg_pool is not None:
        print("[strategy-engine] feature store: ACTIVE (TimescaleFeatureStore) — features will persist per cycle", flush=True)
    else:
        _reason = "TIMESCALE_URL unset" if not TIMESCALE_URL else "pool create failed"
        print(f"[strategy-engine] feature store: DISABLED ({_reason}) — features will NOT persist (NullFeatureStore)", flush=True)

    # Portal-selected active strategy (PORTAL_RUNTIME_CONFIG) overrides the env default. Read at
    # startup — strategy selection is structural (universe source, rolling window, cross-cycle state).
    _configured = await strategy_config.get_active_strategy()
    if _configured and _configured in known_strategies():
        ACTIVE_STRATEGY = _configured
    try:
        _apply_active_strategy(ACTIVE_STRATEGY)   # builds _strategy + derives _needed/_history_* + _engine_state
    except ValueError as exc:
        raise RuntimeError(f"Unknown strategy: {ACTIVE_STRATEGY}") from exc

    # Single client across the engine — its per-cycle cache clears on start_cycle.
    _bars_client = MarketDataClient()

    # Research factor_scores store + the point-in-time fundamentals seam the host fills
    # HistoryView.fundamentals from. Both best-effort: the persist mirrors the feature store (a
    # Mongo blip logs but never blocks emission), and the seam reuses _bars_client's internal Yahoo
    # path (no new infra). ensure_indexes is idempotent — a failure just leaves the read slower.
    _factor_store = FactorStore()
    _fundamentals_provider = YahooFundamentalsAsOf(_bars_client)
    try:
        await _factor_store.ensure_indexes()
        print("[strategy-engine] factor_scores store: indexes ensured — research factors will persist per cycle", flush=True)
    except Exception as exc:  # noqa: BLE001 — best-effort; persistence is never on the emission path
        print(f"[strategy-engine] factor_scores index ensure failed (continuing): {exc!r}", flush=True)

    print(f"[strategy-engine] singletons ready — strategy={ACTIVE_STRATEGY} bar_freq={BAR_FREQUENCY} "
          f"rolling_window={ROLLING_WINDOW_BARS} history_range={_history_range} history_interval={_history_interval} "
          f"prewarm_cycles={_strategy.config.prewarm_cycles} "
          f"input={INPUT_STREAM} output={OUTPUT_STREAM} consumer={CONSUMER_NAME} group={CONSUMER_GROUP}", flush=True)


async def process_cycle(
    bars: list[OHLCVBar],
    *,
    source: str,
    entry_id: str | None = None,
    publish: bool = True,
    force_rebalance: bool = False,
) -> dict:
    """
    Run one strategy cycle. Used by both the live runLoop (source="stream") and
    the admin /replay endpoint (source="admin").

    Returns a result dict for the caller — runLoop ignores it, replay returns it
    as JSON.

    Concurrency: holds _cycle_lock for the full strategy.update() + publish.
    RegimeEngine and FeatureStabilityAnalyser carry cross-cycle state that must
    not interleave between two concurrent callers (runLoop + replay).

    `publish=False` runs the strategy and returns the output without xadding
    signals:strategy. Useful for replay's dry-run mode where the operator wants
    to see what the engine WOULD produce without driving signal-service.
    """
    assert _strategy is not None and _bars_client is not None and _redis is not None, \
        "engine singletons not initialised — call _init_engine_singletons() first"

    async with _cycle_lock:
        global _prewarmed

        # Hot strategy switch — a portal selection applies live, no restart. The check is cheap
        # (15s-cached) and the swap is essentially free: history is re-fetched per cycle from
        # market-data, so there's no in-engine warming buffer to lose. Other replicas (KEDA keeps
        # ≤1) converge within the cache TTL; the PUT path applies it instantly on the serving pod.
        try:
            _desired = await strategy_config.get_active_strategy(use_cache=True)
            if _desired and _desired != ACTIVE_STRATEGY and _desired in known_strategies():
                _prev = ACTIVE_STRATEGY
                _apply_active_strategy(_desired)
                print(f"[strategy-engine] HOT SWITCH active strategy {_prev} → {_desired} "
                      f"(portal selection, no restart) rolling_window={_needed} range={_history_range}", flush=True)
        except Exception as _swap_exc:  # noqa: BLE001 — never break the cycle on a swap hiccup
            print(f"[strategy-engine] active-strategy swap check failed (continuing): {_swap_exc!r}", flush=True)

        import time as _t
        _engine_state["cycles"] += 1
        _engine_state["last_cycle_ts"] = _t.strftime("%Y-%m-%dT%H:%M:%SZ", _t.gmtime())
        cycle_n = _engine_state["cycles"]

        active_tickers = sorted(set(b.ticker for b in bars))
        sample = ",".join(active_tickers[:8])
        print(f"[strategy-engine] cycle {cycle_n} entry source={source} "
              f"id={entry_id} bars={len(bars)} unique_tickers={len(active_tickers)} "
              f"sample=[{sample}]", flush=True)

        # Lazy prewarm on the FIRST cycle (regardless of source) — populates
        # RegimeEngine + FeatureStabilityAnalyser state from Mongo so cycle 1
        # starts at steady state instead of the 0.5 confidence sentinel.
        if not _prewarmed:
            await historical_prewarm(_strategy, _bars_client, _history_interval, active_tickers)
            _prewarmed = True

        cycle_id = f"{cycle_n}:{entry_id or source}"
        _bars_client.start_cycle(cycle_id)

        # Sector hydration. One HTTP call per cycle (cheap; market-data-service serves
        # this from a read-through Mongo cache that itself refreshes from Yahoo only
        # when rows are stale). Failure is non-fatal — keep the stale `_strategy._sectors`
        # so a transient market-data-service blip doesn't downgrade the cycle to all-Unknown.
        # Strategies that don't carry stateful sectors (none of the current three) are
        # still safe because the dict is just used as a lookup.
        try:
            fetched_sectors = await _bars_client.fetch_sectors()
            if fetched_sectors:
                _strategy._sectors.update(fetched_sectors)   # type: ignore[attr-defined]
                print(f"[strategy-engine] cycle {cycle_n} sectors hydrated: "
                      f"{len(fetched_sectors)} ticker(s) — Unknown count="
                      f"{sum(1 for v in fetched_sectors.values() if v == 'Unknown')}", flush=True)
        except Exception as exc:   # noqa: BLE001 — best-effort hydration; log + continue
            print(f"[strategy-engine] cycle {cycle_n} sector hydration failed (keeping stale): {exc}", flush=True)

        _fetch_start = _t.time()
        history_map = await _bars_client.fetch_bars_batch(
            tickers=active_tickers,
            interval=_history_interval,
            range_key=_history_range,
        )
        _fetch_ms = int((_t.time() - _fetch_start) * 1000)

        def _lookup(t: str, _m=history_map) -> list[float]:
            return [b.close for b in _m.get(t, [])]

        _engine_state["active_universe"] = active_tickers
        _engine_state["ready_tickers"]   = [t for t in active_tickers if len(_lookup(t)) >= _needed]
        _ready = len(_engine_state["ready_tickers"])
        _total = len(_engine_state["active_universe"])
        _warming = _total - _ready
        print(f"[strategy-engine] cycle {cycle_n} history fetched in {_fetch_ms}ms "
              f"interval={_history_interval} range={_history_range} "
              f"ready={_ready}/{_total} warming={_warming} (needed={_needed}+ bars per ticker)",
              flush=True)

        _update_start = _t.time()
        # Split strategy contract: compute_features (pure features-as-of-now) then decide
        # (features → emission). Same source of truth as the backtest replay.
        as_of_ms = int(_update_start * 1000)
        # Per-cycle live params (portal override, 15s cache) — hot-applied, no restart. Empty ⇒
        # the strategy's code defaults via StrategyParams.get.
        _live_params = await strategy_config.get_live_params(ACTIVE_STRATEGY)
        def _ts_lookup(t: str, _m=history_map) -> list[int]:
            return [b.timestamp for b in _m.get(t, [])]
        # Fundamentals (QMJ) for quality-screening strategies (high_velocity_v1). Best-effort:
        # a fetch failure leaves the map empty → the fail-closed screen emits nothing this cycle.
        fundamentals_map: dict[str, dict[str, float]] = {}
        if getattr(_strategy.config, "wants_fundamentals", False):
            try:
                fundamentals_map = await _bars_client.fetch_fundamentals(active_tickers)
            except Exception as exc:  # noqa: BLE001
                print(f"[strategy-engine] cycle {cycle_n} fundamentals fetch failed (continuing): {exc!r}", flush=True)
        # Operator "Rebalance now" injects a transient force_rebalance flag so a monthly strategy
        # (high_velocity_v1) rebalances on demand instead of waiting for the month boundary. Merged
        # per-cycle ONLY — never persisted to portal_strategy_config — so normal live cycles and the
        # backtest/replay path are unaffected (parity preserved).
        _params = dict(_live_params)
        if force_rebalance:
            _params["force_rebalance"] = 1.0
        features = _strategy.compute_features(
            _history_view(_lookup, active_tickers, _ts_lookup, fundamentals_map),
            as_of_ms, StrategyParams(values=_params),
        )
        # Persist the feature vector bi-temporally (audit + replay parity). Best-effort:
        # a store failure logs but never blocks signal emission.
        if features is not None and _feature_store is not None:
            try:
                await _feature_store.write(features, is_replay=False)
                global _feature_persist_logged
                if not _feature_persist_logged:
                    print(f"[strategy-engine] feature persist OK — first row written "
                          f"(strategy={ACTIVE_STRATEGY} observation_ts={as_of_ms} "
                          f"tickers={len(features.ticker_universe)})", flush=True)
                    _feature_persist_logged = True
            except Exception as exc:  # noqa: BLE001
                print(f"[strategy-engine] cycle {cycle_n} feature persist failed: {exc!r}", flush=True)

        # Research factor_scores persist (the linchpin store every Research UI card reads). Computed
        # over the FULL active universe (not just the held set) so Research is honest for any symbol,
        # and runs regardless of the active strategy. ENTIRELY best-effort: this whole block —
        # compute, the cross-service div-yield call, and the Mongo write — is wrapped in one guard
        # that logs and continues, NEVER blocking the decide()/publish below (same contract as the
        # feature store). The div-yield leg degrades independently: a failure leaves it None for all
        # names (value source falls back to yahoo-snapshot), it never crashes the cycle.
        await _persist_research_factors(active_tickers, history_map, as_of_ms, cycle_n)

        output = _strategy.decide(features, _EMPTY_PORTFOLIO) if features is not None else None
        _update_ms = int((_t.time() - _update_start) * 1000)

        _bars_processed.labels(strategy_id=ACTIVE_STRATEGY).inc(len(bars))

        # The screen-survivor count for the funnel's first hard cut: high_velocity's QMJ+cap
        # eligibility (recorded in cross_sectional_stats) when present, else the history-filter pass
        # count (bars-only strategies have no separate screen — eligible == ready).
        _eligible = int((features.cross_sectional_stats.get("n_eligible") if features is not None else None) or _ready)

        def _record_pipeline(scored: int, held: int, emitted: bool) -> None:
            # Snapshot the cycle's funnel counts for /admin/api/strategy/<id>/pipeline (T37 §G).
            _engine_state["last_pipeline"] = {
                "universe": _total, "ready": _ready, "eligible": _eligible,
                "scored": scored, "top_k": _strategy.config.top_k, "held": held, "emitted": emitted,
            }

        if output is None:
            reason = "unknown"
            if _ready < _strategy.config.min_universe_size:
                reason = f"ready={_ready} < min_universe_size={_strategy.config.min_universe_size}"
            elif _total == 0:
                reason = "no bars on the stream"
            else:
                reason = "strategy returned None (regime gate or all HOLD)"
            # HOLD / no-emit cycle: universe + history narrow, but nothing was scored/held this cycle.
            _record_pipeline(scored=0, held=0, emitted=False)
            print(f"[strategy-engine] cycle {cycle_n} NO SIGNAL "
                  f"strategy_update={_update_ms}ms — {reason}", flush=True)
            return {
                "cycle": cycle_n, "source": source, "ready": _ready, "total": _total,
                "warming": _warming, "signal_emitted": False, "reason": reason,
                "fetch_ms": _fetch_ms, "update_ms": _update_ms,
            }

        if publish:
            payload = json.dumps(dataclasses.asdict(output))
            await _redis.xadd(OUTPUT_STREAM, {"data": payload})
            await _redis.set("strategy:latest_output", payload)
            await _redis.set("regime:confidence", str(output.regime_confidence))
            await _redis.publish("strategy:dashboard", payload)
            _signals_published.labels(strategy_id=ACTIVE_STRATEGY).inc()
            _regime_confidence.labels(strategy_id=ACTIVE_STRATEGY).set(output.regime_confidence)
            _engine_state["signals_emitted"] += 1
            _engine_state["last_signal"] = _engine_state["last_cycle_ts"]
        _nonzero = sum(1 for v in (output.composite_scores or {}).values() if v != 0)
        # Funnel snapshot for an emit cycle: `scored` = names with a usable composite score, `held`
        # = the emitted held set (output.ticker_universe). emitted reflects whether we published.
        _record_pipeline(scored=_nonzero, held=len(output.ticker_universe), emitted=publish)
        print(f"[strategy-engine] cycle {cycle_n} SIGNAL "
              f"{'EMITTED' if publish else 'COMPUTED (dry_run)'} "
              f"strategy_update={_update_ms}ms ready={_ready}/{_total} "
              f"regime_confidence={output.regime_confidence:.3f} "
              f"nonzero_scores={_nonzero}/{len(output.ticker_universe)} "
              f"position_size_multiplier={getattr(output, 'position_size_multiplier', 1.0):.2f}",
              flush=True)
        return {
            "cycle": cycle_n, "source": source, "ready": _ready, "total": _total,
            "warming": _warming, "signal_emitted": publish, "dry_run": not publish,
            "fetch_ms": _fetch_ms, "update_ms": _update_ms,
            "regime_confidence": output.regime_confidence,
            "nonzero_scores": _nonzero, "universe_size": len(output.ticker_universe),
            "output": dataclasses.asdict(output) if not publish else None,   # full payload only in dry-run
        }


async def process_loop() -> None:
    await _init_engine_singletons()
    assert _redis is not None
    idle_polls = 0
    while True:
        messages = await _redis.xreadgroup(
            groupname=CONSUMER_GROUP,
            consumername=CONSUMER_NAME,
            streams={INPUT_STREAM: ">"},
            count=10,
            block=5000,
        )
        if not messages:
            idle_polls += 1
            if idle_polls % 12 == 0:
                print(f"[strategy-engine] idle — no {INPUT_STREAM} entries in last ~60s (consumer={CONSUMER_NAME})", flush=True)
            continue
        idle_polls = 0
        for _stream_name, entries in (messages or []):
            for entry_id, fields in entries:
                eid = entry_id.decode() if isinstance(entry_id, bytes) else entry_id
                try:
                    bars = bars_from_json(json.loads(fields[b"data"]))
                    await process_cycle(bars, source=f"stream:{INPUT_STREAM}", entry_id=eid, publish=True)
                    await _redis.xack(INPUT_STREAM, CONSUMER_GROUP, entry_id)
                except Exception as exc:
                    _processing_errors.labels(strategy_id=ACTIVE_STRATEGY).inc()
                    print(f"[strategy-engine] processing error on {entry_id}: {exc!r}", flush=True)


def _on_loop_done(task: asyncio.Task) -> None:
    # Surface silent crashes — without this, an exception in process_loop dies inside
    # the asyncio task and the pod keeps serving /health 200s while consuming nothing.
    try:
        task.result()
    except asyncio.CancelledError:
        return
    except Exception as exc:
        print(f"[strategy-engine] FATAL: process_loop crashed: {exc!r}", flush=True)


@app.post("/admin/api/strategy/replay")
async def replay(body: dict) -> dict:
    """
    Manually trigger one strategy cycle, bypassing the market:raw stream.

    Useful for:
      - smoke-testing strategy changes without waiting for the next bar boundary
      - forcing a re-evaluation after an admin backfill populated Mongo
      - cluster-debugging: prove the full strategy → signal-service path works
        with a known universe and a deterministic invocation

    Body:
      {
        "universe": ["AAPL_US_EQ", "MSFT_US_EQ", ...],   // required, ≥1 ticker
        "dry_run":  true | false                          // optional, default true
      }

    dry_run=true (default):
      Compute the StrategyOutput and return it in the JSON response. DOES NOT
      publish to signals:strategy. Use this when you want to inspect what the
      engine would produce without driving signal-service / trading-service.

    dry_run=false:
      Full pipeline — publish to signals:strategy as if it came from market-data.
      signal-service will consume, approve (if auto-approval is on), and the
      dispatcher will place orders in whichever TRADING_MODE is configured.
      USE WITH CARE in Demo/Live mode — this WILL place real orders.

    Returns:
      {
        cycle, source: "admin:replay", ready, total, warming,
        signal_emitted: bool, dry_run: bool,
        fetch_ms, update_ms,
        regime_confidence?, nonzero_scores?, universe_size?,
        output?: {...}     // full StrategyOutput only in dry-run
      }
    """
    universe = body.get("universe") or []
    dry_run  = bool(body.get("dry_run", True))
    # force_rebalance bypasses a monthly strategy's RebalanceClock for this one cycle (portal
    # "Rebalance now"). Harmless for per-cycle strategies (they emit every cycle regardless).
    force_rebalance = bool(body.get("force_rebalance", False))
    if not isinstance(universe, list) or not all(isinstance(t, str) for t in universe):
        return {"error": "universe must be a list of ticker strings", "status": 400}
    if not universe:
        return {"error": "universe is empty", "status": 400}

    # Synthetic bars — only the ticker matters; the strategy fetches real price
    # history from Mongo via bars_client. Timestamps and OHLCV values are zero
    # placeholders. Cross-sectional return comes from history_map[ticker][-1] -
    # history_map[ticker][-2], not from these bars.
    import time as _t
    now_ms = int(_t.time() * 1000)
    bars = [
        OHLCVBar(ticker=t, timestamp=now_ms, open=0.0, high=0.0, low=0.0, close=0.0, volume=0.0)
        for t in universe
    ]

    result = await process_cycle(
        bars, source="admin:replay", entry_id=None, publish=not dry_run, force_rebalance=force_rebalance,
    )
    return result


@app.on_event("startup")
async def startup() -> None:
    # Initialise singletons (strategy, bars_client, redis) BEFORE either the runLoop
    # or the replay endpoint can call into them. process_loop() also calls
    # _init_engine_singletons() but it's idempotent — first call wins, second no-ops.
    # Doing it here means a replay request that arrives before process_loop reaches
    # its init still finds the singletons ready.
    await _init_engine_singletons()

    # Retain a reference on app.state so the task isn't GC'd. Previously this was a
    # bare create_task() with no reference held, which Python is free to collect —
    # observed in prod as "Task was destroyed but it is pending!" at startup.
    task = asyncio.create_task(process_loop(), name="process_loop")
    task.add_done_callback(_on_loop_done)
    app.state.process_loop_task = task

    # Note: BAR_FREQUENCY is a deploy-time decision. A portal flip in `portal_market_config`
    # does NOT hot-swap the engine — operator must `kubectl rollout restart` after updating
    # the helm value. Worker-per-mode (see roadmap) replaces this with separate pods
    # parameterized at deploy time.

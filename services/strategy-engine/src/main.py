import os
import json
import asyncio
import dataclasses
from fastapi import FastAPI, Response
from fastapi.responses import PlainTextResponse
import redis.asyncio as aioredis
from prometheus_client import Counter, Gauge, generate_latest, CONTENT_TYPE_LATEST
from .application.topology_strategy import TopologyStrategy
from .application.sector_momentum_strategy import SectorMomentumStrategy
from .application.factor_rank_strategy import FactorRankStrategy
from .domain.dataclasses import OHLCVBar
from .infrastructure.market_data_client import MarketDataClient

STRATEGY_REGISTRY = {
    'topology_v1':        TopologyStrategy,
    'sector_momentum_v1': SectorMomentumStrategy,
    'factor_rank_v1':     FactorRankStrategy,
}

app = FastAPI()
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")

# Start with the simplest validated strategy. Enable topology only after
# OOS ablation confirms it adds statistically significant IC (see PROGRESS.md).
ACTIVE_STRATEGY = os.getenv("ACTIVE_STRATEGY", "factor_rank_v1")
BAR_FREQUENCY   = os.getenv("BAR_FREQUENCY", "daily")   # daily | intraday

# Rolling window in bars: 20 daily bars = 20 days; 20 intraday bars = 20 * bar_size minutes
# Strategy classes read ROLLING_WINDOW_BARS from this module so the env var flows through.
ROLLING_WINDOW_BARS = 20 if BAR_FREQUENCY == "daily" else 60

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
}


def _health():
    return {"status": "ok", "active_strategy": ACTIVE_STRATEGY, "bar_frequency": BAR_FREQUENCY, "rolling_window_bars": ROLLING_WINDOW_BARS}


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
    return {"available": list(STRATEGY_REGISTRY.keys()), "active": ACTIVE_STRATEGY}


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
    needed = getattr(strategy, "prewarm_cycles", 0)
    if needed <= 0:
        print(f"[strategy-engine] prewarm: skipped (strategy.prewarm_cycles=0)", flush=True)
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
        bars_at_ts = by_ts[ts]

        # Strategy lookup: closes oldest-first, up to and including this timestamp.
        # Replaces the live cycle's market-data-service round-trip with a slice
        # of the already-fetched history_map. No I/O.
        def history_at_ts(t: str, _ts=ts, _hist=history_map) -> list[float]:
            return [b.close for b in _hist.get(t, []) if b.timestamp <= _ts]

        try:
            strategy.update(bars_at_ts, history_at_ts)
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
    if _strategy is not None:
        return
    _redis = await aioredis.from_url(REDIS_URL)
    await ensure_consumer_group(_redis, INPUT_STREAM, CONSUMER_GROUP)

    strategy_cls = STRATEGY_REGISTRY.get(ACTIVE_STRATEGY)
    if not strategy_cls:
        raise RuntimeError(f"Unknown strategy: {ACTIVE_STRATEGY}")
    _strategy = strategy_cls()

    # Single client across the engine — its per-cycle cache clears on start_cycle.
    _bars_client = MarketDataClient()

    _needed = getattr(_strategy, "rolling_window", ROLLING_WINDOW_BARS)
    _history_interval = "daily" if BAR_FREQUENCY == "daily" else "15m"
    # Range key the HTTP endpoint accepts. shared-bars currently supports
    # 30d / 60d / 90d / 180d. 30d covers the 20-bar daily window; 60d covers the
    # 60-bar 15m intraday window. Prewarm asks for a longer range separately.
    _history_range = "30d" if _needed <= 25 else "60d"

    print(f"[strategy-engine] singletons ready — strategy={ACTIVE_STRATEGY} bar_freq={BAR_FREQUENCY} "
          f"rolling_window={ROLLING_WINDOW_BARS} history_range={_history_range} history_interval={_history_interval} "
          f"prewarm_cycles={getattr(_strategy, 'prewarm_cycles', 0)} "
          f"input={INPUT_STREAM} output={OUTPUT_STREAM} consumer={CONSUMER_NAME} group={CONSUMER_GROUP}", flush=True)


async def process_cycle(
    bars: list[OHLCVBar],
    *,
    source: str,
    entry_id: str | None = None,
    publish: bool = True,
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
        output = _strategy.update(bars, _lookup)
        _update_ms = int((_t.time() - _update_start) * 1000)

        _bars_processed.labels(strategy_id=ACTIVE_STRATEGY).inc(len(bars))

        if output is None:
            reason = "unknown"
            if _ready < _strategy.min_universe_size:
                reason = f"ready={_ready} < min_universe_size={_strategy.min_universe_size}"
            elif _total == 0:
                reason = "no bars on the stream"
            else:
                reason = "strategy returned None (regime gate or all HOLD)"
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

    result = await process_cycle(bars, source="admin:replay", entry_id=None, publish=not dry_run)
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

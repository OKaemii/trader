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

CONSUMER_GROUP = "strategy-engine"
CONSUMER_NAME  = f"strategy-engine-{os.getenv('POD_NAME', 'local')}"

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


@app.get("/health")
def health():
    return {"status": "ok", "active_strategy": ACTIVE_STRATEGY, "bar_frequency": BAR_FREQUENCY, "rolling_window_bars": ROLLING_WINDOW_BARS}


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/strategies")
def list_strategies():
    return {"available": list(STRATEGY_REGISTRY.keys()), "active": ACTIVE_STRATEGY}


@app.get("/status")
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


async def process_loop() -> None:
    r = await aioredis.from_url(REDIS_URL)
    await ensure_consumer_group(r, "market:raw", CONSUMER_GROUP)

    strategy_cls = STRATEGY_REGISTRY.get(ACTIVE_STRATEGY)
    if not strategy_cls:
        raise RuntimeError(f"Unknown strategy: {ACTIVE_STRATEGY}")
    strategy = strategy_cls()

    # Single client across the loop — its per-cycle cache clears on start_cycle.
    bars_client = MarketDataClient()

    # Range key the HTTP endpoint accepts. shared-bars currently supports 30d/60d/90d.
    # 30d is enough for the 20-bar daily window with weekend/holiday margin; topology
    # needs 30 bars so we ask for 60d there. We pick based on the strategy's declared
    # rolling_window, falling back to 30d.
    #
    # TODO: guard against rolling_window > what 90d at the chosen interval can supply.
    # Today no strategy declares one that large (factor_rank=20 daily, topology=30 daily,
    # both fit in 60d). If someone sets BAR_FREQUENCY=intraday with ROLLING_WINDOW_BARS=60
    # and a 15m interval, 60 bars × 15m = 15h of history — well inside 30d, so still fine.
    # The hole is only exposed if rolling_window > ~8500 (15m bars in 90d) or > 90 (daily
    # bars in 90d). Add an explicit assertion + expand shared-bars range keys when that
    # becomes real.
    needed = getattr(strategy, "rolling_window", ROLLING_WINDOW_BARS)
    history_range = "30d" if needed <= 25 else "60d"
    history_interval = "daily" if BAR_FREQUENCY == "daily" else "15m"

    # Persist regime state across pod restarts so the engine doesn't spend ~21 cycles
    # in the warm-up sentinel after every redeploy. Only strategies that expose their
    # regime engine via `regime_engine_for_persistence` participate.
    if hasattr(strategy, "regime_engine_for_persistence"):
        re = strategy.regime_engine_for_persistence()
        re.attach_store(r)
        await re.load_from_store()

    while True:
        # Block up to 5 seconds for new messages; recover from PEL on restart
        messages = await r.xreadgroup(
            groupname=CONSUMER_GROUP,
            consumername=CONSUMER_NAME,
            streams={"market:raw": ">"},
            count=10,
            block=5000,
        )
        for _stream_name, entries in (messages or []):
            for entry_id, fields in entries:
                try:
                    bars = bars_from_json(json.loads(fields[b"data"]))
                    _bars_processed.labels(strategy_id=ACTIVE_STRATEGY).inc(len(bars))

                    # Update shared state for /status
                    import time as _time
                    _engine_state["cycles"] += 1
                    _engine_state["last_cycle_ts"] = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())

                    # Batch-fetch rolling-window history for every ticker arriving this
                    # cycle. ONE HTTP round-trip per cycle, regardless of universe size.
                    # market-data-service serves from its read-through Redis cache, so
                    # the steady-state path is sub-millisecond on the strategy side.
                    cycle_id = f"{_engine_state['cycles']}:{entry_id.decode() if isinstance(entry_id, bytes) else entry_id}"
                    bars_client.start_cycle(cycle_id)
                    active_tickers = sorted(set(b.ticker for b in bars))
                    history_map = await bars_client.fetch_bars_batch(
                        tickers=active_tickers,
                        interval=history_interval,
                        range_key=history_range,
                    )
                    # Strategy lookup: returns closes oldest-first for any ticker. Tickers
                    # missing from history_map (e.g. brand-new universe additions before
                    # backfill catches up) get an empty list — strategies treat that as
                    # "skip" via their min-length check.
                    def _lookup(t: str, _m=history_map) -> list[float]:
                        return [b.close for b in _m.get(t, [])]

                    _engine_state["active_universe"] = active_tickers
                    _engine_state["ready_tickers"]   = [t for t in active_tickers if len(_lookup(t)) >= needed]

                    output = strategy.update(bars, _lookup)

                    # Persist regime state out-of-band so warm-up survives restarts. The
                    # strategy.update() path is synchronous; this hook fires after each cycle.
                    if hasattr(strategy, "regime_engine_for_persistence"):
                        await strategy.regime_engine_for_persistence()._persist()

                    # Log readiness state every cycle until signals start, then only on signals
                    ready  = len(_engine_state["ready_tickers"])
                    total  = len(_engine_state["active_universe"])
                    if output is None:
                        print(f"[strategy-engine] no signal — cycle {_engine_state['cycles']}: "
                              f"{ready}/{total} tickers have {needed}+ bars in Mongo (min_universe={strategy.min_universe_size})")
                    else:
                        payload = json.dumps(dataclasses.asdict(output))
                        await r.xadd("signals:strategy", {"data": payload})
                        await r.set("strategy:latest_output", payload)
                        await r.set("regime:confidence", str(output.regime_confidence))
                        await r.publish("strategy:dashboard", payload)
                        _signals_published.labels(strategy_id=ACTIVE_STRATEGY).inc()
                        _regime_confidence.labels(strategy_id=ACTIVE_STRATEGY).set(output.regime_confidence)
                        _engine_state["signals_emitted"] += 1
                        _engine_state["last_signal"] = _engine_state["last_cycle_ts"]
                        print(f"[strategy-engine] signal emitted — {ready} tickers, "
                              f"regime_confidence={output.regime_confidence:.3f}")

                    await r.xack("market:raw", CONSUMER_GROUP, entry_id)
                except Exception as exc:
                    # Log but do not ACK — message stays in PEL for retry/inspection
                    _processing_errors.labels(strategy_id=ACTIVE_STRATEGY).inc()
                    print(f"[strategy-engine] processing error on {entry_id}: {exc}")


def _on_loop_done(task: asyncio.Task) -> None:
    # Surface silent crashes — without this, an exception in process_loop dies inside
    # the asyncio task and the pod keeps serving /health 200s while consuming nothing.
    try:
        task.result()
    except asyncio.CancelledError:
        return
    except Exception as exc:
        print(f"[strategy-engine] FATAL: process_loop crashed: {exc!r}", flush=True)


@app.on_event("startup")
async def startup() -> None:
    # Retain a reference on app.state so the task isn't GC'd. Previously this was a
    # bare create_task() with no reference held, which Python is free to collect —
    # observed in prod as "Task was destroyed but it is pending!" at startup.
    task = asyncio.create_task(process_loop(), name="process_loop")
    task.add_done_callback(_on_loop_done)
    app.state.process_loop_task = task

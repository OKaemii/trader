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


@app.get("/health")
def health():
    return {"status": "ok", "active_strategy": ACTIVE_STRATEGY, "bar_frequency": BAR_FREQUENCY, "rolling_window_bars": ROLLING_WINDOW_BARS}


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/strategies")
def list_strategies():
    return {"available": list(STRATEGY_REGISTRY.keys()), "active": ACTIVE_STRATEGY}


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
                    output = strategy.update(bars)
                    if output is not None:
                        payload = json.dumps(dataclasses.asdict(output))
                        # Durable delivery to signal-service via Redis Streams
                        await r.xadd("signals:strategy", {"data": payload})
                        # Ephemeral latest-value keys (dashboard reads, not trading pipeline)
                        await r.set("strategy:latest_output", payload)
                        await r.set("regime:confidence", str(output.regime_confidence))
                        # Pub/sub for WebSocket dashboard feeds (missed updates are OK for UI)
                        await r.publish("strategy:dashboard", payload)
                        _signals_published.labels(strategy_id=ACTIVE_STRATEGY).inc()
                        _regime_confidence.labels(strategy_id=ACTIVE_STRATEGY).set(output.regime_confidence)
                    await r.xack("market:raw", CONSUMER_GROUP, entry_id)
                except Exception as exc:
                    # Log but do not ACK — message stays in PEL for retry/inspection
                    _processing_errors.labels(strategy_id=ACTIVE_STRATEGY).inc()
                    print(f"[strategy-engine] processing error on {entry_id}: {exc}")


@app.on_event("startup")
async def startup() -> None:
    asyncio.create_task(process_loop())

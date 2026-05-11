import os
import json
import asyncio
import dataclasses
from fastapi import FastAPI
import redis.asyncio as aioredis
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

CONSUMER_GROUP = "strategy-engine"
CONSUMER_NAME  = f"strategy-engine-{os.getenv('POD_NAME', 'local')}"


@app.get("/health")
def health():
    return {"status": "ok", "active_strategy": ACTIVE_STRATEGY}


@app.get("/strategies")
def list_strategies():
    return {"available": list(STRATEGY_REGISTRY.keys()), "active": ACTIVE_STRATEGY}


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
                    await r.xack("market:raw", CONSUMER_GROUP, entry_id)
                except Exception as exc:
                    # Log but do not ACK — message stays in PEL for retry/inspection
                    print(f"[strategy-engine] processing error on {entry_id}: {exc}")


@app.on_event("startup")
async def startup() -> None:
    asyncio.create_task(process_loop())

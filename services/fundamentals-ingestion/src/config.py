"""Portal-configurable fundamentals config — the `portal_fundamentals_config` Mongo singleton.

The operator-tunable runtime overrides for the ingestion service, mirroring market-data-service's
`portal_market_config` (`shared/live-config.ts`): a single Mongo doc whose set fields OVERRIDE the
env/compile-time defaults, read per-run behind a short TTL cache, with cross-pod cache invalidation
on a write. The precedence is the platform-wide rule — **override > env > built-in default** — applied
per field, so an absent/`null` override field falls back to env/code for *just that field*.

WHY this exists (the card's headline): the SEC `EDGAR_USER_AGENT` is the one knob an operator must be
able to change from the portal WITHOUT a redeploy — SEC blocks an anonymous/placeholder UA, and the
deployed default (`trader-platform fundamentals-ingestion`) carries no contact, which SEC's fair-access
policy asks for. The config doc lets the portal set a real contact string (`edgarUserAgent`) live; the
orchestrator/EDGAR clients resolve the **effective UA** from here before constructing the clients, and
STILL refuse to call SEC with an empty effective UA (the fail-closed invariant the ingest run already
enforces — we move the resolution earlier so a portal value wins over the env).

THREE FIELDS, all optional (absent ⇒ fall back):
  * `edgarUserAgent`  — the descriptive SEC User-Agent. Override > `EDGAR_USER_AGENT` env > the
                        built-in `DEFAULT_EDGAR_USER_AGENT`. The empty string is treated as "unset"
                        (so a blank portal field does not blank-out the env), never as a valid UA.
  * `coverageCap`     — override the `FUNDAMENTALS_COVERAGE_CAP` for a portal-triggered run (0 ⇒
                        uncapped — the operator's explicit opt-in to the full universe+index set).
  * `ingestEnabled`   — a soft kill switch: when explicitly `false`, the force-ingest endpoint refuses
                        to start a run (feed-health surfaces it). Absent/`true` ⇒ enabled.

CACHE + CROSS-POD INVALIDATION (mirrors `live-config.ts`): a 15s in-process TTL cache fronts the Mongo
read; a PUT invalidates the local cache AND publishes `config:invalidated` on Redis so any *other* pod
drops its cache too. The Deployment is `replicas: 1` today, so the local bust is the load-bearing path
and the Redis publish is best-effort (a Redis blip never fails the PUT). Reads degrade to the prior
effective config (env/default on first read) on a Mongo error — a config read must never break the run.

DRIVER-FREE IMPORT: motor/redis are imported lazily inside the async methods, so importing this module
(which the module-import smoke test does) opens no socket — matching the rest of the service's
"the stage packages connect to nothing" invariant.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Optional

log = logging.getLogger("fundamentals-ingestion.config")

# The Mongo collection + the singleton doc key — mirrors `portal_market_config`'s `{_id:'singleton'}`
# shape (shared-mongo COLLECTIONS.PORTAL_MARKET_CONFIG). One doc per deployment; the portal upserts it.
COLL_PORTAL_FUNDAMENTALS_CONFIG = "portal_fundamentals_config"
SINGLETON_ID = "singleton"

# Cross-pod cache-invalidation topic — the SAME bus market-data-service publishes config writes on
# (`shared/live-config.ts` CONFIG_INVALIDATED_TOPIC). Best-effort pub/sub (not a durable stream): a
# missed message only means a stale-up-to-15s read on another pod, which the TTL self-heals.
CONFIG_INVALIDATED_TOPIC = "config:invalidated"

# Built-in default UA — the compile-time fallback when neither the override nor the env is set. Matches
# the Helm `global.env.edgarUserAgent` default so behaviour is identical whether the value is wired via
# env or omitted. NOT a valid contact string on its own (no email) — the card sets a real one in values.
DEFAULT_EDGAR_USER_AGENT = "trader-platform fundamentals-ingestion"

# TTL of the in-process config cache. 15s matches `live-config.ts` — long enough to spare Mongo a read
# per orchestrator step, short enough that a portal change without a Redis publish still lands quickly.
_CACHE_MS = 15_000


@dataclass(frozen=True)
class FundamentalsConfig:
    """The RESOLVED effective config (override > env > default already applied per field).

    `edgar_user_agent` is the empty string ONLY when neither an override, the env, nor the default
    yielded a value (the default is non-empty, so in practice this is never empty — but the
    `effective_user_agent` helper still guards the empty case so a future blank default fails closed
    rather than calling SEC anonymously). `coverage_cap` is None when uncapped. `ingest_enabled` is the
    soft kill switch (True unless explicitly disabled)."""

    edgar_user_agent: str
    coverage_cap: Optional[int]
    ingest_enabled: bool
    # Provenance of the UA — 'override' | 'env' | 'default' — so feed-health/status can show WHERE the
    # effective value came from (the operator's "is my portal value actually winning?" check).
    edgar_user_agent_source: str


def _env_user_agent() -> str:
    """The env-layer UA (`EDGAR_USER_AGENT`), stripped. Empty when unset/blank."""
    return os.getenv("EDGAR_USER_AGENT", "").strip()


# The same env→cap mapping `coverage.coverage_cap_from_env` applies, inlined here so the pure resolver
# stays dependency-light (importing src.coverage drags in quant_core, which the precedence unit tests
# must not need). The semantics MUST match coverage.DEFAULT_COVERAGE_CAP / coverage_cap_from_env: an
# unset env ⇒ the default cap; an explicit 0/negative/unparseable ⇒ uncapped (None).
_DEFAULT_COVERAGE_CAP = 64


def _env_coverage_cap() -> Optional[int]:
    """The env-layer coverage cap (`FUNDAMENTALS_COVERAGE_CAP`), or None (uncapped) when 0/negative/bad.
    An unset env falls back to the default cap (mirrors `coverage.coverage_cap_from_env`)."""
    raw = os.getenv("FUNDAMENTALS_COVERAGE_CAP", "")
    if not raw:
        return _DEFAULT_COVERAGE_CAP
    try:
        n = int(raw)
    except ValueError:
        return _DEFAULT_COVERAGE_CAP
    return n if n > 0 else None


def resolve_effective(doc: Optional[dict]) -> FundamentalsConfig:
    """PURE resolver: a `portal_fundamentals_config` doc (or None) → the effective `FundamentalsConfig`,
    applying override > env > default per field. Unit-tested directly (no Mongo) — this is where the
    precedence contract lives.

    `edgarUserAgent`: a non-empty override wins; else a non-empty env; else the built-in default. A
    BLANK override (empty/whitespace) is treated as "unset" — it falls through to env/default rather
    than blanking the UA (a blank portal field must not break SEC access).
    `coverageCap`: an override that is a non-negative int wins (0 ⇒ uncapped/None); else the env cap.
    `ingestEnabled`: only an explicit `false` disables; absent/non-bool ⇒ enabled (fail-open for a
    control that merely gates a heavy manual trigger)."""
    doc = doc or {}

    override_ua = doc.get("edgarUserAgent")
    override_ua = override_ua.strip() if isinstance(override_ua, str) else ""
    if override_ua:
        ua, ua_source = override_ua, "override"
    else:
        env_ua = _env_user_agent()
        if env_ua:
            ua, ua_source = env_ua, "env"
        else:
            ua, ua_source = DEFAULT_EDGAR_USER_AGENT, "default"

    # coverageCap: an int override (incl. 0 ⇒ uncapped) wins; anything else falls back to the env cap.
    cap_override = doc.get("coverageCap")
    if isinstance(cap_override, bool):  # bool is an int subclass — reject it explicitly (a config typo)
        cap = _env_coverage_cap()
    elif isinstance(cap_override, int):
        cap = cap_override if cap_override > 0 else None
    else:
        cap = _env_coverage_cap()

    ingest_enabled = doc.get("ingestEnabled")
    enabled = False if ingest_enabled is False else True

    return FundamentalsConfig(
        edgar_user_agent=ua,
        coverage_cap=cap,
        ingest_enabled=enabled,
        edgar_user_agent_source=ua_source,
    )


def effective_user_agent(cfg: FundamentalsConfig) -> Optional[str]:
    """The UA the EDGAR clients should send, or None when there is NO usable UA (empty after resolution).

    Returning None is the fail-closed signal: the caller must refuse to construct the SEC clients / start
    a run rather than send an anonymous request SEC would 403 (and risk an IP block). In practice the
    non-empty built-in default means this returns a value, but the guard is the contract — a deployment
    that somehow blanks the default still fails closed here."""
    ua = (cfg.edgar_user_agent or "").strip()
    return ua or None


class FundamentalsConfigProvider:
    """Reads `portal_fundamentals_config` from Mongo behind a 15s TTL cache; resolves the effective
    config (override > env > default); publishes `config:invalidated` on a write.

    Mirrors `live-config.ts`: `get()` is the hot read (cache-first), `put()` upserts + invalidates, and
    a Mongo read error degrades to the env/default config (never raises into the orchestrator). The
    motor client + redis client are injected (the composition root builds them) OR lazily constructed
    from env on first use; passing them in keeps the unit tests driver-free and lets the process share
    ONE client.
    """

    def __init__(self, mongo_db=None, *, redis=None) -> None:
        # `mongo_db` is a motor database handle (or a fake in tests). When None it is built lazily from
        # MONGODB_URL/MONGODB_DB on first read (the composition root path). `redis` is the shared
        # redis.asyncio client for the invalidation publish — best-effort, None disables the publish.
        self._db = mongo_db
        self._redis = redis
        self._cache: Optional[tuple[FundamentalsConfig, float]] = None

    async def _database(self):
        """The motor database handle — injected, or built once from env. Lazy import keeps the module
        socket-free on import."""
        if self._db is not None:
            return self._db
        from motor.motor_asyncio import AsyncIOMotorClient

        url = os.getenv("MONGODB_URL", "mongodb://localhost:27017")
        name = os.getenv("MONGODB_DB", "trader")
        self._db = AsyncIOMotorClient(url)[name]
        return self._db

    async def _read_doc(self) -> Optional[dict]:
        """Read the singleton override doc, or None (no override / a read error). A Mongo failure logs
        and returns None so `get()` falls back to env/default — a config read never breaks a run."""
        try:
            db = await self._database()
            return await db[COLL_PORTAL_FUNDAMENTALS_CONFIG].find_one({"_id": SINGLETON_ID})
        except Exception as exc:  # noqa: BLE001 — degrade to env/default, never abort the caller
            log.warning("[config] portal_fundamentals_config read failed (%s): %s", type(exc).__name__, exc)
            return None

    async def get(self, *, force_refresh: bool = False) -> FundamentalsConfig:
        """The effective config, cache-first (15s TTL). `force_refresh` bypasses the cache (the PUT path
        re-reads to confirm the write). The resolution (override > env > default) runs on every refresh
        so a changed env is picked up too."""
        now = time.monotonic() * 1000
        if not force_refresh and self._cache is not None and (now - self._cache[1]) < _CACHE_MS:
            return self._cache[0]
        doc = await self._read_doc()
        cfg = resolve_effective(doc)
        self._cache = (cfg, now)
        return cfg

    def invalidate(self) -> None:
        """Drop the local cache (next `get()` re-reads Mongo). Called on the local PUT and on a
        `config:invalidated` pub/sub message from another pod."""
        self._cache = None

    async def put(self, patch: dict, *, updated_by: str = "portal") -> FundamentalsConfig:
        """Upsert the override doc with the provided fields, invalidate the local cache, publish the
        cross-pod invalidation, and return the freshly-resolved effective config.

        Only the recognised override keys are persisted (`edgarUserAgent`/`coverageCap`/`ingestEnabled`)
        — an unknown key in the patch is ignored, never written, so the doc shape stays the contract.
        A `null` value in the patch is written as `null` (explicitly clearing an override back to the
        env/default), matching `portal_market_config`'s per-field null = fall-back semantics."""
        update = self._sanitise_patch(patch)
        update["updatedBy"] = updated_by
        from datetime import datetime, timezone

        update["updatedAt"] = datetime.now(timezone.utc)

        db = await self._database()
        await db[COLL_PORTAL_FUNDAMENTALS_CONFIG].update_one(
            {"_id": SINGLETON_ID}, {"$set": update}, upsert=True
        )
        self.invalidate()
        await self._publish_invalidated()
        return await self.get(force_refresh=True)

    @staticmethod
    def _sanitise_patch(patch: dict) -> dict:
        """Project the incoming patch onto the recognised override fields, coercing types so a portal
        typo can't write a garbage doc. Unknown keys are dropped. A present `coverageCap` is coerced to
        an int (a non-int ⇒ dropped); `ingestEnabled` to a bool; `edgarUserAgent` to a stripped str (or
        explicit null to clear)."""
        out: dict = {}
        if "edgarUserAgent" in patch:
            v = patch["edgarUserAgent"]
            out["edgarUserAgent"] = v.strip() if isinstance(v, str) else (None if v is None else str(v))
        if "coverageCap" in patch:
            v = patch["coverageCap"]
            if v is None:
                out["coverageCap"] = None
            elif isinstance(v, bool):
                pass  # reject a bool masquerading as the cap
            elif isinstance(v, (int, float)):
                out["coverageCap"] = int(v)
        if "ingestEnabled" in patch:
            v = patch["ingestEnabled"]
            if isinstance(v, bool):
                out["ingestEnabled"] = v
            elif v is None:
                out["ingestEnabled"] = None
        return out

    async def _publish_invalidated(self) -> None:
        """Best-effort `config:invalidated` publish so other pods drop their cache (mirror market-data's
        write path). A None client (or any Redis error) is a no-op — the local cache bust already
        applied, and the 15s TTL bounds the staleness on peers."""
        if self._redis is None:
            return
        try:
            import json

            await self._redis.publish(
                CONFIG_INVALIDATED_TOPIC,
                json.dumps({"scope": "fundamentals", "source": "fundamentals-ingestion"}),
            )
        except Exception as exc:  # noqa: BLE001 — invalidation is best-effort; never fail the PUT
            log.warning("[config] config:invalidated publish failed (%s): %s", type(exc).__name__, exc)

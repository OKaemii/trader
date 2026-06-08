"""portal_fundamentals_config provider tests — the override > env > default precedence + the
empty-effective-UA fail-closed + the PUT-invalidates contract (Ops backend card).

The headline knob is the SEC `EDGAR_USER_AGENT`: an operator must be able to set a real contact string
from the portal WITHOUT a redeploy, and a portal value must WIN over the env, which wins over the
built-in default. These tests pin that precedence on the PURE `resolve_effective` (no Mongo), the
fail-closed `effective_user_agent` guard, and the provider's cache + PUT-invalidation against a tiny
fake motor singleton collection. No network, no DB.
"""
from __future__ import annotations

import pytest

from src.config import (
    DEFAULT_EDGAR_USER_AGENT,
    FundamentalsConfigProvider,
    effective_user_agent,
    resolve_effective,
)


# ── pure precedence: override > env > default ──────────────────────────────────────
def test_override_user_agent_wins_over_env_and_default(monkeypatch) -> None:
    monkeypatch.setenv("EDGAR_USER_AGENT", "env-ua envcontact@example.com")
    cfg = resolve_effective({"edgarUserAgent": "portal-ua portal@example.com"})
    assert cfg.edgar_user_agent == "portal-ua portal@example.com"
    assert cfg.edgar_user_agent_source == "override"


def test_env_user_agent_wins_when_no_override(monkeypatch) -> None:
    monkeypatch.setenv("EDGAR_USER_AGENT", "env-ua envcontact@example.com")
    cfg = resolve_effective({})  # no override doc field
    assert cfg.edgar_user_agent == "env-ua envcontact@example.com"
    assert cfg.edgar_user_agent_source == "env"


def test_builtin_default_used_when_neither_override_nor_env(monkeypatch) -> None:
    monkeypatch.delenv("EDGAR_USER_AGENT", raising=False)
    cfg = resolve_effective(None)  # no doc at all
    assert cfg.edgar_user_agent == DEFAULT_EDGAR_USER_AGENT
    assert cfg.edgar_user_agent_source == "default"


def test_blank_override_falls_through_to_env_not_blanking_it(monkeypatch) -> None:
    # A blank/whitespace portal field must NOT blank-out the UA — it falls through to env (then default).
    monkeypatch.setenv("EDGAR_USER_AGENT", "env-ua envcontact@example.com")
    cfg = resolve_effective({"edgarUserAgent": "   "})
    assert cfg.edgar_user_agent == "env-ua envcontact@example.com"
    assert cfg.edgar_user_agent_source == "env"


# ── empty-effective-UA refusal (the fail-closed guard) ─────────────────────────────
def test_effective_user_agent_none_when_empty(monkeypatch) -> None:
    # Force the (unrealistic) all-empty case to prove the guard: no override, no env, and a blanked
    # default — effective_user_agent returns None so the caller refuses to call SEC.
    monkeypatch.delenv("EDGAR_USER_AGENT", raising=False)
    monkeypatch.setattr("src.config.DEFAULT_EDGAR_USER_AGENT", "")
    cfg = resolve_effective(None)
    assert cfg.edgar_user_agent == ""
    assert effective_user_agent(cfg) is None


def test_effective_user_agent_returns_value_when_present() -> None:
    cfg = resolve_effective({"edgarUserAgent": "trader-platform/1.0 (ops@example.com)"})
    assert effective_user_agent(cfg) == "trader-platform/1.0 (ops@example.com)"


# ── coverageCap + ingestEnabled precedence ─────────────────────────────────────────
def test_coverage_cap_override_wins_over_env(monkeypatch) -> None:
    monkeypatch.setenv("FUNDAMENTALS_COVERAGE_CAP", "64")
    cfg = resolve_effective({"coverageCap": 12})
    assert cfg.coverage_cap == 12


def test_coverage_cap_zero_override_means_uncapped(monkeypatch) -> None:
    monkeypatch.setenv("FUNDAMENTALS_COVERAGE_CAP", "64")
    cfg = resolve_effective({"coverageCap": 0})
    assert cfg.coverage_cap is None  # 0 ⇒ uncapped (the operator's opt-in to the full set)


def test_coverage_cap_falls_back_to_env_when_absent(monkeypatch) -> None:
    monkeypatch.setenv("FUNDAMENTALS_COVERAGE_CAP", "40")
    cfg = resolve_effective({})
    assert cfg.coverage_cap == 40


def test_ingest_enabled_defaults_true_and_only_explicit_false_disables() -> None:
    assert resolve_effective({}).ingest_enabled is True
    assert resolve_effective({"ingestEnabled": True}).ingest_enabled is True
    assert resolve_effective({"ingestEnabled": False}).ingest_enabled is False


# ── provider: cache + PUT invalidation against a fake singleton collection ──────────
class _FakeSingletonCollection:
    """A tiny motor-collection stand-in for the singleton doc: find_one returns the stored doc (or None),
    update_one applies a `$set` upsert. Counts reads so the cache test can assert a cache hit."""

    def __init__(self) -> None:
        self.doc: dict | None = None
        self.find_calls = 0

    async def find_one(self, _query):
        self.find_calls += 1
        return dict(self.doc) if self.doc is not None else None

    async def update_one(self, query, update, upsert=False):  # noqa: ARG002
        base = dict(self.doc) if self.doc is not None else {"_id": query["_id"]}
        base.update(update["$set"])
        self.doc = base


class _FakeDb:
    def __init__(self, col: _FakeSingletonCollection) -> None:
        self._col = col

    def __getitem__(self, _name):
        return self._col


@pytest.mark.asyncio
async def test_provider_caches_reads(monkeypatch) -> None:
    monkeypatch.delenv("EDGAR_USER_AGENT", raising=False)
    col = _FakeSingletonCollection()
    col.doc = {"_id": "singleton", "edgarUserAgent": "doc-ua doc@example.com"}
    provider = FundamentalsConfigProvider(_FakeDb(col))

    first = await provider.get()
    second = await provider.get()  # within the 15s TTL → cache hit, no second Mongo read
    assert first.edgar_user_agent == "doc-ua doc@example.com"
    assert second.edgar_user_agent == "doc-ua doc@example.com"
    assert col.find_calls == 1  # one read served both gets


@pytest.mark.asyncio
async def test_put_persists_invalidates_and_returns_effective(monkeypatch) -> None:
    monkeypatch.delenv("EDGAR_USER_AGENT", raising=False)
    col = _FakeSingletonCollection()
    provider = FundamentalsConfigProvider(_FakeDb(col))

    # Prime the cache with the default (no doc yet).
    before = await provider.get()
    assert before.edgar_user_agent_source == "default"

    # PUT a portal UA → persisted, cache invalidated, effective config returned reflects the new value.
    cfg = await provider.put({"edgarUserAgent": "portal-ua portal@example.com", "coverageCap": 8})
    assert cfg.edgar_user_agent == "portal-ua portal@example.com"
    assert cfg.edgar_user_agent_source == "override"
    assert cfg.coverage_cap == 8
    assert col.doc["edgarUserAgent"] == "portal-ua portal@example.com"
    assert col.doc["coverageCap"] == 8
    assert "updatedAt" in col.doc and col.doc["updatedBy"] == "portal"

    # A subsequent get reflects the persisted value (cache was invalidated by the PUT).
    after = await provider.get()
    assert after.edgar_user_agent == "portal-ua portal@example.com"


@pytest.mark.asyncio
async def test_put_ignores_unknown_keys_and_clears_with_null(monkeypatch) -> None:
    monkeypatch.setenv("EDGAR_USER_AGENT", "env-ua env@example.com")
    col = _FakeSingletonCollection()
    provider = FundamentalsConfigProvider(_FakeDb(col))

    # An unknown key is never written; a null edgarUserAgent clears the override back to env/default.
    await provider.put({"edgarUserAgent": "portal-ua p@example.com", "bogus": 1})
    assert "bogus" not in col.doc
    cfg = await provider.put({"edgarUserAgent": None})
    assert col.doc["edgarUserAgent"] is None
    assert cfg.edgar_user_agent == "env-ua env@example.com"  # fell back to env
    assert cfg.edgar_user_agent_source == "env"


@pytest.mark.asyncio
async def test_get_degrades_to_env_default_on_mongo_error(monkeypatch) -> None:
    monkeypatch.setenv("EDGAR_USER_AGENT", "env-ua env@example.com")

    class _BoomCollection:
        async def find_one(self, _query):
            raise OSError("mongo unreachable")

    class _BoomDb:
        def __getitem__(self, _name):
            return _BoomCollection()

    provider = FundamentalsConfigProvider(_BoomDb())
    cfg = await provider.get()  # read raises → degrade to env config, never propagate
    assert cfg.edgar_user_agent == "env-ua env@example.com"
    assert cfg.edgar_user_agent_source == "env"


@pytest.mark.asyncio
async def test_put_publishes_config_invalidated(monkeypatch) -> None:
    monkeypatch.delenv("EDGAR_USER_AGENT", raising=False)
    col = _FakeSingletonCollection()

    published: list[tuple[str, str]] = []

    class _FakeRedis:
        async def publish(self, channel, message):
            published.append((channel, message))

    provider = FundamentalsConfigProvider(_FakeDb(col), redis=_FakeRedis())
    await provider.put({"edgarUserAgent": "portal-ua p@example.com"})
    assert len(published) == 1
    assert published[0][0] == "config:invalidated"
    assert "fundamentals" in published[0][1]

"""In-memory fakes for the read-side tests — an asyncpg-pool stand-in over the `fundamentals` +
`security_master.*` tables, and a trivial async Redis double — so the resolver/endpoints are exercised
with NO live Timescale and NO Redis.

WHY a hand-rolled fake DB rather than a real Postgres in the gate: the python gate
(`backtest-engine-test.Dockerfile`) is a pure pytest image with no database. What this card must verify
at the DB seam is (a) the as-of read returns ONLY facts with knowledge_ts ≤ asOf (the no-look-ahead
guard, which lives in the SQL — so the fake faithfully reproduces that WHERE clause), (b) the live path
reads the is_superseded=FALSE fast lane, (c) the pivot produces the snake_case LINE_ITEMS dict, and (d)
ticker → instrument_id resolves as-of (FB→META). A faithful in-memory store that reproduces exactly the
query shapes the resolver issues covers all four deterministically. It is a TEST DOUBLE, not a SQL
engine — it understands only the statements this service's code emits.

The `fundamentals` row model + the security_master tables mirror the deployed 0009/0008 schema and the
ingestion service's FakeTimescale, so a row seeded here is the same shape the write-side writer lands.
"""
from __future__ import annotations

import re
from typing import Any, Optional


class _Acquire:
    """async context manager returned by `pool.acquire()`."""

    def __init__(self, conn: "FakeConnection") -> None:
        self._conn = conn

    async def __aenter__(self) -> "FakeConnection":
        return self._conn

    async def __aexit__(self, *exc: Any) -> bool:
        return False


class FakeConnection:
    """The asyncpg connection surface the resolver + endpoints use: fetch / fetchrow."""

    def __init__(self, db: "FakeTimescale") -> None:
        self._db = db

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        return self._db.run_fetch(query, args)

    async def fetchrow(self, query: str, *args: Any) -> Optional[dict[str, Any]]:
        rows = self._db.run_fetch(query, args)
        return rows[0] if rows else None


class FakeTimescale:
    """A tiny in-memory stand-in for `fundamentals` + `security_master.{instruments,identifiers,companies}`
    + the asyncpg pool API. Answers exactly the queries the read service issues."""

    def __init__(self) -> None:
        # security_master
        self.companies: list[dict[str, Any]] = []
        self.instruments: list[dict[str, Any]] = []
        self.identifiers: list[dict[str, Any]] = []
        # canonical facts (bi-temporal; the read surface). Seed rows here as the writer would land them.
        self.fundamentals: list[dict[str, Any]] = []
        self.fundamentals_quarantine: list[dict[str, Any]] = []

    # ── pool API ────────────────────────────────────────────────────────────────
    def acquire(self) -> _Acquire:
        return _Acquire(FakeConnection(self))

    @staticmethod
    def _norm(q: str) -> str:
        return re.sub(r"\s+", " ", q).strip().lower()

    # ── seed helpers ──────────────────────────────────────────────────────────────
    def add_instrument(
        self, *, instrument_id: int, t212_ticker: str, company_id: int = 1, cik: Optional[str] = None
    ) -> None:
        self.instruments.append(
            {"instrument_id": instrument_id, "company_id": company_id, "t212_ticker": t212_ticker}
        )
        if not any(c["company_id"] == company_id for c in self.companies):
            self.companies.append({"company_id": company_id, "cik": cik, "sector": None})

    def add_identifier(
        self,
        *,
        instrument_id: int,
        identifier_value: str,
        effective_from: int,
        effective_to: Optional[int] = None,
        identifier_type: str = "ticker",
    ) -> None:
        self.identifiers.append(
            {
                "instrument_id": instrument_id,
                "identifier_type": identifier_type,
                "identifier_value": identifier_value,
                "effective_from": effective_from,
                "effective_to": effective_to,
            }
        )

    def add_fact(
        self,
        *,
        instrument_id: int,
        metric: str,
        observation_ts: int,
        knowledge_ts: int,
        value: Optional[float],
        is_superseded: bool = False,
        dim_signature: str = "",
        source: str = "pit-edgar",
        content_hash: str = "h",
    ) -> None:
        self.fundamentals.append(
            {
                "instrument_id": instrument_id,
                "metric": metric,
                "observation_ts": observation_ts,
                "knowledge_ts": knowledge_ts,
                "dim_signature": dim_signature,
                "value": value,
                "source": source,
                "is_superseded": is_superseded,
                "content_hash": content_hash,
            }
        )

    # ── fetch ─────────────────────────────────────────────────────────────────────
    def run_fetch(self, query: str, args: tuple) -> list[dict[str, Any]]:
        q = self._norm(query)

        # coverage: aggregate over current facts. Checked BEFORE the live fast lane below — the coverage
        # query also says `from fundamentals` + `is_superseded = false`, so it must be matched first by
        # its distinctive COUNT(DISTINCT …) shape (else it would fall into the per-instrument live branch).
        if "count(distinct instrument_id)" in q and "from fundamentals" in q:
            current = [r for r in self.fundamentals if not r["is_superseded"]]
            instruments = len({r["instrument_id"] for r in current})
            facts = len(current)
            oldest = min((r["observation_ts"] for r in current), default=None)
            newest = max((r["knowledge_ts"] for r in current), default=None)
            return [{
                "instruments": instruments, "facts": facts,
                "oldest_observation_ts": oldest, "newest_knowledge_ts": newest,
            }]

        # Resolver: fundamentals LIVE fast lane — is_superseded=FALSE, dim_signature='' for one instrument.
        if "from fundamentals" in q and "is_superseded = false" in q and "knowledge_ts <= $2" not in q \
                and "distinct on" not in q:
            (instrument_id,) = args
            rows = [
                r for r in self.fundamentals
                if r["instrument_id"] == instrument_id and not r["is_superseded"]
                and r["dim_signature"] == ""
            ]
            rows.sort(key=lambda r: (r["metric"], -r["observation_ts"]))
            return [self._fact_proj(r) for r in rows]

        # Resolver: fundamentals AS-OF — DISTINCT ON (metric, observation_ts, dim) latest knowledge_ts ≤ asOf.
        # THE NO-LOOK-AHEAD GUARD reproduced exactly: only rows with knowledge_ts <= $2 survive.
        if "from fundamentals" in q and "knowledge_ts <= $2" in q and "distinct on" in q:
            instrument_id, as_of = args
            candidates = [
                r for r in self.fundamentals
                if r["instrument_id"] == instrument_id and r["dim_signature"] == ""
                and r["knowledge_ts"] <= as_of
            ]
            # DISTINCT ON (metric, observation_ts, dim) ORDER BY …, knowledge_ts DESC → per logical fact,
            # the latest revision known at asOf.
            best: dict[tuple, dict[str, Any]] = {}
            for r in candidates:
                key = (r["metric"], r["observation_ts"], r["dim_signature"])
                cur = best.get(key)
                if cur is None or r["knowledge_ts"] > cur["knowledge_ts"]:
                    best[key] = r
            return [self._fact_proj(r) for r in best.values()]

        # Resolver candidate-intervals (security_master): every ticker-typed interval on any instrument
        # that ever carried identifier_value=$2.
        if "from security_master.identifiers i" in q and "join security_master.instruments inst" in q:
            itype, ival = args[0], args[1]
            target = {
                r["instrument_id"] for r in self.identifiers
                if r["identifier_type"] == itype and r["identifier_value"] == ival
            }
            out = []
            for r in self.identifiers:
                if r["identifier_type"] != itype or r["instrument_id"] not in target:
                    continue
                inst = self._instrument(r["instrument_id"])
                out.append({
                    "instrument_id": r["instrument_id"],
                    "identifier_value": r["identifier_value"],
                    "effective_from": r["effective_from"],
                    "effective_to": r["effective_to"],
                    "company_id": inst["company_id"] if inst else None,
                    "t212_ticker": inst["t212_ticker"] if inst else None,
                })
            return out

        # resolve_instrument direct t212 join.
        if "from security_master.instruments inst" in q and "where inst.t212_ticker = $1" in q:
            inst = next((i for i in self.instruments if i["t212_ticker"] == args[0]), None)
            if inst is None:
                return []
            return [{
                "instrument_id": inst["instrument_id"], "company_id": inst["company_id"],
                "t212_ticker": inst["t212_ticker"],
            }]

        # quarantine by-reason / recent (endpoint). since param is args[0]; recent also binds limit.
        if "from fundamentals_quarantine" in q and "group by reason" in q:
            counts: dict[str, int] = {}
            for r in self.fundamentals_quarantine:
                counts[r["reason"]] = counts.get(r["reason"], 0) + 1
            return [{"reason": reason, "n": n}
                    for reason, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]
        if "from fundamentals_quarantine" in q and "order by occurred_at desc" in q:
            limit = args[1] if len(args) > 1 else 50
            rows = list(self.fundamentals_quarantine)
            rows.sort(key=lambda r: r["event_id"], reverse=True)
            return [
                {
                    "event_id": r["event_id"], "occurred_at": r.get("occurred_at"),
                    "instrument_id": r["instrument_id"], "filing_id": r["filing_id"],
                    "reason": r["reason"], "payload": r["payload"],
                }
                for r in rows[:limit]
            ]

        raise AssertionError(f"FakeTimescale.run_fetch: unrecognised query: {q}")

    @staticmethod
    def _fact_proj(r: dict[str, Any]) -> dict[str, Any]:
        """The columns the resolver's SELECTs project."""
        return {
            "metric": r["metric"],
            "observation_ts": r["observation_ts"],
            "knowledge_ts": r["knowledge_ts"],
            "dim_signature": r["dim_signature"],
            "value": r["value"],
            "source": r["source"],
        }

    def _instrument(self, instrument_id: int) -> Optional[dict[str, Any]]:
        return next((i for i in self.instruments if i["instrument_id"] == instrument_id), None)


class FakeRedis:
    """A trivial in-memory async Redis double: get / set(ex=) over a dict, plus a hit counter so a test
    can assert the read-through cache short-circuited Postgres."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.get_calls = 0
        self.set_calls = 0

    async def get(self, key: str) -> Optional[str]:
        self.get_calls += 1
        return self.store.get(key)

    async def set(self, key: str, value: str, ex: Optional[int] = None) -> None:
        self.set_calls += 1
        self.store[key] = value


class FakeMarketDataReader:
    """An in-memory stand-in for `src.market_cap.MarketDataReader` — the Gap-2 enrichment edge — so the
    resolver's market-cap/dividend wiring is tested with NO HTTP and NO Redis. Seed the as-of adjusted
    close per (ticker, asOf), the FX→GBP multiplier per currency, and the dividend yield per ticker; the
    resolver calls exactly these three methods.

    The async signatures match the real reader so it is a faithful injection. A ticker/asOf with no
    seeded close → None (the real reader's 'no bar at/<= as_of'); a currency with no seeded rate → None
    (the real reader's 'no FX basis'); a ticker with no seeded yield is simply absent from the batch."""

    def __init__(self) -> None:
        self.closes: dict[tuple[str, Optional[int]], Optional[float]] = {}
        self.fx: dict[Optional[str], Optional[float]] = {"GBP": 1.0}
        self.dividend_yields: dict[str, float] = {}
        # Call recorders so a test can assert the coalesced upstream reads (one batch dividend-yield, one
        # batch close, FX once per distinct currency) — and that an unresolved name is excluded from them.
        self.close_calls: list[tuple[str, Optional[int]]] = []
        self.batch_close_calls: list[tuple[tuple[str, ...], Optional[int]]] = []
        self.dividend_calls: list[tuple[tuple[str, ...], Optional[int]]] = []
        self.fx_calls: list[Optional[str]] = []

    def set_close(self, ticker: str, as_of_ms: Optional[int], close: Optional[float]) -> None:
        self.closes[(ticker, as_of_ms)] = close

    def set_fx(self, currency: Optional[str], rate: Optional[float]) -> None:
        self.fx[currency] = rate

    def set_dividend_yield(self, ticker: str, yield_: float) -> None:
        self.dividend_yields[ticker] = yield_

    async def adjusted_close_as_of(self, ticker: str, as_of_ms: Optional[int]) -> Optional[float]:
        self.close_calls.append((ticker, as_of_ms))
        return self.closes.get((ticker, as_of_ms))

    async def adjusted_closes_as_of(
        self, tickers: list[str], as_of_ms: Optional[int]
    ) -> dict[str, float]:
        # The batch read the resolver uses on the hot path — back it with the same seeded closes, and
        # record the call (tickers + asOf) so a test can assert the ONE coalesced round-trip.
        self.batch_close_calls.append((tuple(tickers), as_of_ms))
        out: dict[str, float] = {}
        for t in tickers:
            c = self.closes.get((t, as_of_ms))
            if c is not None:
                out[t] = c
        return out

    async def fx_to_gbp(self, currency: Optional[str]) -> Optional[float]:
        self.fx_calls.append(currency)
        return self.fx.get(currency)

    async def dividend_yields_as_of(
        self, tickers: list[str], as_of_ms: Optional[int]
    ) -> dict[str, float]:
        self.dividend_calls.append((tuple(tickers), as_of_ms))
        return {t: self.dividend_yields[t] for t in tickers if t in self.dividend_yields}

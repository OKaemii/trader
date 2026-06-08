"""In-memory fakes for the security-master tests — an asyncpg-pool stand-in and an httpx transport
factory — so the writers/resolver/clients are exercised with NO live Postgres and NO network.

WHY a hand-rolled fake DB rather than a real Postgres in the gate: the python gate
(`backtest-engine-test.Dockerfile`) is a pure pytest image with no database, and the resolution RULE
already lives in the pure `intervals.resolve_interval` (tested directly). What remains to verify at
the DB seam is (a) the writers issue the right append-only statements and stay idempotent, and (b) the
resolver feeds the fetched candidate rows into the pure rule. A faithful in-memory table store covers
both deterministically. The store reproduces exactly the SQL the modules issue (matched by a small
set of recognised query shapes) — it is a TEST DOUBLE, not a SQL engine, and intentionally only
understands the statements this module's code emits.
"""
from __future__ import annotations

import re
from typing import Any, Optional


class _Txn:
    """async context manager mimicking `conn.transaction()` — the fake store is single-threaded and
    auto-commits, so the transaction is a no-op scope (rollback semantics aren't needed: the tests
    drive one coroutine at a time)."""

    async def __aenter__(self) -> "_Txn":
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False


class FakeConnection:
    """Implements the asyncpg connection surface the security-master code uses: fetch / fetchrow /
    fetchval / execute / transaction. Backed by the parent FakeTimescale's in-memory tables."""

    def __init__(self, db: "FakeTimescale") -> None:
        self._db = db

    def transaction(self) -> _Txn:
        return _Txn()

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        return self._db.run_fetch(query, args)

    async def fetchrow(self, query: str, *args: Any) -> Optional[dict[str, Any]]:
        rows = self._db.run_fetch(query, args)
        return rows[0] if rows else None

    async def fetchval(self, query: str, *args: Any) -> Any:
        return self._db.run_fetchval(query, args)

    async def execute(self, query: str, *args: Any) -> str:
        self._db.run_execute(query, args)
        return "OK"


class _Acquire:
    """async context manager returned by `pool.acquire()`."""

    def __init__(self, conn: FakeConnection) -> None:
        self._conn = conn

    async def __aenter__(self) -> FakeConnection:
        return self._conn

    async def __aexit__(self, *exc: Any) -> bool:
        return False


class FakeTimescale:
    """A tiny in-memory stand-in for the `security_master.*` tables + the asyncpg pool API.

    Holds three lists of dict-rows (companies/instruments/identifiers/filings) and answers exactly the
    queries the writers and resolver issue. BIGSERIAL ids are assigned from per-table counters.
    """

    def __init__(self) -> None:
        self.companies: list[dict[str, Any]] = []
        self.instruments: list[dict[str, Any]] = []
        self.identifiers: list[dict[str, Any]] = []
        self.filings: list[dict[str, Any]] = []
        # Raw zone (epic Task 5). No BIGSERIAL — the PK is the full natural fact tuple, so re-ingest
        # of an identical fact is an ON CONFLICT DO NOTHING no-op (modelled below).
        self.raw_facts: list[dict[str, Any]] = []
        self._seq = {"company": 0, "instrument": 0, "identifier": 0, "filing": 0}

    # The columns of the raw-facts PK, in the deployed 0009_fundamentals.sql order. Two raw facts
    # collide (ON CONFLICT) iff they agree on every one of these.
    _RAW_PK = (
        "filing_id", "raw_tag", "context_id", "period_type", "period_end",
        "knowledge_ts", "dim_signature",
    )

    # ── pool API ──────────────────────────────────────────────────────────────
    def acquire(self) -> _Acquire:
        return _Acquire(FakeConnection(self))

    def _next(self, table: str) -> int:
        self._seq[table] += 1
        return self._seq[table]

    @staticmethod
    def _norm(q: str) -> str:
        return re.sub(r"\s+", " ", q).strip().lower()

    # ── fetchval (single scalar: SELECT id / INSERT … RETURNING id) ────────────
    def run_fetchval(self, query: str, args: tuple) -> Any:
        q = self._norm(query)

        # companies: find by cik / find by name / insert.
        if "select company_id from security_master.companies where cik=$1" in q:
            return next((c["company_id"] for c in self.companies if c["cik"] == args[0]), None)
        if "select company_id from security_master.companies where cik is null and name=$1" in q:
            return next(
                (c["company_id"] for c in self.companies if c["cik"] is None and c["name"] == args[0]),
                None,
            )
        if q.startswith("insert into security_master.companies"):
            cid = self._next("company")
            name, country, sector, industry, cik, lei = args
            self.companies.append({
                "company_id": cid, "name": name, "country": country, "sector": sector,
                "industry": industry, "cik": cik, "lei": lei,
            })
            return cid

        # instruments: find by (company,t212) / find by (company,type,exchange,null) / insert.
        if "select instrument_id from security_master.instruments where company_id=$1 and t212_ticker=$2" in q:
            return next(
                (i["instrument_id"] for i in self.instruments
                 if i["company_id"] == args[0] and i["t212_ticker"] == args[1]),
                None,
            )
        if "and exchange is not distinct from $3 and t212_ticker is null" in q:
            return next(
                (i["instrument_id"] for i in self.instruments
                 if i["company_id"] == args[0] and i["instrument_type"] == args[1]
                 and i["exchange"] == args[2] and i["t212_ticker"] is None),
                None,
            )
        if q.startswith("insert into security_master.instruments"):
            iid = self._next("instrument")
            company_id, instrument_type, exchange, currency, t212 = args
            self.instruments.append({
                "instrument_id": iid, "company_id": company_id, "instrument_type": instrument_type,
                "exchange": exchange, "currency": currency, "t212_ticker": t212,
            })
            return iid

        # identifiers: find exact interval / insert.
        if "select identifier_id from security_master.identifiers" in q and "effective_from=$4" in q:
            inst, itype, ival, efrom = args
            return next(
                (r["identifier_id"] for r in self.identifiers
                 if r["instrument_id"] == inst and r["identifier_type"] == itype
                 and r["identifier_value"] == ival and r["effective_from"] == efrom),
                None,
            )
        if q.startswith("insert into security_master.identifiers"):
            rid = self._next("identifier")
            inst, itype, ival, efrom, eto = args
            self.identifiers.append({
                "identifier_id": rid, "instrument_id": inst, "identifier_type": itype,
                "identifier_value": ival, "effective_from": efrom, "effective_to": eto,
            })
            return rid

        # filings: ON CONFLICT DO NOTHING insert / SELECT existing.
        if q.startswith("insert into security_master.filings"):
            inst, accn, form, filed, accepted, url, source, is_amd = args
            if any(f["source"] == source and f["accession_number"] == accn for f in self.filings):
                return None  # conflict → DO NOTHING returns no row
            fid = self._next("filing")
            self.filings.append({
                "filing_id": fid, "instrument_id": inst, "accession_number": accn, "form_type": form,
                "filed_ts": filed, "accepted_ts": accepted, "filing_url": url, "source": source,
                "is_amendment": is_amd,
            })
            return fid
        if "select filing_id from security_master.filings where source=$1 and accession_number=$2" in q:
            return next(
                (f["filing_id"] for f in self.filings
                 if f["source"] == args[0] and f["accession_number"] == args[1]),
                None,
            )

        # raw zone: append-only INSERT … ON CONFLICT (full PK) DO NOTHING RETURNING 1. The writer
        # binds the 13 columns in declaration order; map them, then honour the PK conflict no-op.
        if q.startswith("insert into fundamentals_raw_facts"):
            cols = (
                "filing_id", "raw_tag", "taxonomy", "context_id", "period_type", "period_start",
                "period_end", "knowledge_ts", "value", "unit", "currency", "dim_signature",
                "content_hash",
            )
            row = dict(zip(cols, args))
            if any(all(r[k] == row[k] for k in self._RAW_PK) for r in self.raw_facts):
                return None  # ON CONFLICT DO NOTHING → no row returned (an existing fact)
            self.raw_facts.append(row)
            return 1  # RETURNING 1 → a fresh insert

        raise AssertionError(f"FakeTimescale.run_fetchval: unrecognised query: {q}")

    # ── fetch (row sets: candidate intervals; resolve_instrument row) ──────────
    def run_fetch(self, query: str, args: tuple) -> list[dict[str, Any]]:
        q = self._norm(query)

        # Resolver candidate-intervals query: every interval of identifier_type=$1 on any instrument
        # that ever carried identifier_value=$2, joined to instruments + companies.
        if "from security_master.identifiers i" in q and "join security_master.instruments inst" in q \
                and "where i.identifier_type = $1" in q:
            itype, ival = args[0], args[1]
            target_instruments = {
                r["instrument_id"] for r in self.identifiers
                if r["identifier_type"] == itype and r["identifier_value"] == ival
            }
            out = []
            for r in self.identifiers:
                if r["identifier_type"] != itype or r["instrument_id"] not in target_instruments:
                    continue
                inst = self._instrument(r["instrument_id"])
                comp = self._company(inst["company_id"]) if inst else None
                out.append({
                    "instrument_id": r["instrument_id"],
                    "identifier_type": r["identifier_type"],
                    "identifier_value": r["identifier_value"],
                    "effective_from": r["effective_from"],
                    "effective_to": r["effective_to"],
                    "company_id": inst["company_id"] if inst else None,
                    "t212_ticker": inst["t212_ticker"] if inst else None,
                    "cik": comp["cik"] if comp else None,
                })
            return out

        # resolve_instrument direct t212 lookup.
        if "from security_master.instruments inst" in q and "where inst.t212_ticker = $1" in q:
            inst = next((i for i in self.instruments if i["t212_ticker"] == args[0]), None)
            if inst is None:
                return []
            comp = self._company(inst["company_id"])
            return [{
                "instrument_id": inst["instrument_id"], "company_id": inst["company_id"],
                "t212_ticker": inst["t212_ticker"], "cik": comp["cik"] if comp else None,
            }]

        raise AssertionError(f"FakeTimescale.run_fetch: unrecognised query: {q}")

    def run_execute(self, query: str, args: tuple) -> None:
        # The append-only writers issue NO UPDATE/DELETE; reaching execute() with one is a test
        # failure that would mean the code violated the append-only contract.
        q = self._norm(query)
        if q.startswith("update") or q.startswith("delete"):
            raise AssertionError(f"append-only violation: writer issued {q.split()[0].upper()}")
        raise AssertionError(f"FakeTimescale.run_execute: unrecognised query: {q}")

    def _instrument(self, instrument_id: int) -> Optional[dict[str, Any]]:
        return next((i for i in self.instruments if i["instrument_id"] == instrument_id), None)

    def _company(self, company_id: int) -> Optional[dict[str, Any]]:
        return next((c for c in self.companies if c["company_id"] == company_id), None)


def httpx_transport(handler):
    """Build an httpx MockTransport from a `handler(request) -> httpx.Response`. Imported lazily so
    a test that doesn't touch the network path doesn't require httpx at collection time."""
    import httpx

    return httpx.MockTransport(handler)

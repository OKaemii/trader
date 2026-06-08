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
        # Canonical zone (epic Task 7). `fundamentals` is bi-temporal (supersede-in-txn); the revisions
        # log + quarantine are append-only ledgers. Modelled below: the supersede flips is_superseded on
        # the current row, the insert honours the full PK ON CONFLICT, quarantine assigns a BIGSERIAL.
        self.fundamentals: list[dict[str, Any]] = []
        self.fundamentals_revisions_log: list[dict[str, Any]] = []
        self.fundamentals_quarantine: list[dict[str, Any]] = []
        self._seq = {"company": 0, "instrument": 0, "identifier": 0, "filing": 0, "quarantine": 0}

    # The columns of the raw-facts PK, in the deployed 0009_fundamentals.sql order. Two raw facts
    # collide (ON CONFLICT) iff they agree on every one of these.
    _RAW_PK = (
        "filing_id", "raw_tag", "context_id", "period_type", "period_end",
        "knowledge_ts", "dim_signature",
    )

    # The canonical `fundamentals` LOGICAL-FACT key (the partial-unique current-row scope) and the full
    # PK (which adds knowledge_ts). The supersede targets the logical key + is_superseded=FALSE; the
    # insert's ON CONFLICT is on the full PK.
    _FUND_LOGICAL_KEY = ("instrument_id", "metric", "observation_ts", "dim_signature")
    _FUND_PK = ("instrument_id", "metric", "observation_ts", "dim_signature", "knowledge_ts")

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

        # canonical INSERT … ON CONFLICT (full PK) DO NOTHING RETURNING 1. 15 binds in declaration
        # order; is_superseded is the literal FALSE in the statement (not bound).
        if q.startswith("insert into fundamentals ("):
            cols = (
                "instrument_id", "metric", "observation_ts", "knowledge_ts", "fiscal_year",
                "fiscal_period", "period_type", "dim_signature", "value", "unit", "currency",
                "source", "accession_number", "raw_tag", "content_hash",
            )
            row = dict(zip(cols, args))
            row["is_superseded"] = False
            if any(all(r[k] == row[k] for k in self._FUND_PK) for r in self.fundamentals):
                return None  # ON CONFLICT DO NOTHING → no row (same logical key + same knowledge_ts)
            self.fundamentals.append(row)
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

        # canonical zone (Task 7) hash-compare gate read (via fetchrow): the current
        # (is_superseded=FALSE) row's content_hash + knowledge_ts for a logical fact, or [] when there
        # is no current row. Returns the columns the writer's _SELECT_LATEST projects.
        if "select content_hash, knowledge_ts from fundamentals" in q and "is_superseded = false" in q:
            inst, metric, obs, dim = args
            return [
                {"content_hash": r["content_hash"], "knowledge_ts": r["knowledge_ts"]}
                for r in self.fundamentals
                if r["instrument_id"] == inst and r["metric"] == metric
                and r["observation_ts"] == obs and r["dim_signature"] == dim
                and not r["is_superseded"]
            ]

        # QA engine (Task 8) outlier baseline: the latest CURRENT consolidated value per metric at an
        # observation STRICTLY EARLIER than $3, for instrument $1, over the metric set $2. DISTINCT ON
        # (metric) ORDER BY observation_ts DESC → one row per metric, the most recent prior. Reproduce
        # the SELECT in qa/engine._SELECT_PRIOR_VALUE.
        if "select distinct on (metric) metric, value" in q and "observation_ts < $3" in q:
            inst, metrics, before = args
            metric_set = set(metrics)
            by_metric: dict[str, dict[str, Any]] = {}
            for r in self.fundamentals:
                if (r["instrument_id"] != inst or r["metric"] not in metric_set
                        or r["dim_signature"] != "" or r["is_superseded"]
                        or r["value"] is None or r["observation_ts"] >= before):
                    continue
                cur = by_metric.get(r["metric"])
                if cur is None or r["observation_ts"] > cur["observation_ts"]:
                    by_metric[r["metric"]] = r
            return [{"metric": m, "value": r["value"]} for m, r in by_metric.items()]

        # QA report (Task 8) — by-reason counts over the optional occurred_at window ($1). Reproduce
        # qa/report._COUNT_BY_REASON.
        if "from fundamentals_quarantine" in q and "group by reason" in q:
            since = args[0]
            counts: dict[str, int] = {}
            for r in self.fundamentals_quarantine:
                if not self._after(r, since):
                    continue
                counts[r["reason"]] = counts.get(r["reason"], 0) + 1
            return [{"reason": reason, "n": n} for reason, n in
                    sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]

        # QA report — by-sector counts (LEFT JOIN quarantine → instruments → companies on instrument_id,
        # group by company sector; NULL sector groups under None). Reproduce qa/report._COUNT_BY_SECTOR.
        if "from fundamentals_quarantine q" in q and "group by c.sector" in q:
            since = args[0]
            counts: dict[Any, int] = {}
            for r in self.fundamentals_quarantine:
                if not self._after(r, since):
                    continue
                inst = self._instrument(r["instrument_id"]) if r["instrument_id"] is not None else None
                comp = self._company(inst["company_id"]) if inst else None
                sector = comp["sector"] if comp else None
                counts[sector] = counts.get(sector, 0) + 1
            return [{"sector": sector, "n": n} for sector, n in
                    sorted(counts.items(), key=lambda kv: -kv[1])]

        # QA report — recent sample (newest first, bounded by $2). Reproduce qa/report._RECENT_SAMPLE.
        if "from fundamentals_quarantine" in q and "order by occurred_at desc" in q:
            since, limit = args
            rows = [r for r in self.fundamentals_quarantine if self._after(r, since)]
            rows.sort(key=lambda r: (r.get("occurred_at") or 0, r["event_id"]), reverse=True)
            return [
                {
                    "event_id": r["event_id"],
                    "occurred_at": r.get("occurred_at"),
                    "instrument_id": r["instrument_id"],
                    "filing_id": r["filing_id"],
                    "reason": r["reason"],
                    "payload": r["payload"],
                }
                for r in rows[:limit]
            ]

        raise AssertionError(f"FakeTimescale.run_fetch: unrecognised query: {q}")

    @staticmethod
    def _after(row: dict[str, Any], since: Any) -> bool:
        """Window predicate for the QA-report queries: `since` None ⇒ all rows; otherwise compare the
        row's `occurred_at` (which the fake leaves unset unless a test sets it). A row with no
        `occurred_at` is treated as 'now' (always inside a bounded window) — the unit tests assert on
        counts with `since=None`, so this only matters if a test exercises the windowed path."""
        if since is None:
            return True
        occurred = row.get("occurred_at")
        if occurred is None:
            return True
        return occurred >= since

    def run_execute(self, query: str, args: tuple) -> None:
        q = self._norm(query)

        # canonical supersede (Task 7): the ONLY mutation the fundamentals_writer role is granted —
        # UPDATE(is_superseded) flipping the current row(s) of one logical fact to TRUE. Scoped to
        # is_superseded=FALSE so it touches only the current row (the partial-unique invariant).
        if q.startswith("update fundamentals set is_superseded = true"):
            inst, metric, obs, dim = args
            for r in self.fundamentals:
                if (r["instrument_id"] == inst and r["metric"] == metric
                        and r["observation_ts"] == obs and r["dim_signature"] == dim
                        and not r["is_superseded"]):
                    r["is_superseded"] = True
            return

        # revisions-log append (one row per supersede/first-print). ON CONFLICT (full PK) DO NOTHING.
        if q.startswith("insert into fundamentals_revisions_log"):
            cols = (
                "instrument_id", "metric", "observation_ts", "dim_signature", "knowledge_ts",
                "prior_hash", "new_hash", "accession_number",
            )
            row = dict(zip(cols, args))
            if any(all(r[k] == row[k] for k in self._FUND_PK) for r in self.fundamentals_revisions_log):
                return  # ON CONFLICT DO NOTHING
            self.fundamentals_revisions_log.append(row)
            return

        # quarantine append (value-agreement conflicts handed off to Task 8's review queue). BIGSERIAL
        # event_id; payload arrives as a JSON string ($4::jsonb) — decode it so tests can assert shape.
        if q.startswith("insert into fundamentals_quarantine"):
            instrument_id, filing_id, reason, payload = args
            self.fundamentals_quarantine.append({
                "event_id": self._next("quarantine"),
                "instrument_id": instrument_id, "filing_id": filing_id, "reason": reason,
                "payload": payload,
            })
            return

        # Any OTHER UPDATE/DELETE is an append-only violation (the security-master writers issue none).
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

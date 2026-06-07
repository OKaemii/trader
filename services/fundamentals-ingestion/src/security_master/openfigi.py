"""OpenFIGI mapping client — ticker → FIGI (the second freely-obtainable identifier).

FIGI is the share-class-stable identifier that survives a ticker rename unchanged, so it is the
rename-proof join key the security master records alongside the effective-dated tickers. It comes
free from OpenFIGI's v3 mapping API:

  * `POST https://api.openfigi.com/v3/mapping` with a JSON body that is an ARRAY of jobs, each
    `{"idType": "TICKER", "idValue": "<TICKER>", "exchCode": "<US|...>"}` (verified live). The
    response is a parallel ARRAY: each element is either `{"data": [ {figi, name, ticker, exchCode,
    compositeFIGI, securityType, ...}, … ]}` for a hit or `{"error": "<message>"}` for a miss. We
    take the FIRST `data` record's `figi` (the primary listing) and `compositeFIGI` (the
    cross-exchange composite — the value that is invariant to a ticker rename, which is what we store
    as the durable identifier).
  * Rate limits (published): ~25 requests/minute and ~10 jobs/request UNAUTHENTICATED; ~25
    requests/6 s and 100 jobs/request with an `X-OPENFIGI-APIKEY` header. The optional key comes from
    `OPENFIGI_API_KEY` (a future tfvar secret); absent ⇒ the conservative unauthenticated budget.

Same fail-soft + lazy + rate-limited contract as the EDGAR client: the network client is built only
when called, every request goes through a `RateLimiter`, and any failure degrades to "no FIGI for
this batch" rather than throwing into the ingest loop. **Live calls are exercised by the cron/backfill
card (epic Task 9), NOT here** — this module is unit-tested via the pure `parse_mapping_response`
plus a fake httpx transport.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Optional

from .rate_limiter import RateLimiter

OPENFIGI_MAPPING_URL = "https://api.openfigi.com/v3/mapping"
_API_KEY_HEADER = "X-OPENFIGI-APIKEY"

# Unauthenticated budget: 25 req/min, ≤10 jobs each. Keyed budget is far higher (25 req / 6 s, 100
# jobs each) — selected at construction by whether a key is present.
_UNKEYED_MAX_REQS, _UNKEYED_PER_SECONDS, _UNKEYED_BATCH = 25, 60.0, 10
_KEYED_MAX_REQS, _KEYED_PER_SECONDS, _KEYED_BATCH = 25, 6.0, 100
_DEFAULT_TIMEOUT_S = 15.0


@dataclass(frozen=True)
class FigiMapping:
    """The resolved FIGI for one mapping job. `composite_figi` is the rename-stable value stored as
    the durable `figi` identifier; `figi` is the specific listing. None fields ⇒ OpenFIGI returned an
    error/empty `data` for that job (an uncovered name), which the caller skips rather than fabricates."""

    query_ticker: str
    figi: Optional[str]
    composite_figi: Optional[str]
    name: Optional[str]
    exch_code: Optional[str]
    security_type: Optional[str]


@dataclass(frozen=True)
class _MappingJob:
    """One job sent to the mapping endpoint, paired with the source ticker so the parallel response
    re-associates by index even though the API echoes no query field."""

    query_ticker: str
    id_type: str
    id_value: str
    exch_code: Optional[str]

    def to_body(self) -> dict[str, str]:
        body = {"idType": self.id_type, "idValue": self.id_value}
        if self.exch_code:
            body["exchCode"] = self.exch_code
        return body


def parse_mapping_response(
    response: Any, jobs: list[_MappingJob]
) -> list[FigiMapping]:
    """Zip the parallel mapping response array back onto the jobs that produced it.

    The API returns one element per submitted job in the SAME order, so association is positional.
    An element is `{"data":[…]}` (take the first record) or `{"error":…}`/`{}`/missing (no FIGI →
    all-None mapping). Tolerant of a short/over-long response (truncate to the jobs we sent)."""
    out: list[FigiMapping] = []
    items = response if isinstance(response, list) else []
    for idx, job in enumerate(jobs):
        record: dict[str, Any] = {}
        if idx < len(items) and isinstance(items[idx], dict):
            data = items[idx].get("data")
            if isinstance(data, list) and data and isinstance(data[0], dict):
                record = data[0]
        out.append(
            FigiMapping(
                query_ticker=job.query_ticker,
                figi=(str(record["figi"]) if record.get("figi") else None),
                composite_figi=(str(record["compositeFIGI"]) if record.get("compositeFIGI") else None),
                name=(str(record["name"]) if record.get("name") else None),
                exch_code=(str(record["exchCode"]) if record.get("exchCode") else None),
                security_type=(str(record["securityType"]) if record.get("securityType") else None),
            )
        )
    return out


class OpenFigiClient:
    """Resolves tickers → FIGI in rate-limited batches, fail-soft.

    `api_key` defaults to `OPENFIGI_API_KEY` (absent ⇒ the unauthenticated budget + smaller batch).
    `transport` is injected by the tests (httpx `MockTransport`) so the request/parse path runs with
    no socket."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        limiter: Optional[RateLimiter] = None,
        transport: Any = None,
        timeout: float = _DEFAULT_TIMEOUT_S,
    ) -> None:
        self._api_key = api_key if api_key is not None else os.getenv("OPENFIGI_API_KEY", "")
        keyed = bool(self._api_key)
        self._batch_size = _KEYED_BATCH if keyed else _UNKEYED_BATCH
        self._limiter = limiter or RateLimiter(
            _KEYED_MAX_REQS if keyed else _UNKEYED_MAX_REQS,
            _KEYED_PER_SECONDS if keyed else _UNKEYED_PER_SECONDS,
        )
        self._transport = transport
        self._timeout = timeout

    @property
    def batch_size(self) -> int:
        """Max jobs per request (10 unauthenticated, 100 keyed) — the caller chunks to this."""
        return self._batch_size

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers[_API_KEY_HEADER] = self._api_key
        return headers

    async def _post(self, body: list[dict[str, str]]) -> Optional[Any]:
        """One rate-limited POST returning decoded JSON, or None on any failure (fail-soft)."""
        import httpx

        await self._limiter.acquire()
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=self._timeout, headers=self._headers()
            ) as client:
                resp = await client.post(OPENFIGI_MAPPING_URL, json=body)
            if resp.status_code != 200:
                return None
            return resp.json()
        except Exception:
            return None

    async def map_tickers(
        self, tickers: list[str], *, exch_code: str = "US"
    ) -> list[FigiMapping]:
        """Map a list of tickers → FIGI in batches of `batch_size`, preserving input order.

        `exch_code` is OpenFIGI's exchange code (US common stock is `"US"` for the composite). Names
        that fail to resolve come back as all-None `FigiMapping`s (never fabricated). A failed batch
        contributes all-None mappings for its members so the result length always matches the input —
        the caller filters to mappings whose `composite_figi`/`figi` is non-None before writing."""
        results: list[FigiMapping] = []
        for start in range(0, len(tickers), self._batch_size):
            chunk = tickers[start : start + self._batch_size]
            jobs = [
                _MappingJob(query_ticker=t, id_type="TICKER", id_value=t, exch_code=exch_code)
                for t in chunk
            ]
            response = await self._post([j.to_body() for j in jobs])
            if response is None:
                results.extend(
                    FigiMapping(query_ticker=j.query_ticker, figi=None, composite_figi=None,
                                name=None, exch_code=None, security_type=None)
                    for j in jobs
                )
            else:
                results.extend(parse_mapping_response(response, jobs))
        return results

    async def map_ticker(self, ticker: str, *, exch_code: str = "US") -> Optional[FigiMapping]:
        """Single-ticker convenience over `map_tickers`. Returns None when the name doesn't resolve."""
        mapped = await self.map_tickers([ticker], exch_code=exch_code)
        if not mapped:
            return None
        m = mapped[0]
        return m if (m.figi or m.composite_figi) else None

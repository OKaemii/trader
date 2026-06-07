"""EDGAR submissions client — CIK↔ticker mapping + filing metadata (the freely-obtainable US identity).

Two SEC endpoints, both free and unauthenticated (but a descriptive `User-Agent` is mandatory — SEC
returns 403 without one):

  * `https://www.sec.gov/files/company_tickers.json` — the bulk CIK↔ticker map for every SEC filer.
    Shape (verified against the live file): a JSON object keyed by an arbitrary index string, each
    value `{"cik_str": <int>, "ticker": "<TICKER>", "title": "<COMPANY NAME>"}`. This seeds the
    `companies`/`instruments`/`identifiers` rows and is where a ticker *rename* is first observed
    (the same CIK now carries a different `ticker`).
  * `https://data.sec.gov/submissions/CIK##########.json` — per-CIK detail: top-level `cik`
    (zero-padded string), `name`, `tickers` (array), `exchanges` (array), and `filings.recent`,
    whose parallel arrays `accessionNumber`/`form`/`filingDate`/`acceptanceDateTime`/`primaryDocument`
    carry the filing lineage + the two PIT timestamps (`filingDate` → `filed_ts`, `acceptanceDateTime`
    → `accepted_ts`). The accepted timestamp is the one the bi-temporal fact writer (epic Task 7)
    derives `knowledge_ts` from — an after-hours acceptance is only knowable next session.

NETWORK IS LAZY AND RATE-LIMITED. The HTTP methods construct the `httpx` client only when called and
go through a shared `RateLimiter` honouring SEC's 10 req/s courtesy limit; a failure (network error,
non-200, malformed body) degrades to an EMPTY result and never throws into the ingest loop (the next
CronJob tick resumes) — the same fail-soft contract as `EodhdCreditLimiter`. **Live ingestion is
exercised by the cron/backfill card (epic Task 9), NOT here** — this module is unit-tested against
fixtures via the pure parsers (`parse_company_tickers`, `parse_submissions`) and a fake transport, so
the gate runs with no network.

Parsing is split from fetching on purpose: the parsers are total functions over already-decoded JSON
(tolerant of missing keys), so they test exhaustively against fixtures while the thin fetch wrappers
own only the I/O + rate-limit + fail-soft.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Optional

from .rate_limiter import RateLimiter

SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"

# SEC's published courtesy limit is 10 requests/second per IP. One shared limiter for both endpoints.
_SEC_MAX_REQS = 10
_SEC_PER_SECONDS = 1.0
# httpx read timeout: SEC is usually fast, but submissions for a heavy filer is a large body.
_DEFAULT_TIMEOUT_S = 20.0

# Forms that materially change reported fundamentals — the downloader (Task 5) filters to these;
# exposed here so the parser can flag amendments (`is_amendment`) consistently with the schema.
_AMENDMENT_SUFFIX = "/A"


@dataclass(frozen=True)
class TickerMapEntry:
    """One row of `company_tickers.json`: a CIK with its CURRENT ticker + company title. A rename is
    detected by this same `cik` later carrying a different `ticker`."""

    cik: str  # zero-padded 10-digit (normalised on parse)
    ticker: str
    title: str


@dataclass(frozen=True)
class SubmissionFiling:
    """One filing from `filings.recent` (parallel-array element). `filed_ts`/`accepted_ts` are UTC ms
    or None when SEC omitted/garbled the field; `is_amendment` is true for a `*-K/A`-style form."""

    accession_number: str
    form: str
    filed_ts: Optional[int]
    accepted_ts: Optional[int]
    primary_document: Optional[str]
    is_amendment: bool


@dataclass(frozen=True)
class CompanySubmissions:
    """The parsed shape of a per-CIK submissions document the security-master upsert path consumes."""

    cik: str  # zero-padded 10-digit
    name: str
    tickers: tuple[str, ...]
    exchanges: tuple[str, ...]
    filings: tuple[SubmissionFiling, ...] = field(default_factory=tuple)


def pad_cik(cik_like: Any) -> str:
    """Normalise an int/str CIK to EDGAR's 10-digit zero-padded form. Tolerant of a bare int (the
    `cik_str` field) or an already-padded string."""
    s = str(cik_like).strip().lstrip("0") or "0"
    if not s.isdigit():
        return str(cik_like)
    return s.zfill(10)


def _iso_to_ms(value: Any) -> Optional[int]:
    """Parse an EDGAR timestamp to UTC ms. Handles `acceptanceDateTime` (`2020-05-01T17:32:10.000Z`)
    and a bare `filingDate` (`2020-05-01`, taken as UTC midnight). Returns None on anything
    unparseable so a single bad field never aborts a whole submissions parse."""
    if not value or not isinstance(value, str):
        return None
    from datetime import datetime, timezone

    text = value.strip()
    # Date-only (filingDate): midnight UTC.
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        try:
            dt = datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
        except ValueError:
            return None
    # Datetime (acceptanceDateTime). EDGAR uses a trailing 'Z'; fromisoformat handles it on 3.11+,
    # but normalise to be safe across runtimes.
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


def parse_company_tickers(payload: Any) -> list[TickerMapEntry]:
    """Parse `company_tickers.json` (object keyed by index → {cik_str, ticker, title}) to a list of
    `TickerMapEntry`. Skips malformed rows (missing cik/ticker) rather than raising — a single bad
    row in a 10k-row file must not break the whole map."""
    if not isinstance(payload, dict):
        return []
    out: list[TickerMapEntry] = []
    for row in payload.values():
        if not isinstance(row, dict):
            continue
        cik_str = row.get("cik_str")
        ticker = row.get("ticker")
        if cik_str is None or not ticker:
            continue
        out.append(
            TickerMapEntry(
                cik=pad_cik(cik_str),
                ticker=str(ticker).strip().upper(),
                title=str(row.get("title", "")).strip(),
            )
        )
    return out


def parse_submissions(payload: Any) -> Optional[CompanySubmissions]:
    """Parse a per-CIK submissions document to `CompanySubmissions`. Returns None when the body is
    not the expected object or lacks a CIK. The `filings.recent` block is a set of PARALLEL arrays
    (accessionNumber[i] ↔ form[i] ↔ filingDate[i] ↔ acceptanceDateTime[i]); zip them by index,
    tolerating ragged lengths (truncate to the shortest required array)."""
    if not isinstance(payload, dict):
        return None
    cik_raw = payload.get("cik")
    if cik_raw is None:
        return None

    tickers = tuple(
        str(t).strip().upper() for t in payload.get("tickers", []) if t
    )
    exchanges = tuple(str(e).strip() for e in payload.get("exchanges", []) if e)

    recent = payload.get("filings", {}).get("recent", {}) if isinstance(payload.get("filings"), dict) else {}
    accns = recent.get("accessionNumber", []) if isinstance(recent, dict) else []
    forms = recent.get("form", []) if isinstance(recent, dict) else []
    filed = recent.get("filingDate", []) if isinstance(recent, dict) else []
    accepted = recent.get("acceptanceDateTime", []) if isinstance(recent, dict) else []
    primary = recent.get("primaryDocument", []) if isinstance(recent, dict) else []

    n = min(len(accns), len(forms)) if accns and forms else 0
    filings: list[SubmissionFiling] = []
    for i in range(n):
        form = str(forms[i]).strip()
        filings.append(
            SubmissionFiling(
                accession_number=str(accns[i]).strip(),
                form=form,
                filed_ts=_iso_to_ms(filed[i]) if i < len(filed) else None,
                accepted_ts=_iso_to_ms(accepted[i]) if i < len(accepted) else None,
                primary_document=(str(primary[i]).strip() if i < len(primary) and primary[i] else None),
                is_amendment=form.endswith(_AMENDMENT_SUFFIX),
            )
        )

    return CompanySubmissions(
        cik=pad_cik(cik_raw),
        name=str(payload.get("name", "")).strip(),
        tickers=tickers,
        exchanges=exchanges,
        filings=tuple(filings),
    )


class EdgarSubmissionsClient:
    """Fetches the SEC ticker map + per-CIK submissions, rate-limited and fail-soft.

    `transport` is an optional httpx transport injected by the tests (a `MockTransport`) so the I/O
    path is exercised without a socket. `user_agent` defaults to `EDGAR_USER_AGENT` (the non-secret
    env var wired in Task 3); SEC fails closed without a descriptive UA, so an empty UA is treated as
    "do not call" — the client degrades to empty rather than sending a bannable anonymous request."""

    def __init__(
        self,
        *,
        user_agent: Optional[str] = None,
        limiter: Optional[RateLimiter] = None,
        transport: Any = None,
        timeout: float = _DEFAULT_TIMEOUT_S,
    ) -> None:
        self._user_agent = user_agent if user_agent is not None else os.getenv("EDGAR_USER_AGENT", "")
        self._limiter = limiter or RateLimiter(_SEC_MAX_REQS, _SEC_PER_SECONDS)
        self._transport = transport
        self._timeout = timeout

    def _headers(self) -> dict[str, str]:
        # SEC asks for a descriptive UA identifying the requester + contact; Accept-Encoding gzip
        # because submissions bodies are large. Host is implied by httpx.
        return {"User-Agent": self._user_agent, "Accept-Encoding": "gzip, deflate"}

    async def _get_json(self, url: str) -> Optional[Any]:
        """One rate-limited GET returning decoded JSON, or None on any failure (fail-soft)."""
        if not self._user_agent:
            # No descriptive UA ⇒ SEC will 403; refuse to send an anonymous request that risks an
            # IP block. The cron card (Task 9) sets a real EDGAR_USER_AGENT before live ingest.
            return None
        import httpx

        await self._limiter.acquire()
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=self._timeout, headers=self._headers()
            ) as client:
                resp = await client.get(url)
            if resp.status_code != 200:
                return None
            return resp.json()
        except Exception:
            # Network error / decode error: degrade to empty, mirror EodhdCreditLimiter's never-throw.
            return None

    async def fetch_company_tickers(self) -> list[TickerMapEntry]:
        """The bulk CIK↔ticker map. Empty list on any failure."""
        payload = await self._get_json(SEC_COMPANY_TICKERS_URL)
        return parse_company_tickers(payload) if payload is not None else []

    async def fetch_submissions(self, cik: Any) -> Optional[CompanySubmissions]:
        """Per-CIK submissions (name, tickers, exchanges, filings). None on any failure."""
        url = SEC_SUBMISSIONS_URL.format(cik=pad_cik(cik))
        payload = await self._get_json(url)
        return parse_submissions(payload) if payload is not None else None

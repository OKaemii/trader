"""EDGAR fact downloader — companyfacts / companyconcept fetch + bulk-ZIP seed (epic Task 5).

This is the US fact-fetch half of the ingestion chain: it pulls every reported XBRL fact (us-gaap:*
+ dei:*) for a CIK, parses it into a flat list of `RawFact`s, and hands them to `raw_store` for the
append-only raw zone. The CIK↔ticker map + filing metadata (the lineage the facts join to) is the
*other* half — already built in Task 4's `security_master.EdgarSubmissionsClient` / `SecurityMasterWriter`,
which this module REUSES rather than re-implements (no second submissions client).

TWO INGEST SHAPES, one fact contract:
  * INCREMENTAL — the per-CIK REST API. Two endpoints, both free + unauthenticated (a descriptive
    `User-Agent` is mandatory — SEC 403s without one):
      - companyfacts:   https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json
        every fact the entity has ever reported, nested facts→taxonomy→tag→units→[fact].
      - companyconcept: https://data.sec.gov/api/xbrl/companyconcept/CIK##########/{taxonomy}/{tag}.json
        one tag's full history — the cheap targeted refresh when only a few metrics changed.
  * BULK SEED — the nightly full-corpus ZIPs (one HTTP GET each, then local iteration):
      - companyfacts.zip:  https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip
        one CIK##########.json member per filer (the companyfacts payload).
      - submissions.zip:   https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip
        one CIK##########.json member per filer (the submissions payload — same shape Task 4 parses).

URL PROVENANCE. The plan flagged the bulk-ZIP URLs as "verify before hardcoding" (research §"Bulk-ZIP
URLs need verification"). Verified 2026-06-08 against the maintained `dgunning/edgartools` library
(`edgar/urls.py` + `edgar/config.py` + `edgar/storage/_local.py`): `SEC_ARCHIVE_URL` =
`https://www.sec.gov/Archives/edgar`; companyfacts.zip at `…/daily-index/xbrl/companyfacts.zip`,
submissions.zip at `…/daily-index/bulkdata/submissions.zip`; the per-CIK companyfacts API at
`{SEC_DATA_URL}/api/xbrl/companyfacts/CIK{cik:010d}.json` with `SEC_DATA_URL` = `https://data.sec.gov`.
The companyconcept endpoint follows the same documented SEC `/api/xbrl/companyconcept/CIK…/{tax}/{tag}.json`
shape. Overridable via env (`SEC_BASE_URL` / `SEC_DATA_URL`) for a mirror, mirroring edgartools.

FAIL-SOFT + RATE-LIMITED, identical contract to `EdgarSubmissionsClient`: the HTTP client is built
only when called, every request goes through a shared `EdgarRateLimiter` honouring SEC's 10 req/s
courtesy limit, and any failure (network error, non-200, malformed body, EMPTY `EDGAR_USER_AGENT`)
degrades to an EMPTY result and never throws into the ingest loop — the next CronJob tick resumes.
Mirrors `EodhdCreditLimiter`'s never-throw / degrade-to-empty discipline (rate-limit back-pressure is
absorbed by the limiter; it sleeps, it does not raise).

LIVE INGESTION IS THE CRON CARD'S JOB (epic Task 9), NOT HERE. This module is unit-tested against
recorded JSON fixtures via the pure parsers (`parse_company_facts`, `parse_company_concept`) and a fake
httpx transport, so the gate runs with no network. A one-shot AAPL+MSFT fetch is fine to demonstrate
live behaviour, but the gate must stay fixture-based + deterministic.

Parsing is split from fetching on purpose (same as Task 4): the parsers are total functions over
already-decoded JSON (tolerant of missing keys), so they test exhaustively against fixtures while the
thin fetch wrappers own only the I/O + rate-limit + fail-soft.
"""
from __future__ import annotations

import io
import os
import zipfile
from dataclasses import dataclass
from typing import Any, Iterator, Optional

from src.security_master.edgar_submissions import pad_cik
from src.security_master.rate_limiter import RateLimiter

# ── SEC endpoints (verified — see module docstring) ───────────────────────────
# Hosts are env-overridable for a mirror; the defaults are the live SEC hosts.
SEC_BASE_URL = os.getenv("SEC_BASE_URL", "https://www.sec.gov").rstrip("/")
SEC_DATA_URL = os.getenv("SEC_DATA_URL", "https://data.sec.gov").rstrip("/")
SEC_ARCHIVE_URL = f"{SEC_BASE_URL}/Archives/edgar"

COMPANY_FACTS_URL = SEC_DATA_URL + "/api/xbrl/companyfacts/CIK{cik}.json"
COMPANY_CONCEPT_URL = SEC_DATA_URL + "/api/xbrl/companyconcept/CIK{cik}/{taxonomy}/{tag}.json"
COMPANY_FACTS_ZIP_URL = SEC_ARCHIVE_URL + "/daily-index/xbrl/companyfacts.zip"
SUBMISSIONS_ZIP_URL = SEC_ARCHIVE_URL + "/daily-index/bulkdata/submissions.zip"

# SEC's published courtesy limit is 10 requests/second per IP. One shared limiter for every endpoint
# (companyfacts + companyconcept + the ZIP GETs), constructed from EDGAR_REQS_PER_SEC when set.
_SEC_MAX_REQS = 10
_SEC_PER_SECONDS = 1.0
# httpx read timeout: a companyfacts body for a heavy filer is large; the ZIPs are streamed to a temp
# buffer, so allow a generous window.
_DEFAULT_TIMEOUT_S = 60.0

# The financial-reporting taxonomies preserved verbatim in the raw zone. Other taxonomies in a
# companyfacts payload (e.g. srt:*, invest:*) are not part of the fundamentals contract and are
# skipped — full preservation is scoped to the financial reporting set.
#   * us-gaap / dei — every domestic (10-K/10-Q) filer's facts + the DEI cover-page entity facts.
#   * ifrs-full — a foreign private issuer filing a 20-F/40-F under IFRS tags its income/balance-sheet
#     facts in the IFRS taxonomy (e.g. `ifrs-full:ProfitLoss`, not `us-gaap:NetIncomeLoss`), so without
#     this taxonomy those facts are dropped at parse and an IFRS filer (e.g. TSM) staged null for
#     net_income/revenue. Preservation here is load-bearing: a registry alias (metric_registry.yaml)
#     can only SELECT a tag the raw zone kept — it cannot recover a fact dropped at parse time. The
#     parser is taxonomy-agnostic (`_facts_from_units` keys nothing on the taxonomy name), so adding
#     the name preserves ifrs-full facts byte-for-byte alongside us-gaap/dei; the resolver's value-
#     agreement guard and fail-closed selection are unchanged (a name tagging neither yields no fact).
PRESERVED_TAXONOMIES = ("us-gaap", "dei", "ifrs-full")


def edgar_rate_limiter(reqs_per_sec: Optional[int] = None) -> RateLimiter:
    """The shared EDGAR limiter — a 10 req/s sliding window (SEC's courtesy limit).

    Named per the plan's `EdgarRateLimiter` but built from Task 4's `RateLimiter` (the
    `EodhdCreditLimiter` mirror) rather than a second limiter class: SEC has no per-day cap, only the
    per-second rate, which `RateLimiter(max_calls, per_seconds)` already models exactly. `reqs_per_sec`
    falls back to `EDGAR_REQS_PER_SEC` then the 10/s default; values <1 clamp to 1 (a limiter must
    admit at least one call)."""
    if reqs_per_sec is None:
        raw = os.getenv("EDGAR_REQS_PER_SEC", "")
        try:
            reqs_per_sec = int(raw) if raw else _SEC_MAX_REQS
        except ValueError:
            reqs_per_sec = _SEC_MAX_REQS
    return RateLimiter(max(int(reqs_per_sec), 1), _SEC_PER_SECONDS)


@dataclass(frozen=True)
class RawFact:
    """One parsed XBRL fact, flattened from the nested companyfacts/companyconcept JSON.

    This is the writer's input row (raw_store maps it onto `fundamentals_raw_facts` columns). It carries
    the full XBRL fact identity the raw zone must preserve:

      * `taxonomy`/`tag` → the `raw_tag` is `"{taxonomy}:{tag}"` (e.g. `us-gaap:NetIncomeLoss`); both
        kept so the writer/registry can split them without re-parsing.
      * `period_type` — 'instant' (a balance-sheet point: only `end`) vs 'duration' (a flow over
        `start`→`end`). Derived from whether SEC gave a `start`. In the PK, so an instant and a
        duration fact sharing an `end` don't collide.
      * `period_start`/`period_end` — UTC ms; `period_end` is the observation (always present for a
        valid fact). `period_start` is None for instants.
      * `value`/`unit`/`currency` — the reported number, its unit key (`USD`, `shares`, `USD/shares`),
        and the parsed ISO currency when the unit names one (`USD`→USD; `shares` has no currency).
      * `accession_number` — provenance back to the source filing (`accn`); the writer resolves it to
        a `filing_id` against `security_master.filings`.
      * `fiscal_year`/`fiscal_period`/`form` — SEC's `fy`/`fp`/`form`, preserved for the normalize step.
      * `context_id` — XBRL context framing. SEC's company-facts JSON does NOT surface a raw XBRL
        contextRef; the dimensional/segment framing collapses into `frame` (only present on the
        consolidated, undimensioned facts SEC chose to "frame"). We carry `frame` here so the writer
        can set `context_id`/`dim_signature` deterministically — see `dim_signature` below.
      * `dim_signature` — '' for consolidated/undimensioned (the only kind companyfacts exposes; SEC's
        company-facts feed already drops segment members). Kept on the row so a richer source (raw
        instance docs, Task 6+) can populate it without a schema change.
    """

    taxonomy: str
    tag: str
    period_type: str            # 'instant' | 'duration'
    period_start: Optional[int]  # UTC ms; None for instants
    period_end: int             # UTC ms
    value: Optional[float]
    unit: str
    currency: Optional[str]
    accession_number: Optional[str]
    fiscal_year: Optional[int]
    fiscal_period: Optional[str]
    form: Optional[str]
    frame: Optional[str] = None
    context_id: str = ""
    dim_signature: str = ""

    @property
    def raw_tag(self) -> str:
        """The fully-qualified tag the raw zone stores (`us-gaap:NetIncomeLoss`)."""
        return f"{self.taxonomy}:{self.tag}"


# ── unit → currency (the only place a fundamentals fact carries an ISO currency) ──
# XBRL monetary units name the currency directly (`USD`, `GBP`); ratio/share units don't. We tag a
# currency only when the unit is a bare ISO code or a `CUR/shares` per-share unit (currency = numerator).
def _currency_of_unit(unit: str) -> Optional[str]:
    u = unit.strip()
    if not u:
        return None
    # 'USD/shares' (EPS) → currency is the numerator; 'shares', 'pure' → no currency.
    head = u.split("/", 1)[0].upper()
    if len(head) == 3 and head.isalpha():
        return head
    return None


def _ms_from_date(value: Any) -> Optional[int]:
    """Parse an EDGAR fact date (`start`/`end`, an ISO `YYYY-MM-DD`) to UTC-midnight ms. None on
    anything unparseable so one bad fact date never aborts a whole company's parse."""
    if not value or not isinstance(value, str):
        return None
    from datetime import datetime, timezone

    text = value.strip()
    try:
        dt = datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


def _coerce_float(value: Any) -> Optional[float]:
    """A fact `val` to float, or None. SEC sends numbers as JSON numbers, but tolerate a numeric
    string and reject anything else rather than raising."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _facts_from_units(taxonomy: str, tag: str, units: Any) -> list[RawFact]:
    """Flatten one tag's `units` block (`{unit: [factObj, …]}`) into RawFacts. Each factObj carries
    `end` (+ optional `start`), `val`, `accn`, `fy`, `fp`, `form`, optional `frame`. A fact missing a
    parseable `end` is dropped (period_end is the observation + a NOT NULL PK column)."""
    out: list[RawFact] = []
    if not isinstance(units, dict):
        return out
    for unit_key, fact_list in units.items():
        if not isinstance(fact_list, list):
            continue
        unit = str(unit_key)
        currency = _currency_of_unit(unit)
        for fact in fact_list:
            if not isinstance(fact, dict):
                continue
            period_end = _ms_from_date(fact.get("end"))
            if period_end is None:
                continue
            period_start = _ms_from_date(fact.get("start"))
            # 'duration' iff SEC supplied a start (a flow over an interval); else 'instant'.
            period_type = "duration" if period_start is not None else "instant"
            fy = fact.get("fy")
            out.append(
                RawFact(
                    taxonomy=taxonomy,
                    tag=tag,
                    period_type=period_type,
                    period_start=period_start,
                    period_end=period_end,
                    value=_coerce_float(fact.get("val")),
                    unit=unit,
                    currency=currency,
                    accession_number=(str(fact.get("accn")).strip() if fact.get("accn") else None),
                    fiscal_year=(int(fy) if isinstance(fy, (int, float)) else None),
                    fiscal_period=(str(fact.get("fp")).strip() if fact.get("fp") else None),
                    form=(str(fact.get("form")).strip() if fact.get("form") else None),
                    frame=(str(fact.get("frame")).strip() if fact.get("frame") else None),
                    context_id="",       # companyfacts exposes no raw contextRef; '' = undimensioned
                    dim_signature="",     # consolidated only — segment members aren't in this feed
                )
            )
    return out


def parse_company_facts(payload: Any) -> list[RawFact]:
    """Parse a companyfacts document (`{cik, entityName, facts: {taxonomy: {tag: {units}}}}`) into a
    flat list of RawFacts across the preserved taxonomies (us-gaap, dei, ifrs-full — the IFRS taxonomy
    a 20-F/40-F foreign filer reports under).

    Total function over decoded JSON: a non-dict body, a missing `facts` block, or a malformed
    taxonomy/tag yields an empty list / is skipped rather than raising — a single bad tag must not
    drop a whole filer's facts."""
    if not isinstance(payload, dict):
        return []
    facts = payload.get("facts")
    if not isinstance(facts, dict):
        return []
    out: list[RawFact] = []
    for taxonomy in PRESERVED_TAXONOMIES:
        tag_block = facts.get(taxonomy)
        if not isinstance(tag_block, dict):
            continue
        for tag, body in tag_block.items():
            if not isinstance(body, dict):
                continue
            out.extend(_facts_from_units(taxonomy, str(tag), body.get("units")))
    return out


def parse_company_concept(payload: Any) -> list[RawFact]:
    """Parse a companyconcept document (one tag's full history: `{cik, taxonomy, tag, label,
    description, units}`) into RawFacts. The targeted-refresh counterpart to `parse_company_facts`;
    same fact shape, scoped to a single `(taxonomy, tag)`."""
    if not isinstance(payload, dict):
        return []
    taxonomy = payload.get("taxonomy")
    tag = payload.get("tag")
    if not taxonomy or not tag:
        return []
    return _facts_from_units(str(taxonomy), str(tag), payload.get("units"))


def cik_from_zip_member(member_name: str) -> Optional[str]:
    """Extract the zero-padded CIK from a bulk-ZIP member filename (`CIK0000320193.json` → the padded
    CIK). None for a non-CIK member (the ZIPs are flat CIK-named JSON, but guard anyway)."""
    base = member_name.rsplit("/", 1)[-1]
    if not base.upper().startswith("CIK") or not base.lower().endswith(".json"):
        return None
    digits = base[3:-5]
    return pad_cik(digits) if digits.isdigit() else None


def iter_zip_members(zip_bytes: bytes, only_ciks: Optional[set[str]] = None) -> Iterator[tuple[str, Any]]:
    """Iterate `(cik, decoded_json)` for each `CIK##########.json` member of a bulk ZIP held in memory.

    `only_ciks` (zero-padded) scopes the iteration to the coverage set — a backfill of the
    universe+index set reads only those members rather than the full ~15k-filer corpus. A member that
    isn't valid JSON is skipped (logged by the caller), never raised, so one corrupt entry doesn't
    abort the seed. Reading members lazily keeps peak memory to one decoded document at a time."""
    import json

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            cik = cik_from_zip_member(info.filename)
            if cik is None:
                continue
            if only_ciks is not None and cik not in only_ciks:
                continue
            try:
                with zf.open(info) as fh:
                    yield cik, json.loads(fh.read())
            except (json.JSONDecodeError, zipfile.BadZipFile, OSError, ValueError):
                continue


class EdgarFactsClient:
    """Fetches per-CIK companyfacts / companyconcept (and, for a seed, the bulk ZIPs), rate-limited
    and fail-soft — the fact-fetch sibling of Task 4's `EdgarSubmissionsClient`.

    `transport` is an optional httpx transport injected by the tests (a `MockTransport`) so the I/O
    path is exercised without a socket. `user_agent` defaults to `EDGAR_USER_AGENT` (the non-secret env
    wired in Task 3); an empty UA is treated as "do not call" — the client degrades to empty rather than
    sending an anonymous request SEC would 403 / block. `limiter` defaults to the shared 10 req/s
    `EdgarRateLimiter`; pass one shared instance across all clients in a backfill to honour the global
    budget."""

    def __init__(
        self,
        *,
        user_agent: Optional[str] = None,
        limiter: Optional[RateLimiter] = None,
        transport: Any = None,
        timeout: float = _DEFAULT_TIMEOUT_S,
    ) -> None:
        self._user_agent = user_agent if user_agent is not None else os.getenv("EDGAR_USER_AGENT", "")
        self._limiter = limiter or edgar_rate_limiter()
        self._transport = transport
        self._timeout = timeout

    def _headers(self) -> dict[str, str]:
        # SEC asks for a descriptive UA identifying the requester + contact; gzip because facts bodies
        # and the bulk ZIPs are large.
        return {"User-Agent": self._user_agent, "Accept-Encoding": "gzip, deflate"}

    async def _get(self, url: str) -> Optional[Any]:
        """One rate-limited httpx GET returning the raw `httpx.Response`, or None on any failure
        (fail-soft). The JSON vs bytes decode is the caller's (companyfacts decodes JSON; the ZIP seed
        reads `.content`)."""
        if not self._user_agent:
            # No descriptive UA ⇒ SEC will 403; refuse to send an anonymous request that risks an IP
            # block. The cron card (Task 9) sets a real EDGAR_USER_AGENT before live ingest.
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
            return resp
        except Exception:
            # Network/decode error: degrade to empty, mirror EodhdCreditLimiter's never-throw.
            return None

    async def fetch_company_facts(self, cik: Any) -> list[RawFact]:
        """All us-gaap/dei/ifrs-full facts for a CIK from the companyfacts API (ifrs-full covers a 20-F
        IFRS foreign filer). Empty list on any failure."""
        url = COMPANY_FACTS_URL.format(cik=pad_cik(cik))
        resp = await self._get(url)
        if resp is None:
            return []
        try:
            payload = resp.json()
        except Exception:
            return []
        return parse_company_facts(payload)

    async def fetch_company_concept(self, cik: Any, taxonomy: str, tag: str) -> list[RawFact]:
        """One tag's full history for a CIK from the companyconcept API (the targeted refresh). Empty
        list on any failure."""
        url = COMPANY_CONCEPT_URL.format(cik=pad_cik(cik), taxonomy=taxonomy, tag=tag)
        resp = await self._get(url)
        if resp is None:
            return []
        try:
            payload = resp.json()
        except Exception:
            return []
        return parse_company_concept(payload)

    async def fetch_company_facts_zip(self) -> Optional[bytes]:
        """Download the full companyfacts bulk ZIP (one GET). Returns the raw bytes for
        `iter_zip_members`, or None on any failure. Large (~1GB+) — a seed-time call, not the hot path."""
        resp = await self._get(COMPANY_FACTS_ZIP_URL)
        return resp.content if resp is not None else None

    async def fetch_submissions_zip(self) -> Optional[bytes]:
        """Download the full submissions bulk ZIP (one GET). Returns the raw bytes; each member is the
        same shape Task 4's `parse_submissions` consumes (so the seed reuses that parser for lineage)."""
        resp = await self._get(SUBMISSIONS_ZIP_URL)
        return resp.content if resp is not None else None

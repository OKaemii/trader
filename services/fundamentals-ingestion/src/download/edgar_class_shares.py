"""Per-class share-count recovery from a filing's XBRL instance (epic post-pit-coverage-bugs, Tasks 4/5).

WHY THIS EXISTS. A dual-class issuer (META, Visa, Mastercard, Alphabet) tags shares outstanding ONLY
per share class — each `dei:EntityCommonStockSharesOutstanding` fact is dimensioned on
`us-gaap:StatementClassOfStockAxis` with a `CommonClass{A,B,C}Member`. SEC's `companyfacts`/`companyconcept`
REST feeds return only the DEFAULT (undimensioned) member, so the per-class facts are stripped before
`download/edgar.py` ever sees them — for META/V/MA there is NO consolidated total to select, and the
market cap (`price × shares × fx`) goes null. The dimensioned facts survive ONLY in the filing's own
inline-XBRL instance document. This module fetches that instance per filing and parses the per-class
share facts back out, preserving the real class `dim_signature` — the honest raw-zone preservation the
companyfacts path can't do (a registry alias can only select a tag the raw zone kept).

It is a SIBLING of `EdgarFactsClient` (shares the 10 req/s `EdgarRateLimiter`, the injectable httpx
transport, the fail-soft "degrade to empty, never throw" contract) and is invoked by the orchestrator
ONLY for the small set of dual-class CIKs that stage null consolidated shares — every other name is
untouched, so the ~200-name nightly walk pays no extra GETs.

The consolidation (sum the 1:1 classes / Visa as-converted) is a NORMALIZER derivation and lives in
`stage/class_shares.py`; this module only RECOVERS the per-class facts.
"""
from __future__ import annotations

import logging
import os
from html.parser import HTMLParser
from typing import Any, Optional

from src.download.edgar import RawFact, edgar_rate_limiter
from src.security_master.edgar_submissions import pad_cik
from src.security_master.rate_limiter import RateLimiter

log = logging.getLogger("fundamentals-ingestion.edgar-class-shares")

# Archives live on www.sec.gov (NOT data.sec.gov), under the UNPADDED integer CIK.
SEC_ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data"
_DEFAULT_TIMEOUT_S = 30.0

# The dimensioned cover-page share fact + the axis that carries the class.
_SHARES_NAME = "dei:entitycommonstocksharesoutstanding"          # inline-XBRL @name (lower-cased)
_SHARES_LOCAL = "entitycommonstocksharesoutstanding"             # classic instance element local-name
CLASS_AXIS = "us-gaap:StatementClassOfStockAxis"
_CLASS_AXIS_LOCAL = "statementclassofstockaxis"


def _accn_nodash(accession: str) -> str:
    return accession.replace("-", "")


def _index_url(cik: Any, accession: str) -> str:
    return f"{SEC_ARCHIVES_URL}/{int(pad_cik(cik))}/{_accn_nodash(accession)}/index.json"


def _doc_url(cik: Any, accession: str, name: str) -> str:
    return f"{SEC_ARCHIVES_URL}/{int(pad_cik(cik))}/{_accn_nodash(accession)}/{name}"


def _pick_instance(index_payload: Any) -> Optional[str]:
    """Pick the filing's primary XBRL instance from an accession `index.json` directory listing.

    The inline-XBRL instance is conventionally `{ticker}-{yyyymmdd}.htm` (modern, 2019+); a classic
    pre-inline filing ships a `{ticker}-{yyyymmdd}.xml` instance. We prefer that dated-stem pattern,
    then fall back to any `.htm` that is NOT a rendered R-file / FilingSummary / the index page. Returns
    None when nothing looks like an instance (the caller then degrades to no per-class facts)."""
    try:
        items = index_payload["directory"]["item"]
    except (TypeError, KeyError):
        return None
    if not isinstance(items, list):
        return None
    names = [str(it.get("name", "")) for it in items if isinstance(it, dict)]

    import re

    dated = re.compile(r"^[a-z0-9]+-\d{8}\.(htm|xml)$", re.IGNORECASE)
    preferred = [n for n in names if dated.match(n)]
    if preferred:
        # A 10-K/10-Q ships exactly one dated instance; if several match, the .htm inline instance wins.
        preferred.sort(key=lambda n: (not n.lower().endswith(".htm"), n))
        return preferred[0]
    skip = re.compile(r"(^R\d+\.htm$)|(filingsummary)|(-index\.html?$)|(^index\.)", re.IGNORECASE)
    htmls = [n for n in names if n.lower().endswith(".htm") and not skip.search(n)]
    return htmls[0] if htmls else None


def _to_shares(text: Optional[str], scale: Optional[str], sign: Optional[str]) -> Optional[float]:
    """Inline-XBRL numeric → float: strip grouping commas / NBSP, apply `@scale` (power of ten) and
    `@sign='-'`. None on anything unparseable (one bad fact never aborts the parse)."""
    t = (text or "").strip().replace(",", "").replace("\xa0", "").replace(" ", "")
    if not t:
        return None
    try:
        value = float(t)
    except ValueError:
        return None
    if scale:
        try:
            value *= 10 ** int(scale)
        except ValueError:
            pass
    if (sign or "").strip() == "-":
        value = -value
    return value


def _is_conversion_ratio(name_local: str) -> bool:
    """True for a per-class conversion-rate/ratio fact (Visa's Class B/C → Class A factor), matched
    loosely across us-gaap + filer-custom taxonomies."""
    nl = name_local.lower()
    return "conversion" in nl and ("ratio" in nl or "rate" in nl)


class _ClassFactExtractor(HTMLParser):
    """A tolerant inline-XBRL (and classic-instance) walker that pulls per-class
    `dei:EntityCommonStockSharesOutstanding` facts — and any per-class conversion-ratio facts — together
    with the `StatementClassOfStockAxis` member of each fact's context.

    HTMLParser (not ElementTree) on purpose: real SEC inline-XBRL is XHTML laden with HTML entities and
    occasional non-well-formed fragments that abort a strict XML parse; HTMLParser degrades gracefully
    and lower-cases tag + attribute NAMES (values keep their case, so QNames like
    `us-gaap:CommonClassAMember` survive intact)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.context_member: dict[str, str] = {}     # context id → class member QName
        self.facts: list[dict] = []                  # {kind, ctx, scale, sign, buf}
        self._ctx_id: Optional[str] = None
        self._member_ctx: Optional[str] = None       # context whose class member we're buffering
        self._member_buf = ""
        self._cur: Optional[dict] = None             # the share/ratio fact currently open

    @staticmethod
    def _local(tag: str) -> str:
        return tag.split(":")[-1]

    def handle_starttag(self, tag: str, attrs: list) -> None:
        a = {k: (v or "") for k, v in attrs}
        local = self._local(tag)
        if local == "context":
            self._ctx_id = a.get("id")
        elif local == "explicitmember" and self._ctx_id is not None:
            if self._local(a.get("dimension", "")).lower() == _CLASS_AXIS_LOCAL:
                self._member_ctx = self._ctx_id
                self._member_buf = ""
        elif local == "nonfraction":                 # inline XBRL: <ix:nonFraction name=... contextRef=...>
            name = a.get("name", "").strip().lower()
            if name == _SHARES_NAME:
                self._open("shares", a)
            elif _is_conversion_ratio(self._local(name)):
                self._open("ratio", a)
        elif local == _SHARES_LOCAL and a.get("contextref"):   # classic instance: <dei:Entity...>
            self._open("shares", a)

    def _open(self, kind: str, a: dict) -> None:
        ctx = a.get("contextref")
        if ctx:
            self._cur = {"kind": kind, "ctx": ctx, "name": a.get("name"),
                         "scale": a.get("scale"), "sign": a.get("sign"), "buf": ""}

    def handle_data(self, data: str) -> None:
        if self._member_ctx is not None:
            self._member_buf += data
        if self._cur is not None:
            self._cur["buf"] += data

    def handle_endtag(self, tag: str) -> None:
        local = self._local(tag)
        if local == "explicitmember" and self._member_ctx is not None:
            self.context_member[self._member_ctx] = self._member_buf.strip()
            self._member_ctx = None
        elif local == "context":
            self._ctx_id = None
        elif local in ("nonfraction", _SHARES_LOCAL) and self._cur is not None:
            self.facts.append(self._cur)
            self._cur = None


def _parse_class_shares(doc: str, *, cik: Any, accession: str, period_end_ms: int) -> list[RawFact]:
    """Parse one instance document into per-class `RawFact`s (`dim_signature =
    'us-gaap:StatementClassOfStockAxis={member}'`). Emits a share fact (`unit='shares'`) per class that
    carries a class member, plus any per-class conversion-ratio fact (`unit='pure'`) so the Visa
    as-converted handler can read it. Fail-soft: a parse error or a doc with no class-dimensioned facts
    returns []."""
    extractor = _ClassFactExtractor()
    try:
        extractor.feed(doc)
        extractor.close()
    except Exception:
        return []

    out: list[RawFact] = []
    for f in extractor.facts:
        member = extractor.context_member.get(f["ctx"])
        if not member:
            continue  # consolidated/default-member fact (or a non-class dimension) → not per-class
        value = _to_shares(f["buf"], f.get("scale"), f.get("sign"))
        if value is None:
            continue
        if f["kind"] == "shares":
            if value <= 0:
                continue
            out.append(RawFact(
                taxonomy="dei", tag="EntityCommonStockSharesOutstanding",
                period_type="instant", period_start=None, period_end=period_end_ms,
                value=value, unit="shares", currency=None,
                accession_number=accession, fiscal_year=None, fiscal_period=None, form=None,
                context_id=f["ctx"], dim_signature=f"{CLASS_AXIS}={member}",
            ))
        else:  # conversion ratio — preserve the real reported tag for honest provenance
            name = (f.get("name") or "").strip()
            taxonomy, tag = (name.split(":", 1) if ":" in name else ("dei", name or "ClassConversionRatio"))
            out.append(RawFact(
                taxonomy=taxonomy, tag=tag,
                period_type="instant", period_start=None, period_end=period_end_ms,
                value=value, unit="pure", currency=None,
                accession_number=accession, fiscal_year=None, fiscal_period=None, form=None,
                context_id=f["ctx"], dim_signature=f"{CLASS_AXIS}={member}",
            ))
    # Deterministic order (by kind then member) so writes + tests are stable.
    out.sort(key=lambda r: (r.tag, r.dim_signature))
    return out


class EdgarClassSharesClient:
    """Fetches a filing's XBRL instance and recovers its per-class share facts. Sibling of
    `EdgarFactsClient`: same UA / shared limiter / injectable transport / fail-soft contract.

    `limiter` SHOULD be the one shared `EdgarRateLimiter` passed across every EDGAR client in a run
    (the SEC budget is per-IP across all endpoints). An empty `EDGAR_USER_AGENT` means "do not call" —
    the client returns [] rather than send an anonymous request SEC would 403."""

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
        return {"User-Agent": self._user_agent, "Accept-Encoding": "gzip, deflate"}

    async def _get(self, url: str) -> Any:
        """One rate-limited httpx GET → the raw `httpx.Response`, or None on any failure (fail-soft)."""
        if not self._user_agent:
            return None
        import httpx

        await self._limiter.acquire()
        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=self._timeout, headers=self._headers()
            ) as client:
                resp = await client.get(url)
            return resp if resp.status_code == 200 else None
        except Exception:
            return None

    async def fetch_class_shares(self, cik: Any, accession: str, period_end_ms: int) -> list[RawFact]:
        """Per-class share (+ conversion-ratio) RawFacts for ONE filing. Locates the instance via the
        accession `index.json`, fetches it, and parses. [] on any miss — the name then stages null
        consolidated shares exactly as before (the documented degrade)."""
        idx = await self._get(_index_url(cik, accession))
        if idx is None:
            return []
        try:
            instance_name = _pick_instance(idx.json())
        except Exception:
            instance_name = None
        if not instance_name:
            log.info("[class-shares] no instance located for CIK %s accn %s", cik, accession)
            return []
        doc = await self._get(_doc_url(cik, accession, instance_name))
        if doc is None:
            return []
        return _parse_class_shares(doc.text, cik=cik, accession=accession, period_end_ms=period_end_ms)

"""Polite, rate-limited async client for SEC EDGAR — the harvester's only upstream.

SEC fair-access rules: at most 10 requests/second and a descriptive User-Agent
("Company Name contact@email.com"). The client FAILS CLOSED on an empty or placeholder
`EDGAR_USER_AGENT`: the SEC blocks anonymous clients, so a no-op run that silently fetches
nothing is worse than refusing to start. It backs off on 429/5xx.

See: https://www.sec.gov/search-filings/edgar-application-programming-interfaces
"""
from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import httpx

DATA = "https://data.sec.gov"
WWW = "https://www.sec.gov"

# Platform-standard SEC User-Agent env (CLAUDE.md: `EDGAR_USER_AGENT`). A real descriptive contact
# string is required — the placeholder default the chart ships (`trader-platform fundamentals-...`)
# carries no `@` contact, so it fails the guard below until an operator sets a real address.
_UA = os.environ.get("EDGAR_USER_AGENT", "")

# Shared EDGAR rate budget — SEC's published ceiling is 10 req/s; never raise above it. Read from
# `EDGAR_REQS_PER_SEC` (the platform-wide knob) so the same limit governs every EDGAR caller; values
# above 10 are clamped to 10 (a misconfig must not get us rate-banned).
_SEC_RPS_CEILING = 10.0


def _resolve_rps() -> float:
    raw = os.environ.get("EDGAR_REQS_PER_SEC", "")
    if not raw.strip():
        return _SEC_RPS_CEILING
    try:
        rps = float(raw)
    except ValueError:
        return _SEC_RPS_CEILING
    if rps <= 0:
        return _SEC_RPS_CEILING
    return min(rps, _SEC_RPS_CEILING)


def _ua_is_valid(ua: str) -> bool:
    """A usable SEC UA is a non-empty descriptive string carrying a contact (an `@` address). The
    chart's placeholder (no `@`) and an empty string both fail — the client refuses to start."""
    return bool(ua and "@" in ua)


class Edgar:
    """Async EDGAR HTTP client with a shared ≤10 req/s throttle and 429/5xx backoff.

    `rps` defaults from `EDGAR_REQS_PER_SEC` (clamped to the 10 req/s SEC ceiling); an explicit
    argument (tests) still cannot exceed the ceiling.
    """

    def __init__(self, rps: float | None = None):
        if not _ua_is_valid(_UA):
            raise SystemExit(
                "EDGAR_USER_AGENT must be a real descriptive contact string "
                "('trader-platform ops@example.com') — the SEC requires it and blocks anonymous "
                "clients. Refusing to start with an empty/placeholder UA."
            )
        resolved = _resolve_rps() if rps is None else min(rps, _SEC_RPS_CEILING)
        self._interval = 1.0 / resolved
        self._lock = asyncio.Lock()
        self._last = 0.0
        self._c = httpx.AsyncClient(
            headers={"User-Agent": _UA, "Accept-Encoding": "gzip, deflate"},
            timeout=60.0,
            follow_redirects=True,
        )

    async def aclose(self) -> None:
        await self._c.aclose()

    async def _throttle(self) -> None:
        async with self._lock:
            wait = self._last + self._interval - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._last = time.monotonic()

    async def get(self, url: str) -> httpx.Response:
        for attempt in range(5):
            await self._throttle()
            r = await self._c.get(url)
            if r.status_code == 429 or r.status_code >= 500:
                await asyncio.sleep(2 ** attempt)
                continue
            r.raise_for_status()
            return r
        r.raise_for_status()  # raise the last error
        return r

    async def json(self, url: str):
        return (await self.get(url)).json()

    async def download(self, url: str, dest: Path) -> None:
        """Stream a large file (bulk zips) to disk atomically (tmpfile + os.replace)."""
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        await self._throttle()
        async with self._c.stream("GET", url) as r:
            r.raise_for_status()
            with open(tmp, "wb") as f:
                async for chunk in r.aiter_bytes(1 << 20):
                    f.write(chunk)
        os.replace(tmp, dest)

    # ------------------------------------------------------------------ #
    # Endpoints                                                          #
    # ------------------------------------------------------------------ #
    async def company_tickers(self) -> dict:
        """Current ticker -> CIK map for the whole US universe."""
        return await self.json(f"{WWW}/files/company_tickers.json")

    async def submissions(self, cik: int) -> dict:
        """Filing history + entity metadata (incl. formerNames + acceptanceDateTime) for one CIK."""
        return await self.json(f"{DATA}/submissions/CIK{cik:010d}.json")

    async def companyfacts(self, cik: int) -> dict:
        """Every XBRL fact the entity ever filed, with accession + filed date."""
        return await self.json(f"{DATA}/api/xbrl/companyfacts/CIK{cik:010d}.json")

    async def daily_form_index(self, d) -> str:
        """All filings accepted on date d (any filer). 404 on non-business days."""
        qtr = (d.month - 1) // 3 + 1
        url = f"{WWW}/Archives/edgar/daily-index/{d:%Y}/QTR{qtr}/form.{d:%Y%m%d}.idx"
        return (await self.get(url)).text

    # Bulk archives, recompiled nightly (~3:00 a.m. ET)
    BULK_COMPANYFACTS = f"{WWW}/Archives/edgar/daily-index/xbrl/companyfacts.zip"
    BULK_SUBMISSIONS = f"{WWW}/Archives/edgar/daily-index/bulkdata/submissions.zip"

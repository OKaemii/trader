"""security_master — entity + effective-dated identifier upserts and resolution (epic Task 4).

Owns the writers for `security_master.{companies,instruments,identifiers,filings}` and the as-of
resolver over the effective-dated `identifiers` rows. CIK↔ticker comes from EDGAR `submissions`
(`edgar_submissions.py`); FIGI from free OpenFIGI (`openfigi.py`); ticker-change history is recorded
append-only so `resolve_symbol(ticker, as_of)` returns the instrument that the ticker pointed at on a
past date (the canonical FB→META case). Permanent IDs decouple facts from tickers, which change over
time.

The external clients (EDGAR, OpenFIGI) are lazy + rate-limited + fail-soft: importing this package
opens no socket, and live ingestion is driven by the cron/backfill card (epic Task 9). Connection
construction lives in `pool.py`; the writers/resolver take an injected `asyncpg.Pool`.

Public surface (imported by the future downloader/cron and by the tests):
  writers   — SecurityMasterWriter + the record dataclasses + identifier/country constants
  resolver  — SecurityMasterResolver + ResolvedInstrument + pad_cik
  clients   — EdgarSubmissionsClient / OpenFigiClient (+ their parsers + parsed dataclasses)
  pool      — get_pool / close_pool / timescale_url
  limiter   — RateLimiter
"""
from .edgar_submissions import (
    CompanySubmissions,
    EdgarSubmissionsClient,
    SubmissionFiling,
    TickerMapEntry,
    parse_company_tickers,
    parse_submissions,
)
from .openfigi import (
    FigiMapping,
    OpenFigiClient,
    parse_mapping_response,
)
from .intervals import IdentifierInterval, resolve_interval
from .pool import close_pool, get_pool, timescale_url
from .rate_limiter import RateLimiter
from .resolver import ResolvedInstrument, SecurityMasterResolver, pad_cik
from .writers import (
    COUNTRY_GB,
    COUNTRY_US,
    FREELY_OBTAINABLE_IDENTIFIERS,
    ID_FIGI,
    ID_TICKER,
    SOURCE_COMPANIES_HOUSE,
    SOURCE_SEC_EDGAR,
    CompanyRecord,
    FilingRecord,
    IdentifierRecord,
    InstrumentRecord,
    SecurityMasterWriter,
    country_for_ticker,
)

__all__ = [
    # writers
    "SecurityMasterWriter",
    "CompanyRecord",
    "InstrumentRecord",
    "IdentifierRecord",
    "FilingRecord",
    "country_for_ticker",
    "ID_TICKER",
    "ID_FIGI",
    "FREELY_OBTAINABLE_IDENTIFIERS",
    "SOURCE_SEC_EDGAR",
    "SOURCE_COMPANIES_HOUSE",
    "COUNTRY_US",
    "COUNTRY_GB",
    # resolver + pure interval rule
    "SecurityMasterResolver",
    "ResolvedInstrument",
    "pad_cik",
    "IdentifierInterval",
    "resolve_interval",
    # EDGAR
    "EdgarSubmissionsClient",
    "TickerMapEntry",
    "SubmissionFiling",
    "CompanySubmissions",
    "parse_company_tickers",
    "parse_submissions",
    # OpenFIGI
    "OpenFigiClient",
    "FigiMapping",
    "parse_mapping_response",
    # pool / limiter
    "get_pool",
    "close_pool",
    "timescale_url",
    "RateLimiter",
]

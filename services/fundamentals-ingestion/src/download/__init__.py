"""download — upstream fetchers for raw filings (epic Tasks 5 and 18).

`edgar.py` (US): bulk-seed from SEC `companyfacts.zip` + `submissions.zip`, incremental via the
per-CIK companyfacts/submissions API behind an `EdgarRateLimiter` (10 req/s sliding window + the
mandatory `EDGAR_USER_AGENT`), modelled on `EodhdCreditLimiter`. `companies_house.py` (UK, later):
Free Accounts Data Product iXBRL ZIPs + filing-metadata API, Arelle-parsed over FRC taxonomies, with
a PDF group-accounts fallback into the QA manual-review queue.

Public surface (imported by the future cron/backfill — epic Task 9 — and by the tests):
  client    — EdgarFactsClient (+ edgar_rate_limiter factory) — companyfacts/companyconcept + bulk ZIPs
  facts     — RawFact (one flattened XBRL fact) + the pure parsers
  parsers   — parse_company_facts / parse_company_concept (total functions over decoded JSON)
  bulk      — iter_zip_members / cik_from_zip_member (lazy per-CIK iteration over a bulk ZIP)
"""
from .edgar import (
    COMPANY_CONCEPT_URL,
    COMPANY_FACTS_URL,
    COMPANY_FACTS_ZIP_URL,
    PRESERVED_TAXONOMIES,
    SUBMISSIONS_ZIP_URL,
    EdgarFactsClient,
    RawFact,
    cik_from_zip_member,
    edgar_rate_limiter,
    iter_zip_members,
    parse_company_concept,
    parse_company_facts,
)

__all__ = [
    "EdgarFactsClient",
    "edgar_rate_limiter",
    "RawFact",
    "parse_company_facts",
    "parse_company_concept",
    "iter_zip_members",
    "cik_from_zip_member",
    "PRESERVED_TAXONOMIES",
    "COMPANY_FACTS_URL",
    "COMPANY_CONCEPT_URL",
    "COMPANY_FACTS_ZIP_URL",
    "SUBMISSIONS_ZIP_URL",
]

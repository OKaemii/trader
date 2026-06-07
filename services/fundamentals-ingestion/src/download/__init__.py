"""download — upstream fetchers for raw filings (epic Tasks 5 and 18).

`edgar.py` (US): bulk-seed from SEC `companyfacts.zip` + `submissions.zip`, incremental via the
per-CIK companyfacts/submissions API behind an `EdgarRateLimiter` (10 req/s sliding window + the
mandatory `EDGAR_USER_AGENT`), modelled on `EodhdCreditLimiter`. `companies_house.py` (UK, later):
Free Accounts Data Product iXBRL ZIPs + filing-metadata API, Arelle-parsed over FRC taxonomies, with
a PDF group-accounts fallback into the QA manual-review queue.
"""

"""security_master — entity + effective-dated identifier upserts (epic Task 4).

Owns the writers for `security_master.{companies,instruments,identifiers,filings}`: CIK↔ticker
resolution from EDGAR `submissions`, FIGI from free OpenFIGI, and ticker-change history so
`resolve_symbol(ticker, as_of)` returns the instrument that the ticker pointed at on a past date
(e.g. FB→META). Permanent IDs decouple facts from tickers, which change over time.
"""

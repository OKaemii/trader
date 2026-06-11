"""Curated NO-EDGAR exception set — US-listed curated names that genuinely file NOTHING with the SEC.

The sibling of `ticker_aliases.py`. That table bridges a symbol the SEC ticker snapshot MISSES to a real,
rename-invariant CIK (a rename / new-IPO / newly-sponsored ADR — the filer DOES file, we just have to find
its CIK). This table is the opposite case: a curated US-listed line whose issuer files **no SEC reports at
all**, so there is no CIK to bridge to and no fundamentals will ever land for it from EDGAR. The canonical
example is an **unsponsored ADR** — a depositary creates the ADR without the foreign issuer's involvement,
so the issuer never registers with the SEC and files neither a 20-F nor a 6-K (Tencent's `TCEHY` is exactly
this: it trades OTC in the US but Tencent files only with the HKEX, nothing with EDGAR).

WHY AN ENUMERATED, DATED, COMMENTED TABLE — NOT A HEURISTIC. "Files nothing with the SEC" is the same kind
of discrete, auditable fact as a ticker rename: it can be checked once (the symbol is ABSENT from the SEC's
bulk `company_tickers.json` AND there is no CIK behind it) and then asserted. We never INFER it from a miss
at runtime — a transient "no_cik" can equally mean a brand-new filer the daily SEC snapshot hasn't picked up
yet (which `ticker_aliases.py` + the OpenFIGI fallback exist to catch). Conflating the two would silently
stop ingesting a name that just listed. So the operator adds a name here ONLY after verifying it genuinely
does not file — each entry carries a human-auditable reason string.

THE DENOMINATOR DISTINCTION THIS DRIVES (the whole point of the card). The freshness audit's safe-to-retire
gate (`retirable`) must be computed over the names that COULD be ingested from EDGAR — the **EDGAR-eligible**
denominator (curated US universe − this set). A NO_EDGAR name will forever be `covered:false`; counting it as
`missing` would make `retirable` impossible to ever reach (the gate would block on a name no amount of
ingesting can satisfy) and would mislead the operator into chasing a "missing" name that is correctly
degrading to the Yahoo fallback. So the audit excludes these names from `missing`/`stale`/`retirable` and
surfaces them in a distinct `no_edgar` block WITH reasons — a documented, accepted exception exactly like an
LSE/foreign name with no US CIK, not a silent gap.

KEYS ARE BARE UPPERCASE US SYMBOLS — the same alphabet the curated-US freshness universe speaks (`AAPL`,
not `AAPL_US_EQ`); the audit normalises the universe to bare symbols before excluding this set, so the two
agree. Verified against the live SEC `company_tickers.json` during this task (see each entry's note).
"""
from __future__ import annotations

from typing import Optional

# Each value is the human-auditable reason the symbol files nothing with the SEC. KEY is the BARE uppercase
# US symbol (the curated-US freshness universe alphabet — the audit upper-cases before the lookup, so a
# direct caller is also tolerant via `is_no_edgar`/`no_edgar_reason`).
#
# Verified against the live SEC bulk `company_tickers.json` during this task (2026-06-11):
#   * TCEHY — Tencent's UNSPONSORED ADR. ABSENT from the bulk map and NO CIK behind it: Tencent (a Hong
#             Kong issuer, HKEX 0700) never registered with the SEC, the US ADR was created by a depositary
#             without the issuer, so it files neither a 20-F nor a 6-K — there is nothing to ingest from
#             EDGAR. Degrades to the Yahoo fundamentals fallback. (Distinct from a SPONSORED ADR like TSM,
#             which DOES file a 20-F and is a normal annual-cadence EDGAR name — NOT here.)
#
# NOT in this set, and why (the trap the card calls out — `missing` ≠ `no_edgar`):
#   * META — has CIK 0001326801 (the FB→META rename; bridged by ticker_aliases.py). It is `missing` only
#            until the capstone re-ingest lands its facts — a coverage gap that ingesting CLOSES, never a
#            no-EDGAR name. Adding it here would wrongly stop the gate from ever waiting for its data.
#   * SPCX — resolves natively to CIK 0001181412 (Space Exploration Technologies) in the SEC bulk map. A
#            normal EDGAR name; `missing` only pending ingest.
NO_EDGAR: dict[str, str] = {
    "TCEHY": "unsponsored ADR — Tencent (HKEX 0700) files nothing with the SEC (no CIK); degrades to Yahoo",
}


def is_no_edgar(symbol: str) -> bool:
    """True when the bare/cased US symbol is an enumerated no-EDGAR name (files nothing with the SEC).
    Total + side-effect-free; upper-cases so a direct caller is tolerant of casing."""
    return symbol.strip().upper() in NO_EDGAR


def no_edgar_reason(symbol: str) -> Optional[str]:
    """The curated reason a symbol files nothing with the SEC, or None when it is not a no-EDGAR name."""
    return NO_EDGAR.get(symbol.strip().upper())

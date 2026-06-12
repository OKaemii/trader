"""Curated NO-EDGAR exception set — US-listed curated names that genuinely file NOTHING with the SEC.

A US-listed line whose issuer files **no SEC reports at all**, so there is no CIK behind it and no
fundamentals will ever land for it from EDGAR. The canonical example is an **unsponsored ADR** — a
depositary creates the ADR without the foreign issuer's involvement, so the issuer never registers with
the SEC and files neither a 20-F nor a 6-K (Tencent's `TCEHY` is exactly this: it trades OTC in the US
but Tencent files only with the HKEX, nothing with EDGAR).

WHY AN ENUMERATED, DATED, COMMENTED TABLE — NOT A HEURISTIC. "Files nothing with the SEC" is a discrete,
auditable fact: it can be checked once (the symbol is ABSENT from the SEC's bulk `company_tickers.json`
AND there is no CIK behind it) and then asserted. The harvester NEVER infers it from a miss at runtime —
a transient "no CIK in today's snapshot" can equally mean a brand-new filer the daily SEC snapshot hasn't
picked up yet. Conflating the two would silently stop tracking a name that just listed. So a name is added
here ONLY after verifying it genuinely does not file — each entry carries a human-auditable reason string.

THE DENOMINATOR DISTINCTION THIS DRIVES (the whole point of the set). The freshness audit's
safe-to-retire gate (`retirable`) is computed over the names that COULD be ingested from EDGAR — the
**EDGAR-eligible** denominator (`universe − NO_EDGAR`). A NO_EDGAR name is FOREVER `covered:false`;
counting it as `missing` would make `retirable` impossible to reach (the gate would block on a name no
amount of harvesting can satisfy) and would mislead the operator into chasing a "missing" name that is a
documented exception. So the audit excludes these names from `missing`/`stale`/`retirable` and surfaces
them in a distinct `no_edgar` block WITH reasons.

KEYS ARE BARE UPPERCASE US SYMBOLS — the same alphabet the lake speaks (`AAPL`, not `AAPL_US_EQ`); the
audit normalises the universe to bare symbols before excluding this set, so the two agree. Verified
against the live SEC `company_tickers.json` during the originating coverage task (see each entry's note).
"""
from __future__ import annotations

from typing import Optional

# Each value is the human-auditable reason the symbol files nothing with the SEC. KEY is the BARE
# uppercase US symbol (the lake alphabet — the audit upper-cases before the lookup, so a direct caller is
# also tolerant via `is_no_edgar`/`no_edgar_reason`).
#
# Verified against the live SEC bulk `company_tickers.json` (2026-06-11):
#   * TCEHY — Tencent's UNSPONSORED ADR. ABSENT from the bulk map and NO CIK behind it: Tencent (a Hong
#             Kong issuer, HKEX 0700) never registered with the SEC, the US ADR was created by a depositary
#             without the issuer, so it files neither a 20-F nor a 6-K — there is nothing to harvest from
#             EDGAR. Fail-closed (no fundamentals; the value/quality legs are NaN-excluded). (Distinct from
#             a SPONSORED ADR like TSM, which DOES file a 20-F and is a normal annual-cadence EDGAR name —
#             NOT here.)
#
# NOT in this set, and why (the trap the set guards against — `missing` ≠ `no_edgar`):
#   * META — has CIK 0001326801 (the FB→META rename; carried by the harvester's ticker_history seed). It is
#            `missing` only until the harvest lands its facts — a coverage gap that harvesting CLOSES, never
#            a no-EDGAR name. Adding it here would wrongly stop the gate from ever waiting for its data.
#   * SPCX — resolves natively to CIK 0001181412 (Space Exploration Technologies) in the SEC bulk map. A
#            normal EDGAR name; `missing` only pending harvest.
NO_EDGAR: dict[str, str] = {
    "TCEHY": "unsponsored ADR — Tencent (HKEX 0700) files nothing with the SEC (no CIK); fail-closed",
}


def is_no_edgar(symbol: str) -> bool:
    """True when the bare/cased US symbol is an enumerated no-EDGAR name (files nothing with the SEC).
    Total + side-effect-free; upper-cases so a direct caller is tolerant of casing."""
    return symbol.strip().upper() in NO_EDGAR


def no_edgar_reason(symbol: str) -> Optional[str]:
    """The curated reason a symbol files nothing with the SEC, or None when it is not a no-EDGAR name."""
    return NO_EDGAR.get(symbol.strip().upper())

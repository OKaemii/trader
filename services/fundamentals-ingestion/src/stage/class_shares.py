"""Dual-class share consolidation (epic post-pit-coverage-bugs, Tasks 6/7).

PURE derivation: given a filing's per-class `dei:EntityCommonStockSharesOutstanding` facts (recovered
from the XBRL instance by `download/edgar_class_shares.py`, which `companyfacts` strips), produce the
ONE consolidated `shares_outstanding` value the market cap needs — or NOTHING (fail-closed). It mirrors
the registry's "staging selects, summation is a normalizer derivation" rule (metric_registry.yaml,
total_debt): the per-class facts are real reported facts kept in the raw zone; the consolidated total
is a derivation, emitted with a `derived:…` provenance tag so the revisions log never mistakes it for a
single reported fact.

Two regimes:
  * 1:1-FUNGIBLE classes (META, Mastercard, Alphabet) — Class B/C convert 1:1 to Class A, so the legal
    share count is the NAIVE SUM of the per-class members. Require ≥2 classes (these names ARE dual-class;
    a single member means we only recovered part of the cover page → fail-closed undercount guard).
  * Visa — Class B-1/B-2/C convert to Class A at ratios < 1 (disclosed per filing, NOT 1:1), so a naive
    sum OVER-counts the float. We compute the as-converted Class-A-equivalent `A + Σ(classᵢ × ratioᵢ)`
    using per-class conversion-ratio facts when the filing tags them, gated by a sanity band. Any
    missing / insane / out-of-band input → None (the caller quarantines + degrades to Yahoo). We never
    emit a naive over-count nor a guessed ratio.
"""
from __future__ import annotations

import logging
from typing import Optional

from src.download.edgar import RawFact
from src.security_master.edgar_submissions import pad_cik
from src.stage.resolver import InterpretedFact

log = logging.getLogger("fundamentals-ingestion.class-shares")

# CIKs whose share classes convert 1:1 (sum is the legal share count).
META_CIK = "0001326801"
MASTERCARD_CIK = "0001141391"
ALPHABET_CIK = "0001652044"
FUNGIBLE_1TO1 = {META_CIK, MASTERCARD_CIK, ALPHABET_CIK}

# Visa — non-1:1 classes; needs the as-converted handler.
VISA_CIK = "0001403161"

# The set the orchestrator routes onto the instance-fetch path (null-consolidated-shares dual-class
# names). GOOGL/GOOG (Alphabet) is included so a name whose us-gaap consolidated fallback is ever absent
# still recovers via the per-class sum; the fallback (PR #151) wins first when present, so this is belt
# and braces, never a regression.
DUAL_CLASS_CIKS = FUNGIBLE_1TO1 | {VISA_CIK}

# Visa as-converted sanity band: the consolidated as-converted total must land within this multiple of
# the Class A count alone. Visa's non-A classes convert at < 1, so the total is modestly above A — a
# result outside the band means a mis-parsed ratio/share and we fail-closed.
_VISA_BAND_LO = 0.9
_VISA_BAND_HI = 3.0


def _shares_by_member(class_facts: list[RawFact]) -> dict[str, float]:
    return {
        f.dim_signature: f.value
        for f in class_facts
        if f.unit == "shares" and f.value and f.value > 0
    }


def _ratios_by_member(class_facts: list[RawFact]) -> dict[str, float]:
    return {
        f.dim_signature: f.value
        for f in class_facts
        if f.unit == "pure" and f.value and f.value > 0
    }


def _visa_as_converted(shares: dict[str, float], ratios: dict[str, float]) -> Optional[float]:
    """`A + Σ(classᵢ × ratioᵢ)` for Visa's non-1:1 classes. Class A is the base (ratio 1.0); every other
    class needs a parsed, in-range (0, 1.5] conversion ratio. Returns None — fail-closed — if Class A
    isn't identifiable, any non-A class lacks a sane ratio, or the result falls outside the sanity band."""
    a_member = next((m for m in shares if "classa" in m.lower()), None)
    if a_member is None:
        return None
    a_count = shares[a_member]
    total = a_count
    for member, count in shares.items():
        if member == a_member:
            continue
        ratio = ratios.get(member)
        if ratio is None or not (0 < ratio <= 1.5):
            return None  # missing / insane ratio → fail-closed (no naive over-count)
        total += count * ratio
    if not (_VISA_BAND_LO * a_count <= total <= _VISA_BAND_HI * a_count):
        return None  # out-of-band → a mis-parse slipped through; fail-closed
    return total


def _consolidated_fact(total: float, *, cik: str, accession: str, period_end: int) -> InterpretedFact:
    """The single consolidated `shares_outstanding` InterpretedFact (dim_signature='' = consolidated),
    provenance-tagged `derived:…` so the bi-temporal writer's revisions log records it as a derivation,
    never a single reported tag. `knowledge_ts` stays None — the writer derives the next-session
    availability hop from the filing's `accepted_ts`, identical to every other staged fact."""
    return InterpretedFact(
        metric="shares_outstanding",
        cik=cik,
        value=total,
        unit="shares",
        currency=None,
        period_start=None,
        period_end=period_end,
        period_type="instant",
        fiscal_year=None,
        fiscal_period=None,
        dim_signature="",
        is_segment=False,
        raw_tag="derived:sum(dei:EntityCommonStockSharesOutstanding@class)",
        accession_number=accession,
        knowledge_ts=None,
    )


def derive_consolidated_shares(
    class_facts: list[RawFact], *, cik: str, accession: str
) -> Optional[InterpretedFact]:
    """The consolidated `shares_outstanding` for a dual-class filing, or None (fail-closed).

    1:1 names sum their ≥2 per-class members; Visa uses the as-converted handler. Any name not in
    `DUAL_CLASS_CIKS`, an empty/partial recovery, or a Visa as-converted failure yields None — the
    caller then quarantines and the name degrades to the Yahoo live-fallback. Never a fabricated value."""
    cik = pad_cik(cik)
    shares = _shares_by_member(class_facts)
    if not shares:
        return None
    period_end = next((f.period_end for f in class_facts if f.unit == "shares"), None)
    if period_end is None:
        return None

    if cik in FUNGIBLE_1TO1:
        if len(shares) < 2:
            log.info("[class-shares] %s: only %d class recovered — fail-closed", cik, len(shares))
            return None  # partial cover-page recovery → undercount guard
        total = sum(shares.values())
    elif cik == VISA_CIK:
        total = _visa_as_converted(shares, _ratios_by_member(class_facts))
        if total is None:
            log.info("[class-shares] VISA: as-converted unresolved — fail-closed (quarantine→Yahoo)")
            return None
    else:
        return None  # unknown dual-class name → never guess

    return _consolidated_fact(total, cik=cik, accession=accession, period_end=period_end)

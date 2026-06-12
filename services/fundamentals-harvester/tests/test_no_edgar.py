"""Unit tests for the enumerated NO_EDGAR exception set (epic Task 9).

A NO_EDGAR name files NOTHING with the SEC (an unsponsored ADR like TCEHY), so it can never be covered
from EDGAR. The freshness audit must EXCLUDE it from the `missing`/`stale`/`retirable` denominator (else
the safe-to-retire gate is unreachable) and surface it with a reason instead. These tests pin the set's
shape + the `is_no_edgar`/`no_edgar_reason` helpers; the audit-level exclusion is covered in
`test_freshness.py`.
"""
from __future__ import annotations

import no_edgar


def test_tcehy_is_the_enumerated_unsponsored_adr() -> None:
    # TCEHY (Tencent's unsponsored ADR) is the canonical no-EDGAR name — present with a reason string.
    assert "TCEHY" in no_edgar.NO_EDGAR
    assert "unsponsored adr" in no_edgar.NO_EDGAR["TCEHY"].lower()


def test_meta_and_spcx_are_not_no_edgar() -> None:
    # The trap the set guards against: META (FB→META rename, CIK 0001326801) and SPCX (resolves natively)
    # are `missing` only until harvested — NOT no-EDGAR names. Listing them would block the gate forever.
    assert "META" not in no_edgar.NO_EDGAR
    assert "SPCX" not in no_edgar.NO_EDGAR
    assert no_edgar.is_no_edgar("META") is False
    assert no_edgar.is_no_edgar("SPCX") is False


def test_is_no_edgar_case_insensitive_and_total() -> None:
    assert no_edgar.is_no_edgar("TCEHY") is True
    assert no_edgar.is_no_edgar("tcehy") is True
    assert no_edgar.is_no_edgar("  TcEhY  ") is True  # whitespace + casing tolerant
    assert no_edgar.is_no_edgar("AAPL") is False
    assert no_edgar.is_no_edgar("") is False


def test_no_edgar_reason_returns_the_string_or_none() -> None:
    assert no_edgar.no_edgar_reason("TCEHY") == no_edgar.NO_EDGAR["TCEHY"]
    assert no_edgar.no_edgar_reason("tcehy") == no_edgar.NO_EDGAR["TCEHY"]
    assert no_edgar.no_edgar_reason("AAPL") is None


def test_keys_are_bare_uppercase_symbols() -> None:
    # Keys must be the BARE US symbol alphabet (no `_US_EQ` suffix) — the same the lake universe speaks, so
    # the audit's bare-symbol exclusion matches.
    for key in no_edgar.NO_EDGAR:
        assert key == key.upper()
        assert "_" not in key  # no T212 suffix form

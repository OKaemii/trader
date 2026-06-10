"""Curated ticker-alias table tests — the rename / ADR / new-IPO → CIK bridge.

The table is data, so these assert its CONTRACT: the seeded cases resolve to the rename-invariant CIK,
the rename direction is recorded (`renamed_from` on the current side only), lookup is case/whitespace
tolerant, and an unknown symbol is an honest miss (no fabricated CIK).
"""
from __future__ import annotations

from datetime import datetime, timezone

from src.security_master.ticker_aliases import (
    TICKER_ALIASES,
    TickerAlias,
    resolve_alias,
)

_META_CIK = "0001326801"
_RENAME_MS = int(datetime(2022, 6, 9, tzinfo=timezone.utc).timestamp() * 1000)


def test_fb_and_meta_seeded_to_the_same_stable_cik() -> None:
    # Both sides of the rename point at Meta's single, rename-invariant CIK.
    assert TICKER_ALIASES["FB"].cik == _META_CIK
    assert TICKER_ALIASES["META"].cik == _META_CIK


def test_rename_dated_at_the_rebrand_instant() -> None:
    # since_ms is the 2022-06-09 rebrand date — the boundary the effective-dated identifier interval is
    # closed/opened at.
    assert TICKER_ALIASES["FB"].since_ms == _RENAME_MS
    assert TICKER_ALIASES["META"].since_ms == _RENAME_MS


def test_renamed_from_set_only_on_the_current_side() -> None:
    # The CURRENT symbol (META) carries renamed_from=FB so the orchestrator can close FB's interval; the
    # legacy/origin symbol (FB) has no predecessor to close.
    assert TICKER_ALIASES["META"].renamed_from == "FB"
    assert TICKER_ALIASES["FB"].renamed_from is None


def test_resolve_alias_is_case_and_whitespace_tolerant() -> None:
    a = resolve_alias("  fb ")
    assert isinstance(a, TickerAlias) and a.cik == _META_CIK and a.note == "renamed_to META"


def test_resolve_alias_unknown_symbol_is_a_miss() -> None:
    # No alias entry ⇒ None (the orchestrator then skips no_cik) — never a fabricated CIK.
    assert resolve_alias("ZZZZ") is None
    # SPCX resolves NATIVELY from the SEC map, so it is deliberately NOT in the alias table.
    assert resolve_alias("SPCX") is None
    # TCEHY (unsponsored ADR, files nothing) defers to the NO_EDGAR set, not a fabricated alias.
    assert resolve_alias("TCEHY") is None

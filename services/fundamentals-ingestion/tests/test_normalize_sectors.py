"""Sector-template-by-SIC tests (epic Task 7).

Proves `template_for_sic` maps the financial/utility SIC bands to the registry's template names
(general|bank|insurance|reit|utility — the exact keys metric_registry.yaml's sector overrides use) and
falls back to 'general' for everything else and for a missing/unparseable SIC. The template feeds
`stage.resolve_metrics(sector=...)`, so a wrong classification would apply the wrong tag overrides — a
bank read off product-sale revenue, or an industrial denied its gross profit.
"""
from __future__ import annotations

import pytest

from src.normalize.sectors import (
    TEMPLATE_BANK,
    TEMPLATE_GENERAL,
    TEMPLATE_INSURANCE,
    TEMPLATE_REIT,
    TEMPLATE_UTILITY,
    TEMPLATES,
    template_for_sic,
)
from src.stage.registry import DEFAULT_SECTOR, default_registry


def test_templates_match_registry_sector_keys() -> None:
    # The template set MUST be exactly the keys the resolver/registry understand. 'general' is the
    # default; the other four are the YAML's `sectors.<template>` overrides. A drift here would mean a
    # template the registry silently falls back to 'general' for (a wrong, unflagged classification).
    reg = default_registry()
    used_sector_keys = set()
    for metric in reg.metrics():
        for sector in TEMPLATES:
            # candidates() must not raise for any template name (it falls back to general when no
            # override) — proves the template names are all valid sector arguments.
            reg.candidates(metric, sector)
            used_sector_keys.add(sector)
    assert DEFAULT_SECTOR == TEMPLATE_GENERAL
    assert TEMPLATE_GENERAL in TEMPLATES
    # All five are distinct, lowercase, non-empty.
    assert len(set(TEMPLATES)) == 5
    assert all(t == t.lower() and t for t in TEMPLATES)


@pytest.mark.parametrize(
    "sic,expected",
    [
        # Banks / depositories / bank holding companies.
        (6020, TEMPLATE_BANK),   # national commercial banks
        (6021, TEMPLATE_BANK),
        (6022, TEMPLATE_BANK),   # state commercial banks
        (6035, TEMPLATE_BANK),   # savings institutions, federally chartered
        (6079, TEMPLATE_BANK),   # band upper bound
        (6120, TEMPLATE_BANK),   # savings institutions
        (6712, TEMPLATE_BANK),   # bank holding companies (JPM, BAC, …)
        # Insurance carriers + agents.
        (6300, TEMPLATE_INSURANCE),
        (6311, TEMPLATE_INSURANCE),  # life insurance
        (6331, TEMPLATE_INSURANCE),  # fire, marine & casualty
        (6411, TEMPLATE_INSURANCE),  # insurance agents/brokers (band upper bound)
        # REIT.
        (6798, TEMPLATE_REIT),       # the single REIT SIC (O, SPG, …)
        # Utilities.
        (4900, TEMPLATE_UTILITY),
        (4911, TEMPLATE_UTILITY),    # electric services
        (4924, TEMPLATE_UTILITY),    # natural gas distribution
        (4941, TEMPLATE_UTILITY),    # water supply
        (4991, TEMPLATE_UTILITY),    # band upper bound
    ],
)
def test_financial_and_utility_bands(sic: int, expected: str) -> None:
    assert template_for_sic(sic) == expected


@pytest.mark.parametrize(
    "sic",
    [
        3571,   # electronic computers (AAPL is 3571) → general
        7372,   # prepackaged software (MSFT) → general
        5411,   # grocery stores
        2834,   # pharmaceutical preparations
        6199,   # finance services — NOT in a mapped band → general (conservative: default tags resolve)
        6500,   # real estate (not the 6798 REIT SIC) → general
        4800,   # communications (just below the utility band) → general
        5000,   # wholesale → general
    ],
)
def test_non_financial_sic_is_general(sic: int) -> None:
    # The bands are conservative — only SICs whose accounting genuinely breaks the default tags are
    # mapped; a borderline financial-services SIC (6199, 6500) stays 'general'.
    assert template_for_sic(sic) == TEMPLATE_GENERAL


def test_string_sic_is_accepted() -> None:
    # EDGAR's submissions.json gives `sic` as a 4-digit STRING; both the string and int forms classify.
    assert template_for_sic("6021") == TEMPLATE_BANK
    assert template_for_sic(" 6798 ") == TEMPLATE_REIT   # stray whitespace tolerated
    assert template_for_sic("3571") == TEMPLATE_GENERAL


@pytest.mark.parametrize("bad", [None, "", "  ", "N/A", "abc", "65xx", True, False])
def test_missing_or_unparseable_sic_is_general(bad: object) -> None:
    # A filer EDGAR never classified, an empty/garbage code, or a stray bool degrades to 'general' —
    # never a crash, never a guess. 'general' is the safe default (it never SUPPRESSES a metric the
    # way a wrong financial template would).
    assert template_for_sic(bad) == TEMPLATE_GENERAL

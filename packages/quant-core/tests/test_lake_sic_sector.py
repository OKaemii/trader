"""SIC → GICS-style sector LABEL map (epic pit-fundamentals-lake-rearchitecture, Thread C / Task 19).

Pins the secondary (EDGAR-SIC) sector source the universe falls back to for curated/US names: the
carve-outs resolve ahead of their wider bands (oil-&-gas inside Mining, drugs inside Chemicals,
software inside Services, semis/computers inside Machinery, food stores inside Retail, REITs inside
Holding offices), the eleven EODHD/GICS labels round-trip, and an absent/malformed/unmapped SIC →
None (the caller renders 'Unknown', never a guessed sector). Pure — no I/O, no lake.
"""
from __future__ import annotations

import pytest

from quant_core.fundamentals.lake.sic_sector import (
    SECTOR_BASIC_MATERIALS,
    SECTOR_COMMUNICATION_SERVICES,
    SECTOR_CONSUMER_CYCLICAL,
    SECTOR_CONSUMER_DEFENSIVE,
    SECTOR_ENERGY,
    SECTOR_FINANCIAL_SERVICES,
    SECTOR_HEALTHCARE,
    SECTOR_INDUSTRIALS,
    SECTOR_REAL_ESTATE,
    SECTOR_TECHNOLOGY,
    SECTOR_UTILITIES,
    sector_for_sic,
)


@pytest.mark.parametrize(
    "sic,expected",
    [
        # Real, well-known issuers (the labels QA spot-checks on /scanner).
        ("7372", SECTOR_TECHNOLOGY),            # Microsoft — prepackaged software
        ("3674", SECTOR_TECHNOLOGY),            # NVIDIA / Intel — semiconductors
        ("3571", SECTOR_TECHNOLOGY),            # Apple — electronic computers
        ("3661", SECTOR_TECHNOLOGY),            # Cisco — telephone & telegraph apparatus
        ("7370", SECTOR_TECHNOLOGY),            # computer services
        ("3812", SECTOR_INDUSTRIALS),           # RTX / Lockheed / Northrop — defense (carve-out, not Healthcare)
        ("3585", SECTOR_INDUSTRIALS),           # Carrier / Trane — refrigeration machinery (not Technology)
        ("3634", SECTOR_INDUSTRIALS),           # Whirlpool — household appliances (not Technology)
        ("3690", SECTOR_INDUSTRIALS),           # misc electrical machinery (not Technology)
        ("2631", SECTOR_BASIC_MATERIALS),       # International Paper — paperboard mills (not Consumer Cyclical)
        (2834, SECTOR_HEALTHCARE),             # Pfizer — pharmaceutical preparations (int input)
        ("2836", SECTOR_HEALTHCARE),            # biological products
        ("3841", SECTOR_HEALTHCARE),            # surgical & medical instruments
        ("8011", SECTOR_HEALTHCARE),            # offices of physicians — health services
        ("1311", SECTOR_ENERGY),               # Exxon — crude petroleum & natural gas
        ("2911", SECTOR_ENERGY),               # petroleum refining
        ("6021", SECTOR_FINANCIAL_SERVICES),    # JPMorgan — national commercial bank
        ("6311", SECTOR_FINANCIAL_SERVICES),    # life insurance
        ("6199", SECTOR_FINANCIAL_SERVICES),    # finance services
        ("6770", SECTOR_FINANCIAL_SERVICES),    # blank checks / holding offices
        ("6798", SECTOR_REAL_ESTATE),           # REIT (carve-out before the wider 6700 band)
        ("6500", SECTOR_REAL_ESTATE),           # real estate
        ("4911", SECTOR_UTILITIES),             # electric services
        ("4813", SECTOR_COMMUNICATION_SERVICES),  # telephone communications
        ("7812", SECTOR_COMMUNICATION_SERVICES),  # motion picture production
        ("3711", SECTOR_CONSUMER_CYCLICAL),     # motor vehicles
        ("5651", SECTOR_CONSUMER_CYCLICAL),     # family clothing stores
        ("5812", SECTOR_CONSUMER_CYCLICAL),     # eating places
        ("2080", SECTOR_CONSUMER_DEFENSIVE),    # beverages
        ("2111", SECTOR_CONSUMER_DEFENSIVE),    # cigarettes
        ("5411", SECTOR_CONSUMER_DEFENSIVE),    # grocery stores (carve-out before the wider 5200 band)
        ("2821", SECTOR_BASIC_MATERIALS),       # plastics materials & resins (chemicals)
        ("1040", SECTOR_BASIC_MATERIALS),       # gold mining
        ("3312", SECTOR_BASIC_MATERIALS),       # steel works
        ("3559", SECTOR_INDUSTRIALS),           # special industry machinery
        ("1531", SECTOR_INDUSTRIALS),           # operative builders — construction
        ("4011", SECTOR_INDUSTRIALS),           # railroads
        ("5122", SECTOR_INDUSTRIALS),           # drugs wholesale (wholesale trade → industrials)
    ],
)
def test_known_sics_map_to_the_expected_sector(sic, expected):
    assert sector_for_sic(sic) == expected


def test_carve_outs_win_over_their_wider_band():
    # Each carve-out band is checked BEFORE the wider band it sits inside — the first containing band
    # wins, so the narrower sector label is returned, not the wider one.
    assert sector_for_sic("1311") == SECTOR_ENERGY            # oil&gas inside Mining(BasicMaterials)
    assert sector_for_sic("2631") == SECTOR_BASIC_MATERIALS   # paper inside Textiles(Cyclical)
    assert sector_for_sic("2834") == SECTOR_HEALTHCARE        # drugs inside Chemicals(BasicMaterials)
    assert sector_for_sic("3571") == SECTOR_TECHNOLOGY        # computers inside Machinery(Industrials)
    assert sector_for_sic("3674") == SECTOR_TECHNOLOGY        # semis inside Machinery(Industrials)
    # The Tech electronics carve-out is 3660–3679 (comms/semis), NOT the low 36xx: appliances (3634
    # Whirlpool) + electrical apparatus (3612) must fall through to Industrials, not the Tech band.
    assert sector_for_sic("3634") == SECTOR_INDUSTRIALS       # household appliances — Industrials, not Tech
    assert sector_for_sic("3612") == SECTOR_INDUSTRIALS       # power transformers — Industrials, not Tech
    assert sector_for_sic("3812") == SECTOR_INDUSTRIALS       # defense inside Instruments(Healthcare)
    assert sector_for_sic("5411") == SECTOR_CONSUMER_DEFENSIVE  # food stores inside Retail(Cyclical)
    assert sector_for_sic("6798") == SECTOR_REAL_ESTATE       # REIT inside Holding(FinancialServices)


@pytest.mark.parametrize("bad", [None, "", "   ", "n/a", "abc", "Software", True, False, "99999999"])
def test_absent_or_unmapped_sic_returns_none(bad):
    # Unparseable / empty / a description slipped in / a SIC outside every band → None (the caller
    # renders 'Unknown', cap-exempt — never a guessed sector). bool is excluded (int subclass).
    assert sector_for_sic(bad) is None


def test_every_returned_label_is_one_of_the_eleven_gics_sectors():
    labels = {
        SECTOR_BASIC_MATERIALS, SECTOR_COMMUNICATION_SERVICES, SECTOR_CONSUMER_CYCLICAL,
        SECTOR_CONSUMER_DEFENSIVE, SECTOR_ENERGY, SECTOR_FINANCIAL_SERVICES, SECTOR_HEALTHCARE,
        SECTOR_INDUSTRIALS, SECTOR_REAL_ESTATE, SECTOR_TECHNOLOGY, SECTOR_UTILITIES,
    }
    # Sweep every SIC 0..9999; whatever resolves must be one of the eleven labels (never a stray string).
    for code in range(0, 10000):
        label = sector_for_sic(code)
        if label is not None:
            assert label in labels

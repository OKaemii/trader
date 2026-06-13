"""SEC SIC code → GICS-style **sector LABEL** (epic pit-fundamentals-lake-rearchitecture, Thread C /
Task 19).

This is DISTINCT from `metrics.template_for_sic`, which classifies a filer into a registry *metric
template* (`bank | insurance | reit | utility | general`) so the standardization picks the right XBRL
tag. THIS map produces a human-facing **sector label** for the active-universe sector cap +
`/scanner` display — the SECONDARY sector source for curated/US names, behind the EODHD screener row
(the primary). The labels match the EODHD screener's sector vocabulary (Yahoo/GICS-style:
``Technology``, ``Financial Services``, ``Healthcare``, …) so the two sources count COHERENTLY against
the same 35%-per-sector cap (a name sectored "Technology" by EODHD and one sectored "Technology" by
SIC fall in the same bucket — mixing a registry-template vocabulary here would split the bucket).

WHY A COARSE DIVISION MAP, NOT A 1000-LINE SIC TABLE. The sector cap is a coarse diversification
guard, not a taxonomy; mapping the SIC's broad **divisions / major groups** (the leading 2 digits) to
the eleven GICS sectors is the honest scope (the same data-light philosophy as
`normalize/sectors.py`). The bands below follow the SEC Standard Industrial Classification division
structure (https://www.sec.gov/corpfin/division-of-corporation-finance-standard-industrial):

  * 0100–0999  Agriculture, Forestry, Fishing            → Basic Materials
  * 1000–1499  Mining (metal/coal/nonmetallic)           → Basic Materials
  * 1300–1399  Oil & Gas Extraction                      → Energy            (carve-out of Mining)
  * 1500–1799  Construction                              → Industrials
  * 2000–2099  Food & Kindred Products                   → Consumer Defensive
  * 2080–2085  Beverages                                 → Consumer Defensive
  * 2100–2199  Tobacco                                   → Consumer Defensive
  * 2200–2799  Textiles / Apparel / Paper / Printing     → Consumer Cyclical
  * 2800–2899  Chemicals (incl. industrial/ag chem)      → Basic Materials
  * 2833–2836  Drugs / Biologicals                       → Healthcare        (carve-out of Chemicals)
  * 2900–2999  Petroleum Refining                        → Energy
  * 3000–3399  Rubber / Plastics / Leather / Stone / Metals → Basic Materials
  * 3400–3569  Fabricated Metal / Machinery (non-computer) → Industrials
  * 3570–3579  Computer & Office Equipment               → Technology
  * 3600–3674  Electronics / Semiconductors              → Technology
  * 3700–3799  Transportation Equipment (auto/aero)      → Consumer Cyclical
  * 3800–3851  Instruments / Medical devices             → Healthcare
  * 3852–3999  Photographic / misc manufacturing         → Industrials
  * 4000–4799  Transportation (rail/truck/air/water)     → Industrials
  * 4800–4899  Communications (telephone/broadcast)      → Communication Services
  * 4900–4991  Electric / Gas / Water / Sanitary         → Utilities
  * 5000–5199  Wholesale Trade                           → Industrials
  * 5200–5599  Retail (building/general/auto)            → Consumer Cyclical
  * 5400–5499  Food Stores                               → Consumer Defensive (carve-out of Retail)
  * 5600–5799  Apparel / Furniture / Eating places       → Consumer Cyclical
  * 5800–5899  Eating & Drinking Places                  → Consumer Cyclical
  * 5900–5999  Misc Retail (incl. drug stores)           → Consumer Cyclical
  * 6000–6199  Depository / Non-depository Credit         → Financial Services
  * 6200–6299  Securities / Commodity Brokers            → Financial Services
  * 6300–6499  Insurance                                 → Financial Services
  * 6500–6599  Real Estate                               → Real Estate
  * 6798       Real Estate Investment Trusts             → Real Estate
  * 6700–6799  Holding / Investment Offices              → Financial Services
  * 7000–7299  Hotels / Personal & Business Services     → Consumer Cyclical
  * 7300–7372  Services-Computer Programming/Software     → Technology
  * 7373–7379  Computer Services / Data Processing        → Technology
  * 7380–7799  Other Business / Auto / Misc Repair Svcs   → Consumer Cyclical
  * 7800–7999  Motion Pictures / Amusement / Recreation   → Communication Services
  * 8000–8099  Health Services                           → Healthcare
  * 8100–8999  Legal / Educational / Social / Eng Svcs    → Industrials
  * else / unparseable / absent                          → None (caller → 'Unknown')

The carve-outs (oil-&-gas inside Mining, drugs inside Chemicals, computer/semis inside Machinery,
software inside Services, food stores inside Retail) are encoded as NARROWER bands placed BEFORE the
wider band; the first containing band wins. An unmapped / malformed / absent SIC returns ``None`` — the
caller renders ``'Unknown'`` (cap-exempt), never a guessed sector. Pure + total — no I/O, no
exceptions on bad input.
"""
from __future__ import annotations

# GICS-style sector labels — the EODHD screener's vocabulary, so the SIC secondary and the EODHD
# primary count into the same sector-cap bucket. Spelled once here; the universe never re-types them.
SECTOR_BASIC_MATERIALS = "Basic Materials"
SECTOR_COMMUNICATION_SERVICES = "Communication Services"
SECTOR_CONSUMER_CYCLICAL = "Consumer Cyclical"
SECTOR_CONSUMER_DEFENSIVE = "Consumer Defensive"
SECTOR_ENERGY = "Energy"
SECTOR_FINANCIAL_SERVICES = "Financial Services"
SECTOR_HEALTHCARE = "Healthcare"
SECTOR_INDUSTRIALS = "Industrials"
SECTOR_REAL_ESTATE = "Real Estate"
SECTOR_TECHNOLOGY = "Technology"
SECTOR_UTILITIES = "Utilities"

# (low, high) inclusive SIC bands → sector label. Checked in order; the FIRST containing band wins, so
# a narrower carve-out (e.g. drugs 2833–2836) MUST precede the wider band it sits inside (chemicals
# 2800–2899). See the module docstring for each band's provenance.
_SIC_SECTOR_BANDS: tuple[tuple[int, int, str], ...] = (
    # Agriculture / Forestry / Fishing.
    (100, 999, SECTOR_BASIC_MATERIALS),
    # Mining — oil & gas extraction (1300–1399) carved out to Energy before the wider Mining band.
    (1300, 1399, SECTOR_ENERGY),
    (1000, 1499, SECTOR_BASIC_MATERIALS),
    # Construction.
    (1500, 1799, SECTOR_INDUSTRIALS),
    # Food / beverages / tobacco — consumer staples.
    (2000, 2199, SECTOR_CONSUMER_DEFENSIVE),
    # Textiles / apparel / lumber / furniture / paper / printing — cyclical goods.
    (2200, 2799, SECTOR_CONSUMER_CYCLICAL),
    # Chemicals — drugs/biologicals (2833–2836) carved out to Healthcare before the wider Chemicals band.
    (2833, 2836, SECTOR_HEALTHCARE),
    (2800, 2899, SECTOR_BASIC_MATERIALS),
    # Petroleum refining.
    (2900, 2999, SECTOR_ENERGY),
    # Rubber / plastics / leather / stone-clay-glass / primary & fabricated metals (non-machinery).
    (3000, 3399, SECTOR_BASIC_MATERIALS),
    # Fabricated metal + machinery (non-computer).
    (3400, 3569, SECTOR_INDUSTRIALS),
    # Computer & office equipment.
    (3570, 3579, SECTOR_TECHNOLOGY),
    # Electronic / electrical equipment incl. semiconductors.
    (3580, 3699, SECTOR_TECHNOLOGY),
    # Transportation equipment (motor vehicles, aerospace, ships) — cyclical.
    (3700, 3799, SECTOR_CONSUMER_CYCLICAL),
    # Measuring / analysing / controlling instruments + medical/surgical devices.
    (3800, 3851, SECTOR_HEALTHCARE),
    # Photographic / watches / misc manufacturing.
    (3852, 3999, SECTOR_INDUSTRIALS),
    # Transportation services (rail / trucking / air / water / pipelines, ex-communications).
    (4000, 4799, SECTOR_INDUSTRIALS),
    # Communications (telephone, telegraph, radio/TV broadcast, cable).
    (4800, 4899, SECTOR_COMMUNICATION_SERVICES),
    # Electric / gas / water / sanitary / combination utilities.
    (4900, 4991, SECTOR_UTILITIES),
    # Wholesale trade (durable + non-durable goods).
    (5000, 5199, SECTOR_INDUSTRIALS),
    # Retail — food stores (5400–5499) carved out to Consumer Defensive before the wider Retail band.
    (5400, 5499, SECTOR_CONSUMER_DEFENSIVE),
    (5200, 5999, SECTOR_CONSUMER_CYCLICAL),
    # Finance — depository/credit, brokers, insurance, holding & investment offices.
    (6000, 6499, SECTOR_FINANCIAL_SERVICES),
    # Real estate operators / developers / agents.
    (6500, 6599, SECTOR_REAL_ESTATE),
    # Real estate investment trusts (the one SIC the REIT band keys on) before the wider holding band.
    (6798, 6798, SECTOR_REAL_ESTATE),
    (6700, 6799, SECTOR_FINANCIAL_SERVICES),
    # Hotels / personal services / business services.
    (7000, 7299, SECTOR_CONSUMER_CYCLICAL),
    # Computer programming / software / data-processing services.
    (7300, 7379, SECTOR_TECHNOLOGY),
    # Other business / auto / misc repair services — cyclical.
    (7380, 7799, SECTOR_CONSUMER_CYCLICAL),
    # Motion pictures / amusement / recreation.
    (7800, 7999, SECTOR_COMMUNICATION_SERVICES),
    # Health services.
    (8000, 8099, SECTOR_HEALTHCARE),
    # Legal / educational / social / membership / engineering & management services.
    (8100, 8999, SECTOR_INDUSTRIALS),
)


def _coerce_sic(sic: object) -> int | None:
    """A SIC value (int, a '7372' string, or None) → its int code, or None when absent/unparseable.

    EDGAR's `entities.parquet` stores `sic` as a 4-digit string (from `/submissions`, sometimes with
    stray whitespace); a few sources give an int. Anything non-numeric (a description slipped in, an
    empty string) ⇒ None so the caller falls back to ``None`` (→ 'Unknown') rather than crashing.
    Mirrors `metrics._coerce_sic` exactly — `bool` is excluded (it is an int subclass)."""
    if sic is None:
        return None
    if isinstance(sic, bool):  # bool is an int subclass — exclude it explicitly
        return None
    if isinstance(sic, int):
        return sic
    s = str(sic).strip()
    if not s.isdigit():
        return None
    return int(s)


def sector_for_sic(sic: object) -> str | None:
    """Map a filer's SEC SIC code to a GICS-style sector LABEL (the EODHD-vocabulary sector the universe
    cap counts on), or ``None`` when the SIC is absent/unparseable/unmapped.

    Returns one of the eleven EODHD/GICS sector labels for a SIC in a mapped band; ``None`` otherwise.
    The caller (the universe sector enrichment, the read-API `/sectors` route) renders ``None`` as the
    cap-exempt ``'Unknown'`` placeholder — never a guessed sector. Pure + total — no I/O, no exceptions
    on bad input (a malformed SIC degrades to ``None``)."""
    code = _coerce_sic(sic)
    if code is None:
        return None
    for low, high, label in _SIC_SECTOR_BANDS:
        if low <= code <= high:
            return label
    return None

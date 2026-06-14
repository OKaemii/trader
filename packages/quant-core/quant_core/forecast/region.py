"""Region-bucket seam for the analyst-free forecast pool.

WHY this exists at all today, when there is only one populated region. The cross-sectional regressions
(Li-Mohanram RI/EP, HVZ) and the growth-shrinkage step pool firms and shrink toward a per-region
median. Mechanical forecasts are estimated *within* a region so the cross-section is economically
comparable (a US name is not ranked against an EM name's accounting + macro regime). The estimation
pool today is **US only** — the EDGAR lake is US-only and non-US fundamentals fail closed
(``pit-fundamentals-lake-rearchitecture`` Thread C; CLAUDE.md § Fundamentals): an LSE / foreign name
has ZERO point-in-time fundamentals, so it cannot enter a regression pool. ``region_of`` therefore
resolves **everything to ``'US'`` today** — the only populated pool.

The dev-ex-US / EM buckets are a deliberate FORWARD SEAM, not dead code: the scope decision (operator,
2026-06-14) is "US-only now, build the region seam, defer all non-US to **card 131** (UK PIT against
the FCA NSM / UKSEF iXBRL)". Scaling every regression input by total assets (``features.py``) is
adopted now precisely so the pool is currency-free the day a second region lands — at which point
``region_of`` starts routing LSE → ``'DEV_EX_US'`` (and a future EM market list → ``'EM'``) and the
ensemble shrinks each name toward *its own* region median. Keeping the three-way ``Region`` literal in
the type system now means the downstream cross-sectional / ensemble code is written region-aware from
day one; flipping a market into a populated bucket is then a one-line change here, not a refactor.

The seam is intentionally minimal — a pure, total function over ``TickerIdentity.market``. It does NOT
gate fail-closed behaviour (that is the lake's job: ``pit_metric_history`` already returns ``[]`` for a
non-US identity); it only labels which estimation pool a name belongs to. A name whose region has too
few members to fit a regression is dropped *by the cross-sectional layer* (a region with ``< N`` names
yields no fit, never garbage) — not here.
"""
from __future__ import annotations

from typing import Literal

from quant_core.ticker_identity import TickerIdentity

# The estimation-pool buckets. ``US`` is the only populated pool today; ``DEV_EX_US`` (developed
# markets ex-US — the card-131 UK PIT bucket lands here first) and ``EM`` (emerging markets) are the
# forward seam, empty until a non-US PIT source exists. Mirrors the brief's US / developed-ex-US / EM
# segmentation.
Region = Literal["US", "DEV_EX_US", "EM"]

# The ordered tuple of valid region keys — the cross-sectional / ensemble layers iterate these to fit
# and shrink per pool. Declared once here so a new region is added in exactly one place.
REGIONS: tuple[Region, ...] = ("US", "DEV_EX_US", "EM")

# The market → region routing table. TODAY every tradable market maps to ``US``: the US market IS the
# US pool, and LSE (the only other tradable market — ``TickerIdentity.market`` is ``Literal['US',
# 'LSE']``) also routes to ``US`` because LSE names have no PIT fundamentals to pool yet, so labelling
# them ``DEV_EX_US`` would create an empty-but-referenced bucket before card 131 populates it. When the
# UK PIT source lands (card 131), flip ``'LSE': 'DEV_EX_US'`` here and the ensemble shrinks LSE names
# toward the dev-ex-US median instead of the US one — the only change required.
_MARKET_TO_REGION: dict[str, Region] = {
    "US": "US",
    "LSE": "US",  # card-131 seam: becomes 'DEV_EX_US' once UK PIT fundamentals exist
}


def region_of(ident: TickerIdentity) -> Region:
    """The estimation-pool region a name belongs to.

    Pure + total: a ``TickerIdentity`` (bare ``symbol`` + ``market``) maps to one of ``US`` /
    ``DEV_EX_US`` / ``EM`` via :data:`_MARKET_TO_REGION`. **Today every market resolves to ``'US'``**
    — the only populated pool (the EDGAR lake is US-only; non-US fundamentals fail closed, so a non-US
    name has nothing to pool). The dev-ex-US / EM buckets are the card-131 forward seam (see the module
    docstring). An unrecognised market (impossible under the ``Literal['US','LSE']`` type, but defended
    against a future third member arriving before its mapping) falls back to ``'US'`` — the safe pool
    that never *invents* a region for a name we cannot place, consistent with the lake's "a borderline
    case stays general" stance.
    """
    return _MARKET_TO_REGION.get(ident.market, "US")

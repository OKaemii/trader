"""Sector-template selection by SIC (epic Task 7).

The stage resolver (Task 6) takes a `sector` parameter that switches the per-sector candidate-tag
overrides in `metric_registry.yaml` — a bank's revenue is `RevenuesNetOfInterestExpense`, not a
product-sale `RevenueFromContractWithCustomer…`; a bank/insurer/REIT has no `gross_profit` /
`current_assets` (those overrides are empty ⇒ the metric is NaN-excluded, never fabricated). This
module is the ONE place that classifies a filer's SEC SIC code into the registry's template name, so
the normalizer can hand `stage.resolve_metrics(sector=...)` the right template.

THE TEMPLATE SET matches `metric_registry.yaml` exactly: ``general | bank | insurance | reit |
utility`` (the resolver lower-cases the sector key, and the YAML overrides are keyed on these names).
A SIC that doesn't fall in a financial/utility band → ``general`` (the default candidate lists).

SIC BANDS (SEC Standard Industrial Classification, the `sic` field EDGAR's `submissions.json` carries
on every filer — Division H "Finance, Insurance, and Real Estate" 6000–6799 + Division E
"Transportation … Electric, Gas, and Sanitary Services" 4900–4991):

  * BANK       6020–6079 (national/state commercial banks, savings institutions, credit unions),
               6120 (savings institutions), 6712 (bank holding companies). Depository + bank holdcos.
  * INSURANCE  6300–6411 (life/accident-health/fire-marine-casualty/title/surety carriers + agents).
  * REIT       6798 (real estate investment trusts) — the one SIC the REIT template keys on.
  * UTILITY    4900–4991 (electric, gas, water, sanitary, combination utilities).
  * GENERAL    everything else (industrials, tech, retail, healthcare, …) → the default registry.

The bands are intentionally CONSERVATIVE — only the SIC ranges whose accounting genuinely breaks the
default tag choices (a financial has no gross profit / current-asset split; a bank's "revenue" is net
interest income) are mapped. A borderline financial-services SIC outside these bands stays ``general``
(its default tags still resolve; the value-agreement guard + Task 8 QA catch a genuine mismatch). The
map is DATA-light by design: SIC→template is a coarse routing decision, not a taxonomy — keeping it a
small, auditable set of ranges (rather than the full 1000-line SIC table) is the honest scope.

A missing/unparseable SIC (a filer EDGAR never classified, or a non-US name with no SIC) ⇒ ``general``
— never a guess. The normalizer logs the fallback; the default template is the safe choice (it never
*suppresses* a metric the way a wrong financial template would).
"""
from __future__ import annotations

from typing import Optional

# Registry template names — MUST match metric_registry.yaml's `sectors.<template>` keys + the
# resolver's DEFAULT_SECTOR. Imported by the writer/cron so the spelling is shared, not re-typed.
TEMPLATE_GENERAL = "general"
TEMPLATE_BANK = "bank"
TEMPLATE_INSURANCE = "insurance"
TEMPLATE_REIT = "reit"
TEMPLATE_UTILITY = "utility"

TEMPLATES: tuple[str, ...] = (
    TEMPLATE_GENERAL,
    TEMPLATE_BANK,
    TEMPLATE_INSURANCE,
    TEMPLATE_REIT,
    TEMPLATE_UTILITY,
)

# (low, high) inclusive SIC bands → template. Checked in order; first containing band wins. Singleton
# SICs (e.g. REIT 6798) are encoded as (n, n). See the module docstring for the provenance of each band.
_SIC_BANDS: tuple[tuple[int, int, str], ...] = (
    # Banks / depositories / bank holding companies.
    (6020, 6079, TEMPLATE_BANK),
    (6120, 6120, TEMPLATE_BANK),
    (6712, 6712, TEMPLATE_BANK),
    # Insurance carriers + agents.
    (6300, 6411, TEMPLATE_INSURANCE),
    # Real estate investment trusts.
    (6798, 6798, TEMPLATE_REIT),
    # Electric / gas / water / sanitary / combination utilities.
    (4900, 4991, TEMPLATE_UTILITY),
)


def _coerce_sic(sic: object) -> Optional[int]:
    """A SIC value (int, a '6021' string, or None) → its int code, or None when absent/unparseable.

    EDGAR's `submissions.json` gives `sic` as a 4-digit string (sometimes with stray whitespace);
    a few feeds give an int. Anything non-numeric (a description slipped in, an empty string) ⇒ None
    so the caller falls back to ``general`` rather than crashing on a malformed code."""
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


def template_for_sic(sic: object) -> str:
    """Classify a filer's SEC SIC code into a registry sector template.

    Returns one of ``general | bank | insurance | reit | utility`` — the exact key
    `stage.resolve_metrics(sector=...)` switches the candidate-tag overrides on. A SIC in a mapped
    financial/utility band returns that template; everything else (and a missing/unparseable SIC)
    returns ``general``. Pure + total — no I/O, no exceptions on bad input (a malformed SIC degrades
    to ``general``, the safe default)."""
    code = _coerce_sic(sic)
    if code is None:
        return TEMPLATE_GENERAL
    for low, high, template in _SIC_BANDS:
        if low <= code <= high:
            return template
    return TEMPLATE_GENERAL

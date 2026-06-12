"""Tests for the PIT-lake query-time metric standardization (epic Task 4).

`lake.metrics` translates the gold tag genealogy (`metric_registry.yaml`) into an ordered-fallback
map and assembles standardized, PIT-correct series off whatever rows `store.pit_series(...)` returns.
These tests pin the contract requirements:

  1. **Every filed LINE_ITEM resolves** on a synthetic fact set (the 11 filed metrics — flows +
     instants — keyed by their `LINE_ITEMS` names so the Task-6 contract layer needs no rename).
  2. **IFRS fallback ordering** — a 20-F/IFRS filer resolves `net_income` from `ifrs-full:ProfitLoss`
     when that is the only tag present; a DUAL-tagger (both us-gaap and ifrs-full present for the same
     period) keeps the us-gaap value (us-gaap precedes ifrs-full in every fallback list).
  3. **`total_debt` SELECTS, never sums** — when a filer tags both a reported total
     (`DebtAndCapitalLeaseObligations`) AND a component (`LongTermDebt`), the resolved value is the
     single best-available *reported* total, not their sum (summation would double-count).
  4. **Derived-Q4 PIT safety** — the synthesized Q4 carries `filed = max(inputs.filed)`, so it never
     surfaces in an as-of view before every input was public; value = FY - (Q1+Q2+Q3).
  5. **TTM needs four consecutive quarters** — a complete four-quarter window sums; a window with a
     missing quarter (a >120-day end-to-end gap) is skipped, not silently stitched.
  6. **Sector-override selection** — a `sector` template key picks the bank/reit override concept
     list; an empty override (a bank's `gross_profit`) yields no fact (fail-closed).

SOURCE-AGNOSTIC fixture. `FakeStore` mimics `store.pit_series`: it holds raw facts keyed by
`(taxonomy, concept, unit)`, applies the PIT filter on `filed <= as_of` and the latest-knowledge
supersede (highest `filed`/`accession` per period wins) IN THE FIXTURE — exactly the contract the
real DuckDB store (Task 5) implements — and returns rows with the `start`/`end`/`value`/`filed`/
`accession`/`form` shape `metrics` consumes. `metrics` itself never touches the lake, so this fully
exercises the standardization logic with no pyarrow/DuckDB dependency (this suite runs even where the
`[lake]` extra is absent).
"""
from __future__ import annotations

from datetime import date

from quant_core.fundamentals.contract import LINE_ITEMS
from quant_core.fundamentals.lake.metrics import (
    DERIVED,
    METRICS,
    SECTOR_TEMPLATES,
    merged_series,
    metric_series,
    split_periods,
    ttm,
    with_derived_q4,
)


# --------------------------------------------------------------------------------------------------- #
# Source-agnostic fake store (mirrors the real `store.pit_series` contract, Task 5)                    #
# --------------------------------------------------------------------------------------------------- #
def _d(s: str) -> date:
    return date.fromisoformat(s)


class FakeStore:
    """Holds raw facts and serves them through the same `pit_series` contract the DuckDB store will.

    A fact is `(taxonomy, concept, unit, start|None, end, value, filed, accession, form)`. The store
    contract: PIT-filter on `filed <= as_of`, then per fiscal period keep the latest-knowledge row
    (highest `filed`, ties broken by `accession`) — restatements supersede. Returns rows sorted by
    `end` with the keys `metrics` reads.
    """

    def __init__(self) -> None:
        self.facts: list[dict] = []

    def add(self, taxonomy: str, concept: str, end: str, value: float,
            filed: str, accession: str, form: str = "10-K",
            unit: str = "USD", start: str | None = None) -> "FakeStore":
        self.facts.append({
            "taxonomy": taxonomy, "concept": concept, "unit": unit,
            "start": _d(start) if start else None, "end": _d(end),
            "value": float(value), "filed": _d(filed),
            "accession": accession, "form": form,
        })
        return self

    def pit_series(self, cik: int, taxonomy: str, concept: str, unit: str,
                   as_of: date, instant: bool) -> list[dict]:
        # PIT filter: only facts public by `as_of`, matching the concept/unit.
        candidates = [
            f for f in self.facts
            if f["taxonomy"] == taxonomy and f["concept"] == concept
            and f["unit"] == unit and f["filed"] <= as_of
        ]
        # Latest knowledge wins per fiscal period (the supersede the store does via row_number()).
        by_period: dict[tuple, dict] = {}
        partition_key = (lambda f: (f["end"],)) if instant else (lambda f: (f["start"], f["end"]))
        for f in sorted(candidates, key=lambda f: (f["filed"], f["accession"])):
            by_period[partition_key(f)] = f  # later iteration (higher filed/accn) overwrites
        rows = [
            {"start": f["start"], "end": f["end"], "value": f["value"],
             "filed": f["filed"], "accession": f["accession"], "form": f["form"]}
            for f in by_period.values()
        ]
        return sorted(rows, key=lambda r: r["end"])


AS_OF_NOW = _d("2030-01-01")


def _quarters_2023(store: FakeStore, concept: str, vals: tuple[float, float, float],
                   taxonomy: str = "us-gaap", unit: str = "USD") -> FakeStore:
    """Seed Q1-Q3 2023 + the FY for a flow concept (so Q4 derivation has its three inputs)."""
    store.add(taxonomy, concept, "2023-03-31", vals[0], "2023-05-01", "Q1", "10-Q", unit, "2023-01-01")
    store.add(taxonomy, concept, "2023-06-30", vals[1], "2023-08-01", "Q2", "10-Q", unit, "2023-04-01")
    store.add(taxonomy, concept, "2023-09-30", vals[2], "2023-11-01", "Q3", "10-Q", unit, "2023-07-01")
    return store


# --------------------------------------------------------------------------------------------------- #
# 1. Every filed LINE_ITEM resolves                                                                    #
# --------------------------------------------------------------------------------------------------- #
FILED_LINE_ITEMS = (
    "net_income", "total_revenue", "gross_profit", "cash_flow_ops",  # flows
    "total_assets", "total_liabilities", "total_equity",
    "current_assets", "current_liabilities", "total_debt", "shares_outstanding",  # instants
)


def test_all_filed_line_items_are_keys_in_metrics():
    """The 11 filed line items are each a `METRICS` key spelled exactly as in `LINE_ITEMS` (so the
    contract layer calls `metric_series(store, cik, "<line_item>")` with no rename)."""
    for li in FILED_LINE_ITEMS:
        assert li in METRICS, f"{li} missing from METRICS"
        assert li in LINE_ITEMS, f"{li} not a canonical LINE_ITEM"


def test_each_filed_line_item_resolves_on_synthetic_facts():
    """Seed the FIRST-priority us-gaap tag for each filed metric and assert it resolves to a value."""
    s = FakeStore()
    # Flows — seed an annual fact off each metric's top us-gaap concept.
    s.add("us-gaap", "NetIncomeLoss", "2023-12-31", 500, "2024-02-15", "F1", start="2023-01-01")
    s.add("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax", "2023-12-31", 4000,
          "2024-02-15", "F2", start="2023-01-01")
    s.add("us-gaap", "GrossProfit", "2023-12-31", 1500, "2024-02-15", "F3", start="2023-01-01")
    s.add("us-gaap", "NetCashProvidedByUsedInOperatingActivities", "2023-12-31", 800,
          "2024-02-15", "F4", start="2023-01-01")
    # Instants — seed each balance-sheet metric's top tag (no `start`).
    s.add("us-gaap", "Assets", "2023-12-31", 10000, "2024-02-15", "I1")
    s.add("us-gaap", "Liabilities", "2023-12-31", 6000, "2024-02-15", "I2")
    s.add("us-gaap", "StockholdersEquity", "2023-12-31", 4000, "2024-02-15", "I3")
    s.add("us-gaap", "AssetsCurrent", "2023-12-31", 3000, "2024-02-15", "I4")
    s.add("us-gaap", "LiabilitiesCurrent", "2023-12-31", 1500, "2024-02-15", "I5")
    s.add("us-gaap", "LongTermDebt", "2023-12-31", 2000, "2024-02-15", "I6")
    s.add("dei", "EntityCommonStockSharesOutstanding", "2023-12-31", 1e9, "2024-02-15", "I7",
          unit="shares")

    expected = {
        "net_income": 500, "total_revenue": 4000, "gross_profit": 1500, "cash_flow_ops": 800,
        "total_assets": 10000, "total_liabilities": 6000, "total_equity": 4000,
        "current_assets": 3000, "current_liabilities": 1500, "total_debt": 2000,
        "shares_outstanding": 1e9,
    }
    for metric, want in expected.items():
        freq = "a" if METRICS[metric]["kind"] == "flow" else "q"
        pts = metric_series(s, 1, metric, freq, AS_OF_NOW)["points"]
        assert pts, f"{metric} resolved no points"
        assert pts[-1]["value"] == want, f"{metric}: got {pts[-1]['value']}, want {want}"


def test_lower_priority_tag_used_when_top_absent():
    """A filer reporting only an older/lower-priority us-gaap tag still resolves off it."""
    s = FakeStore()
    # Only `Revenues` (priority 1), not the ASC-606 contract tag (priority 0).
    s.add("us-gaap", "Revenues", "2023-12-31", 3500, "2024-02-15", "R1", start="2023-01-01")
    pts = metric_series(s, 1, "total_revenue", "a", AS_OF_NOW)["points"]
    assert pts[-1]["value"] == 3500


# --------------------------------------------------------------------------------------------------- #
# 2. IFRS fallback ordering (us-gaap preferred)                                                        #
# --------------------------------------------------------------------------------------------------- #
def test_20f_filer_net_income_from_ifrs_profit_loss():
    """A 20-F IFRS filer (no us-gaap tags) resolves `net_income` off `ifrs-full:ProfitLoss`."""
    s = FakeStore()
    s.add("ifrs-full", "ProfitLoss", "2023-12-31", 750, "2024-04-30", "20F1",
          form="20-F", start="2023-01-01")
    pts = metric_series(s, 1, "net_income", "a", AS_OF_NOW)["points"]
    assert pts and pts[-1]["value"] == 750
    assert pts[-1]["concept"] == "ProfitLoss"
    assert pts[-1]["taxonomy"] == "ifrs-full"


def test_dual_tagger_prefers_us_gaap_over_ifrs():
    """When BOTH us-gaap:NetIncomeLoss and ifrs-full:ProfitLoss are tagged for the same period, the
    us-gaap value wins (us-gaap precedes ifrs-full in the fallback list)."""
    s = FakeStore()
    s.add("us-gaap", "NetIncomeLoss", "2023-12-31", 600, "2024-02-15", "US1", start="2023-01-01")
    s.add("ifrs-full", "ProfitLoss", "2023-12-31", 999, "2024-02-15", "IF1", start="2023-01-01")
    pts = metric_series(s, 1, "net_income", "a", AS_OF_NOW)["points"]
    assert pts[-1]["value"] == 600
    assert pts[-1]["taxonomy"] == "us-gaap"


def _assert_us_gaap_before_ifrs(label: str, concepts: list) -> None:
    seen_ifrs = False
    for taxonomy, _ in concepts:
        if taxonomy == "ifrs-full":
            seen_ifrs = True
        elif taxonomy == "us-gaap":
            assert not seen_ifrs, f"{label}: us-gaap tag follows ifrs-full"


def test_ifrs_aliases_after_us_gaap_in_every_metric_and_sector_override():
    """Structural invariant: no us-gaap tag follows an ifrs-full tag in ANY fallback list — the
    `default` concept list AND every sector override (the override lists bypass the
    `_ifrs_after_us_gaap` per-list wrap, so the import-time `_validate_sector_overrides_ifrs_order`
    pass + this test are what keep a future mis-ordered override from silently mis-prioritising)."""
    for metric, spec in METRICS.items():
        _assert_us_gaap_before_ifrs(metric, spec["concepts"])
        for tmpl, override in spec.get("sectors", {}).items():
            _assert_us_gaap_before_ifrs(f"{metric}.sectors.{tmpl}", override)


# --------------------------------------------------------------------------------------------------- #
# 3. total_debt SELECTS, never sums                                                                    #
# --------------------------------------------------------------------------------------------------- #
def test_total_debt_selects_reported_total_not_sum_of_components():
    """A filer tagging BOTH a reported total (`DebtAndCapitalLeaseObligations`, priority 0) AND a
    component (`LongTermDebt`, priority 2) for the same period resolves to the TOTAL alone — never
    total+component (which would double-count)."""
    s = FakeStore()
    s.add("us-gaap", "DebtAndCapitalLeaseObligations", "2023-12-31", 5000, "2024-02-15", "D1")
    s.add("us-gaap", "LongTermDebt", "2023-12-31", 4200, "2024-02-15", "D2")
    pts = metric_series(s, 1, "total_debt", "q", AS_OF_NOW)["points"]
    assert len(pts) == 1
    assert pts[-1]["value"] == 5000  # the reported total, NOT 5000 + 4200 = 9200
    assert pts[-1]["concept"] == "DebtAndCapitalLeaseObligations"


def test_total_debt_falls_through_to_component_when_no_total():
    """When only a component tag is present (no reported total), it is selected — preference order,
    still a single SELECT (never a sum)."""
    s = FakeStore()
    s.add("us-gaap", "LongTermDebt", "2023-12-31", 4200, "2024-02-15", "D2")
    s.add("us-gaap", "DebtCurrent", "2023-12-31", 300, "2024-02-15", "D3")
    pts = metric_series(s, 1, "total_debt", "q", AS_OF_NOW)["points"]
    assert pts[-1]["value"] == 4200  # LongTermDebt precedes DebtCurrent; NOT 4200 + 300
    assert pts[-1]["concept"] == "LongTermDebt"


# --------------------------------------------------------------------------------------------------- #
# 4. Derived-Q4 PIT safety (filed = max(inputs))                                                       #
# --------------------------------------------------------------------------------------------------- #
def test_q4_derived_value_and_filed_is_max_of_inputs():
    """Q4 = FY - (Q1+Q2+Q3); the derived row's `filed` is the max of its four inputs' filing dates."""
    s = FakeStore()
    _quarters_2023(s, "Revenues", (90, 100, 105))
    s.add("us-gaap", "Revenues", "2023-12-31", 400, "2024-02-15", "FY", "10-K", start="2023-01-01")
    pts = metric_series(s, 1, "total_revenue", "q", AS_OF_NOW)["points"]
    by_end = {p["end"].isoformat(): p for p in pts}
    q4 = by_end["2023-12-31"]
    assert q4["derived"] is True
    assert q4["value"] == 400 - (90 + 100 + 105)  # == 105
    # filed = max(Q1 2023-05-01, Q2 2023-08-01, Q3 2023-11-01, FY 2024-02-15) = the FY date.
    assert q4["filed"] == _d("2024-02-15")


def test_q4_not_visible_before_all_inputs_public():
    """As-of BEFORE the FY 10-K is filed, the derived Q4 must not appear (its `filed` postdates the
    cutoff) — the PIT-safety guarantee the `filed = max(inputs)` carry provides."""
    s = FakeStore()
    _quarters_2023(s, "Revenues", (90, 100, 105))
    s.add("us-gaap", "Revenues", "2023-12-31", 400, "2024-02-15", "FY", "10-K", start="2023-01-01")
    # Cutoff just before the FY filing: Q1-Q3 are public, the FY (and thus derived Q4) is not.
    pts = metric_series(s, 1, "total_revenue", "q", _d("2024-01-01"))["points"]
    ends = {p["end"].isoformat() for p in pts}
    assert "2023-12-31" not in ends
    assert ends == {"2023-03-31", "2023-06-30", "2023-09-30"}


def test_with_derived_q4_skips_non_additive():
    """Non-additive metrics (EPS/share counts) are never derived as FY-(Q1+Q2+Q3)."""
    quarters = [
        {"start": _d("2023-01-01"), "end": _d("2023-03-31"), "value": 1.0, "filed": _d("2023-05-01"),
         "accession": "Q1", "form": "10-Q", "taxonomy": "us-gaap", "concept": "EPS", "derived": False},
    ]
    annual = [
        {"start": _d("2023-01-01"), "end": _d("2023-12-31"), "value": 4.0, "filed": _d("2024-02-15"),
         "accession": "FY", "form": "10-K", "taxonomy": "us-gaap", "concept": "EPS", "derived": False},
    ]
    out = with_derived_q4(quarters, annual, additive=False)
    assert all(not r["derived"] for r in out)  # no derived Q4 injected


# --------------------------------------------------------------------------------------------------- #
# 5. TTM needs four consecutive quarters                                                               #
# --------------------------------------------------------------------------------------------------- #
def _q(end: str, value: float, filed: str) -> dict:
    start = {"03-31": "01-01", "06-30": "04-01", "09-30": "07-01", "12-31": "10-01"}[end[5:]]
    y = end[:4]
    return {"start": _d(f"{y}-{start}"), "end": _d(end), "value": value, "filed": _d(filed),
            "accession": end, "form": "10-Q", "taxonomy": "us-gaap", "concept": "Revenues",
            "derived": False}


def test_ttm_sums_four_consecutive_quarters():
    quarters = [
        _q("2023-03-31", 90, "2023-05-01"),
        _q("2023-06-30", 100, "2023-08-01"),
        _q("2023-09-30", 110, "2023-11-01"),
        _q("2023-12-31", 120, "2024-02-15"),
    ]
    out = ttm(quarters)
    assert len(out) == 1
    assert out[0]["value"] == 90 + 100 + 110 + 120  # 420
    assert out[0]["filed"] == _d("2024-02-15")  # latest input
    assert out[0]["derived"] is True


def test_ttm_skips_window_with_missing_quarter():
    """A four-row window spanning a missing quarter (a >120-day end-to-end gap) is NOT summed."""
    quarters = [
        _q("2023-03-31", 90, "2023-05-01"),
        _q("2023-06-30", 100, "2023-08-01"),
        # Q3 2023 missing → next is Q4, then Q1 2024: the window 03-31 → 12-31 has a >120d gap.
        _q("2023-12-31", 120, "2024-02-15"),
        _q("2024-03-31", 130, "2024-05-01"),
    ]
    out = ttm(quarters)
    assert out == []  # no valid consecutive-four window


def test_ttm_needs_at_least_four_quarters():
    assert ttm([_q("2023-03-31", 90, "2023-05-01")]) == []


def test_metric_series_ttm_for_flow():
    """End-to-end: `freq='ttm'` over a four-quarter flow yields the trailing sum."""
    s = FakeStore()
    s.add("us-gaap", "Revenues", "2023-03-31", 90, "2023-05-01", "Q1", "10-Q", start="2023-01-01")
    s.add("us-gaap", "Revenues", "2023-06-30", 100, "2023-08-01", "Q2", "10-Q", start="2023-04-01")
    s.add("us-gaap", "Revenues", "2023-09-30", 110, "2023-11-01", "Q3", "10-Q", start="2023-07-01")
    s.add("us-gaap", "Revenues", "2023-12-31", 400, "2024-02-15", "FY", "10-K", start="2023-01-01")
    # FY 400 with Q1-Q3 = 300 → derived Q4 = 100 → TTM = 90+100+110+100 = 400.
    pts = metric_series(s, 1, "total_revenue", "ttm", AS_OF_NOW)["points"]
    assert pts[-1]["value"] == 400


# --------------------------------------------------------------------------------------------------- #
# 6. Sector-override selection                                                                         #
# --------------------------------------------------------------------------------------------------- #
def test_bank_revenue_uses_override_concept_list():
    """A bank's `total_revenue` resolves off the override tag (`RevenuesNetOfInterestExpense`), NOT
    the default product-sales contract tag."""
    s = FakeStore()
    # Bank tags its net-interest revenue; it does NOT tag the product-sales contract concept.
    s.add("us-gaap", "RevenuesNetOfInterestExpense", "2023-12-31", 8000, "2024-02-15", "B1",
          start="2023-01-01")
    # Default template: no product-sales tag present → no fact.
    assert metric_series(s, 1, "total_revenue", "a", AS_OF_NOW)["points"] == []
    # Bank template: resolves off the override.
    pts = metric_series(s, 1, "total_revenue", "a", AS_OF_NOW, sector="bank")["points"]
    assert pts[-1]["value"] == 8000
    assert pts[-1]["concept"] == "RevenuesNetOfInterestExpense"


def test_reit_revenue_picks_reit_override_list():
    s = FakeStore()
    s.add("us-gaap", "Revenues", "2023-12-31", 2500, "2024-02-15", "RE1", start="2023-01-01")
    pts = metric_series(s, 1, "total_revenue", "a", AS_OF_NOW, sector="reit")["points"]
    assert pts[-1]["value"] == 2500


def test_bank_gross_profit_empty_override_is_fail_closed():
    """A bank has no gross-profit line: the empty override yields NO fact even if a stray GrossProfit
    tag exists — the empty list is honoured (fail-closed), not silently replaced by the default."""
    s = FakeStore()
    s.add("us-gaap", "GrossProfit", "2023-12-31", 100, "2024-02-15", "G1", start="2023-01-01")
    assert metric_series(s, 1, "gross_profit", "a", AS_OF_NOW, sector="bank")["points"] == []
    # Sanity: the same fact DOES resolve under the default (general) template.
    assert metric_series(s, 1, "gross_profit", "a", AS_OF_NOW)["points"][-1]["value"] == 100


def test_unknown_sector_falls_back_to_default():
    """A sector key a metric has no override for uses the default concept list."""
    s = FakeStore()
    s.add("us-gaap", "NetIncomeLoss", "2023-12-31", 500, "2024-02-15", "N1", start="2023-01-01")
    pts = metric_series(s, 1, "net_income", "a", AS_OF_NOW, sector="utility")["points"]
    assert pts[-1]["value"] == 500


def test_sector_templates_constant_matches_registry_names():
    assert SECTOR_TEMPLATES == ("general", "bank", "insurance", "reit", "utility")


# --------------------------------------------------------------------------------------------------- #
# Helpers (duration classification + restatement supersede)                                            #
# --------------------------------------------------------------------------------------------------- #
def test_split_periods_classifies_quarter_vs_annual():
    rows = [
        {"start": _d("2023-01-01"), "end": _d("2023-03-31"), "value": 1},   # ~90d quarter
        {"start": _d("2023-01-01"), "end": _d("2023-12-31"), "value": 4},   # ~365d annual
    ]
    quarters, annual = split_periods(rows)
    assert len(quarters) == 1 and len(annual) == 1
    assert quarters[0]["end"] == _d("2023-03-31")
    assert annual[0]["end"] == _d("2023-12-31")


def test_restatement_supersede_via_store_contract():
    """An amended FY value (later `filed`) supersedes the original at a later as-of; the original is
    still returned at an as-of before the amendment — the store contract `metrics` relies on."""
    s = FakeStore()
    s.add("us-gaap", "Revenues", "2023-12-31", 400, "2024-02-15", "A4", "10-K", start="2023-01-01")
    s.add("us-gaap", "Revenues", "2023-12-31", 402, "2024-08-10", "A5", "10-K/A", start="2023-01-01")
    before = metric_series(s, 1, "total_revenue", "a", _d("2024-03-01"))["points"][-1]
    after = metric_series(s, 1, "total_revenue", "a", _d("2025-01-01"))["points"][-1]
    assert before["value"] == 400
    assert after["value"] == 402


def test_merged_series_first_concept_claims_period():
    """When two fallback concepts both supply the same period, the higher-priority one claims it."""
    s = FakeStore()
    s.add("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax", "2023-12-31", 4000,
          "2024-02-15", "C1", start="2023-01-01")
    s.add("us-gaap", "Revenues", "2023-12-31", 3999, "2024-02-15", "C2", start="2023-01-01")
    spec = METRICS["total_revenue"]
    rows = merged_series(s, 1, spec, AS_OF_NOW)
    assert len(rows) == 1
    assert rows[0]["value"] == 4000  # the priority-0 contract tag, not Revenues
    assert rows[0]["concept"] == "RevenueFromContractWithCustomerExcludingAssessedTax"


def test_merged_series_does_not_mutate_store_rows():
    """`merged_series` stamps provenance on a COPY — the store's returned row is left untouched (so a
    store that caches/shares row objects is not corrupted, and `derived`/`concept` don't leak)."""

    class _SharedRowStore(FakeStore):
        def __init__(self) -> None:
            super().__init__()
            # A single shared row object the "store" hands back on every call (the worst case).
            self._row = {"start": _d("2023-01-01"), "end": _d("2023-12-31"), "value": 4000.0,
                         "filed": _d("2024-02-15"), "accession": "X", "form": "10-K"}

        def pit_series(self, cik, taxonomy, concept, unit, as_of, instant):
            return [self._row] if (taxonomy, concept) == ("us-gaap", "Revenues") else []

    store = _SharedRowStore()
    out = merged_series(store, 1, METRICS["total_revenue"], AS_OF_NOW)
    assert out and out[0]["concept"] == "Revenues" and out[0]["derived"] is False
    # The store's own row must NOT have gained provenance keys.
    assert "concept" not in store._row
    assert "derived" not in store._row
    assert "taxonomy" not in store._row


# --------------------------------------------------------------------------------------------------- #
# Robustness — a malformed null-start duration row degrades to omission, never crashes                 #
# --------------------------------------------------------------------------------------------------- #
def test_split_periods_skips_null_start_rows():
    """A duration row with no `start` (a malformed fact, or an instant that slipped into a duration
    query) is SKIPPED, not fed to `_dur` (which would raise `date - None`)."""
    rows = [
        {"start": None, "end": _d("2023-12-31"), "value": 1},          # malformed — skipped
        {"start": _d("2023-01-01"), "end": _d("2023-03-31"), "value": 2},  # real quarter
    ]
    quarters, annual = split_periods(rows)
    assert len(quarters) == 1 and quarters[0]["value"] == 2
    assert annual == []


def test_metric_series_flow_with_null_start_row_degrades_not_crashes():
    """A FLOW metric whose store returns a null-start row degrades to the well-formed periods only —
    the whole name's fundamentals must not raise (the `metric_series` → `split_periods` path)."""

    class _NullStartStore(FakeStore):
        def pit_series(self, cik, taxonomy, concept, unit, as_of, instant):
            if (taxonomy, concept) == ("us-gaap", "Revenues"):
                return [
                    {"start": None, "end": _d("2023-12-31"), "value": 9999.0,
                     "filed": _d("2024-02-15"), "accession": "BAD", "form": "10-K"},
                    {"start": _d("2023-01-01"), "end": _d("2023-03-31"), "value": 90.0,
                     "filed": _d("2023-05-01"), "accession": "Q1", "form": "10-Q"},
                ]
            return []

    pts = metric_series(_NullStartStore(), 1, "total_revenue", "q", AS_OF_NOW)["points"]
    ends = {p["end"].isoformat() for p in pts}
    assert "2023-12-31" not in ends  # the null-start row was dropped
    assert ends == {"2023-03-31"}


# --------------------------------------------------------------------------------------------------- #
# DERIVED metrics (free_cash_flow = cash_flow_ops - capex) — consumed by the read-API /metrics+/facts  #
# --------------------------------------------------------------------------------------------------- #
def test_free_cash_flow_is_a_derived_metric():
    assert DERIVED["free_cash_flow"] == ("cash_flow_ops", "-", "capex")


def _seed_quarterly_flow(store: FakeStore, concept: str, vals: dict[str, float]) -> None:
    """Seed quarterly + FY rows for a flow concept so Q4 derivation has its inputs. `vals` maps the
    period end (MM-DD or 'FY') to a value; 'FY' is the annual 10-K row."""
    cal = {"Q1": ("2023-01-01", "2023-03-31", "2023-05-01"),
           "Q2": ("2023-04-01", "2023-06-30", "2023-08-01"),
           "Q3": ("2023-07-01", "2023-09-30", "2023-11-01")}
    for q, (start, end, filed) in cal.items():
        if q in vals:
            store.add("us-gaap", concept, end, vals[q], filed, q, "10-Q", start=start)
    if "FY" in vals:
        store.add("us-gaap", concept, "2023-12-31", vals["FY"], "2024-02-15", "FY10K", "10-K",
                  start="2023-01-01")


def test_free_cash_flow_subtracts_aligned_periods():
    """Quarterly FCF = cash_flow_ops - capex per aligned (start,end); derived Q4 aligns on both legs."""
    s = FakeStore()
    _seed_quarterly_flow(s, "NetCashProvidedByUsedInOperatingActivities",
                         {"Q1": 200, "Q2": 220, "Q3": 240, "FY": 1000})  # derived Q4 = 340
    _seed_quarterly_flow(s, "PaymentsToAcquirePropertyPlantAndEquipment",
                         {"Q1": 50, "Q2": 55, "Q3": 60, "FY": 250})       # derived Q4 = 85
    pts = metric_series(s, 1, "free_cash_flow", "q", AS_OF_NOW)["points"]
    by_end = {p["end"].isoformat(): p for p in pts}
    assert by_end["2023-03-31"]["value"] == 200 - 50    # 150
    assert by_end["2023-12-31"]["value"] == 340 - 85    # 255 (derived Q4 of each leg)
    assert by_end["2023-12-31"]["derived"] is True
    assert "-" in by_end["2023-03-31"]["concept"]       # the concept string records the op


def test_free_cash_flow_annual():
    """Annual FCF aligns the two legs' annual rows."""
    s = FakeStore()
    s.add("us-gaap", "NetCashProvidedByUsedInOperatingActivities", "2023-12-31", 1000,
          "2024-02-15", "C1", "10-K", start="2023-01-01")
    s.add("us-gaap", "PaymentsToAcquirePropertyPlantAndEquipment", "2023-12-31", 250,
          "2024-02-15", "C2", "10-K", start="2023-01-01")
    pts = metric_series(s, 1, "free_cash_flow", "a", AS_OF_NOW)["points"]
    assert pts[-1]["value"] == 750
    # filed carry = max of the two legs' filed dates.
    assert pts[-1]["filed"] == _d("2024-02-15")


def test_free_cash_flow_omits_period_with_only_one_leg():
    """A period where only one leg reports (no aligned counterpart) is dropped — no half-derived FCF."""
    s = FakeStore()
    # cash_flow_ops annual present; capex annual ABSENT for the same period.
    s.add("us-gaap", "NetCashProvidedByUsedInOperatingActivities", "2023-12-31", 1000,
          "2024-02-15", "C1", "10-K", start="2023-01-01")
    assert metric_series(s, 1, "free_cash_flow", "a", AS_OF_NOW)["points"] == []

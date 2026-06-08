"""Stage resolver tests — the metric registry applied to raw facts (epic Task 6).

Per the card's constraint, raw facts are built by Task 5's PURE `parse_company_facts` over recorded
companyfacts-shaped JSON — no network, no DB. Every test asserts one of the six interpretation rules:
  1. highest-priority present tag (revenue fallback ordering),
  2. instant vs duration kept separate (implicit — balance-sheet vs flow),
  3. QTD vs YTD selection for flow metrics,
  4. segment isolation (dim_signature != ''),
  5. value-agreement guard (rejects a false merge),
  6. canonical keys (the staged facts are keyed to LINE_ITEMS).
Plus the card's "Done when": AAPL revenue + net_income staged across years.

The fixtures mirror the live companyfacts shape (facts → taxonomy → tag → units → [factObj], factObj =
{start?, end, val, accn, fy, fp, form, frame?}); `parse_company_facts` flattens them to RawFacts.
"""
from __future__ import annotations

from datetime import datetime, timezone

from src.download.edgar import RawFact, parse_company_facts
from src.stage import resolve_metrics
from src.stage.resolver import fact_key


def _ms(date_str: str) -> int:
    return int(datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def _facts(tag_units: dict, *, taxonomy: str = "us-gaap") -> dict:
    """Wrap a `{tag: {unit: [factObj,…]}}` block into a companyfacts payload for parse_company_facts."""
    return {"cik": 320193, "entityName": "Test Co", "facts": {taxonomy: tag_units}}


# ── Rule 1: revenue tag fallback ordering ─────────────────────────────────────
def test_revenue_prefers_contract_revenue_tag_over_revenues() -> None:
    # A filer that reports BOTH the modern contract-revenue tag and the legacy Revenues for the same
    # period: the registry default lists RevenueFromContractWithCustomerExcludingAssessedTax FIRST, so
    # it wins. Values agree (same figure tagged twice) so the value-agreement guard does not fire.
    payload = _facts({
        "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [
            {"start": "2020-09-27", "end": "2021-09-25", "val": 365817000000,
             "accn": "a-21", "fy": 2021, "fp": "FY", "form": "10-K"},
        ]}},
        "Revenues": {"units": {"USD": [
            {"start": "2020-09-27", "end": "2021-09-25", "val": 365817000000,
             "accn": "a-21", "fy": 2021, "fp": "FY", "form": "10-K"},
        ]}},
    })
    res = resolve_metrics(parse_company_facts(payload), cik="320193")
    rev = [f for f in res.facts if f.metric == "total_revenue"]
    assert len(rev) == 1
    assert rev[0].raw_tag == "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax"
    assert rev[0].value == 365817000000.0
    assert not res.conflicts


def test_revenue_falls_through_to_revenues_when_preferred_absent() -> None:
    # Older filer: only the legacy Revenues tag present → the resolver falls through the preference list
    # to it (the next-best PRESENT candidate).
    payload = _facts({
        "Revenues": {"units": {"USD": [
            {"start": "2019-07-01", "end": "2020-06-30", "val": 143015000000,
             "accn": "m-20", "fy": 2020, "fp": "FY", "form": "10-K"},
        ]}},
    })
    res = resolve_metrics(parse_company_facts(payload), cik="789019")
    rev = [f for f in res.facts if f.metric == "total_revenue"]
    assert len(rev) == 1 and rev[0].raw_tag == "us-gaap:Revenues"


def test_bank_sector_override_changes_revenue_tag() -> None:
    # A bank reports interest+fee income, not product sales. Under the 'bank' template the registry
    # prefers RevenuesNetOfInterestExpense; the same Revenues tag a manufacturer would fall through to
    # is lower priority here, and the contract-revenue tag isn't a bank candidate at all.
    payload = _facts({
        "RevenuesNetOfInterestExpense": {"units": {"USD": [
            {"start": "2020-01-01", "end": "2020-12-31", "val": 119500000000,
             "accn": "b-20", "fy": 2020, "fp": "FY", "form": "10-K"},
        ]}},
        "Revenues": {"units": {"USD": [
            {"start": "2020-01-01", "end": "2020-12-31", "val": 119500000000,
             "accn": "b-20", "fy": 2020, "fp": "FY", "form": "10-K"},
        ]}},
    })
    res = resolve_metrics(parse_company_facts(payload), cik="19617", sector="bank")
    rev = [f for f in res.facts if f.metric == "total_revenue"]
    assert len(rev) == 1 and rev[0].raw_tag == "us-gaap:RevenuesNetOfInterestExpense"

    # Under the default (general) template the same facts resolve to Revenues (no bank tag, contract
    # tag absent) — proving the override is sector-scoped, not global.
    res_general = resolve_metrics(parse_company_facts(payload), cik="19617")
    rev_general = [f for f in res_general.facts if f.metric == "total_revenue"]
    assert len(rev_general) == 1 and rev_general[0].raw_tag == "us-gaap:Revenues"


# ── Rule 3: QTD vs YTD selection ──────────────────────────────────────────────
def test_qtd_chosen_over_ytd_for_flow_metric() -> None:
    # A Q3 10-Q reports NetIncomeLoss twice ending the same day: the discrete quarter (~91d) and the
    # YTD cumulative (~273d). The resolver keeps the fiscal-quarter frame (the shorter span matching the
    # Q3 fiscal-period target), never the cumulative — so downstream period math can't double-count.
    payload = _facts({
        "NetIncomeLoss": {"units": {"USD": [
            {"start": "2021-06-27", "end": "2021-09-25", "val": 20551000000,   # QTD ~90d
             "accn": "q3-21", "fy": 2021, "fp": "Q3", "form": "10-Q"},
            {"start": "2020-12-27", "end": "2021-09-25", "val": 74129000000,   # YTD cumulative ~272d
             "accn": "q3-21", "fy": 2021, "fp": "Q3", "form": "10-Q"},
        ]}},
    })
    res = resolve_metrics(parse_company_facts(payload), cik="320193")
    ni = [f for f in res.facts if f.metric == "net_income" and f.period_end == _ms("2021-09-25")]
    assert len(ni) == 1
    assert ni[0].value == 20551000000.0                     # the QTD figure
    assert ni[0].period_start == _ms("2021-06-27")          # the quarter start, not the YTD start


def test_fy_flow_keeps_full_year_span() -> None:
    # An annual flow: a single full-year duration (~365d) with fp=FY. Its fiscal-period target is the
    # year, so the full-year span is kept (not mistaken for a cumulative to shorten).
    payload = _facts({
        "NetIncomeLoss": {"units": {"USD": [
            {"start": "2020-09-27", "end": "2021-09-25", "val": 94680000000,
             "accn": "fy-21", "fy": 2021, "fp": "FY", "form": "10-K"},
        ]}},
    })
    res = resolve_metrics(parse_company_facts(payload), cik="320193")
    ni = [f for f in res.facts if f.metric == "net_income"]
    assert len(ni) == 1 and ni[0].value == 94680000000.0
    assert ni[0].period_start == _ms("2020-09-27")


# ── Rule 4: segment isolation ─────────────────────────────────────────────────
def test_segment_facts_isolated_from_consolidated() -> None:
    # The consolidated total (dim_signature == '') and a segment breakout (dim_signature != '') share
    # the metric + period. The resolver surfaces them as SEPARATE interpreted facts — the segment never
    # stands in for, nor is summed into, the consolidated metric. (companyfacts itself is consolidated;
    # we build a dimensional fact directly via RawFact to model the richer-source case the row supports.)
    consolidated = parse_company_facts(_facts({
        "Revenues": {"units": {"USD": [
            {"start": "2020-01-01", "end": "2020-12-31", "val": 100000000000,
             "accn": "c-20", "fy": 2020, "fp": "FY", "form": "10-K"},
        ]}},
    }))
    segment = RawFact(
        taxonomy="us-gaap", tag="Revenues", period_type="duration",
        period_start=_ms("2020-01-01"), period_end=_ms("2020-12-31"),
        value=40000000000.0, unit="USD", currency="USD", accession_number="c-20",
        fiscal_year=2020, fiscal_period="FY", form="10-K",
        context_id="", dim_signature="StatementBusinessSegmentsAxis=AmericasSegment",
    )
    res = resolve_metrics([*consolidated, segment], cik="320193")
    rev = [f for f in res.facts if f.metric == "total_revenue"]
    by_dim = {f.dim_signature: f for f in rev}
    assert "" in by_dim and by_dim[""].value == 100000000000.0 and by_dim[""].is_segment is False
    seg = by_dim["StatementBusinessSegmentsAxis=AmericasSegment"]
    assert seg.value == 40000000000.0 and seg.is_segment is True
    # The consolidated value is NOT the segment value and was not summed.
    assert by_dim[""].value != seg.value


# ── Rule 5: value-agreement guard ─────────────────────────────────────────────
def test_value_agreement_guard_rejects_false_merge() -> None:
    # Two candidate tags for the SAME metric/period/dim disagree (a mis-tagged subtotal vs the real
    # total). The guard suppresses the consolidated emission rather than silently picking one, and
    # surfaces the conflict so QA (Task 8) sees it.
    payload = _facts({
        "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [
            {"start": "2020-01-01", "end": "2020-12-31", "val": 100000000000,
             "accn": "x-20", "fy": 2020, "fp": "FY", "form": "10-K"},
        ]}},
        "Revenues": {"units": {"USD": [
            {"start": "2020-01-01", "end": "2020-12-31", "val": 60000000000,   # disagrees by 40%
             "accn": "x-20", "fy": 2020, "fp": "FY", "form": "10-K"},
        ]}},
    })
    res = resolve_metrics(parse_company_facts(payload), cik="320193")
    assert [f for f in res.facts if f.metric == "total_revenue"] == []   # suppressed
    conflicts = [c for c in res.conflicts if c.metric == "total_revenue"]
    assert len(conflicts) == 1
    c = conflicts[0]
    assert c.tag_a == "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax"
    assert c.value_a == 100000000000.0
    assert c.tag_b == "us-gaap:Revenues" and c.value_b == 60000000000.0


def test_value_agreement_within_tolerance_does_not_conflict() -> None:
    # The same figure tagged to two synonymous tags with sub-tolerance rounding noise (<=0.5%) is NOT a
    # conflict — the resolver emits the highest-priority tag's value cleanly.
    payload = _facts({
        "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [
            {"start": "2020-01-01", "end": "2020-12-31", "val": 100000000000,
             "accn": "x-20", "fy": 2020, "fp": "FY", "form": "10-K"},
        ]}},
        "Revenues": {"units": {"USD": [
            {"start": "2020-01-01", "end": "2020-12-31", "val": 100200000000,  # +0.2% rounding
             "accn": "x-20", "fy": 2020, "fp": "FY", "form": "10-K"},
        ]}},
    })
    res = resolve_metrics(parse_company_facts(payload), cik="320193")
    rev = [f for f in res.facts if f.metric == "total_revenue"]
    assert len(rev) == 1 and rev[0].value == 100000000000.0
    assert not res.conflicts


# ── Rule 2: instant vs duration kept separate ─────────────────────────────────
def test_instant_metric_ignores_duration_fact_of_same_tag() -> None:
    # A balance-sheet metric (total_equity, instant) must not pick up a duration fact even if one
    # somehow carried the same tag. We model it by handing the resolver an instant + a (spurious)
    # duration for StockholdersEquity; only the instant is interpreted.
    instant = RawFact(
        taxonomy="us-gaap", tag="StockholdersEquity", period_type="instant",
        period_start=None, period_end=_ms("2021-09-25"), value=63090000000.0,
        unit="USD", currency="USD", accession_number="fy-21", fiscal_year=2021,
        fiscal_period="FY", form="10-K",
    )
    spurious_duration = RawFact(
        taxonomy="us-gaap", tag="StockholdersEquity", period_type="duration",
        period_start=_ms("2020-09-27"), period_end=_ms("2021-09-25"), value=999.0,
        unit="USD", currency="USD", accession_number="fy-21", fiscal_year=2021,
        fiscal_period="FY", form="10-K",
    )
    res = resolve_metrics([instant, spurious_duration], cik="320193")
    eq = [f for f in res.facts if f.metric == "total_equity"]
    assert len(eq) == 1 and eq[0].value == 63090000000.0 and eq[0].period_type == "instant"


# ── Done-when: AAPL revenue + net_income staged across years ───────────────────
def test_aapl_revenue_and_net_income_staged_across_years() -> None:
    # The card's acceptance: multiple fiscal years of revenue + net_income resolve to the canonical
    # metrics, one interpreted fact per (metric, year), values intact.
    payload = _facts({
        "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [
            {"start": "2019-09-29", "end": "2020-09-26", "val": 274515000000,
             "accn": "a-20", "fy": 2020, "fp": "FY", "form": "10-K"},
            {"start": "2020-09-27", "end": "2021-09-25", "val": 365817000000,
             "accn": "a-21", "fy": 2021, "fp": "FY", "form": "10-K"},
        ]}},
        "NetIncomeLoss": {"units": {"USD": [
            {"start": "2019-09-29", "end": "2020-09-26", "val": 57411000000,
             "accn": "a-20", "fy": 2020, "fp": "FY", "form": "10-K"},
            {"start": "2020-09-27", "end": "2021-09-25", "val": 94680000000,
             "accn": "a-21", "fy": 2021, "fp": "FY", "form": "10-K"},
        ]}},
    })
    res = resolve_metrics(parse_company_facts(payload), cik="320193")

    rev = {f.period_end: f.value for f in res.facts if f.metric == "total_revenue"}
    ni = {f.period_end: f.value for f in res.facts if f.metric == "net_income"}
    assert rev == {_ms("2020-09-26"): 274515000000.0, _ms("2021-09-25"): 365817000000.0}
    assert ni == {_ms("2020-09-26"): 57411000000.0, _ms("2021-09-25"): 94680000000.0}
    # Canonical keys only (rule 6): every staged metric is in the contract vocabulary.
    from quant_core.fundamentals.contract import LINE_ITEMS
    assert {f.metric for f in res.facts} <= set(LINE_ITEMS)


def test_shares_outstanding_from_dei_cover_page() -> None:
    # The PIT share count is the dei cover-page instant, not a us-gaap weighted-average. The dei tag
    # maps to shares_outstanding; the fact is an instant with no currency.
    payload = {"cik": 320193, "entityName": "Apple Inc.", "facts": {"dei": {
        "EntityCommonStockSharesOutstanding": {"units": {"shares": [
            {"end": "2021-10-15", "val": 16406397000, "accn": "a-21", "fy": 2021, "fp": "FY",
             "form": "10-K"},
        ]}},
    }}}
    res = resolve_metrics(parse_company_facts(payload), cik="320193")
    sh = [f for f in res.facts if f.metric == "shares_outstanding"]
    assert len(sh) == 1
    assert sh[0].raw_tag == "dei:EntityCommonStockSharesOutstanding"
    assert sh[0].value == 16406397000.0 and sh[0].currency is None
    assert sh[0].period_type == "instant"


# ── fact identity key ─────────────────────────────────────────────────────────
def test_fact_key_carries_full_identity() -> None:
    # The resolver keys on (cik, raw_tag, unit, period_start, period_end, dim_signature, accn).
    f = RawFact(
        taxonomy="us-gaap", tag="NetIncomeLoss", period_type="duration",
        period_start=_ms("2020-09-27"), period_end=_ms("2021-09-25"), value=94680000000.0,
        unit="USD", currency="USD", accession_number="a-21", fiscal_year=2021,
        fiscal_period="FY", form="10-K", dim_signature="",
    )
    k = fact_key(f, cik="320193")
    assert k.cik == "320193"
    assert k.raw_tag == "us-gaap:NetIncomeLoss"
    assert k.unit == "USD"
    assert k.period_start == _ms("2020-09-27") and k.period_end == _ms("2021-09-25")
    assert k.dim_signature == "" and k.accession_number == "a-21"

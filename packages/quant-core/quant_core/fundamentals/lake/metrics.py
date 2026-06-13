"""Query-time metric standardization — turning raw XBRL facts into standardized PIT series.

Companies tag the same economic quantity with different us-gaap concepts (and switch tags over time:
pre-ASC-606 ``Revenues`` vs post ``RevenueFromContractWithCustomerExcludingAssessedTax``). Each
standardized metric is an ORDERED fallback list; the per-fiscal-period series are merged with the
highest-priority *present* tag winning, so a company's whole reporting history stitches together off
one canonical key.

WHY query-time (not ingest-time). The old Timescale path normalized at ingest, so a mapping change
needed a full re-ingest. Here the lake stores raw facts verbatim and standardization is this pure,
in-process tag-fallback map — adding a metric or fixing a tag list is a code change with no refetch.

SOURCE-AGNOSTIC by design. This module consumes whatever rows ``store.pit_series(...)`` returns; the
point-in-time filtering (the ``knowledge_ts <= as_of`` clause) lives in the store (Task 5), NOT here.
The prototype keyed its PIT axis on ``filed``; our lake store keys on ``knowledge_ts`` — but the rows
the store hands back still carry a ``filed`` date, and that is the field the Q4/TTM derivation
propagates as ``filed = max(inputs)`` (the PIT-safety carry: a *derived* row can never surface in an
as-of view before EVERY input it was built from was already public). The merge/Q4/TTM logic is
indifferent to which axis the store filtered on — it only reads the ``start``/``end``/``value``/
``filed`` (+ provenance) the store returns.

POINT-IN-TIME SAFETY of derived values. US filers don't file a standalone Q4 10-Q, so Q4 is derived
as ``FY - (Q1+Q2+Q3)``; the derived row's ``filed`` is the max of its inputs', so it only ever
appears in an as-of view where every input was already public. TTM sums four CONSECUTIVE quarters and
likewise carries the latest input ``filed``.

CONTRACT KEYS. ``METRICS`` is keyed by ``quant_core.fundamentals.contract.LINE_ITEMS`` names where
they map 1:1 (``net_income``, ``total_revenue``, ``gross_profit``, ``cash_flow_ops`` — flows;
``total_assets``/``total_liabilities``/``total_equity``/``current_assets``/``current_liabilities``/
``total_debt``/``shares_outstanding`` — instants), so the contract layer (Task 6) calls
``metric_series(store, cik, "<line_item>", …)`` directly with NO rename layer. The 2 enriched legs
(``market_cap_gbp`` / ``dividend_yield``) and the computed ``earnings_stability`` are NOT raw SEC
metrics and are assembled in the contract/API layers, not here. A handful of richer non-LINE_ITEM
metrics (``eps_diluted``, ``capex``, ``free_cash_flow``, …) are kept because they cost nothing and
back the read-API's ``/metrics`` + ``/facts`` routes.

GENEALOGY SOURCE. The tag fallback lists are translated from
``services/fundamentals-ingestion/src/stage/metadata/metric_registry.yaml`` (the authoritative
us-gaap → ifrs-full concept lists + the bank/insurance/reit/utility sector overrides). Two invariants
carried verbatim from that registry:
  * ``ifrs-full:*`` aliases come AFTER the us-gaap tags in every metric's list, so a dual-tagger
    prefers us-gaap while a pure-IFRS 20-F filer (e.g. TSM) falls through to the IFRS tag.
  * ``total_debt`` SELECTS the single best-available *reported* total in preference order — it does
    NOT sum components (summing risks double-counting a filer that tags both a total and its parts);
    sector-template summation is a documented future refinement, out of scope here.
"""
from __future__ import annotations

from datetime import date, timedelta

FLOW, STOCK = "flow", "stock"  # duration vs instant facts

# The as-of cutoff is forwarded VERBATIM to `store.pit_series` and never operated on here (this module
# only does arithmetic on row fields — `start`/`end`/`filed`). Its concrete type is therefore the
# STORE's contract, not this module's: the prototype store filtered `filed <= as_of` (a `date`); the
# real lake store (Task 5) filters `knowledge_ts <= as_of_ms` (int64 epoch-ms, see `lake.schema`), and
# the Task-6 contract layer holds `as_of_ms` (int). So the type is deliberately `int | date` — this
# layer is axis-agnostic and must not pin it to one, or the annotation would lie to a caller passing
# epoch-ms. (A `date` is accepted unchanged for the prototype/fixture path.)
AsOf = int | date

# Accepted taxonomies, for reference. us-gaap is preferred; ifrs-full backs 20-F/40-F foreign
# filers; dei carries the cover-page share count; srt appears on some supplementary facts. The
# ordering INSIDE each metric's `concepts` list is what enforces us-gaap-preferred / ifrs-fallback —
# this tuple is documentation, not a filter.
ACCEPTED_TAXONOMIES: tuple[str, ...] = ("us-gaap", "ifrs-full", "dei", "srt")

# The sector templates the registry's `<metric>.sectors.<template>` overrides are keyed by. A template
# is the optional selector handed to `metric_series` / `merged_series`. `general` is the default (the
# metric's `default` concept list) when no template is supplied or a metric has no override.
SECTOR_TEMPLATES: tuple[str, ...] = ("general", "bank", "insurance", "reit", "utility")

# (low, high) inclusive SIC bands → template, checked in order (first containing band wins). Singleton
# SICs (e.g. REIT 6798) are (n, n). Ported VERBATIM from the retired
# `services/fundamentals-ingestion/src/normalize/sectors.py` (whose SIC→template map fed the old
# ingest-time normalizer); it now lives here so the LAKE read path — which standardizes at query time —
# can pick the same registry sector override the old normalizer baked in, with the ingestion service
# gone. The bands are deliberately CONSERVATIVE: only the SEC SIC ranges whose accounting genuinely
# breaks the default tag choices (a financial has no gross profit / current-asset split; a bank's
# "revenue" is net interest income; Division H 6000–6799 + Division E utilities 4900–4991) are mapped —
# a borderline SIC stays `general` (its default tags still resolve). See that module's docstring for the
# per-band provenance.
_SIC_BANDS: tuple[tuple[int, int, str], ...] = (
    # Banks / depositories / bank holding companies.
    (6020, 6079, "bank"),
    (6120, 6120, "bank"),
    (6712, 6712, "bank"),
    # Insurance carriers + agents.
    (6300, 6411, "insurance"),
    # Real estate investment trusts.
    (6798, 6798, "reit"),
    # Electric / gas / water / sanitary / combination utilities.
    (4900, 4991, "utility"),
)


def _coerce_sic(sic: object) -> int | None:
    """A SIC value (int, a `'6021'` string, or None) → its int code, or None when absent/unparseable.

    EDGAR's `submissions.json` gives `sic` as a 4-digit string (sometimes whitespace-padded); a few
    feeds give an int. Anything non-numeric (a description slipped in, an empty string) ⇒ None so the
    caller falls back to `general` rather than crashing on a malformed code. `bool` is excluded
    explicitly (it is an `int` subclass — `True` must not read as SIC 1)."""
    if sic is None or isinstance(sic, bool):
        return None
    if isinstance(sic, int):
        return sic
    s = str(sic).strip()
    return int(s) if s.isdigit() else None


def template_for_sic(sic: object) -> str:
    """Classify a filer's SEC SIC code into a registry sector template.

    Returns one of `general | bank | insurance | reit | utility` — the exact key `metric_series(…,
    sector=…)` switches the candidate-tag overrides on (`_concepts_for`). A SIC in a mapped
    financial/utility band returns that template; everything else (and a missing/unparseable SIC)
    returns `general`. Pure + total — no I/O, no exceptions on bad input (a malformed SIC degrades to
    `general`, the safe default that never *suppresses* a metric the way a wrong financial template
    would). Ported verbatim from the retired ingestion-service normalizer."""
    code = _coerce_sic(sic)
    if code is None:
        return "general"
    for low, high, template in _SIC_BANDS:
        if low <= code <= high:
            return template
    return "general"


def _ifrs_after_us_gaap(concepts: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Assert the registry invariant: every us-gaap tag precedes every ifrs-full tag in a fallback
    list (so a dual-tagger prefers us-gaap; a pure-IFRS filer falls through). Returns the list
    unchanged when the invariant holds — a build-time guard against a mis-ordered edit, not a sort."""
    seen_ifrs = False
    for taxonomy, _ in concepts:
        if taxonomy == "ifrs-full":
            seen_ifrs = True
        elif taxonomy == "us-gaap" and seen_ifrs:
            raise ValueError(
                f"us-gaap tag must precede ifrs-full in fallback list: {concepts}"
            )
    return concepts


# Per-metric standardization spec. Each entry:
#   kind      — FLOW (duration fact: income statement / cash flow) or STOCK (balance-sheet instant).
#   unit      — the SEC unit the fact is reported in (USD | shares | USD/shares).
#   concepts  — ORDERED `(taxonomy, concept)` fallback list (the `default` / general template). The
#               first concept PRESENT for a period wins (see `merged_series`).
#   additive  — (FLOW only) False ⇒ the value is per-share/an average that must NEVER be summed
#               across periods (no Q4 = FY-(Q1+Q2+Q3), no TTM sum). Defaults True.
#   sectors   — (optional) `{template: concepts}` overrides REPLACING `concepts` for filers in that
#               sector template (a bank's "revenue" is net interest + fee income, not product sales).
#               An empty list for a template means "no tag for this sector" (fail-closed: the metric
#               yields no fact, NaN-excluded downstream — e.g. a bank has no gross-profit line).
#
# Keys that match `LINE_ITEMS` are spelled identically so the Task-6 contract layer needs no rename.
METRICS: dict[str, dict] = {
    # ── Income statement (flows) ──────────────────────────────────────────────────────────────────
    "total_revenue": dict(kind=FLOW, unit="USD", concepts=_ifrs_after_us_gaap([
        ("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"),
        ("us-gaap", "Revenues"),
        ("us-gaap", "SalesRevenueNet"),
        ("us-gaap", "RevenueFromContractWithCustomerIncludingAssessedTax"),
        ("ifrs-full", "Revenue"),
    ]), sectors={
        # A bank's top line is net interest + noninterest income, not product sales.
        "bank": [
            ("us-gaap", "RevenuesNetOfInterestExpense"),
            ("us-gaap", "InterestAndDividendIncomeOperating"),
            ("us-gaap", "Revenues"),
        ],
        # Insurers report premiums + net investment income; Revenues is the rolled-up total.
        "insurance": [
            ("us-gaap", "Revenues"),
            ("us-gaap", "PremiumsEarnedNet"),
        ],
        "reit": [
            ("us-gaap", "Revenues"),
            ("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"),
        ],
        "utility": [
            ("us-gaap", "RegulatedAndUnregulatedOperatingRevenue"),
            ("us-gaap", "Revenues"),
            ("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"),
        ],
    }),
    "gross_profit": dict(kind=FLOW, unit="USD", concepts=_ifrs_after_us_gaap([
        ("us-gaap", "GrossProfit"),
        ("ifrs-full", "GrossProfit"),
    ]), sectors={
        # Banks / insurers do not report a gross-profit line — fail-closed (empty ⇒ no fact).
        "bank": [],
        "insurance": [],
    }),
    "net_income": dict(kind=FLOW, unit="USD", concepts=_ifrs_after_us_gaap([
        ("us-gaap", "NetIncomeLoss"),
        ("us-gaap", "ProfitLoss"),  # consolidated-incl-NCI fallback (still a us-gaap element)
        ("us-gaap", "NetIncomeLossAvailableToCommonStockholdersBasic"),
        ("ifrs-full", "ProfitLoss"),  # 20-F IFRS foreign filer (e.g. TSM)
    ])),
    "cash_flow_ops": dict(kind=FLOW, unit="USD", concepts=_ifrs_after_us_gaap([
        ("us-gaap", "NetCashProvidedByUsedInOperatingActivities"),
        ("us-gaap", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"),
        ("ifrs-full", "CashFlowsFromUsedInOperatingActivities"),
    ])),
    # ── Balance sheet (instants) ──────────────────────────────────────────────────────────────────
    "total_equity": dict(kind=STOCK, unit="USD", concepts=_ifrs_after_us_gaap([
        ("us-gaap", "StockholdersEquity"),
        # Includes noncontrolling interest — preferred only when the parent-only tag is absent.
        ("us-gaap", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"),
        ("ifrs-full", "Equity"),
    ])),
    "total_assets": dict(kind=STOCK, unit="USD", concepts=_ifrs_after_us_gaap([
        ("us-gaap", "Assets"),
        ("ifrs-full", "Assets"),
    ])),
    "total_liabilities": dict(kind=STOCK, unit="USD", concepts=_ifrs_after_us_gaap([
        ("us-gaap", "Liabilities"),
        ("ifrs-full", "Liabilities"),
    ])),
    "current_assets": dict(kind=STOCK, unit="USD", concepts=_ifrs_after_us_gaap([
        ("us-gaap", "AssetsCurrent"),
        ("ifrs-full", "CurrentAssets"),
    ]), sectors={
        # Banks / insurers run unclassified balance sheets (no current/non-current split) — absent.
        "bank": [],
        "insurance": [],
    }),
    "current_liabilities": dict(kind=STOCK, unit="USD", concepts=_ifrs_after_us_gaap([
        ("us-gaap", "LiabilitiesCurrent"),
        ("ifrs-full", "CurrentLiabilities"),
    ]), sectors={
        "bank": [],
        "insurance": [],
    }),
    "total_debt": dict(kind=STOCK, unit="USD", concepts=_ifrs_after_us_gaap([
        # No single "total debt" us-gaap tag exists. SELECT the single best-available *reported* total
        # in preference order — do NOT sum components (summing double-counts a filer tagging both a
        # total and its parts). Sector-template summation is a documented future refinement.
        ("us-gaap", "DebtAndCapitalLeaseObligations"),
        ("us-gaap", "LongTermDebtAndCapitalLeaseObligations"),
        ("us-gaap", "LongTermDebt"),
        ("us-gaap", "DebtCurrent"),
        # IFRS borrowings: the closest single *reported* total a 20-F filer tags. Same select-not-sum.
        ("ifrs-full", "Borrowings"),
        ("ifrs-full", "LongtermBorrowings"),
    ])),
    # ── Cover page (instant; own knowledge_ts = filing date) ──────────────────────────────────────
    "shares_outstanding": dict(kind=STOCK, unit="shares", concepts=[
        # The canonical PIT share count is the DEI cover-page fact (entity-level, as-of the cover
        # date) — NOT a us-gaap weighted-average (that is a flow used for EPS). A multi-class filer
        # (GOOGL/GOOG) whose dei fact is class-dimensioned-away falls through to the undimensioned
        # consolidated us-gaap balance-sheet count. Fail-closed: a filer with NEITHER yields no count
        # → null PIT market cap (never a fabricated value). (No ifrs alias — dei is the cover-page
        # source across taxonomies; ordering here is dei-then-us-gaap, no us-gaap-before-ifrs case.)
        ("dei", "EntityCommonStockSharesOutstanding"),
        ("us-gaap", "CommonStockSharesOutstanding"),
    ]),
    # ── Richer non-LINE_ITEM metrics (kept for the read-API /metrics + /facts; cheap) ─────────────
    "operating_income": dict(kind=FLOW, unit="USD", concepts=[
        ("us-gaap", "OperatingIncomeLoss"),
    ]),
    "eps_diluted": dict(kind=FLOW, unit="USD/shares", additive=False, concepts=_ifrs_after_us_gaap([
        ("us-gaap", "EarningsPerShareDiluted"),
        ("ifrs-full", "DilutedEarningsLossPerShare"),
    ])),
    "shares_diluted_wavg": dict(kind=FLOW, unit="shares", additive=False, concepts=[
        ("us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding"),
    ]),
    "capex": dict(kind=FLOW, unit="USD", concepts=[
        ("us-gaap", "PaymentsToAcquirePropertyPlantAndEquipment"),
        ("us-gaap", "PaymentsToAcquireProductiveAssets"),
    ]),
    "cash_and_equivalents": dict(kind=STOCK, unit="USD", concepts=[
        ("us-gaap", "CashAndCashEquivalentsAtCarryingValue"),
    ]),
}

# metric = left <op> right, computed per aligned fiscal period (provenance + `filed` propagate).
DERIVED: dict[str, tuple[str, str, str]] = {
    "free_cash_flow": ("cash_flow_ops", "-", "capex"),
}

def _validate_sector_overrides_ifrs_order() -> None:
    """The us-gaap-before-ifrs invariant must hold for the SECTOR OVERRIDE lists too —
    `_ifrs_after_us_gaap` guards only each metric's `default`/`concepts` list at construction, so
    without this pass a future registry sync that put an ifrs-full tag ahead of a us-gaap tag in, say,
    a bank override would import and run while silently mis-prioritising the wrong tag for a
    dual-tagging bank. Run at import so a mis-ordered override fails loudly (same as the default)."""
    for spec in METRICS.values():
        for override in spec.get("sectors", {}).values():
            _ifrs_after_us_gaap(override)


_validate_sector_overrides_ifrs_order()


def _concepts_for(spec: dict, sector: str | None) -> list[tuple[str, str]]:
    """Pick the concept fallback list for a metric, honouring a sector template when one is supplied
    AND the metric declares an override for it. Otherwise the metric's `default` (general) list.

    This is the sector-override SELECTION MECHANISM (the only sector logic in this module): the
    caller passes a template key (derived from the entity SIC in the contract/store layer), and an
    override REPLACES the default list — including an EMPTY override, which is meaningful (fail-closed
    "no tag for this sector", e.g. a bank's gross_profit), so a present-but-empty override is honoured
    rather than silently falling back to the default."""
    if sector and sector != "general":
        overrides = spec.get("sectors")
        if overrides is not None and sector in overrides:
            return overrides[sector]
    return spec["concepts"]


# --------------------------------------------------------------------------------------------------- #
# Series assembly (all inputs are already PIT-filtered by the store — see module docstring)            #
# --------------------------------------------------------------------------------------------------- #
def merged_series(store, cik: int, spec: dict, as_of: AsOf,
                  sector: str | None = None) -> list[dict]:
    """Union the (sector-selected) fallback concepts; per fiscal period, the highest-priority tag
    PRESENT wins. The store returns each concept's PIT-filtered rows; the first concept that supplies
    a given `(start, end)` period claims it, so a filer's history stitches across tag changes."""
    by_period: dict[tuple, dict] = {}
    for taxonomy, concept in _concepts_for(spec, sector):
        rows = store.pit_series(cik, taxonomy, concept, spec["unit"],
                                as_of, instant=spec["kind"] == STOCK)
        for r in rows:
            key = (r["start"], r["end"])
            if key not in by_period:
                # Stamp provenance on a COPY, never the store's returned row: the module promises it
                # "never touches the lake", and a real store that caches/shares row objects would be
                # corrupted by an in-place write (the value would leak across as-of reads / metrics).
                by_period[key] = {**r, "taxonomy": taxonomy, "concept": concept, "derived": False}
    return sorted(by_period.values(), key=lambda r: r["end"])


def _dur(r: dict) -> int:
    return (r["end"] - r["start"]).days + 1


def split_periods(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """Classify duration facts by length (robust to odd fiscal calendars — NVIDIA's late-January
    year-end, 53-week retail years): ~90-day windows are quarters, ~365-day windows are annuals.

    Only DURATION rows reach here (a STOCK metric returns before `split_periods` in `metric_series`),
    and a well-formed duration fact always carries a `start`. A row with no `start` (a malformed
    EDGAR fact, or an instant concept that slipped into a duration query) is SKIPPED rather than
    crashing `_dur` with `date - None` — the whole name's fundamentals must degrade to omission, not
    raise. (`_dur` itself is never handed a null `start` because of this filter.)"""
    duration = [r for r in rows if r.get("start") is not None]
    quarters = [r for r in duration if 75 <= _dur(r) <= 105]
    annual = [r for r in duration if 340 <= _dur(r) <= 385]
    return quarters, annual


def _max_knowledge_ts(rows: list[dict]) -> int | None:
    """The latest `knowledge_ts` across a derived row's inputs — the availability carry that mirrors
    `filed = max(inputs)`. Real (merged_series) rows always carry `knowledge_ts` (the store SELECTs
    it), so a derived value's availability is the LATEST of its inputs': a derived Q4/TTM is knowable
    only once EVERY input was knowable. Returns None only if NO input carried one (defensive — a
    caller handing rows without the field), so a derived row never claims an earlier availability than
    its inputs (the under-report that would let it surface too early in an as-of/knowledge re-filter)."""
    kts = [r["knowledge_ts"] for r in rows if r.get("knowledge_ts") is not None]
    return max(kts) if kts else None


def with_derived_q4(quarters: list[dict], annual: list[dict],
                    additive: bool = True) -> list[dict]:
    """US filers don't file a standalone Q4 10-Q; derive Q4 = FY - (Q1+Q2+Q3). The derived row's
    `filed` AND `knowledge_ts` are the max of its inputs', so it only ever appears in an as-of/knowledge
    view where EVERY input was already public (the PIT-safety carry — without the `knowledge_ts` carry a
    consumer re-filtering on it would see the derived value as knowable too early). Non-additive metrics
    (EPS, share counts) are NEVER derived this way (`additive=False` short-circuits — you can't subtract
    per-share figures meaningfully)."""
    qs = {r["end"]: r for r in quarters}
    for fy in annual:
        if fy["end"] in qs or not additive:
            continue
        inside = sorted(
            (q for q in qs.values()
             if fy["start"] <= q["start"] and q["end"] < fy["end"]),
            key=lambda q: q["end"],
        )
        if len(inside) != 3:
            continue
        qs[fy["end"]] = {
            "start": inside[-1]["end"] + timedelta(days=1),
            "end": fy["end"],
            "value": fy["value"] - sum(q["value"] for q in inside),
            "filed": max([fy["filed"]] + [q["filed"] for q in inside]),
            "knowledge_ts": _max_knowledge_ts([fy, *inside]),
            "accession": fy["accession"],
            "form": fy["form"],
            "taxonomy": fy["taxonomy"],
            "concept": fy["concept"],
            "derived": True,
        }
    return sorted(qs.values(), key=lambda r: r["end"])


def ttm(quarters: list[dict]) -> list[dict]:
    """Trailing-twelve-month sums over four CONSECUTIVE quarters (≤120-day end-to-end gaps, so a
    missing quarter doesn't silently stitch a 6-month gap into a "TTM"). Each output carries the
    latest input `filed` AND `knowledge_ts` — PIT-safe like the derived Q4 (a TTM is knowable only once
    all four quarters were public; the `knowledge_ts` carry keeps a consumer re-filtering on it from
    seeing the sum too early)."""
    out = []
    for i in range(3, len(quarters)):
        w = quarters[i - 3: i + 1]
        gaps_ok = all((w[j + 1]["end"] - w[j]["end"]).days <= 120 for j in range(3))
        if not gaps_ok:
            continue
        out.append({
            "start": w[0]["start"],
            "end": w[-1]["end"],
            "value": sum(q["value"] for q in w),
            "filed": max(q["filed"] for q in w),
            "knowledge_ts": _max_knowledge_ts(w),
            "accession": w[-1]["accession"],
            "form": w[-1]["form"],
            "taxonomy": w[-1]["taxonomy"],
            "concept": w[-1]["concept"],
            "derived": True,
        })
    return out


def metric_series(store, cik: int, metric: str, freq: str, as_of: AsOf,
                  sector: str | None = None) -> dict:
    """Public entrypoint: the standardized, PIT-correct series for one metric.

    `freq` ∈ {"q","a","ttm"} (ignored for STOCK metrics — instants have no frequency). `sector` is
    the optional template key (bank/insurance/reit/utility) selecting a registry override; absent or
    "general" ⇒ the default concept list. The store has already applied the PIT (`knowledge_ts <=
    as_of`) filter, so everything here is pure series math.
    """
    if metric in DERIVED:
        left, op, right = DERIVED[metric]
        a = metric_series(store, cik, left, freq, as_of, sector=sector)
        b = {(p["start"], p["end"]): p for p in
             metric_series(store, cik, right, freq, as_of, sector=sector)["points"]}
        points = []
        for p in a["points"]:
            q = b.get((p["start"], p["end"]))
            if q is None:
                continue
            points.append({**p,
                           "value": p["value"] - q["value"] if op == "-" else p["value"] + q["value"],
                           "filed": max(p["filed"], q["filed"]),
                           # availability of a two-leg derived value is the LATER of the legs' — mirror
                           # `filed`, so `{**p}` inheriting only the left leg's knowledge_ts can't make
                           # the combined value appear knowable before the right leg was public.
                           "knowledge_ts": _max_knowledge_ts([p, q]),
                           "concept": f"{p['concept']}{op}{q['concept']}",
                           "derived": True})
        return {"unit": a["unit"], "points": points}

    spec = METRICS[metric]
    rows = merged_series(store, cik, spec, as_of, sector=sector)
    if spec["kind"] == STOCK:
        return {"unit": spec["unit"], "points": rows}  # instants; freq n/a

    quarters, annual = split_periods(rows)
    additive = spec.get("additive", True)
    q_full = with_derived_q4(quarters, annual, additive=additive)
    if freq == "a":
        points = annual
    elif freq == "ttm":
        points = ttm(q_full) if additive else q_full  # no EPS/share-count sums
    else:
        points = q_full
    return {"unit": spec["unit"], "points": points}

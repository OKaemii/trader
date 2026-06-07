"""HighVelocityStrategy pipeline + its collaborators (QMJ screen, rebalance clock).
Run: pip install -e packages/quant-core[test] && pytest packages/quant-core (or the docker gate).
"""
import datetime as dt

from quant_core.screen.quality import quality_pass, compute_ratios
from quant_core.strategy.collaborators.rebalance_clock import RebalanceClock
from quant_core.strategy.contract import HistoryView, PortfolioState, StrategyConfig, StrategyParams
from quant_core.strategy.high_velocity import HighVelocityStrategy

AS_OF = 1_750_000_000_000

# Closes (len 10). With mom_lookback=5, mom_skip=1 momentum uses closes[4]→closes[8].
CLOSES = {
    "A": [100, 101, 102, 103, 104, 105, 106, 107, 108, 109],          # smooth up  — high mom, low vol
    "B": [100, 100.5, 101, 101.5, 102, 102.5, 103, 103.5, 104, 104.5], # smooth up  — med  mom, low vol
    "C": [100, 106, 101, 108, 103, 110, 104, 112, 106, 114],           # choppy up  — high mom, HIGH vol
    "D": [100, 99, 98, 97, 96, 95, 94, 93, 92, 91],                    # down       — negative mom
    "E": [100, 103, 106, 109, 112, 115, 118, 121, 124, 127],           # steep up   — HIGHEST mom, fails QMJ
}
PASS_FUND = {"market_cap_gbp": 1e10, "net_income": 1000, "total_equity": 5000,
             "total_debt": 3000, "current_assets": 3000, "current_liabilities": 1500}
FAIL_FUND = {**PASS_FUND, "total_equity": 0}   # zero denominator → fail-closed


def _ts(month_edge: bool, n: int = 10) -> list[int]:
    if month_edge:
        days = [dt.datetime(2026, 5, 18, tzinfo=dt.timezone.utc) + dt.timedelta(days=i) for i in range(n - 1)]
        days.append(dt.datetime(2026, 6, 1, tzinfo=dt.timezone.utc))   # first session of a new month
    else:
        days = [dt.datetime(2026, 5, 4, tzinfo=dt.timezone.utc) + dt.timedelta(days=i) for i in range(n)]
    return [int(d.timestamp() * 1000) for d in days]


def _history(month_edge: bool = True, all_fail_quality: bool = False) -> HistoryView:
    fund = {}
    for t in CLOSES:
        if all_fail_quality:
            fund[t] = FAIL_FUND
        else:
            fund[t] = FAIL_FUND if t == "E" else PASS_FUND
    ts = _ts(month_edge)
    return HistoryView(
        closes={t: list(c) for t, c in CLOSES.items()},
        volumes={t: [1.0] * len(c) for t, c in CLOSES.items()},
        timestamps={t: list(ts) for t in CLOSES},
        fundamentals=fund,
    )


def _cfg() -> StrategyConfig:
    return StrategyConfig(strategy_id="high_velocity_v1", rolling_window=10, min_universe_size=2,
                          report_cadence="per_cycle", top_k=2, wants_fundamentals=True)


def _strat() -> HighVelocityStrategy:
    return HighVelocityStrategy(RebalanceClock(), _cfg(), top_n_momentum=3, drop_n_vol=1,
                                vol_lookback=5, mom_lookback=5, mom_skip=1, min_cap_gbp=1e9)


# ── collaborators ──────────────────────────────────────────────────────────────
def test_quality_pass_rules():
    assert quality_pass(PASS_FUND) is True
    assert quality_pass({**PASS_FUND, "net_income": 100}) is False       # ROE 0.02 < 0.10
    assert quality_pass({**PASS_FUND, "total_debt": 12000}) is False     # D/E 2.4 > 2.0
    assert quality_pass({**PASS_FUND, "current_assets": 1000}) is False  # CR 0.67 < 1.0
    assert compute_ratios(FAIL_FUND) is None                             # fail-closed denominator
    assert quality_pass(FAIL_FUND) is False


def test_rebalance_clock_month_edge():
    assert RebalanceClock().is_rebalance({"X": _ts(month_edge=True)}) is True
    assert RebalanceClock().is_rebalance({"X": _ts(month_edge=False)}) is False
    assert RebalanceClock().is_rebalance({"X": [123]}) is False          # <2 sessions → False


# ── pipeline ───────────────────────────────────────────────────────────────────
def test_pipeline_selects_low_vol_momentum_survivors():
    fv = _strat().compute_features(_history(), AS_OF, StrategyParams(values={}))
    assert fv is not None
    # top-3 momentum of the QMJ-passing set {A,B,C,D} is {A,C,B}; drop the highest-vol (C) → {A,B}.
    assert set(fv.ticker_universe) == {"A", "B"}
    assert "C" not in fv.ticker_universe   # dropped — highest vol of the top-3
    assert "D" not in fv.ticker_universe   # not in the top-3 by momentum
    assert "volatility" in fv.per_ticker["A"] and "momentum" in fv.per_ticker["A"]
    assert all(v > 0 for v in fv.composite_scores.values())   # positive ⇒ usable confidence


def test_screen_excludes_quality_failures():
    # E has the HIGHEST momentum but fails QMJ (zero equity) → must never be selected.
    fv = _strat().compute_features(_history(), AS_OF, StrategyParams(values={}))
    assert fv is not None
    assert "E" not in fv.ticker_universe


def test_holds_off_rebalance_month():
    assert _strat().compute_features(_history(month_edge=False), AS_OF, StrategyParams(values={})) is None


def test_force_rebalance_bypasses_monthly_gate():
    # Off the month boundary the strategy normally holds (see test_holds_off_rebalance_month). The
    # portal "Rebalance now" injects force_rebalance=1.0, which must run the full pipeline anyway —
    # while the default (no flag) keeps holding, so backtest/replay parity is preserved.
    assert _strat().compute_features(_history(month_edge=False), AS_OF, StrategyParams(values={})) is None
    forced = _strat().compute_features(
        _history(month_edge=False), AS_OF, StrategyParams(values={"force_rebalance": 1.0})
    )
    assert forced is not None
    assert set(forced.ticker_universe) == {"A", "B"}   # same selection an on-edge rebalance would make


def test_thin_pool_returns_none():
    assert _strat().compute_features(_history(all_fail_quality=True), AS_OF, StrategyParams(values={})) is None


def test_decide_emits_inverse_vol_weighting():
    s = _strat()
    fv = s.compute_features(_history(), AS_OF, StrategyParams(values={}))
    out = s.decide(fv, PortfolioState(current_weights={}, nav=0.0, cash=0.0))
    assert out.weighting == "inverse_vol"
    assert out.top_k == 2
    assert set(out.ticker_universe) == {"A", "B"}
    assert out.factor_attributions["A"]["volatility"] >= 0.0

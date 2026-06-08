"""PIT market-cap computation tests (epic Task 12, Gap 2) — the pure core, no HTTP / no Redis.

The headline guarantees the card mandates:
  * a PAST-as_of market cap = adjusted_close × shares × fx, and DIFFERS from a stubbed Yahoo current
    scalar (the look-ahead leak this task removes);
  * missing shares OR missing price → market cap ABSENT (NaN-excluded, never a fabricated 0);
  * the FX multiplier is GBP-identity / USD-by-rate / None-otherwise, sanity- + staleness-gated;
  * the as-of adjusted close is the latest bar at/<= as_of (the same series momentum uses);
  * the line-item override drops a stale provider scalar and never fabricates a value.
"""
from __future__ import annotations

from src.market_cap import (
    FX_LAST_GOOD_KEY,
    FX_LAST_TS_KEY,
    adjusted_close_at_or_before,
    apply_dividend_yield,
    apply_pit_market_cap,
    compute_market_cap_gbp,
    currency_of,
    fx_rate_from_redis_values,
)


# ── the identity: adjusted_close × shares × fx ───────────────────────────────────
def test_market_cap_is_price_times_shares_times_fx() -> None:
    # A USD name: $150 adjusted close × 16,000,000,000 shares × 0.79 GBP/USD.
    mc = compute_market_cap_gbp(adjusted_close=150.0, shares_outstanding=16_000_000_000.0, fx_to_gbp_rate=0.79)
    assert mc == 150.0 * 16_000_000_000.0 * 0.79


def test_past_as_of_market_cap_differs_from_today_yahoo_scalar() -> None:
    """THE CARD'S HEADLINE. A past-as_of market cap computed from the as-of close × as-of shares × FX is a
    genuinely different number than today's Yahoo `price.marketCap` scalar (the look-ahead leak). Here the
    past close (a corrected/old adjusted price) × the then-current share count yields a value that is NOT
    the stubbed current Yahoo scalar — proving the computed PIT cap is on its own as-of basis, not the
    provider's reused-at-every-step constant."""
    # Stubbed "today's Yahoo scalar" (what the old code reused at every replay step).
    yahoo_current_market_cap_gbp = 3_000_000_000_000.0  # ~£3T (a megacap today)
    # The PIT inputs at a PAST as_of: a much lower historical adjusted close + a smaller historical share
    # count (companies grow + buy back), at a historical FX.
    past_market_cap = compute_market_cap_gbp(
        adjusted_close=42.0,             # historical adjusted close (years ago)
        shares_outstanding=18_000_000_000.0,
        fx_to_gbp_rate=0.72,             # a historical-ish GBP/USD (still the spot rate the platform has)
    )
    assert past_market_cap is not None
    assert past_market_cap == 42.0 * 18_000_000_000.0 * 0.72
    # And it is materially different from the reused current scalar — the whole point of Gap 2.
    assert past_market_cap != yahoo_current_market_cap_gbp
    assert abs(past_market_cap - yahoo_current_market_cap_gbp) > 1.0


def test_gbp_name_market_cap_uses_identity_fx() -> None:
    # An LSE name prices in GBP (pence already killed) → FX multiplier 1.0.
    mc = compute_market_cap_gbp(adjusted_close=12.5, shares_outstanding=2_000_000_000.0, fx_to_gbp_rate=1.0)
    assert mc == 12.5 * 2_000_000_000.0


# ── missing input → market cap ABSENT (never a fabricated 0) ─────────────────────
def test_missing_shares_yields_none() -> None:
    assert compute_market_cap_gbp(adjusted_close=150.0, shares_outstanding=None, fx_to_gbp_rate=0.79) is None


def test_missing_price_yields_none() -> None:
    assert compute_market_cap_gbp(adjusted_close=None, shares_outstanding=16e9, fx_to_gbp_rate=0.79) is None


def test_missing_fx_yields_none() -> None:
    assert compute_market_cap_gbp(adjusted_close=150.0, shares_outstanding=16e9, fx_to_gbp_rate=None) is None


def test_nonpositive_or_nonfinite_inputs_yield_none() -> None:
    assert compute_market_cap_gbp(0.0, 16e9, 0.79) is None          # zero price
    assert compute_market_cap_gbp(150.0, 0.0, 0.79) is None         # zero shares
    assert compute_market_cap_gbp(150.0, 16e9, 0.0) is None         # zero rate
    assert compute_market_cap_gbp(-150.0, 16e9, 0.79) is None       # negative price
    assert compute_market_cap_gbp(float("nan"), 16e9, 0.79) is None
    assert compute_market_cap_gbp(150.0, float("inf"), 0.79) is None


# ── currency-of-ticker (the FX multiplier's currency) ────────────────────────────
def test_currency_of_routes_by_suffix() -> None:
    assert currency_of("AAPL_US_EQ") == "USD"
    assert currency_of("VODl_EQ") == "GBP"          # LSE: stored close already GBP (pence killed)
    assert currency_of("WEIRD_XX") is None           # unroutable → no FX basis


# ── FX parse + sanity/staleness gate (mirrors RedisGbpUsdProvider) ───────────────
def test_fx_rate_valid_in_bounds_and_fresh() -> None:
    assert fx_rate_from_redis_values("0.79", "1000", now_ms=1000) == 0.79


def test_fx_rate_out_of_bounds_rejected() -> None:
    assert fx_rate_from_redis_values("2.5", "1000", now_ms=1000) is None   # > 1.5 ceiling
    assert fx_rate_from_redis_values("0.1", "1000", now_ms=1000) is None   # < 0.5 floor


def test_fx_rate_stale_rejected() -> None:
    # ts far in the past vs now → older than the 26h ceiling → treated as absent.
    assert fx_rate_from_redis_values("0.79", "0", now_ms=10**12, max_stale_ms=1000) is None


def test_fx_rate_missing_or_garbage_rejected() -> None:
    assert fx_rate_from_redis_values(None, "1000", now_ms=1000) is None
    assert fx_rate_from_redis_values("not-a-number", "1000", now_ms=1000) is None
    # Missing ts defaults to 0 → considered stale unless now is also ~0.
    assert fx_rate_from_redis_values("0.79", None, now_ms=10**12) is None
    # the exact Redis key names the consumer-side FX path reads (regression-pin the contract).
    assert FX_LAST_GOOD_KEY == "fx:GBPUSD:lastGood"
    assert FX_LAST_TS_KEY == "fx:GBPUSD:lastTs"


# ── as-of adjusted close = latest bar at/<= as_of ────────────────────────────────
def _bar(ts: int, close: float) -> dict:
    return {"timestamp": ts, "open": close, "high": close, "low": close, "close": close, "volume": 0}


def test_adjusted_close_picks_latest_at_or_before_as_of() -> None:
    bars = [_bar(100, 10.0), _bar(200, 20.0), _bar(300, 30.0)]
    # as_of between the 2nd and 3rd bar → the 2nd bar's close (the close momentum would have seen).
    assert adjusted_close_at_or_before(bars, as_of_ms=250) == 20.0
    # as_of exactly on a bar → that bar.
    assert adjusted_close_at_or_before(bars, as_of_ms=200) == 20.0
    # no as_of → the latest bar.
    assert adjusted_close_at_or_before(bars, as_of_ms=None) == 30.0


def test_adjusted_close_none_when_no_bar_before_as_of() -> None:
    bars = [_bar(300, 30.0)]
    assert adjusted_close_at_or_before(bars, as_of_ms=200) is None   # earliest bar is after as_of
    assert adjusted_close_at_or_before([], as_of_ms=None) is None    # unseeded ticker


def test_adjusted_close_tolerates_unordered_and_malformed_rows() -> None:
    bars = [_bar(300, 30.0), {"timestamp": "bad"}, _bar(100, 10.0), {"close": 5.0}]
    assert adjusted_close_at_or_before(bars, as_of_ms=None) == 30.0  # malformed rows skipped, sorted


# ── line-item override: drop the scalar, never fabricate ─────────────────────────
def test_apply_market_cap_overrides_and_drops() -> None:
    # A provider scalar that somehow landed is OVERRIDDEN with the computed value.
    assert apply_pit_market_cap({"market_cap_gbp": 999.0, "net_income": 5.0}, 123.0) == {
        "market_cap_gbp": 123.0,
        "net_income": 5.0,
    }
    # No computed value → the key is REMOVED (NaN-excluded), the rest untouched.
    assert apply_pit_market_cap({"market_cap_gbp": 999.0, "net_income": 5.0}, None) == {"net_income": 5.0}
    # Input is not mutated.
    src = {"market_cap_gbp": 999.0}
    apply_pit_market_cap(src, 1.0)
    assert src == {"market_cap_gbp": 999.0}


def test_apply_dividend_yield_sets_clears_keeps_zero() -> None:
    assert apply_dividend_yield({"net_income": 5.0}, 0.031) == {"net_income": 5.0, "dividend_yield": 0.031}
    # A real non-payer's finite 0.0 is KEPT (a real signal), not dropped.
    assert apply_dividend_yield({}, 0.0) == {"dividend_yield": 0.0}
    # None / NaN → absent (no honest yield), never a fabricated 0.
    assert apply_dividend_yield({"dividend_yield": 0.02}, None) == {}
    assert apply_dividend_yield({"dividend_yield": 0.02}, float("nan")) == {}

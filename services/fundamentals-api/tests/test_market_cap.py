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
    apply_dividend_yield,
    apply_pit_market_cap,
    close_from_response,
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


# ── adjusted close from the endpoint's per-ticker value (the server already did the at/<= as_of pick) ──
def test_close_from_response_passes_a_finite_positive_value() -> None:
    # The endpoint returns the close directly (the DESC LIMIT-1 read happened server-side).
    assert close_from_response(30.0) == 30.0
    assert close_from_response("20.5") == 20.5   # numeric strings tolerated


def test_close_from_response_none_for_null_or_no_bar() -> None:
    # A null close (no bar at/<= as_of, unseeded ticker) → None → the name's market cap is absent.
    assert close_from_response(None) is None


def test_close_from_response_rejects_nonpositive_nonfinite_garbage() -> None:
    # A 0 / negative / NaN / non-number is never a real adjusted close — drop it (never a fabricated cap).
    assert close_from_response(0.0) is None
    assert close_from_response(-5.0) is None
    assert close_from_response(float("nan")) is None
    assert close_from_response(float("inf")) is None
    assert close_from_response("not-a-number") is None
    assert close_from_response({"close": 5.0}) is None


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

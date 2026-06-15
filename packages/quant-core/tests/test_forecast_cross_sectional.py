"""Tests for ``quant_core.forecast.cross_sectional`` — Task 4, the pooled OLS members.

The cross-sectional forecasters (Li-Mohanram RI / EP + HVZ) are pure numpy over an
ALREADY-ASSEMBLED training panel of :class:`TrainingPair` rows (feature@t paired with its realised
``E[t+τ]/A`` label@t+τ), so the tests build plain panels — no synthetic lake, no pyarrow. They pin the
plan's done-when (Task 4) plus the fail-closed edges:

  * the PIT **vintage join** rejects a pair whose LABEL is not yet known as-of ``s`` — AND, the other
    leg, a pair whose FEATURE is not yet known (aging only one is the classic look-ahead bug);
  * the stored 1/99 **winsor thresholds** are REUSED at predict (clamp a live outlier to the
    training-time caps, never re-percentiled on the live row);
  * **coefficient signs** on a constructed RI panel — ``χ2(E/A) > 0, χ4(B/A) > 0, χ3(NegE·E/A) < 0,
    χ5(AC/A) < 0`` (built by fitting a noise-free ``y = Xβ_true`` and checking OLS recovers β_true,
    which doubles as the "recover known coefficients" sanity check);
  * a ``< N``-name cross-section yields **no fit** (``None``), never a garbage fit on a thin sample;
  * a degenerate (rank-deficient) design also yields ``None`` rather than lstsq's minimum-norm fudge.
"""
from __future__ import annotations

from datetime import date

import numpy as np
import pytest

from quant_core.forecast import (
    MODEL_EP,
    MODEL_HVZ,
    MODEL_RI,
    MODELS,
    FirmYearFeatures,
    TrainingPair,
    admissible_at,
    fit_all_models,
    fit_vintage,
    predict,
    predict_ratio,
)
from quant_core.forecast.cross_sectional import MIN_FIT_OBS

# A reference estimation instant (UTC ms) and a year in ms — knowledge_ts legs are placed relative to
# it so the vintage-join tests read clearly (before/after the estimation date).
AS_OF_MS = 1_700_000_000_000
YEAR_MS = 365 * 24 * 60 * 60 * 1000


def _fy(
    *,
    roa: float,
    neg_e: int = 0,
    book_to_assets: float | None = None,
    accruals_to_assets: float | None = None,
    payout: float | None = None,
    dd: int | None = None,
    total_assets: float = 1_000.0,
    knowledge_ts: int | None = AS_OF_MS - YEAR_MS,
    period_end: date = date(2020, 12, 31),
) -> FirmYearFeatures:
    """A FirmYearFeatures with the scaled ratios set directly (the regression operates on the ratios).

    ``net_income`` is back-solved from ``roa × total_assets`` so the row is internally consistent (and
    ``predict`` can recover a level off ``total_assets``); the optional legs are passed straight through
    so a test can exercise the listwise-drop on a missing model regressor. ``knowledge_ts`` defaults to
    one year BEFORE the estimation date (admissible by default).
    """
    return FirmYearFeatures(
        period_end=period_end,
        knowledge_ts=knowledge_ts,
        net_income=roa * total_assets,
        total_assets=total_assets,
        roa=roa,
        neg_e=neg_e,
        total_equity=None if book_to_assets is None else book_to_assets * total_assets,
        book_to_assets=book_to_assets,
        dividends=None if payout is None else payout * total_assets,
        payout=payout,
        dd=dd,
        accruals=None if accruals_to_assets is None else accruals_to_assets * total_assets,
        accruals_to_assets=accruals_to_assets,
    )


def _ri_pair(
    *,
    roa: float,
    neg_e: int,
    book_to_assets: float,
    accruals_to_assets: float,
    label_roa: float,
    feat_knowledge_ts: int = AS_OF_MS - YEAR_MS,
    label_knowledge_ts: int = AS_OF_MS - YEAR_MS,
) -> TrainingPair:
    """A fully-specified RI training pair (all RI legs present so no listwise-drop)."""
    return TrainingPair(
        x=_fy(
            roa=roa,
            neg_e=neg_e,
            book_to_assets=book_to_assets,
            accruals_to_assets=accruals_to_assets,
            knowledge_ts=feat_knowledge_ts,
        ),
        label_roa=label_roa,
        label_knowledge_ts=label_knowledge_ts,
    )


# --------------------------------------------------------------------------------------------------- #
# admissible_at — the PIT vintage-join predicate. BOTH the feature AND the label must be known as-of.  #
# --------------------------------------------------------------------------------------------------- #
def test_admissible_when_both_legs_known_before_as_of() -> None:
    pair = _ri_pair(
        roa=0.1,
        neg_e=0,
        book_to_assets=0.4,
        accruals_to_assets=0.02,
        label_roa=0.11,
        feat_knowledge_ts=AS_OF_MS - YEAR_MS,
        label_knowledge_ts=AS_OF_MS - 1,  # known a moment before the estimation date
    )
    assert admissible_at(pair, AS_OF_MS) is True


def test_vintage_join_rejects_not_yet_known_label() -> None:
    """A pair whose LABEL became knowable AFTER ``s`` is inadmissible — aging the feature but not the
    label is the look-ahead bug (training on a future-earnings outcome not yet reported as-of s)."""
    pair = _ri_pair(
        roa=0.1,
        neg_e=0,
        book_to_assets=0.4,
        accruals_to_assets=0.02,
        label_roa=0.11,
        feat_knowledge_ts=AS_OF_MS - YEAR_MS,  # feature IS known
        label_knowledge_ts=AS_OF_MS + 1,       # label NOT yet known (one ms in the future)
    )
    assert admissible_at(pair, AS_OF_MS) is False


def test_vintage_join_rejects_not_yet_known_feature() -> None:
    """The other leg: a pair whose FEATURE is not yet known as-of ``s`` is also inadmissible."""
    pair = _ri_pair(
        roa=0.1,
        neg_e=0,
        book_to_assets=0.4,
        accruals_to_assets=0.02,
        label_roa=0.11,
        feat_knowledge_ts=AS_OF_MS + 1,        # feature NOT yet known
        label_knowledge_ts=AS_OF_MS - YEAR_MS,  # label is known
    )
    assert admissible_at(pair, AS_OF_MS) is False


def test_vintage_join_rejects_missing_knowledge_ts() -> None:
    """Fail-closed: a pair whose knowability cannot be established (a None knowledge_ts on either leg)
    is treated as inadmissible — never silently entered into a PIT-filtered fit."""
    # Feature knowability unknown (x.knowledge_ts=None), label known → inadmissible.
    no_feat_ts = _ri_pair(
        roa=0.1,
        neg_e=0,
        book_to_assets=0.4,
        accruals_to_assets=0.02,
        label_roa=0.11,
        feat_knowledge_ts=None,  # type: ignore[arg-type]  # exercising the None-leg fail-closed path
        label_knowledge_ts=AS_OF_MS - YEAR_MS,
    )
    assert admissible_at(no_feat_ts, AS_OF_MS) is False

    # Label knowability unknown (label_knowledge_ts=None), feature known → inadmissible.
    known_feat = _ri_pair(roa=0.1, neg_e=0, book_to_assets=0.4, accruals_to_assets=0.02, label_roa=0.11)
    no_label_ts = TrainingPair(x=known_feat.x, label_roa=0.11, label_knowledge_ts=None)
    assert admissible_at(no_label_ts, AS_OF_MS) is False


def test_fit_filters_out_inadmissible_pairs() -> None:
    """``fit_vintage`` drops not-yet-known pairs BEFORE fitting: a panel of MIN_FIT_OBS admissible rows
    plus extra future-label rows fits; the same panel with the admissible rows' labels pushed into the
    future yields no fit (all filtered out → below the floor)."""
    rng = np.random.default_rng(0)
    admissible = [
        _ri_pair(
            roa=float(rng.uniform(-0.2, 0.2)),
            neg_e=int(rng.integers(0, 2)),
            book_to_assets=float(rng.uniform(0.1, 0.9)),
            accruals_to_assets=float(rng.uniform(-0.1, 0.1)),
            label_roa=float(rng.uniform(-0.2, 0.2)),
            label_knowledge_ts=AS_OF_MS - 1,  # known
        )
        for _ in range(MIN_FIT_OBS + 5)
    ]
    assert fit_vintage(admissible, MODEL_RI, 1, AS_OF_MS) is not None

    future = [
        TrainingPair(x=p.x, label_roa=p.label_roa, label_knowledge_ts=AS_OF_MS + YEAR_MS)
        for p in admissible
    ]
    assert fit_vintage(future, MODEL_RI, 1, AS_OF_MS) is None  # all inadmissible → below floor → None


# --------------------------------------------------------------------------------------------------- #
# Coefficient signs + known-coefficient recovery — a noise-free RI panel y = X β_true.                 #
# --------------------------------------------------------------------------------------------------- #
# Discrete level grids for the WINSOR-PROOF recovery panel. Drawing each regressor from a small fixed
# set repeated many times makes the 1st/99th percentile land exactly on grid values that EVERY row is
# already within — so the fit's winsor clip is a genuine no-op and the noise-free ``y = X @ beta_true``
# relation survives intact, making exact (1e-6) coefficient recovery a legitimate assertion rather than
# one perturbed by the ~1% the percentile clip would otherwise trim off a continuous uniform tail.
_ROA_LEVELS = (-0.10, -0.04, 0.02, 0.08, 0.14)
_BOOK_LEVELS = (0.25, 0.40, 0.55, 0.70)
_ACC_LEVELS = (-0.06, -0.02, 0.02, 0.06)


def _build_ri_panel_from_beta(beta_true: np.ndarray, n: int, seed: int) -> list[TrainingPair]:
    """An admissible RI panel of ``n`` pairs whose labels are EXACTLY ``X @ beta_true`` (noise-free).

    The RI design is ``[1, NegE, E/A, NegE·E/A, B/A, AC/A]``. Each regressor is drawn from a small
    DISCRETE level set (:data:`_ROA_LEVELS` etc.) so the cross-section's 1/99 winsor caps land on grid
    values all rows already satisfy — the clip is a no-op and the noise-free ``y = X β_true`` relation is
    preserved exactly. ``neg_e`` alternates (full-rank dummy + interaction), every leg is present (no
    listwise-drop), and OLS recovers ``beta_true`` to numerical precision — so both the sign assertions
    AND the known-coefficient sanity check ride on this panel.
    """
    # Deterministic balanced cycling through each level (not random sampling) so every grid level —
    # crucially the extreme ones — has ~n/len(levels) rows. That guarantees the 1st/99th percentile index
    # lands well inside the lowest/highest level's block, so the winsor caps equal the extreme grid values
    # and the clip is provably a no-op (the seed is accepted for signature parity but unused here).
    _ = seed
    pairs: list[TrainingPair] = []
    for i in range(n):
        neg_e = i % 2  # alternate so NegE (and NegE·roa) have variance → full-rank design
        roa = float(_ROA_LEVELS[i % len(_ROA_LEVELS)])
        book = float(_BOOK_LEVELS[(i // 5) % len(_BOOK_LEVELS)])   # de-aligned period from roa
        acc = float(_ACC_LEVELS[(i // 3) % len(_ACC_LEVELS)])      # de-aligned period from roa + book
        design = np.array([1.0, neg_e, roa, neg_e * roa, book, acc])
        label = float(design @ beta_true)
        pairs.append(
            _ri_pair(
                roa=roa, neg_e=neg_e, book_to_assets=book, accruals_to_assets=acc, label_roa=label
            )
        )
    return pairs


def test_ri_coefficient_signs() -> None:
    """RI sign contract (the brief): χ2(E/A) > 0, χ4(B/A) > 0, χ3(NegE·E/A) < 0, χ5(AC/A) < 0.

    A noise-free panel built with a β_true carrying exactly these signs — OLS must recover signs that
    match. Coefficient order: [χ0, χ1(NegE), χ2(E/A), χ3(NegE·E/A), χ4(B/A), χ5(AC/A)].
    """
    beta_true = np.array([0.01, -0.02, 0.80, -0.30, 0.05, -0.40])
    fit = fit_vintage(_build_ri_panel_from_beta(beta_true, 400, seed=1), MODEL_RI, 1, AS_OF_MS)
    assert fit is not None
    c = fit.coefficients
    assert c[2] > 0  # χ2 on E/A (higher current ROA → higher future ROA)
    assert c[4] > 0  # χ4 on B/A (book-to-assets positive)
    assert c[3] < 0  # χ3 on NegE·E/A (a loss attenuates earnings persistence)
    assert c[5] < 0  # χ5 on AC/A (high accruals → lower future earnings — the accrual anomaly)


def test_ri_recovers_known_coefficients_noise_free() -> None:
    """Sanity: on a noise-free panel (discrete-grid regressors so the winsor clip is a no-op) OLS
    recovers β_true to numerical precision — the regression solves the system it was handed, confirming
    the design-matrix assembly + the lstsq solve are correct."""
    beta_true = np.array([0.012, -0.018, 0.77, -0.25, 0.061, -0.33])
    fit = fit_vintage(_build_ri_panel_from_beta(beta_true, 500, seed=2), MODEL_RI, 1, AS_OF_MS)
    assert fit is not None
    np.testing.assert_allclose(fit.coefficients, beta_true, rtol=1e-6, atol=1e-8)


# --------------------------------------------------------------------------------------------------- #
# Stored winsor thresholds — computed on the TRAINING cross-section, REUSED to clamp a live row.       #
# --------------------------------------------------------------------------------------------------- #
def test_winsor_thresholds_stored_on_fit() -> None:
    """The fit carries 1/99 caps for every continuous RI regressor + the label (the dummies are not
    winsorized)."""
    fit = fit_vintage(
        _build_ri_panel_from_beta(np.array([0.0, 0.0, 0.5, 0.0, 0.1, -0.2]), 300, seed=3),
        MODEL_RI,
        1,
        AS_OF_MS,
    )
    assert fit is not None
    assert set(fit.winsor_caps) == {"roa", "book_to_assets", "accruals_to_assets", "label"}
    for lo, hi in fit.winsor_caps.values():
        assert lo <= hi


def test_stored_thresholds_reused_at_predict_not_recomputed() -> None:
    """A live row with an EXTREME roa is clamped to the STORED training-time upper cap, NOT re-percentiled
    on the live row. Verified by predicting with the extreme row and with a row whose roa is exactly the
    stored cap — the two ratios are identical (the extreme was clamped down to the cap).
    """
    # Train on roa drawn from a bounded range so the 99th-pct cap is a concrete interior value.
    # neg_e alternates so the RI design ([1, NegE, roa, NegE·roa, B/A, AC/A]) is full-rank — what is
    # under test is the stored-cap REUSE at predict, not the fit itself.
    rng = np.random.default_rng(4)
    panel = [
        _ri_pair(
            roa=float(rng.uniform(0.0, 0.10)),  # roa in [0, 0.10]
            neg_e=i % 2,
            book_to_assets=float(rng.uniform(0.2, 0.8)),
            accruals_to_assets=float(rng.uniform(-0.05, 0.05)),
            label_roa=float(rng.uniform(0.0, 0.10)),
        )
        for i in range(300)
    ]
    fit = fit_vintage(panel, MODEL_RI, 1, AS_OF_MS)
    assert fit is not None
    roa_cap_hi = fit.winsor_caps["roa"][1]
    assert roa_cap_hi < 0.5  # the cap is well inside the training range, far below the extreme below

    extreme = _fy(roa=5.0, neg_e=0, book_to_assets=0.5, accruals_to_assets=0.0)  # roa=500%, way past cap
    at_cap = _fy(roa=roa_cap_hi, neg_e=0, book_to_assets=0.5, accruals_to_assets=0.0)
    # The extreme roa must be CLAMPED to the stored cap → identical fitted ratio as the at-cap row.
    # (If the caps were recomputed on the single live row, the extreme would not be clamped and the
    # two predictions would differ wildly.)
    assert predict_ratio(fit, extreme) == pytest.approx(predict_ratio(fit, at_cap))


def test_predict_recovers_earnings_level_from_ratio_times_assets() -> None:
    """``predict`` = fitted ratio × current A. With a known fit and a live row, the level is the ratio
    times the row's total_assets (the recover-the-level step; EPS ÷ shares is the caller's)."""
    beta_true = np.array([0.0, 0.0, 0.6, 0.0, 0.1, -0.2])
    fit = fit_vintage(_build_ri_panel_from_beta(beta_true, 300, seed=5), MODEL_RI, 1, AS_OF_MS)
    assert fit is not None
    live = _fy(roa=0.08, neg_e=0, book_to_assets=0.5, accruals_to_assets=0.01, total_assets=2_000.0)
    ratio = predict_ratio(fit, live)
    assert ratio is not None
    assert predict(fit, live) == pytest.approx(ratio * 2_000.0)


# --------------------------------------------------------------------------------------------------- #
# Degenerate samples → no fit (None), never a garbage regression.                                      #
# --------------------------------------------------------------------------------------------------- #
def test_below_min_obs_cross_section_yields_no_fit() -> None:
    """A cross-section with fewer than MIN_FIT_OBS admissible rows yields None — the brief's 'a region
    with < N names yields no fit' (an unpopulated dev-ex-US / EM region lands exactly here)."""
    thin = _build_ri_panel_from_beta(np.array([0.0, 0.0, 0.5, 0.0, 0.1, -0.2]), MIN_FIT_OBS - 1, seed=6)
    assert len(thin) < MIN_FIT_OBS
    assert fit_vintage(thin, MODEL_RI, 1, AS_OF_MS) is None


def test_exactly_min_obs_fits() -> None:
    """The floor is inclusive: exactly MIN_FIT_OBS admissible full-rank rows DO fit (the boundary is not
    silently off-by-one)."""
    panel = _build_ri_panel_from_beta(np.array([0.0, 0.0, 0.5, 0.0, 0.1, -0.2]), MIN_FIT_OBS, seed=7)
    assert len(panel) == MIN_FIT_OBS
    assert fit_vintage(panel, MODEL_RI, 1, AS_OF_MS) is not None


def test_rank_deficient_design_yields_no_fit() -> None:
    """A regressor with NO variance across the whole sample (here every name a non-payer, so HVZ's DD
    column is constant 0) makes the design rank-deficient → None, NOT lstsq's minimum-norm pseudo-fit.
    """
    rng = np.random.default_rng(8)
    panel = [
        TrainingPair(
            x=_fy(
                roa=float(rng.uniform(-0.1, 0.1)),
                neg_e=0,
                payout=0.0,   # every name pays nothing → DD = 0 for all → constant column
                dd=0,
                accruals_to_assets=float(rng.uniform(-0.05, 0.05)),
            ),
            label_roa=float(rng.uniform(-0.1, 0.1)),
            label_knowledge_ts=AS_OF_MS - YEAR_MS,
        )
        for _ in range(MIN_FIT_OBS + 50)
    ]
    assert fit_vintage(panel, MODEL_HVZ, 1, AS_OF_MS) is None


def test_listwise_drop_on_missing_model_leg() -> None:
    """A row missing a model regressor (RI needs book_to_assets) is listwise-dropped, never zero-filled.
    A panel of MIN_FIT_OBS rows that all LACK book_to_assets has zero usable RI rows → None."""
    # roa varies and neg_e alternates so the EP design ([1, NegE, roa, NegE·roa]) is full-rank — the
    # point under test is the RI listwise-drop on the absent book_to_assets, not an EP rank failure.
    no_book = [
        TrainingPair(
            x=_fy(roa=0.05 + 0.001 * i, neg_e=i % 2, accruals_to_assets=0.01),  # book_to_assets None
            label_roa=0.05 + 0.0007 * i,
            label_knowledge_ts=AS_OF_MS - YEAR_MS,
        )
        for i in range(MIN_FIT_OBS + 5)
    ]
    assert fit_vintage(no_book, MODEL_RI, 1, AS_OF_MS) is None
    # EP needs only the mandatory legs (roa, neg_e) — the SAME rows DO fit EP (proving the drop is
    # model-specific, not a blanket reject).
    assert fit_vintage(no_book, MODEL_EP, 1, AS_OF_MS) is not None


def test_predict_returns_none_on_missing_live_leg() -> None:
    """A live row missing a model regressor → predict None (fail-closed, no fabricated forecast)."""
    fit = fit_vintage(
        _build_ri_panel_from_beta(np.array([0.0, 0.0, 0.5, 0.0, 0.1, -0.2]), 200, seed=9),
        MODEL_RI,
        1,
        AS_OF_MS,
    )
    assert fit is not None
    missing_book = _fy(roa=0.08, neg_e=0, accruals_to_assets=0.01)  # no book_to_assets → RI cannot predict
    assert predict_ratio(fit, missing_book) is None
    assert predict(fit, missing_book) is None


# --------------------------------------------------------------------------------------------------- #
# Per-horizon + per-model coverage.                                                                    #
# --------------------------------------------------------------------------------------------------- #
def test_unsupported_horizon_rejected() -> None:
    with pytest.raises(ValueError):
        fit_vintage(
            _build_ri_panel_from_beta(np.array([0.0, 0.0, 0.5, 0.0, 0.1, -0.2]), MIN_FIT_OBS, seed=10),
            MODEL_RI,
            4,  # not in HORIZONS
            AS_OF_MS,
        )


def test_each_horizon_fits_independently() -> None:
    """One pooled OLS PER horizon τ ∈ {1,2,3}: the same panel fits at each horizon (the caller pairs a
    different label per τ; here the structure is what's asserted — every horizon produces a fit)."""
    panel = _build_ri_panel_from_beta(np.array([0.0, 0.0, 0.5, 0.0, 0.1, -0.2]), 200, seed=11)
    for tau in (1, 2, 3):
        fit = fit_vintage(panel, MODEL_RI, tau, AS_OF_MS)
        assert fit is not None
        assert fit.horizon == tau


def test_ep_and_hvz_models_fit_on_complete_panels() -> None:
    """EP (needs roa+neg_e) and HVZ (needs payout+dd+roa+neg_e+accruals) both fit when their legs are
    present — the three specifications are all wired, not just RI."""
    rng = np.random.default_rng(12)
    panel = [
        TrainingPair(
            x=_fy(
                roa=float(rng.uniform(-0.15, 0.2)),
                neg_e=int(rng.integers(0, 2)),
                payout=float(rng.uniform(0.0, 0.06)),
                dd=int(rng.integers(0, 2)),  # variance in DD so HVZ is full-rank
                accruals_to_assets=float(rng.uniform(-0.08, 0.08)),
                book_to_assets=float(rng.uniform(0.1, 0.9)),
            ),
            label_roa=float(rng.uniform(-0.15, 0.2)),
            label_knowledge_ts=AS_OF_MS - YEAR_MS,
        )
        for _ in range(300)
    ]
    assert fit_vintage(panel, MODEL_EP, 1, AS_OF_MS) is not None
    assert fit_vintage(panel, MODEL_HVZ, 1, AS_OF_MS) is not None


def test_fit_all_models_omits_unfittable_models() -> None:
    """``fit_all_models`` returns only the models that produced a fit. A panel with NO dividend/accruals
    legs fits EP (mandatory-leg only) but not RI/HVZ → the dict carries EP alone (omitted, never a None
    value)."""
    # roa varies and neg_e alternates so EP's design is full-rank; no dividend/accruals/book legs are
    # set, so RI + HVZ each listwise-drop EVERY row (all needed legs absent) → only EP fits.
    panel = [
        TrainingPair(
            x=_fy(roa=float(0.04 + 0.0005 * i), neg_e=i % 2),  # only the mandatory roa + neg_e present
            label_roa=0.05 + 0.0006 * i,
            label_knowledge_ts=AS_OF_MS - YEAR_MS,
        )
        for i in range(MIN_FIT_OBS + 10)
    ]
    fits = fit_all_models(panel, AS_OF_MS, 1)
    assert set(fits) == {MODEL_EP}
    assert all(m in MODELS for m in fits)


def test_fit_all_models_full_panel_fits_all_three() -> None:
    rng = np.random.default_rng(13)
    panel = [
        TrainingPair(
            x=_fy(
                roa=float(rng.uniform(-0.15, 0.2)),
                neg_e=int(rng.integers(0, 2)),
                payout=float(rng.uniform(0.0, 0.06)),
                dd=int(rng.integers(0, 2)),
                accruals_to_assets=float(rng.uniform(-0.08, 0.08)),
                book_to_assets=float(rng.uniform(0.1, 0.9)),
            ),
            label_roa=float(rng.uniform(-0.15, 0.2)),
            label_knowledge_ts=AS_OF_MS - YEAR_MS,
        )
        for _ in range(400)
    ]
    fits = fit_all_models(panel, AS_OF_MS, 1)
    assert set(fits) == set(MODELS)

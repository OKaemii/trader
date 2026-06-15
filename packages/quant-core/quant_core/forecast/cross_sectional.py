"""Cross-sectional pooled-OLS earnings forecasters — Li-Mohanram **RI** / **EP** + **HVZ**.

The mechanical-forecast workhorse (plan ``analyst-free-estimates-engine.md`` Task 4; research
§"External findings"): one pooled ordinary-least-squares regression **per horizon** ``τ ∈ {1, 2, 3}``
for each of three model specifications, fit on a panel of firm-fiscal-year rows
(:class:`~quant_core.forecast.features.FirmYearFeatures`, the scaled-by-total-assets inputs from
Task 2) paired with their realised future earnings-to-assets label. The fitted ratio ``E[t+τ]/A`` is
multiplied back by a name's current assets at predict time to recover an earnings *level*.

WHY THREE MODELS, AND WHY RI LEADS. The cited methods brief (Li & Mohanram 2014, cross-verified)
found **HVZ forecasts perform *worse than a naïve random walk***, while their **residual-income (RI)**
model is 28–38% more accurate and is the recommended primary; their earnings-persistence (**EP**) model
sits between. All three are built here so the ensemble (Task 5) can MAE-weight them and **drop any
member that loses to the seasonal-RW floor in a region** — HVZ is a comparison member, not the
primary. The specifications (Design § Layer 1, all operating on the ``/total-assets`` scaled ratios):

  * **Li-Mohanram RI** (primary)::

        E[t+τ]/A = χ0 + χ1·NegE + χ2·(E/A) + χ3·(NegE·E/A) + χ4·(B/A) + χ5·(AC/A) + ε

  * **Li-Mohanram EP** (earnings persistence)::

        E[t+τ]/A = β0 + β1·NegE + β2·(E/A) + β3·(NegE·E/A) + ε

  * **HVZ** (comparison member)::

        E[t+τ]/A = α0 + α1·(D/A) + α2·DD + α3·(E/A) + α4·NegE + α5·(AC/A) + ε

  (The brief's HVZ also carries a raw-``A`` term; here every input is already deflated by total assets
  — the dimensionless-ratio pool that forward-proofs the card-131 cross-currency segmentation — so the
  level-``A`` regressor is dropped and ``D/A`` / ``E/A`` / ``AC/A`` carry the scale-free information,
  the inference-preserving robustness deflator the brief sanctions (HVZ p.507, LM §6).)

THE PIT VINTAGE TRAP (load-bearing — this is the subtle correctness risk the research flags). A
training pair ``(X@t, Y@t+τ)`` is admissible at an estimation date ``s`` ONLY if **BOTH** the feature
``X.knowledge_ts ≤ s`` AND the realised label ``Y.knowledge_ts ≤ s``. Aging the feature but not the
label is the classic look-ahead bug: it would train on a ``t+τ`` earnings outcome that was not yet
*reported* as-of ``s``. Because the label is the FUTURE year's earnings, for ``τ=3`` the freshest
admissible cohort is **~4 years stale** as-of ``s`` (the most recent ``t`` whose ``t+3`` earnings are
already filed) — that is **CORRECT, not a bug**. :func:`fit_vintage` enforces the rule by filtering the
panel to admissible pairs *before* fitting; :func:`admissible_at` is the single predicate, unit-tested
on both legs (a not-yet-known label AND a not-yet-known feature are each rejected).

WINSORIZATION — 1/99 WITHIN the estimation cross-section, thresholds STORED and reused live. Each
continuous regressor (and the label) is winsorized at its 1st/99th percentile **computed over the
admissible training cross-section**, the per-variable caps are STORED on the
:class:`CrossSectionalFit`, and the SAME caps are clamped onto a live input row at
:func:`predict` time. Recomputing percentiles on the prediction cross-section (or worse, on a single
live row) is the mistake the brief calls out — the live row must be clamped to the *training-time*
distribution it was estimated against. The dummies (``NegE`` / ``DD`` ∈ {0, 1}) are NOT winsorized.

DEGENERATE SAMPLES → NO FIT (never a garbage fit). A cross-section with fewer than :data:`MIN_FIT_OBS`
admissible rows — a region the lake has not yet populated (every non-US name is fail-closed today, so
dev-ex-US / EM are empty until card 131), or simply a thin slice — yields **``None``**, never an
under-determined / overfit regression on a handful of points. A rank-deficient design (a regressor that
is constant or collinear across the whole sample, e.g. every name a payer so ``DD`` has no variance)
also yields ``None`` rather than ``numpy.linalg.lstsq``'s minimum-norm fudge — an honest "cannot
estimate this here", the same fail-closed axis as :mod:`quant_core.screen.quality`.

PURE — no I/O, no network, no lake, no pyarrow, no sklearn. The caller (fundamentals-api estimates
assembly #236 / backtest replay) assembles the training panel across the full-lake estimation pool
(per-name ``pit_metric_history`` series, the X@t↔Y@t+τ pairing by annual period-end) and hands plain
:class:`TrainingPair` rows in — exactly as :mod:`quant_core.forecast.features` takes already-fetched
values. The regression itself is ``numpy.linalg.lstsq`` (an SVD least-squares solve — no normal-equation
conditioning loss, no sklearn). This module only does the matrix assembly + the winsor/vintage
bookkeeping + the solve, so the unit tests run on plain hand-built panels (no synthetic lake).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .features import FirmYearFeatures

# The annual horizons (years ahead) a panel can be fit for — one independent pooled OLS per τ. Mirrors
# ``baseline.HORIZONS`` so the ensemble aligns the cross-sectional members with the RW floor on the
# same horizon keys.
HORIZONS: tuple[int, ...] = (1, 2, 3)

# The three model specifications. A model is named by its key; the design-matrix builder
# (:func:`_design_row`) dispatches on it. RI leads the ensemble (Li-Mohanram: HVZ < RW); EP and HVZ are
# the comparison members. Declared as constants (not bare strings at call sites) so a typo is a
# NameError, not a silently-empty fit.
MODEL_RI: str = "ri"   # Li-Mohanram residual-income (primary)
MODEL_EP: str = "ep"   # Li-Mohanram earnings-persistence
MODEL_HVZ: str = "hvz"  # Hou-van Dijk-Zhang (comparison member)
MODELS: tuple[str, ...] = (MODEL_RI, MODEL_EP, MODEL_HVZ)

# Minimum admissible firm-year rows to attempt a fit. A pooled annual cross-sectional regression is
# estimated over the FULL lake (~thousands of US names), so a real US cross-section clears this by
# orders of magnitude; the floor exists to refuse a fit on a thin / unpopulated region (dev-ex-US / EM
# are empty until card 131) rather than overfit a handful of points. Set well above the largest model's
# parameter count (RI/HVZ have 6 coefficients) with headroom for the residual degrees of freedom a
# meaningful OLS needs — 30 is a conservative small-sample floor (>> 6 params), below which the brief's
# "a region with < N names yields no fit" rule fires.
MIN_FIT_OBS: int = 30

# The winsorization tail fractions — 1st / 99th percentile, the brief's "winsorize 1/99 within each
# as-of cross-section". Applied to every CONTINUOUS regressor + the label (the {0,1} dummies are left
# alone — clamping a dummy is meaningless). The thresholds are computed on the training cross-section
# and STORED for reuse at predict (never recomputed on the prediction row).
WINSOR_LOWER_PCT: float = 1.0
WINSOR_UPPER_PCT: float = 99.0

# The continuous feature keys each model winsorizes + stores caps for (the dummies neg_e / dd are
# excluded). Keyed by the FirmYearFeatures attribute name so the same caps clamp a live row's matching
# field at predict. ``roa`` (E/A) and ``label`` are common; the rest are per-model.
_CONTINUOUS_FEATURES_BY_MODEL: dict[str, tuple[str, ...]] = {
    # RI:  intercept, NegE, E/A, NegE·E/A, B/A, AC/A → continuous: roa, book_to_assets, accruals_to_assets
    MODEL_RI: ("roa", "book_to_assets", "accruals_to_assets"),
    # EP:  intercept, NegE, E/A, NegE·E/A → continuous: roa
    MODEL_EP: ("roa",),
    # HVZ: intercept, D/A, DD, E/A, NegE, AC/A → continuous: roa, payout, accruals_to_assets
    MODEL_HVZ: ("roa", "payout", "accruals_to_assets"),
}


# --------------------------------------------------------------------------------------------------- #
# The training pair — one (X@t, Y@t+τ) observation the caller assembles across the estimation pool.    #
# --------------------------------------------------------------------------------------------------- #
@dataclass(frozen=True)
class TrainingPair:
    """One firm-year feature row paired with its realised ``E[t+τ]/A`` label, for a fixed horizon ``τ``.

    The caller (#236 / replay) builds these by walking a name's ``pit_metric_history`` annual series:
    the feature ``x`` is firm-year ``t``; ``label_roa`` is that name's realised ``net_income[t+τ] /
    total_assets[t+τ]`` (the future year's earnings-to-assets — the same ÷-total-assets deflation the
    features use, so the fitted ratio is directly the target). ``label_knowledge_ts`` is when the
    *label's* (the ``t+τ`` earnings') own filing became knowable — the leg the vintage join ages the
    LABEL on (distinct from ``x.knowledge_ts``, which ages the FEATURE). Aging only one is the
    look-ahead bug this whole structure exists to make impossible.

    Both ``knowledge_ts`` legs are ``Optional`` to mirror the lake contract's shape, but a pair missing
    EITHER is treated as inadmissible by :func:`admissible_at` (fail-closed: a row whose knowability we
    cannot establish must not silently enter a PIT-filtered fit).
    """

    x: FirmYearFeatures
    label_roa: float          # realised E[t+τ]/A — the regression target
    label_knowledge_ts: Optional[int]  # when the t+τ earnings became knowable (ages the LABEL)


@dataclass(frozen=True)
class CrossSectionalFit:
    """A fitted pooled OLS for one (model, horizon) — its coefficients + the stored winsor caps.

    ``coefficients`` are in the design-matrix column order of the model (intercept first; see
    :func:`_design_row`). ``winsor_caps`` maps each winsorized variable name (the continuous regressors
    + ``"label"``) to its ``(lower, upper)`` 1/99 thresholds **computed on the training cross-section** —
    these are reapplied at :func:`predict` so a live row is clamped to the training distribution, never
    re-percentiled. ``n_obs`` is the admissible-pair count the fit was estimated on (diagnostics /
    the ensemble's confidence weighting).

    Immutable — a fit is a value object; re-estimating produces a new one.
    """

    model: str
    horizon: int
    coefficients: np.ndarray
    winsor_caps: dict[str, tuple[float, float]]
    n_obs: int = field(default=0)


def admissible_at(pair: TrainingPair, as_of_ms: int) -> bool:
    """The PIT vintage-join predicate: is ``pair`` usable to estimate AS-OF ``as_of_ms``?

    Admissible iff BOTH the feature and the realised label were already knowable at the estimation
    instant — ``pair.x.knowledge_ts <= as_of_ms`` AND ``pair.label_knowledge_ts <= as_of_ms``. A pair
    missing EITHER ``knowledge_ts`` is inadmissible (fail-closed: a row whose knowability is unknown is
    never assumed available). Aging the feature without the label (or vice-versa) is the look-ahead bug;
    this is the single guard both :func:`fit_vintage` and the tests route through.
    """
    if pair.x.knowledge_ts is None or pair.label_knowledge_ts is None:
        return False
    return pair.x.knowledge_ts <= as_of_ms and pair.label_knowledge_ts <= as_of_ms


def _winsor_bounds(values: np.ndarray) -> tuple[float, float]:
    """The (1st, 99th)-percentile clamp bounds for a 1-D array of a regressor's training values."""
    lo = float(np.percentile(values, WINSOR_LOWER_PCT))
    hi = float(np.percentile(values, WINSOR_UPPER_PCT))
    return lo, hi


def _design_row(x: FirmYearFeatures, model: str) -> Optional[list[float]]:
    """One design-matrix row for ``model`` from a feature row, or ``None`` if a needed leg is missing.

    Intercept first, then the model's regressors in the order documented in the module docstring. A row
    whose model needs a fail-closed-omitted leg (``book_to_assets`` for RI, ``payout``/``dd`` for HVZ,
    ``accruals_to_assets`` for RI/HVZ) returns ``None`` — that observation is listwise-dropped from the
    fit (never zero-filled, which would fabricate the missing regressor's value). ``roa`` and ``neg_e``
    are always present on a valid :class:`FirmYearFeatures` (E + A are mandatory), so the EP model — which
    needs only those — never drops on a missing leg.

    The interaction term ``NegE·E/A`` is formed here (a derived regressor, not a stored feature).
    """
    roa = x.roa
    neg_e = float(x.neg_e)
    neg_e_roa = neg_e * roa  # NegE × E/A interaction (RI + EP)

    if model == MODEL_RI:
        # E[t+τ]/A = χ0 + χ1·NegE + χ2·(E/A) + χ3·(NegE·E/A) + χ4·(B/A) + χ5·(AC/A)
        if x.book_to_assets is None or x.accruals_to_assets is None:
            return None  # listwise-drop: a fabricated 0 would corrupt the χ4·(B/A) / χ5·(AC/A) terms
        return [1.0, neg_e, roa, neg_e_roa, x.book_to_assets, x.accruals_to_assets]

    if model == MODEL_EP:
        # E[t+τ]/A = β0 + β1·NegE + β2·(E/A) + β3·(NegE·E/A) — needs only the mandatory legs
        return [1.0, neg_e, roa, neg_e_roa]

    if model == MODEL_HVZ:
        # E[t+τ]/A = α0 + α1·(D/A) + α2·DD + α3·(E/A) + α4·NegE + α5·(AC/A)
        if x.payout is None or x.dd is None or x.accruals_to_assets is None:
            return None  # listwise-drop on a missing dividend / accruals leg (never 0-filled)
        return [1.0, x.payout, float(x.dd), roa, neg_e, x.accruals_to_assets]

    raise ValueError(f"unknown cross-sectional model: {model!r}")


def _clamp(value: float, caps: tuple[float, float]) -> float:
    """Clamp ``value`` to the stored ``(lower, upper)`` winsor bounds."""
    lo, hi = caps
    return min(max(value, lo), hi)


def fit_vintage(
    panel: list[TrainingPair], model: str, horizon: int, as_of_ms: int
) -> Optional[CrossSectionalFit]:
    """Fit one pooled OLS for ``(model, horizon)`` on the PIT-admissible slice of ``panel`` as-of ``as_of_ms``.

    The full vintage-correct estimation in one call:

    1. **Vintage join** — keep only pairs admissible at ``as_of_ms`` (:func:`admissible_at`: BOTH the
       feature AND the label already knowable). This is where the ~4y-stale τ=3 cohort is the *correct*
       freshest sample, not a bug.
    2. **Listwise design assembly** — build each admissible row's design vector (:func:`_design_row`);
       a row missing a model regressor is dropped (never zero-filled).
    3. **Degenerate-sample guard** — fewer than :data:`MIN_FIT_OBS` usable rows ⇒ ``None`` (the brief's
       "a region with < N names yields no fit"; an unpopulated dev-ex-US / EM region lands here).
    4. **Winsorize 1/99 within this cross-section** — clamp every continuous regressor + the label at
       its training-set 1st/99th percentile and STORE the caps on the fit (reused live).
    5. **Solve** — ``numpy.linalg.lstsq`` (SVD least-squares). A rank-deficient design (a regressor with
       no variance across the sample, e.g. an all-payer ``DD``) ⇒ ``None`` rather than lstsq's
       minimum-norm pseudo-fit — an honest "cannot estimate here".

    Returns the :class:`CrossSectionalFit`, or ``None`` for any fail-closed case (too few admissible
    rows / rank-deficient design / unknown model regressor missing everywhere).
    """
    if horizon not in HORIZONS:
        raise ValueError(f"unsupported horizon {horizon!r}; expected one of {HORIZONS}")

    # 1. Vintage join — admissible pairs only (feature AND label knowable as-of).
    admissible = [p for p in panel if admissible_at(p, as_of_ms)]

    # 2. Listwise design assembly — drop rows missing a model regressor.
    rows: list[list[float]] = []
    labels: list[float] = []
    for p in admissible:
        design = _design_row(p.x, model)
        if design is None:
            continue  # listwise-drop a row whose model leg failed closed (never zero-filled)
        rows.append(design)
        labels.append(p.label_roa)

    # 3. Degenerate-sample guard — too few usable rows → no fit (never a garbage fit on a thin sample).
    if len(rows) < MIN_FIT_OBS:
        return None

    design_matrix = np.asarray(rows, dtype=float)
    y = np.asarray(labels, dtype=float)

    # 4. Winsorize 1/99 within THIS cross-section; store the caps for live reuse. The continuous columns
    # are winsorized in place on the design matrix; the {0,1} dummy columns are skipped. The label gets
    # its own caps so a forecast cannot be trained toward an outlier future-earnings ratio.
    winsor_caps: dict[str, tuple[float, float]] = {}
    continuous = _CONTINUOUS_FEATURES_BY_MODEL[model]
    # The design-matrix column index of each continuous feature, derived from the model's row layout so
    # the winsorization clamps the RIGHT column. The interaction term NegE·E/A is NOT separately
    # winsorized (it has no live `FirmYearFeatures` field to clamp from); instead it is REBUILT from the
    # clamped roa below, so the fitted geometry matches exactly what `_winsorized_design_row` reconstructs
    # at predict (raw-roa training interaction vs clamped-roa live interaction would otherwise drift).
    col_of = _continuous_column_indices(model)
    for name in continuous:
        col = col_of[name]
        caps = _winsor_bounds(design_matrix[:, col])
        winsor_caps[name] = caps
        np.clip(design_matrix[:, col], caps[0], caps[1], out=design_matrix[:, col])
    if model in (MODEL_RI, MODEL_EP):
        # Rebuild NegE·roa from the now-clamped roa so train and predict share one geometry.
        roa_col = col_of["roa"]
        design_matrix[:, roa_col + 1] = design_matrix[:, roa_col - 1] * design_matrix[:, roa_col]
    label_caps = _winsor_bounds(y)
    winsor_caps["label"] = label_caps
    y = np.clip(y, label_caps[0], label_caps[1])

    # 5. Solve. Refuse a rank-deficient design (no honest fit there) rather than take lstsq's
    # minimum-norm solution, which would invent coefficients for a collinear / constant regressor.
    rank = int(np.linalg.matrix_rank(design_matrix))
    if rank < design_matrix.shape[1]:
        return None
    coefficients, *_ = np.linalg.lstsq(design_matrix, y, rcond=None)

    return CrossSectionalFit(
        model=model,
        horizon=horizon,
        coefficients=coefficients,
        winsor_caps=winsor_caps,
        n_obs=len(rows),
    )


def _continuous_column_indices(model: str) -> dict[str, int]:
    """Map each continuous-feature name to its column index in ``model``'s design matrix.

    Kept beside :func:`_design_row` (the two MUST agree on column order). Used to winsorize the right
    column at fit and to clamp the matching live field at predict.
    """
    if model == MODEL_RI:
        # [1, NegE, roa, NegE·roa, book_to_assets, accruals_to_assets]
        return {"roa": 2, "book_to_assets": 4, "accruals_to_assets": 5}
    if model == MODEL_EP:
        # [1, NegE, roa, NegE·roa]
        return {"roa": 2}
    if model == MODEL_HVZ:
        # [1, payout, DD, roa, NegE, accruals_to_assets]
        return {"payout": 1, "roa": 3, "accruals_to_assets": 5}
    raise ValueError(f"unknown cross-sectional model: {model!r}")


def _winsorized_design_row(fit: CrossSectionalFit, x: FirmYearFeatures) -> Optional[np.ndarray]:
    """A live design row for ``x`` under ``fit``'s model, with the STORED winsor caps clamped on.

    Builds the raw design row (:func:`_design_row`; ``None`` if a model leg is missing on ``x``), then
    clamps each continuous column to ``fit.winsor_caps`` — the training-time thresholds, NOT recomputed
    on the live row. The interaction column ``NegE·E/A`` is rebuilt from the clamped ``roa`` so it stays
    consistent with the winsorized ``roa`` the model saw.
    """
    raw = _design_row(x, fit.model)
    if raw is None:
        return None  # a live row missing a model leg cannot be predicted (fail-closed, never 0-filled)
    row = np.asarray(raw, dtype=float)

    col_of = _continuous_column_indices(fit.model)
    for name, col in col_of.items():
        caps = fit.winsor_caps.get(name)
        if caps is not None:
            row[col] = _clamp(row[col], caps)

    # Rebuild the NegE·E/A interaction off the CLAMPED roa so the live row matches the fitted geometry.
    # roa lives at a model-specific column; the interaction (where present) is the column right after roa
    # for RI/EP (… NegE, roa, NegE·roa …). HVZ has no interaction term, so this only applies to RI/EP.
    if fit.model in (MODEL_RI, MODEL_EP):
        roa_col = col_of["roa"]
        neg_e_col = roa_col - 1            # NegE precedes roa in both RI and EP layouts
        interaction_col = roa_col + 1      # NegE·roa follows roa
        row[interaction_col] = row[neg_e_col] * row[roa_col]

    return row


def predict_ratio(fit: CrossSectionalFit, x: FirmYearFeatures) -> Optional[float]:
    """The fitted ``E[t+τ]/A`` ratio for a live feature row ``x`` under ``fit``.

    Clamps ``x``'s continuous inputs to ``fit``'s STORED training-time winsor caps (so the row is
    evaluated on the distribution the coefficients were estimated against), then dots the design row
    with the coefficients. Returns ``None`` when ``x`` is missing a regressor the model needs
    (fail-closed — no fabricated ratio).
    """
    row = _winsorized_design_row(fit, x)
    if row is None:
        return None
    return float(row @ fit.coefficients)


def predict(fit: CrossSectionalFit, x: FirmYearFeatures) -> Optional[float]:
    """The forecast EARNINGS LEVEL ``E[t+τ]`` for a live row ``x`` — the fitted ratio × current ``A``.

    The model forecasts a ratio (``E[t+τ]/A``, the currency-free pooled target); the earnings level is
    recovered by multiplying by the name's CURRENT total assets (``x.total_assets``, the deflator the
    feature row carries for exactly this step). Returns ``None`` when the ratio is unpredictable (a
    missing model leg) — never a fabricated level.

    The EPS step is the CALLER's (the ensemble / fundamentals-api assembly): ``EPS[t+τ] = E[t+τ] ÷
    split-adjusted shares``, using the SAME "single latest share count" split-adjust convention as the
    seasonal-RW baseline (#226 ``baseline._split_adjusted_eps`` — divide every year's earnings by the
    one current cover-page count) so the RW floor and the cross-sectional members are on the same
    per-share basis and the ensemble can MAE-compare them. Recovering the level here (not EPS) keeps the
    share count out of this pure regression module — it is a lake/feed leg the caller already holds.
    """
    ratio = predict_ratio(fit, x)
    if ratio is None:
        return None
    return ratio * x.total_assets


def fit_all_models(
    panel: list[TrainingPair], as_of_ms: int, horizon: int
) -> dict[str, CrossSectionalFit]:
    """Convenience: fit every model in :data:`MODELS` for one ``(horizon, as_of_ms)`` over ``panel``.

    Returns a ``{model: fit}`` dict carrying ONLY the models that produced a fit — a model whose
    admissible cross-section was too thin / rank-deficient is OMITTED (fail-closed, never a ``None``
    value to trip a downstream consumer). An empty dict means no model could be estimated on this slice
    (e.g. an unpopulated region) — the ensemble treats that name as having no cross-sectional forecast.
    """
    fits: dict[str, CrossSectionalFit] = {}
    for model in MODELS:
        fit = fit_vintage(panel, model, horizon, as_of_ms)
        if fit is not None:
            fits[model] = fit
    return fits

import numpy as np
from dataclasses import dataclass, field
from scipy.stats import spearmanr

STABILITY_CV_THRESHOLD = 0.5


@dataclass
class SHAPReport:
    timestamp: int
    feature_names: list[str]
    mean_abs_shap: dict[str, float]
    shap_stability_cv: dict[str, float]
    topology_shap_share: float
    dominant_feature: str


@dataclass
class FeatureImportanceStabilityReport:
    feature_name: str
    mean_importance: float
    importance_cv: float
    regime_breakdown: dict[str, float]
    is_stable: bool
    warning: str | None


def compute_shap_report(
    model,
    X: np.ndarray,
    feature_names: list[str],
    topology_feature_names: list[str],
    timestamp: int,
) -> SHAPReport:
    import shap
    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X)
    mean_abs = np.abs(shap_values).mean(axis=0)
    total_abs = mean_abs.sum()

    topology_indices = [i for i, f in enumerate(feature_names) if f in topology_feature_names]
    topology_share = mean_abs[topology_indices].sum() / total_abs if total_abs > 0 else 0.0

    shap_cv = {}
    for i, name in enumerate(feature_names):
        col = shap_values[:, i]
        shap_cv[name] = float(np.std(col) / np.mean(np.abs(col))) if np.mean(np.abs(col)) > 0 else float('inf')

    return SHAPReport(
        timestamp=timestamp,
        feature_names=feature_names,
        mean_abs_shap=dict(zip(feature_names, mean_abs.tolist())),
        shap_stability_cv=shap_cv,
        topology_shap_share=float(topology_share),
        dominant_feature=feature_names[int(np.argmax(mean_abs))],
    )


def permutation_importance(
    predict_fn,
    X_test: np.ndarray,
    y_test: np.ndarray,
    feature_names: list[str],
    n_repeats: int = 10,
    rng_seed: int = 42,
) -> dict[str, float]:
    """Returns mean IC degradation per feature when that feature is randomly shuffled."""
    rng = np.random.default_rng(rng_seed)
    baseline_ic = _information_coefficient(predict_fn(X_test), y_test)
    importances = {}
    for i, name in enumerate(feature_names):
        deltas = []
        for _ in range(n_repeats):
            X_permuted = X_test.copy()
            X_permuted[:, i] = rng.permutation(X_permuted[:, i])
            shuffled_ic = _information_coefficient(predict_fn(X_permuted), y_test)
            deltas.append(baseline_ic - shuffled_ic)
        importances[name] = float(np.mean(deltas))
    return importances


def assess_importance_stability(
    importance_history: list[dict[str, float]],
    feature_names: list[str],
    regime_labels: list[str],
) -> list[FeatureImportanceStabilityReport]:
    reports = []
    for name in feature_names:
        values = np.array([h.get(name, 0.0) for h in importance_history])
        mean_v = float(np.mean(values))
        cv = float(np.std(values) / mean_v) if mean_v > 0 else float('inf')

        by_regime: dict[str, list[float]] = {}
        for val, regime in zip(values, regime_labels):
            by_regime.setdefault(regime, []).append(val)
        regime_means = {r: float(np.mean(vs)) for r, vs in by_regime.items()}

        warning = None
        if cv > STABILITY_CV_THRESHOLD:
            warning = f'{name}: importance CV={cv:.2f} > {STABILITY_CV_THRESHOLD} — feature unstable across rebalance cycles'

        reports.append(FeatureImportanceStabilityReport(
            feature_name=name,
            mean_importance=mean_v,
            importance_cv=cv,
            regime_breakdown=regime_means,
            is_stable=cv <= STABILITY_CV_THRESHOLD,
            warning=warning,
        ))
    return sorted(reports, key=lambda r: r.mean_importance, reverse=True)


def feature_redundancy_report(features_df, correlation_threshold: float = 0.85) -> list[tuple[str, str, float]]:
    """Returns pairs of features with |Spearman correlation| > threshold."""
    names = list(features_df.columns)
    corr_matrix, _ = spearmanr(features_df.values)
    if corr_matrix.ndim == 0:
        return []
    redundant = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            c = abs(float(corr_matrix[i, j]))
            if c > correlation_threshold:
                redundant.append((names[i], names[j], c))
    return sorted(redundant, key=lambda x: x[2], reverse=True)


def _information_coefficient(scores: np.ndarray, returns: np.ndarray) -> float:
    corr, _ = spearmanr(scores, returns, nan_policy='omit')
    return float(corr) if not np.isnan(corr) else 0.0

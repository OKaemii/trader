from dataclasses import dataclass, field
import numpy as np

from .metrics import sharpe_ratio, max_drawdown, cvar_95
from .multiple_testing import bh_corrected_pvalue, deflated_sharpe_ratio, compute_pbo
from .regime import regime_breakdown


@dataclass
class ValidationReport:
    mean_ic: float
    ic_pvalue: float
    ic_hit_rate: float
    oos_sharpe: float
    max_drawdown: float
    cvar_95: float
    deflated_sharpe: float
    pbo: float
    regime_breakdown: dict
    fdr_corrected_pvalue: float
    passed: bool
    failures: list[str] = field(default_factory=list)
    context_notes: list[str] = field(default_factory=list)


COV_CONDITION_NUMBER_LIMIT = 500  # Section 19 stability gate


def validate_strategy(
    ic_series: np.ndarray,
    oos_returns: np.ndarray,
    is_sharpe: float,
    n_trials: int,
    regime_series: np.ndarray,
    covariance_matrix: np.ndarray | None = None,
) -> ValidationReport:
    from scipy import stats

    mean_ic = float(ic_series.mean())
    _, ic_pvalue = stats.ttest_1samp(ic_series, 0)
    ic_hit_rate = float((ic_series > 0).mean())
    oos_sharpe_v = sharpe_ratio(oos_returns)
    mdd = max_drawdown(np.cumprod(1 + oos_returns))
    cvar = cvar_95(oos_returns)
    dsr = deflated_sharpe_ratio(oos_sharpe_v, oos_returns, n_trials)
    pbo_v = compute_pbo(oos_returns.reshape(1, -1)) if oos_returns.ndim == 1 else compute_pbo(oos_returns)
    fdr_p = bh_corrected_pvalue(float(ic_pvalue), n_trials)
    regime_bd = regime_breakdown(oos_returns, regime_series)

    failures = []
    if fdr_p >= 0.05:
        failures.append(f'BH-corrected p-value {fdr_p:.3f} ≥ 0.05 ({n_trials} trials)')
    if mean_ic < 0.02:
        failures.append(f'mean IC {mean_ic:.4f} < 0.02')
    if ic_hit_rate < 0.52:
        failures.append(f'IC hit rate {ic_hit_rate:.2f} < 0.52')
    if oos_sharpe_v < 0.5:
        failures.append(f'OOS Sharpe {oos_sharpe_v:.2f} < 0.5')
    if mdd < -0.25:
        failures.append(f'max drawdown {mdd:.2%} < −25%')
    if cvar < -0.025:
        failures.append(f'CVaR {cvar:.2%} < −2.5%')
    if is_sharpe > 0 and oos_sharpe_v / is_sharpe < 0.70:
        failures.append(f'OOS/IS Sharpe ratio {oos_sharpe_v / is_sharpe:.2f} < 0.70 (overfit)')
    if dsr <= 0:
        failures.append(f'Deflated Sharpe Ratio {dsr:.2f} ≤ 0 (mining bias)')
    if pbo_v >= 0.5:
        failures.append(f'PBO {pbo_v:.2f} ≥ 0.5 (backtest overfit)')

    if covariance_matrix is not None:
        try:
            cond = float(np.linalg.cond(covariance_matrix))
            if cond > COV_CONDITION_NUMBER_LIMIT:
                failures.append(f'Covariance condition number {cond:.0f} > {COV_CONDITION_NUMBER_LIMIT} — increase shrinkage or reduce universe')
        except np.linalg.LinAlgError:
            failures.append('Covariance matrix is singular — stability gate failed')

    return ValidationReport(
        mean_ic=mean_ic,
        ic_pvalue=float(ic_pvalue),
        ic_hit_rate=ic_hit_rate,
        oos_sharpe=oos_sharpe_v,
        max_drawdown=mdd,
        cvar_95=cvar,
        deflated_sharpe=dsr,
        pbo=pbo_v,
        regime_breakdown=regime_bd,
        fdr_corrected_pvalue=fdr_p,
        passed=len(failures) == 0,
        failures=failures,
    )

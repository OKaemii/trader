from dataclasses import dataclass, field
from typing import Literal
from .drift_detection import CUSUMState, update_cusum


@dataclass
class DriftReport:
    timestamp: int
    ic_drift: bool
    feature_drift: bool
    covariance_instability: bool
    topology_instability: bool
    recommended_action: Literal['none', 'alert', 'degrade_50pct', 'suspend']


class DriftMonitor:
    def __init__(self, training_stats: dict):
        """
        training_stats: calibrated from IS period. Expected keys:
          mean_ic, ic_std, feature_means (dict), feature_stds (dict),
          cov_eigenvalue_baseline, cov_eigenvalue_std
        """
        self.training_stats = training_stats
        self.cusum_states: dict[str, CUSUMState] = {}

    def check(self, current_ic: float, current_features: dict | None = None,
              cov_eigenvalue_spread: float | None = None,
              topology_instability_score: float | None = None,
              timestamp: int = 0) -> DriftReport:
        ic_state = self.cusum_states.get('ic', CUSUMState())
        ic_std = self.training_stats.get('ic_std', 0.05)
        ic_state = update_cusum(
            ic_state, current_ic,
            target_mean=self.training_stats.get('mean_ic', 0.02),
            threshold=4 * ic_std,
            slack=ic_std * 0.5,
        )
        self.cusum_states['ic'] = ic_state

        feature_drift = False
        if current_features and 'feature_means' in self.training_stats:
            for feat, val in current_features.items():
                fstate = self.cusum_states.get(f'feat_{feat}', CUSUMState())
                fmean = self.training_stats['feature_means'].get(feat, 0.0)
                fstd  = self.training_stats['feature_stds'].get(feat, 1.0)
                fstate = update_cusum(fstate, val, fmean, threshold=3 * fstd, slack=fstd * 0.25)
                self.cusum_states[f'feat_{feat}'] = fstate
                if fstate.drift_detected:
                    feature_drift = True

        cov_instability = False
        if cov_eigenvalue_spread is not None:
            baseline = self.training_stats.get('cov_eigenvalue_baseline', 0.0)
            cov_std  = self.training_stats.get('cov_eigenvalue_std', 1.0)
            cov_state = self.cusum_states.get('cov', CUSUMState())
            cov_state = update_cusum(cov_state, cov_eigenvalue_spread, baseline,
                                     threshold=5 * cov_std, slack=cov_std * 0.5)
            self.cusum_states['cov'] = cov_state
            cov_instability = cov_state.drift_detected

        topo_instability = False
        if topology_instability_score is not None:
            topo_state = self.cusum_states.get('topo', CUSUMState())
            topo_state = update_cusum(topo_state, topology_instability_score, 0.0,
                                      threshold=4.0, slack=0.5)
            self.cusum_states['topo'] = topo_state
            topo_instability = topo_state.drift_detected

        action = self._classify_severity(
            ic_state.drift_detected, feature_drift, cov_instability, topo_instability
        )
        return DriftReport(
            timestamp=timestamp,
            ic_drift=ic_state.drift_detected,
            feature_drift=feature_drift,
            covariance_instability=cov_instability,
            topology_instability=topo_instability,
            recommended_action=action,
        )

    def _classify_severity(self, ic_d: bool, feat_d: bool, cov_d: bool, topo_d: bool) -> Literal['none', 'alert', 'degrade_50pct', 'suspend']:
        drift_count = sum([ic_d, feat_d, cov_d, topo_d])
        if drift_count >= 3:
            return 'suspend'
        if drift_count >= 2:
            return 'degrade_50pct'
        if drift_count >= 1:
            return 'alert'
        return 'none'

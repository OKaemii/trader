from dataclasses import dataclass
from typing import Literal


@dataclass
class CUSUMState:
    cusum_pos: float = 0.0
    cusum_neg: float = 0.0
    drift_detected: bool = False
    drift_direction: Literal['up', 'down', 'none'] = 'none'


def update_cusum(
    state: CUSUMState,
    value: float,
    target_mean: float,
    threshold: float,
    slack: float = 0.5,
) -> CUSUMState:
    """
    Detects mean shift in a univariate series via CUSUM.
    threshold: detection threshold (typically 4–5σ)
    slack: tuning parameter (typically 0.25–1.0)
    """
    deviation = value - target_mean
    new_pos = max(0.0, state.cusum_pos + deviation - slack)
    new_neg = max(0.0, state.cusum_neg - deviation - slack)
    detected = new_pos > threshold or new_neg > threshold
    direction: Literal['up', 'down', 'none'] = 'none'
    if detected:
        direction = 'up' if new_pos > threshold else 'down'
    return CUSUMState(new_pos, new_neg, detected, direction)


def update_page_hinkley(
    cumsum: float,
    min_so_far: float,
    value: float,
    target_mean: float,
    delta: float = 0.005,
    lambda_: float = 50.0,
) -> tuple[float, float, bool]:
    """Page-Hinkley detector — faster response, higher false-positive rate."""
    cumsum = cumsum + value - target_mean - delta
    min_so_far = min(min_so_far, cumsum)
    detected = (cumsum - min_so_far) > lambda_
    return cumsum, min_so_far, detected

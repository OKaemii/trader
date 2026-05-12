from sklearn.isotonic import IsotonicRegression
import numpy as np


def brier_score(predicted_probs: np.ndarray, outcomes: np.ndarray) -> float:
    return float(np.mean((predicted_probs - outcomes) ** 2))


def calibrate_confidence(raw_confidences: np.ndarray, binary_outcomes: np.ndarray) -> IsotonicRegression:
    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(raw_confidences, binary_outcomes)
    return iso

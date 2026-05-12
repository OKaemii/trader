from dataclasses import dataclass


@dataclass
class WalkForwardFold:
    train_start: int
    train_end: int
    test_start: int
    test_end: int
    embargo_ms: int  # gap between train_end and test_start to prevent leakage


class WalkForwardValidator:
    def __init__(self, data_start: int, data_end: int, n_folds: int = 5, embargo_days: int = 21):
        self._start = data_start
        self._end = data_end
        self._n_folds = n_folds
        self._embargo_ms = embargo_days * 86_400_000

    def folds(self) -> list[WalkForwardFold]:
        span = (self._end - self._start) // (self._n_folds + 1)
        return [
            WalkForwardFold(
                train_start=self._start,
                train_end=self._start + k * span,
                test_start=self._start + k * span + self._embargo_ms,
                test_end=min(self._start + (k + 1) * span, self._end),
                embargo_ms=self._embargo_ms,
            )
            for k in range(1, self._n_folds + 1)
        ]

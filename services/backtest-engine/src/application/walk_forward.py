from dataclasses import dataclass

DAY_MS = 86_400_000


@dataclass
class WalkForwardFold:
    train_start: int
    train_end: int
    test_start: int
    test_end: int
    embargo_ms: int  # gap between train_end and test_start to prevent leakage


def forward_test_folds(
    train_start: int, oos_start: int, oos_end: int,
    n_folds: int = 5, embargo_days: int = 21, *, min_oos_ms: int = 0, min_train_ms: int = 0,
) -> list[WalkForwardFold]:
    """Walk-forward folds whose **test windows tile the OOS region [oos_start, oos_end]**, with
    training anchored at `train_start` (all history up to each fold's embargoed cut).

    This is the geometry the MCPT validator needs: the initial training [train_start, oos_start]
    is the burn-in (never tested), and the walk-forward rolls its test windows strictly through
    the out-of-sample half — so when WF-MCPT permutes everything after oos_start, *every* fold's
    test window (and the later folds' training tails) sits in the permuted region. Tiling tests
    across the whole window instead would leave early folds on un-permuted data and dilute the
    null. Differs from WalkForwardValidator (whole-window anchored), which Phase 4's backtest uses.
    """
    embargo = embargo_days * DAY_MS
    span = (oos_end - oos_start) // max(1, n_folds)
    out: list[WalkForwardFold] = []
    for k in range(n_folds):
        test_start = oos_start + k * span
        test_end = (oos_start + (k + 1) * span) if k < n_folds - 1 else oos_end
        train_end = test_start - embargo
        if train_end <= train_start or test_start >= test_end:
            continue
        if (test_end - test_start) < min_oos_ms or (train_end - train_start) < min_train_ms:
            continue
        out.append(WalkForwardFold(train_start, train_end, test_start, test_end, embargo))
    return out


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

    def valid_folds(self, min_oos_ms: int, min_train_ms: int = 0) -> list[WalkForwardFold]:
        """Folds whose OOS window survives the embargo and is at least `min_oos_ms` wide
        (and whose train window is at least `min_train_ms`). The anchored split degenerates
        when the data window is too short for n_folds + a 21-day embargo — those folds have
        test_start ≥ test_end (embargo overruns the slice) and must be dropped, not silently
        replayed over an empty window. A run left with too few valid folds is
        `insufficient_history`, never a fabricated pass."""
        out: list[WalkForwardFold] = []
        for f in self.folds():
            if f.test_start >= f.test_end:
                continue
            if (f.test_end - f.test_start) < min_oos_ms:
                continue
            if (f.train_end - f.train_start) < min_train_ms:
                continue
            out.append(f)
        return out

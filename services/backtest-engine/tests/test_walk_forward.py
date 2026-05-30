"""WalkForwardValidator.valid_folds — a long window yields usable folds; a short one is
correctly rejected (the embargo overruns the OOS slice) so the orchestrator can return
insufficient_history instead of replaying over empty windows."""
from src.application.walk_forward import WalkForwardValidator

DAY = 86_400_000
WEEK = 7 * DAY


def test_long_window_yields_all_folds():
    start = 0
    end = 10 * 365 * DAY            # ~10 years
    wf = WalkForwardValidator(start, end, n_folds=5, embargo_days=21)
    folds = wf.valid_folds(min_oos_ms=8 * WEEK, min_train_ms=12 * WEEK)
    assert len(folds) == 5
    # anchored: train_start fixed, each OOS window starts after the embargo gap.
    for f in folds:
        assert f.train_start == start
        assert f.test_start - f.train_end == 21 * DAY
        assert f.test_start < f.test_end


def test_short_window_rejected():
    # 60 days can't support 5 folds + a 21-day embargo — every OOS slice collapses.
    wf = WalkForwardValidator(0, 60 * DAY, n_folds=5, embargo_days=21)
    assert len(wf.valid_folds(min_oos_ms=8 * WEEK)) < 2


def test_embargo_eats_thin_oos():
    # Window long enough to make folds but each OOS span is below the min → none survive.
    wf = WalkForwardValidator(0, 365 * DAY, n_folds=5, embargo_days=21)
    # span ≈ 60d, OOS ≈ 60−21 = 39d; demanding ≥ 60d of OOS drops them all.
    assert len(wf.valid_folds(min_oos_ms=60 * DAY)) == 0

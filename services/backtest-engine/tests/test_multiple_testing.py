"""compute_pbo — terminates fast (the bug this replaces never did), and is directionally
correct: a genuine dominator → ~0, an overfit IS/OOS-flipping family → > 0.5."""
import time

import numpy as np
import pytest

from src.application.multiple_testing import compute_pbo


def test_terminates_fast_on_long_series():
    # The old combinations(range(T), T//2) was ~C(300,150) ≈ 10⁸⁹ and never returned. The
    # CSCV block version is C(16,8)=12,870 regardless of T — must finish well under a second.
    rng = np.random.default_rng(0)
    M = rng.normal(0, 0.01, size=(8, 300))
    t0 = time.time()
    pbo = compute_pbo(M)
    assert time.time() - t0 < 5.0
    assert 0.0 <= pbo <= 1.0


def test_genuine_dominator_low_pbo():
    # Config 0 is uniformly best in-sample AND out-of-sample → never below the OOS median.
    M = np.zeros((5, 64))
    M[0, :] = 0.02
    assert compute_pbo(M) == pytest.approx(0.0)


def test_overfit_mirror_high_pbo():
    # Two mirror configs: each wins exactly the blocks the other loses. Whichever is best
    # in-sample is therefore worst out-of-sample → below median on (almost) every split.
    M = np.zeros((2, 64))
    for b in range(16):
        cols = slice(b * 4, (b + 1) * 4)
        M[0, cols] = 1.0 if b % 2 == 0 else -1.0
        M[1, cols] = -M[0, cols][0]
    assert compute_pbo(M, n_partitions=16) > 0.5


def test_single_config_is_uninformative():
    assert compute_pbo(np.ones((1, 64))) == 0.5


def test_too_few_periods_is_uninformative():
    assert compute_pbo(np.ones((3, 1))) == 0.5


def test_non_2d_raises():
    with pytest.raises(ValueError):
        compute_pbo(np.ones(64))

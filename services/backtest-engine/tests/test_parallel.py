"""ParallelMap — SerialMap/ProcessPoolMap equivalence, the progress/cancel/early-stop hooks, and
the spawn-safe worker-global pattern the real MCPT/backtest workers use.

Workers + initializer are module-level so they pickle under ``spawn``; multiprocessing propagates
the parent's ``sys.path`` (incl. pytest's prepend of ``tests/`` and conftest's service-root insert)
to the children, so both this module and ``src.application.*`` import there.
"""
import pytest

from src.application.parallel import (
    ProcessPoolMap, SerialMap, default_workers, make_parallel_map,
)
from src.application.progress import JobCancelled

_CTX = {'offset': 0}


def _square(x):
    return x * x


def _square_plus_offset(x):
    return x * x + _CTX['offset']


def _set_offset(off):
    _CTX['offset'] = off


# ── SerialMap ───────────────────────────────────────────────────────────────────────
def test_serial_basic_and_order():
    assert SerialMap().run(_square, [1, 2, 3, 4]) == [1, 4, 9, 16]


def test_serial_on_result_order():
    seen = []
    SerialMap().run(_square, [3, 1, 2], on_result=seen.append)
    assert seen == [9, 1, 4]


def test_serial_initializer_runs():
    _set_offset(0)
    out = SerialMap().run(_square_plus_offset, [1, 2, 3], initializer=_set_offset, initargs=(100,))
    assert out == [101, 104, 109]
    _set_offset(0)


def test_serial_cancel_raises():
    calls = {'n': 0}

    def _cancel():
        calls['n'] += 1
        if calls['n'] >= 2:
            raise JobCancelled()

    with pytest.raises(JobCancelled):
        SerialMap().run(_square, [1, 2, 3, 4], cancel=_cancel)


def test_serial_should_stop_truncates():
    out = SerialMap().run(_square, range(100), should_stop=lambda r: len(r) >= 3)
    assert out == [0, 1, 4]


# ── ProcessPoolMap (spawn) ───────────────────────────────────────────────────────────
def test_pool_matches_serial():
    items = list(range(24))
    assert ProcessPoolMap(2).run(_square, items) == SerialMap().run(_square, items)


def test_pool_initializer_runs_in_each_worker():
    out = ProcessPoolMap(2).run(_square_plus_offset, range(5),
                                initializer=_set_offset, initargs=(1000,))
    assert out == [1000, 1001, 1004, 1009, 1016]


def test_pool_should_stop_truncates_deterministically():
    out = ProcessPoolMap(2).run(_square, range(200), should_stop=lambda r: len(r) >= 5)
    assert len(out) == 5
    assert all(v == round(v ** 0.5) ** 2 for v in out)   # every result is a real square


def test_pool_empty_items():
    assert ProcessPoolMap(4).run(_square, []) == []


# ── factory + worker count ────────────────────────────────────────────────────────────
def test_make_parallel_map_small_is_serial(monkeypatch):
    monkeypatch.delenv('BACKTEST_MAX_WORKERS', raising=False)
    monkeypatch.setenv('BACKTEST_MIN_PARALLEL', '16')
    assert isinstance(make_parallel_map(4), SerialMap)


def test_make_parallel_map_workers_one_is_serial(monkeypatch):
    monkeypatch.setenv('BACKTEST_MAX_WORKERS', '1')
    assert isinstance(make_parallel_map(1000), SerialMap)


def test_make_parallel_map_large_is_pool(monkeypatch):
    monkeypatch.setenv('BACKTEST_MAX_WORKERS', '4')
    monkeypatch.setenv('BACKTEST_MIN_PARALLEL', '16')
    assert isinstance(make_parallel_map(1000), ProcessPoolMap)


def test_default_workers_respects_env(monkeypatch):
    monkeypatch.setenv('BACKTEST_MAX_WORKERS', '6')
    assert default_workers() == 6

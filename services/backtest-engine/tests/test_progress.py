"""ThreadSafeProgress — the ETA math + cancel signalling the job flusher serialises to Mongo."""
import threading

import pytest

from src.application.progress import JobCancelled, NullProgress, ThreadSafeProgress


def test_null_progress_is_noop():
    p = NullProgress()
    p.set_total(10)
    p.set_stage('x')
    p.tick(3)
    p.raise_if_cancelled()
    assert p.snapshot() == {}


def test_pct_and_units():
    p = ThreadSafeProgress()
    p.set_total(4)
    p.tick()
    p.tick()
    s = p.snapshot()
    assert s['completed_units'] == 2
    assert s['total_units'] == 4
    assert s['pct'] == 0.5


def test_total_floored_and_pct_capped():
    p = ThreadSafeProgress()
    p.set_total(0)          # floored to 1 (no divide-by-zero)
    p.tick(5)               # over-tick is clamped in pct
    s = p.snapshot()
    assert s['total_units'] == 1
    assert s['pct'] == 1.0


def test_negative_or_zero_tick_is_ignored():
    p = ThreadSafeProgress()
    p.set_total(10)
    p.tick(0)
    p.tick(-3)
    assert p.snapshot()['completed_units'] == 0


def test_eta_none_until_first_unit_then_nonnegative():
    p = ThreadSafeProgress()
    p.set_total(10)
    assert p.snapshot()['eta_ms'] is None
    p.tick()
    eta = p.snapshot()['eta_ms']
    assert isinstance(eta, int) and eta >= 0


def test_stage_transition():
    p = ThreadSafeProgress()
    assert p.snapshot()['stage'] == 'starting'
    p.set_stage('in_sample_mcpt')
    assert p.snapshot()['stage'] == 'in_sample_mcpt'


def test_snapshot_shape():
    p = ThreadSafeProgress()
    p.set_total(3)
    p.tick()
    s = p.snapshot()
    assert set(s) == {
        'stage', 'completed_units', 'total_units', 'pct', 'eta_ms', 'started_at', 'updated_at'
    }
    assert s['updated_at'] >= s['started_at']


def test_cancel_signalling():
    p = ThreadSafeProgress()
    p.raise_if_cancelled()           # no-op before a request
    assert p.cancelled() is False
    p.request_cancel()
    assert p.cancelled() is True
    with pytest.raises(JobCancelled):
        p.raise_if_cancelled()


def test_concurrent_ticks_are_all_counted():
    p = ThreadSafeProgress()
    p.set_total(1000)

    def worker():
        for _ in range(100):
            p.tick()

    threads = [threading.Thread(target=worker) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert p.snapshot()['completed_units'] == 1000

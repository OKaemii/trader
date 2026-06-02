"""Cross-thread progress + cooperative cancellation for queued jobs.

The compute thread (validator / backtest) calls ``set_total``/``set_stage``/``tick``/
``raise_if_cancelled``; the event-loop flusher (in the JobRunner) reads ``snapshot()`` and calls
``request_cancel()``. One lock guards the multi-field read so the flusher never observes a torn
counter. This object **never touches Mongo** — the flusher owns all persistence — which preserves
the "compute thread stays Mongo-free" invariant the validator already relies on.

All work is counted in one uniform unit (a single grid-search of the fixed grid), so a global
average rate gives an honest ETA: ``eta = (total - done) * elapsed / done``. It is ``None`` until
the first unit completes (no fabricated up-front guess).
"""
from __future__ import annotations

import threading
import time
from typing import Optional, Protocol


def _now_ms() -> int:
    return int(time.time() * 1000)


class JobCancelled(Exception):
    """Raised inside the compute thread when an operator cancels a running job."""


class ProgressSink(Protocol):
    def set_total(self, units: int) -> None: ...
    def set_stage(self, name: str) -> None: ...
    def tick(self, units: int = 1) -> None: ...
    def raise_if_cancelled(self) -> None: ...
    def snapshot(self) -> dict: ...


class NullProgress:
    """No-op sink — the default for direct callers and tests that don't track progress."""

    def set_total(self, units: int) -> None:
        pass

    def set_stage(self, name: str) -> None:
        pass

    def tick(self, units: int = 1) -> None:
        pass

    def raise_if_cancelled(self) -> None:
        pass

    def snapshot(self) -> dict:
        return {}


class ThreadSafeProgress:
    """Shared progress state across the event-loop ↔ compute-thread boundary.

    ``total`` defaults to 1 until the compute side calls ``set_total`` once the grid/fold geometry
    is known — that avoids a divide-by-zero and shows ~0% in the meantime.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._total = 1
        self._done = 0
        self._stage = 'starting'
        self._started_ms = _now_ms()
        self._cancel = threading.Event()   # thread-safe on its own; needs no lock

    def set_total(self, units: int) -> None:
        with self._lock:
            self._total = max(1, int(units))

    def set_stage(self, name: str) -> None:
        with self._lock:
            self._stage = name

    def tick(self, units: int = 1) -> None:
        if units <= 0:
            return
        with self._lock:
            self._done += int(units)

    def request_cancel(self) -> None:
        self._cancel.set()

    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def raise_if_cancelled(self) -> None:
        if self._cancel.is_set():
            raise JobCancelled()

    def snapshot(self) -> dict:
        with self._lock:
            done, total, stage, started = self._done, self._total, self._stage, self._started_ms
        now = _now_ms()
        elapsed = max(1, now - started)
        eta_ms: Optional[int] = int((total - done) * elapsed / done) if done > 0 else None
        return {
            'stage': stage,
            'completed_units': done,
            'total_units': total,
            'pct': round(min(1.0, done / total), 4),
            'eta_ms': eta_ms,
            'started_at': started,
            'updated_at': now,
        }

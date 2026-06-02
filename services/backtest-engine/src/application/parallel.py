"""ParallelMap — fan independent compute tasks across a process pool, with progress + cancel +
early-stop hooks.

Processes, not threads: each task is GIL-bound Python orchestration over numpy (build strategy →
iterate rebalances → score), so a thread pool wouldn't scale. We use a ``spawn`` context — the
parent is a live asyncio server with threads, and forking a multithreaded process is unsafe — and
pin each worker's BLAS pool (else ``workers × BLAS-threads`` oversubscribes the cores and runs
*slower* than serial). Shared immutable inputs reach the workers **once** via the pool initializer;
per-task payloads are tiny (an int seed / replay index) and results reassemble by submission index,
so a parallel run is byte-identical to the serial one.

``SerialMap`` is the drop-in fallback for tests, ``workers <= 1``, and small jobs (where ``spawn``
startup would dominate). It deliberately does **not** pin BLAS, so a serial baseline measured with
``BACKTEST_MAX_WORKERS=1`` keeps numpy's normal multithreading (an honest serial reference).
"""
from __future__ import annotations

import asyncio
import concurrent.futures as cf
import multiprocessing as mp
import os
import threading
from typing import Callable, Iterable, List, Optional, Protocol

from .progress import JobCancelled


def drive_coro(make_coro: Callable):
    """Run an async coroutine to completion whether or not a loop is already running in this thread.

    A process-pool worker has no running loop → ``asyncio.run`` (fast path). The in-thread serial
    fallback runs *inside* the validator/backtest coroutine's own loop → drive it on a fresh loop in
    a helper thread (``asyncio.run`` would raise "loop already running" otherwise). ``make_coro`` is
    a zero-arg factory so the coroutine is created in the thread that will run it."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(make_coro())
    box: dict = {}

    def _target():
        try:
            box['v'] = asyncio.run(make_coro())
        except BaseException as e:   # noqa: BLE001 — re-raised on the caller thread below
            box['e'] = e

    th = threading.Thread(target=_target)
    th.start()
    th.join()
    if 'e' in box:
        raise box['e']
    return box['v']

_BLAS_ENV_VARS = (
    'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS',
    'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS',
)


def _pin_blas(threads: str = '1') -> None:
    """Cap a worker's BLAS/OpenMP pool. Env covers libs that read it lazily; ``threadpoolctl`` (a
    scikit-learn dependency, so already installed) caps an already-loaded OpenBLAS at runtime."""
    for var in _BLAS_ENV_VARS:
        os.environ[var] = str(threads)
    try:
        import threadpoolctl
        threadpoolctl.threadpool_limits(int(threads))
    except Exception:
        pass


def _worker_init(blas_threads: str, initializer: Optional[Callable], initargs: tuple) -> None:
    """Pool initializer — module-level so it pickles under ``spawn``. Pins BLAS, then runs the
    domain initializer (itself a module-level fn, resolved by re-import in the worker)."""
    _pin_blas(blas_threads)
    if initializer is not None:
        initializer(*initargs)


def default_workers() -> int:
    """``BACKTEST_MAX_WORKERS`` if set, else cgroup/cpuset-aware ``cores - 1`` (leave one for the
    event loop / health), capped at 16."""
    env = os.getenv('BACKTEST_MAX_WORKERS')
    if env:
        try:
            return max(1, int(env))
        except ValueError:
            pass
    try:
        n = len(os.sched_getaffinity(0))   # respects cpuset; Linux
    except AttributeError:                 # pragma: no cover - non-Linux
        n = os.cpu_count() or 2
    return max(1, min(n - 1, 16))


class ParallelMap(Protocol):
    # on_result(result) is called per completion (progress ticks); cancel() may raise JobCancelled;
    # should_stop(results_so_far) -> bool ends the map early (the decision-bounded MCPT stop).
    def run(
        self, worker: Callable, items: Iterable, *,
        initializer: Optional[Callable] = None, initargs: tuple = (),
        on_result: Optional[Callable] = None, cancel: Optional[Callable] = None,
        should_stop: Optional[Callable] = None,
    ) -> list: ...


class SerialMap:
    """In-process fallback. Same semantics as the pool; no spawn cost and no BLAS pinning."""

    def run(self, worker, items, *, initializer=None, initargs=(),
            on_result=None, cancel=None, should_stop=None) -> list:
        if initializer is not None:
            initializer(*initargs)
        out: List = []
        for it in items:
            if cancel is not None:
                cancel()
            out.append(worker(it))
            if on_result is not None:
                on_result(out[-1])
            if should_stop is not None and should_stop(out):
                break
        return out


class ProcessPoolMap:
    def __init__(self, workers: int) -> None:
        self._workers = max(1, workers)

    def run(self, worker, items, *, initializer=None, initargs=(),
            on_result=None, cancel=None, should_stop=None) -> list:
        items = list(items)
        if not items:
            return []
        ctx = mp.get_context('spawn')
        blas = os.getenv('BACKTEST_BLAS_THREADS', '1')
        results: dict[int, object] = {}
        with cf.ProcessPoolExecutor(
            max_workers=self._workers, mp_context=ctx,
            initializer=_worker_init, initargs=(blas, initializer, initargs),
        ) as ex:
            futs = {ex.submit(worker, it): i for i, it in enumerate(items)}
            try:
                for fut in cf.as_completed(futs):
                    if cancel is not None:
                        cancel()                                  # may raise JobCancelled
                    results[futs[fut]] = fut.result()
                    if on_result is not None:
                        on_result(results[futs[fut]])
                    if should_stop is not None and should_stop(list(results.values())):
                        ex.shutdown(cancel_futures=True, wait=False)
                        break
            except JobCancelled:
                ex.shutdown(cancel_futures=True, wait=False)
                raise
        return [results[i] for i in sorted(results)]              # submission order ⇒ deterministic


def make_parallel_map(n_items: int, *, min_parallel: Optional[int] = None) -> ParallelMap:
    """Pool when it's worth it (``workers > 1`` and enough items to amortise ``spawn`` startup),
    else serial. ``BACKTEST_MIN_PARALLEL`` (default 16) is the floor."""
    workers = default_workers()
    if min_parallel is None:
        try:
            min_parallel = int(os.getenv('BACKTEST_MIN_PARALLEL', '16'))
        except ValueError:
            min_parallel = 16
    if workers > 1 and n_items >= min_parallel:
        return ProcessPoolMap(workers)
    return SerialMap()

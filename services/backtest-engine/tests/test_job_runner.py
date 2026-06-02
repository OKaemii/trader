"""JobRunner queue mechanics — FIFO atomic-shape claim, startup sweep, kind dispatch, the
terminal writes (completed/failed/cancelled + progress + compact summary), and the flusher's
cancel relay.

Uses a tiny in-memory async fake of the collections the runner touches (no Mongo in CI). The fake
can't prove Mongo's atomicity — a server guarantee — but it pins the claim *query shape* and the
lifecycle writes.
"""
import asyncio

import pytest

from src.application.job_runner import JobHandler, JobRunner, _compact_summary
from src.application.progress import JobCancelled, NullProgress, ThreadSafeProgress


class _Result:
    def __init__(self, modified_count=0, inserted_id=None):
        self.modified_count = modified_count
        self.inserted_id = inserted_id


def _match(doc, filt):
    return all(doc.get(k) == v for k, v in filt.items())


def _apply(doc, update):
    if '$set' in update:
        doc.update(update['$set'])
    if '$unset' in update:
        for k in update['$unset']:
            doc.pop(k, None)


class _Collection:
    def __init__(self):
        self.docs = []
        self._next = 1

    async def insert_one(self, doc):
        doc = dict(doc)
        doc.setdefault('_id', self._next)
        self._next += 1
        self.docs.append(doc)
        return _Result(inserted_id=doc['_id'])

    async def find_one(self, filt, projection=None):
        for d in self.docs:
            if _match(d, filt):
                return dict(d)
        return None

    async def find_one_and_update(self, filt, update, sort=None, return_document=None):
        cands = [d for d in self.docs if _match(d, filt)]
        if sort:
            key, direction = sort[0]
            cands.sort(key=lambda d: d.get(key, 0), reverse=direction < 0)
        if not cands:
            return None
        _apply(cands[0], update)
        return dict(cands[0])

    async def update_many(self, filt, update):
        n = 0
        for d in self.docs:
            if _match(d, filt):
                _apply(d, update)
                n += 1
        return _Result(modified_count=n)

    async def update_one(self, filt, update):
        for d in self.docs:
            if _match(d, filt):
                _apply(d, update)
                return _Result(modified_count=1)
        return _Result(modified_count=0)


class _Db:
    def __init__(self):
        self._c = {'validation_jobs': _Collection(), 'backtest_results': _Collection()}

    def __getitem__(self, name):
        return self._c[name]


# ── fake handlers ─────────────────────────────────────────────────────────────────────
async def _load_ok(req):
    return {'req': req}


async def _noop_summary(db, report):
    return None


async def _run_ok(ctx, req, progress):
    progress.set_total(2)
    progress.tick(2)
    return {'strategy_id': req.get('strategy_id'), 'engine': 'replay', 'passed': True}


async def _run_boom(ctx, req, progress):
    raise RuntimeError('kaboom')


async def _run_cancelled(ctx, req, progress):
    raise JobCancelled()


async def _summary_writes_row(db, report):
    await db['backtest_results'].insert_one({'engine': report['engine'], 'passed': report['passed']})


def _handler(run_fn, summarize=_noop_summary):
    return JobHandler(load=_load_ok, run=run_fn, summarize=summarize)


# ── queue mechanics ─────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_sweep_reverts_running():
    db = _Db()
    db['validation_jobs'].docs = [
        {'_id': 1, 'status': 'running', 'cancelRequested': True},
        {'_id': 2, 'status': 'running'}, {'_id': 3, 'status': 'queued'},
    ]
    n = await JobRunner(db, {}).sweep_stuck()
    assert n == 2
    assert all(d['status'] == 'queued' for d in db['validation_jobs'].docs)
    assert 'cancelRequested' not in db['validation_jobs'].docs[0]   # stale cancel flag cleared on requeue


@pytest.mark.asyncio
async def test_claim_is_fifo_and_disjoint():
    db = _Db()
    db['validation_jobs'].docs = [
        {'_id': 1, 'status': 'queued', 'createdAt': 200},
        {'_id': 2, 'status': 'queued', 'createdAt': 100},   # older ⇒ claimed first
    ]
    runner = JobRunner(db, {})
    first = await runner._claim_next()
    second = await runner._claim_next()
    third = await runner._claim_next()
    assert first['_id'] == 2 and first['status'] == 'running'
    assert second['_id'] == 1
    assert third is None


# ── dispatch + terminal writes ────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_run_one_backtest_dispatch_writes_report_progress_summary():
    db = _Db()
    job = {'_id': 7, 'kind': 'backtest', 'request': {'strategy_id': 'factor_rank_v1'}}
    db['validation_jobs'].docs = [dict(job, status='running')]
    runner = JobRunner(db, {'backtest': _handler(_run_ok, _summary_writes_row)})
    await runner._run_one(job)
    j = db['validation_jobs'].docs[0]
    assert j['status'] == 'completed' and j['report']['engine'] == 'replay'
    assert j['progress']['pct'] == 1.0                       # sink snapshot captured post-run
    assert j['summary'] == {'passed': True, 'early_stopped': False}
    assert len(db['backtest_results'].docs) == 1             # summarize ran


@pytest.mark.asyncio
async def test_run_one_defaults_to_mcpt_when_kind_absent():
    db = _Db()
    job = {'_id': 8, 'request': {'strategy_id': 'x'}}        # no 'kind' (legacy doc)
    db['validation_jobs'].docs = [dict(job, status='running')]
    seen = {}
    async def _run(ctx, req, progress):
        seen['hit'] = True
        return {'engine': 'replay_mcpt', 'passed': False}
    await JobRunner(db, {'mcpt': _handler(_run)})._run_one(job)
    assert seen.get('hit') is True
    assert db['validation_jobs'].docs[0]['status'] == 'completed'


@pytest.mark.asyncio
async def test_run_one_failure_records_error_and_no_summary():
    db = _Db()
    job = {'_id': 9, 'kind': 'backtest', 'request': {}}
    db['validation_jobs'].docs = [dict(job, status='running')]
    await JobRunner(db, {'backtest': _handler(_run_boom, _summary_writes_row)})._run_one(job)
    j = db['validation_jobs'].docs[0]
    assert j['status'] == 'failed' and 'kaboom' in j['error']
    assert db['backtest_results'].docs == []                 # summarize never runs on failure


@pytest.mark.asyncio
async def test_run_one_cancelled_records_cancelled():
    db = _Db()
    job = {'_id': 10, 'kind': 'mcpt', 'request': {}}
    db['validation_jobs'].docs = [dict(job, status='running')]
    await JobRunner(db, {'mcpt': _handler(_run_cancelled)})._run_one(job)
    j = db['validation_jobs'].docs[0]
    assert j['status'] == 'cancelled'
    assert 'error' not in j                                   # a cancel is not a failure


@pytest.mark.asyncio
async def test_run_one_unknown_kind_fails():
    db = _Db()
    job = {'_id': 12, 'kind': 'weird', 'request': {}}
    db['validation_jobs'].docs = [dict(job, status='running')]
    await JobRunner(db, {'mcpt': _handler(_run_ok)})._run_one(job)
    j = db['validation_jobs'].docs[0]
    assert j['status'] == 'failed' and 'unknown job kind' in j['error']


# ── compact summary + flusher ───────────────────────────────────────────────────────────
def test_compact_summary_extracts_early_stop():
    r = {'passed': False,
         'step2_in_sample_mcpt': {'early_stopped': True, 'n_permutations': 1, 'n_planned': 1000},
         'step4_walk_forward_mcpt': {'early_stopped': False}}
    assert _compact_summary(r) == {'passed': False, 'early_stopped': True, 'n_done': 1, 'n_planned': 1000}
    assert _compact_summary({'passed': True}) == {'passed': True, 'early_stopped': False}


@pytest.mark.asyncio
async def test_flush_relays_cancel_and_writes_progress(monkeypatch):
    monkeypatch.setattr('src.application.job_runner.FLUSH_INTERVAL_S', 0.01)
    db = _Db()
    db['validation_jobs'].docs = [{'_id': 5, 'status': 'running', 'cancelRequested': True}]
    sink = ThreadSafeProgress()
    sink.set_total(4)
    sink.tick()
    task = asyncio.create_task(JobRunner(db, {})._flush(5, sink))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert sink.cancelled() is True                          # operator cancel relayed into the sink
    assert db['validation_jobs'].docs[0]['progress']['completed_units'] == 1


# ── the MCPT run wrapper drops stale/loader-only request keys (was a JobRunner concern) ──
@pytest.mark.asyncio
async def test_run_validator_filters_stale_request_keys():
    from src.main import _run_validator
    ctx = {'prices': {}, 'benchmark_bars': {}, 'constituents': None, 'grid_override': None}
    # `tickers`/`survivorship_free`/`benchmark` are loader-only / renamed — not validator.run kwargs.
    req = {'strategy_id': 'factor_rank_v1', 'start_ms': 0, 'end_ms': 1, 'tickers': ['A'],
           'survivorship_free': False, 'benchmark': '^GSPC', 'mcpt_n_in_sample': 2, 'mcpt_n_wf': 2,
           'seed': 0, 'mcpt_early_stop': True}
    report = await _run_validator(ctx, req, NullProgress())   # must not TypeError on the stale keys
    assert report['engine'] == 'replay_mcpt'
    assert report['passed'] is False                          # empty panel ⇒ insufficient_history

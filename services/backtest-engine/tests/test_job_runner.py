"""JobRunner queue mechanics — FIFO atomic-shape claim, startup sweep, success/failure writes.

Uses a tiny in-memory async fake of the two collections the runner touches (no Mongo needed in
CI). The fake can't prove Mongo's atomicity — that's a server guarantee — but it pins the claim
*query shape* (status filter + createdAt sort) and the lifecycle writes.
"""
import asyncio

import pytest

from src.application.job_runner import JobRunner


class _Result:
    def __init__(self, modified_count=0, inserted_id=None):
        self.modified_count = modified_count
        self.inserted_id = inserted_id


def _match(doc, filt):
    return all(doc.get(k) == v for k, v in filt.items())


def _apply(doc, update):
    if '$set' in update:
        doc.update(update['$set'])


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


class _OkValidator:
    async def run(self, prices, bench, **kwargs):
        return {'strategy_id': kwargs.get('strategy_id'), 'engine': 'replay_mcpt', 'passed': True,
                'legacy_gates': {'oos_sharpe': 1.0}, 'step4_walk_forward_mcpt': {'n_permutations': 5}}


class _BoomValidator:
    async def run(self, prices, bench, **kwargs):
        raise RuntimeError('kaboom')


class _StrictValidator:
    """Strict signature (no **kwargs), mirroring the real Validator.run — it would TypeError on an
    unexpected kwarg if the runner forwarded stale request keys instead of filtering them."""
    async def run(self, prices, benchmark_bars, *, strategy_id, start_ms, end_ms, constituents=None):
        return {'strategy_id': strategy_id, 'engine': 'replay_mcpt', 'passed': True,
                'legacy_gates': {}, 'step4_walk_forward_mcpt': {'n_permutations': 1}}


async def _noop_loader(req):
    return {}, {}, None   # (prices, benchmark_bars_map, constituents) — matches _load_history's contract


@pytest.mark.asyncio
async def test_sweep_reverts_running():
    db = _Db()
    db['validation_jobs'].docs = [
        {'_id': 1, 'status': 'running'}, {'_id': 2, 'status': 'running'}, {'_id': 3, 'status': 'queued'},
    ]
    runner = JobRunner(db, _noop_loader, _OkValidator)
    n = await runner.sweep_stuck()
    assert n == 2
    assert all(d['status'] == 'queued' for d in db['validation_jobs'].docs)


@pytest.mark.asyncio
async def test_claim_is_fifo_and_disjoint():
    db = _Db()
    db['validation_jobs'].docs = [
        {'_id': 1, 'status': 'queued', 'createdAt': 200},
        {'_id': 2, 'status': 'queued', 'createdAt': 100},   # older ⇒ claimed first
    ]
    runner = JobRunner(db, _noop_loader, _OkValidator)
    first = await runner._claim_next()
    second = await runner._claim_next()
    third = await runner._claim_next()
    assert first['_id'] == 2 and first['status'] == 'running'
    assert second['_id'] == 1                                # the two claims are disjoint
    assert third is None                                     # nothing left queued


@pytest.mark.asyncio
async def test_run_one_success_writes_report_and_summary():
    db = _Db()
    job = {'_id': 7, 'request': {'strategy_id': 'factor_rank_v1', 'start_ms': 0, 'end_ms': 1}}
    db['validation_jobs'].docs = [dict(job, status='running')]   # already claimed
    runner = JobRunner(db, _noop_loader, _OkValidator)
    await runner._run_one(job)
    j = db['validation_jobs'].docs[0]
    assert j['status'] == 'completed' and j['report']['passed'] is True
    assert len(db['backtest_results'].docs) == 1                 # back-compat summary row
    assert db['backtest_results'].docs[0]['engine'] == 'replay_mcpt'


@pytest.mark.asyncio
async def test_run_one_failure_records_error():
    db = _Db()
    job = {'_id': 9, 'request': {'strategy_id': 'x', 'start_ms': 0, 'end_ms': 1}}
    db['validation_jobs'].docs = [dict(job, status='running')]
    runner = JobRunner(db, _noop_loader, _BoomValidator)
    await runner._run_one(job)
    j = db['validation_jobs'].docs[0]
    assert j['status'] == 'failed'
    assert 'kaboom' in j['error']
    assert db['backtest_results'].docs == []


@pytest.mark.asyncio
async def test_run_one_drops_stale_request_keys():
    # A job queued under an older schema: `benchmark` (renamed to benchmark_tickers in Phase 6)
    # + loader-only keys. None are validator.run kwargs anymore — the runner must filter them to
    # the current signature and re-run best-effort, not crash with 'unexpected keyword argument'.
    db = _Db()
    job = {'_id': 11, 'request': {'strategy_id': 'x', 'start_ms': 0, 'end_ms': 1,
                                  'benchmark': '^GSPC', 'tickers': ['A'], 'survivorship_free': False}}
    db['validation_jobs'].docs = [dict(job, status='running')]
    runner = JobRunner(db, _noop_loader, _StrictValidator)
    await runner._run_one(job)
    assert db['validation_jobs'].docs[0]['status'] == 'completed'

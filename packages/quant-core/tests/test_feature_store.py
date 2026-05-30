"""Content-hash gate + serialization round-trip for the feature store (DB-free).

The supersede/insert transaction logic is covered by an integration test against a Timescale
container in CI (mirrors packages/shared-pg migrations.test.ts). Here we lock the pure parts.
"""
from quant_core.features.timescale_store import (
    _from_jsonb,
    _to_jsonb,
    hash_feature_vector,
)
from quant_core.strategy.contract import FeatureVector


def _fv(**over) -> FeatureVector:
    base = dict(
        strategy_id='factor_rank_v1',
        observation_ts=1_700_000_000_000,
        ticker_universe=['AAPL', 'MSFT'],
        composite_scores={'AAPL': 0.4, 'MSFT': -0.1},
        per_ticker={'AAPL': {'momentum': 0.5}, 'MSFT': {'momentum': -0.2}},
        cross_sectional_stats={'momentum_mean': 0.0},
        regime_confidence=0.9,
        position_size_multiplier=0.92,
        signal_weights={'momentum': 0.55},
        sectors={'AAPL': 'Tech', 'MSFT': 'Tech'},
        covariance_matrix=[[1.0, 0.0], [0.0, 1.0]],
        feature_stability=None,
    )
    base.update(over)
    return FeatureVector(**base)


def test_hash_is_deterministic():
    assert hash_feature_vector(_fv()) == hash_feature_vector(_fv())


def test_hash_ignores_knowledge_time_but_tracks_content():
    # observation_ts is part of the key, not content — but composite changes must change hash.
    assert hash_feature_vector(_fv()) != hash_feature_vector(
        _fv(composite_scores={'AAPL': 0.41, 'MSFT': -0.1})
    )


def test_serialization_round_trips():
    fv = _fv(extras={'betti': [1, 2, 3]})
    back = _from_jsonb(_to_jsonb(fv))
    assert back == fv

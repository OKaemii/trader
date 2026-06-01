"""Resolver for portal-set per-strategy search-grid overrides (portal_strategy_config).

The grid override lets an operator widen/narrow what the validator sweeps without a redeploy.
Resolved in the async layer (job runner / run_backtest) and passed into the CPU-bound validator
so the compute thread stays Mongo-free. Falls back to the strategy's own parameter_space() when
unset or malformed.
"""
from __future__ import annotations

from typing import Optional

COLLECTION = 'portal_strategy_config'


async def resolve_search_grid(db, strategy_id: str) -> Optional[dict[str, list[float]]]:
    """The portal searchGrid override for `strategy_id`, or None when unset/invalid — None
    signals the caller to fall back to make_strategy(strategy_id).parameter_space()."""
    if db is None:
        return None
    try:
        doc = await db[COLLECTION].find_one({'_id': strategy_id})
    except Exception:
        return None
    if not doc:
        return None
    grid = doc.get('searchGrid')
    if not isinstance(grid, dict) or not grid:
        return None
    out: dict[str, list[float]] = {}
    for k, v in grid.items():
        if isinstance(v, (list, tuple)) and v:
            try:
                out[str(k)] = [float(x) for x in v]
            except (TypeError, ValueError):
                continue
    return out or None

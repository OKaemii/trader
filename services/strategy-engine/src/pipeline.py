"""Strategy-Lab pipeline funnel — declarative stages + live counts.

Plan: agent-docs/plans/research-trading-os.md §G ("Strategy-Lab pipeline funnel"), Task 37.

A strategy's emission is a *funnel*: the wide candidate universe is winnowed through a series of
filter/score/select stages down to the narrow held set. This module turns one cycle's observed
counts into the **declarative** stage list the portal `PipelineFunnel` renders — one
``{key, label, count}`` per stage, ordered widest→narrowest so the funnel visibly narrows.

Kept PURE (no numpy, no FastAPI, no I/O) so it unit-tests in the no-numpy authoring sandbox and so
the host (main.py) is the only place that touches engine state. The host snapshots each cycle's
counts into ``_engine_state['last_pipeline']`` (a ``PipelineSnapshot``-shaped dict); this module maps
that snapshot + the strategy id onto the strategy's known stage shape.

Degrade-gracefully contract: with no snapshot yet (no cycle has run) every count is 0 and the stage
*shape* is still returned, so the funnel renders the labelled stages at zero rather than erroring.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class PipelineSnapshot:
    """One cycle's observed funnel counts, as the host records them after a cycle.

    All optional/zero-defaulted so a pre-cycle (empty) snapshot is valid: the funnel then renders
    the labelled stages at count 0. ``top_k`` is the strategy's configured held-position cap (from
    StrategyConfig); it bounds the Top-K stage even when no cycle has narrowed the set yet.
    """

    universe: int = 0          # tickers on the stream this cycle (the widest stage)
    ready: int = 0             # of those, names with >= rolling_window bars (history filter passed)
    eligible: int = 0          # screen survivors (high_velocity QMJ + cap); 0 for bars-only strategies
    scored: int = 0            # names that received a usable (non-zero) factor/composite score
    top_k: int = 0             # configured held-position cap (StrategyConfig.top_k)
    held: int = 0              # names actually emitted this cycle (held set); 0 on a HOLD/no-emit cycle
    emitted: bool = False      # whether the cycle published signals (a rebalance happened)


# Strategies that run the cross-sectional factor funnel (history-filter → factor-score → top-K).
_CROSS_SECTIONAL = {"factor_rank_v1", "sector_momentum_v1", "topology_v1"}


def _cross_sectional_stages(snap: PipelineSnapshot) -> list[dict]:
    """Universe → History filter → Factor scoring → Top-K → Rebalance.

    Ranking is the act of sorting the scored names; it doesn't drop any, so it is folded into the
    "Factor scoring" stage (a separate Ranking node at the same count would read as a flat segment,
    not a narrowing — the funnel narrows where the candidate set actually shrinks).
    """
    return [
        {"key": "universe", "label": "Universe", "count": snap.universe},
        {"key": "history", "label": "History filter", "count": snap.ready},
        {"key": "scoring", "label": "Factor scoring", "count": snap.scored},
        {"key": "topk", "label": f"Top-K ({snap.top_k})", "count": _topk_count(snap)},
        {"key": "rebalance", "label": "Rebalance", "count": snap.held},
    ]


def _high_velocity_stages(snap: PipelineSnapshot) -> list[dict]:
    """Universe → QMJ screen (cap ≥ floor ∧ fail-closed quality) → Momentum rank → Top-K → Rebalance.

    The QMJ screen is the funnel's first hard cut (most names fail cap-or-quality); momentum rank +
    the high-vol drop produce the held set. ``scored`` carries the momentum-ranked count, ``held``
    the post-vol-drop survivors.
    """
    return [
        {"key": "universe", "label": "Universe", "count": snap.universe},
        {"key": "qmj", "label": "QMJ screen", "count": snap.eligible},
        {"key": "rank", "label": "Momentum rank", "count": snap.scored},
        {"key": "topk", "label": f"Top-K ({snap.top_k})", "count": _topk_count(snap)},
        {"key": "rebalance", "label": "Rebalance", "count": snap.held},
    ]


def _topk_count(snap: PipelineSnapshot) -> int:
    """Count at the Top-K node — how many the cap admits from the scored set this cycle (the visible
    narrowing to the held band). Pre-cycle (scored=0) it shows the configured cap so the stage still
    communicates its width rather than collapsing to 0."""
    return min(snap.scored, snap.top_k) if snap.scored else snap.top_k


def build_pipeline_stages(strategy_id: str, snap: PipelineSnapshot) -> list[dict]:
    """Map a strategy id + one cycle's snapshot onto its declarative funnel stages.

    Returns a list of ``{key, label, count}`` dicts (the portal PipelineFunnel contract), widest
    stage first. An unknown strategy id falls back to the cross-sectional shape (the common case),
    so a new strategy still renders a sensible funnel before it gets a bespoke shape here.
    """
    if strategy_id == "high_velocity_v1":
        return _high_velocity_stages(snap)
    return _cross_sectional_stages(snap)


def snapshot_from_state(state: dict) -> PipelineSnapshot:
    """Read a ``last_pipeline`` dict off ``_engine_state`` into a PipelineSnapshot.

    Tolerant of a missing/partial dict (pre-cycle boot, or an older snapshot shape) — every field
    defaults to 0/False, so the funnel degrades to labelled zero-count stages rather than raising.
    """
    lp = state.get("last_pipeline") or {}
    return PipelineSnapshot(
        universe=int(lp.get("universe", 0) or 0),
        ready=int(lp.get("ready", 0) or 0),
        eligible=int(lp.get("eligible", 0) or 0),
        scored=int(lp.get("scored", 0) or 0),
        top_k=int(lp.get("top_k", 0) or 0),
        held=int(lp.get("held", 0) or 0),
        emitted=bool(lp.get("emitted", False)),
    )

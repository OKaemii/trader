"""Tests for the Strategy-Lab pipeline funnel helper (T37 §G).

Pure stdlib (no numpy, no FastAPI host) — the helper maps one cycle's observed funnel counts onto a
strategy's declarative ``{key, label, count}`` stage list. These pin the stage SHAPE (the portal
PipelineFunnel contract), the narrowing invariant, and the degrade-gracefully (no-cycle) behaviour.
"""
from __future__ import annotations

from src.pipeline import (
    PipelineSnapshot,
    build_pipeline_stages,
    snapshot_from_state,
)


# ── Stage shape (the portal PipelineFunnel contract) ───────────────────────────────────────────

def test_cross_sectional_stage_shape_and_keys():
    # factor_rank_v1 (and the other bars-only strategies) run the cross-sectional funnel:
    # Universe → History filter → Factor scoring → Top-K → Rebalance.
    snap = PipelineSnapshot(universe=192, ready=180, eligible=180, scored=180, top_k=20, held=20, emitted=True)
    stages = build_pipeline_stages("factor_rank_v1", snap)

    assert [s["key"] for s in stages] == ["universe", "history", "scoring", "topk", "rebalance"]
    # Every stage carries the three contract fields with the right types.
    for s in stages:
        assert set(s) == {"key", "label", "count"}
        assert isinstance(s["key"], str) and isinstance(s["label"], str) and isinstance(s["count"], int)
    # The configured cap is surfaced in the Top-K label so the operator sees the held band width.
    topk = next(s for s in stages if s["key"] == "topk")
    assert "20" in topk["label"]


def test_high_velocity_stage_shape_uses_qmj_screen():
    # high_velocity_v1 is a screen-then-rank funnel: Universe → QMJ screen → Momentum rank → Top-K
    # → Rebalance, with eligible = QMJ+cap survivors and scored = the momentum-ranked count.
    snap = PipelineSnapshot(universe=192, ready=190, eligible=140, scored=30, top_k=20, held=20, emitted=True)
    stages = build_pipeline_stages("high_velocity_v1", snap)

    assert [s["key"] for s in stages] == ["universe", "qmj", "rank", "topk", "rebalance"]
    counts = {s["key"]: s["count"] for s in stages}
    assert counts["qmj"] == 140       # the QMJ screen, not the bare history filter
    assert counts["rank"] == 30       # momentum-ranked top-N
    assert counts["rebalance"] == 20  # post-vol-drop held set


def test_unknown_strategy_falls_back_to_cross_sectional():
    stages = build_pipeline_stages("brand_new_v9", PipelineSnapshot(universe=10, ready=8, scored=8, top_k=5))
    assert [s["key"] for s in stages] == ["universe", "history", "scoring", "topk", "rebalance"]


# ── Funnel narrows (the visible invariant the funnel is built to show) ──────────────────────────

def test_counts_narrow_monotonically_on_a_real_emit_cycle():
    snap = PipelineSnapshot(universe=192, ready=180, eligible=140, scored=30, top_k=20, held=20, emitted=True)
    hv = build_pipeline_stages("high_velocity_v1", snap)
    counts = [s["count"] for s in hv]
    # Each stage is no wider than the one before it — the funnel narrows left→right.
    assert counts == sorted(counts, reverse=True)
    assert counts[0] > counts[-1]


def test_topk_capped_by_scored_set():
    # When fewer names are scored than the cap, the Top-K node shows the scored count (the real
    # narrowing), not the nominal cap — the funnel can't widen past what was actually scored.
    snap = PipelineSnapshot(universe=50, ready=12, eligible=12, scored=8, top_k=20, held=8, emitted=True)
    stages = build_pipeline_stages("factor_rank_v1", snap)
    topk = next(s for s in stages if s["key"] == "topk")
    assert topk["count"] == 8


# ── Degrade gracefully (no cycle has run yet) ──────────────────────────────────────────────────

def test_empty_snapshot_renders_zero_count_stages_not_an_error():
    # Pre-cycle boot: the funnel must still render its labelled shape, all counts 0 — never raise.
    snap = snapshot_from_state({})  # no last_pipeline key at all
    stages = build_pipeline_stages("factor_rank_v1", snap)
    assert [s["key"] for s in stages] == ["universe", "history", "scoring", "topk", "rebalance"]
    # Universe/history/scoring/rebalance are 0; Top-K shows the configured cap (0 here, no config).
    assert all(s["count"] == 0 for s in stages)


def test_empty_snapshot_topk_shows_configured_cap():
    # Even with no cycle, a non-zero configured cap communicates the held-band width on the Top-K
    # node (it can't have been narrowed below the cap by a non-existent cycle).
    snap = PipelineSnapshot(top_k=20)  # nothing scored yet
    stages = build_pipeline_stages("factor_rank_v1", snap)
    topk = next(s for s in stages if s["key"] == "topk")
    assert topk["count"] == 20


def test_snapshot_from_state_tolerates_partial_dict():
    # An older/partial last_pipeline missing some fields must default the rest, not KeyError.
    snap = snapshot_from_state({"last_pipeline": {"universe": 100, "ready": 90}})
    assert snap.universe == 100 and snap.ready == 90
    assert snap.eligible == 0 and snap.scored == 0 and snap.top_k == 0 and snap.held == 0
    assert snap.emitted is False


def test_snapshot_from_state_reads_full_dict():
    snap = snapshot_from_state({
        "last_pipeline": {"universe": 192, "ready": 180, "eligible": 140,
                          "scored": 30, "top_k": 20, "held": 20, "emitted": True},
    })
    assert (snap.universe, snap.ready, snap.eligible, snap.scored, snap.top_k, snap.held) == (192, 180, 140, 30, 20, 20)
    assert snap.emitted is True


def test_hold_cycle_snapshot_shows_universe_but_no_held_set():
    # A HOLD cycle (e.g. high_velocity off its monthly rebalance) scored/held nothing this cycle —
    # the funnel still shows the universe + screen narrowing, with scoring/top-k/rebalance at 0.
    snap = PipelineSnapshot(universe=192, ready=190, eligible=140, scored=0, top_k=20, held=0, emitted=False)
    stages = build_pipeline_stages("high_velocity_v1", snap)
    counts = {s["key"]: s["count"] for s in stages}
    assert counts["universe"] == 192 and counts["qmj"] == 140
    assert counts["rank"] == 0 and counts["rebalance"] == 0
    # Top-K with nothing scored falls back to the configured cap label width.
    assert counts["topk"] == 20

"""stage — metric registry application (epic Task 6).

Maps raw us-gaap/dei facts (the `download.edgar.RawFact` parser output, identical in shape to a
`fundamentals_raw_facts` row) to the canonical `quant_core.fundamentals.LINE_ITEMS` keys using the
versioned `metadata/metric_registry.yaml` (ordered candidate tags + per-sector overrides), producing
the staged "interpreted facts" the bi-temporal normalizer (Task 7) consumes. This is the
US-normalization SELECT layer that keeps a writer from emitting `revenue` while the factor reads
`total_revenue`.

Public surface (import from `src.stage`):
  * registry — `load_registry` / `default_registry` / `parse_registry` / `MetricRegistry`.
  * resolver — `resolve_metrics` (the staging entrypoint) + its result/identity types
    (`InterpretedFact`, `ValueConflict`, `StageResult`, `FactKey`, `fact_key`).

The resolver is a PURE function over a list of RawFact + a CIK + a sector template; nothing here opens
a socket or a DB connection on import (the writer that persists these is Task 7).
"""
from __future__ import annotations

from .registry import (
    DEFAULT_SECTOR,
    MetricRegistry,
    default_registry,
    load_registry,
    parse_registry,
)
from .resolver import (
    FactKey,
    InterpretedFact,
    StageResult,
    ValueConflict,
    fact_key,
    resolve_metrics,
)

__all__ = [
    "DEFAULT_SECTOR",
    "MetricRegistry",
    "default_registry",
    "load_registry",
    "parse_registry",
    "FactKey",
    "InterpretedFact",
    "StageResult",
    "ValueConflict",
    "fact_key",
    "resolve_metrics",
]

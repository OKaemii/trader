"""Metric registry loader (epic Task 6).

Loads `metadata/metric_registry.yaml` into a queryable structure: per canonical metric, the ORDERED
candidate us-gaap/dei tag list (default + per-sector overrides) the resolver consults to pick the
highest-priority PRESENT tag. The registry is DATA — a versioned YAML — so a tag mapping changes
without a code edit; this module only parses + validates it (and pins the canonical key set to
`quant_core.fundamentals.LINE_ITEMS`, so the registry can never name a metric the contract doesn't
recognise).

WHY a dataclass over the raw dict: the resolver asks the same two questions a lot — "what tags map to
metric M for sector S?" and "is M a flow?" — and a small typed accessor (`candidates`,
`is_flow_metric`, `metrics_for_tag`) keeps that lookup honest (a typo'd metric name raises here, not as
a silent miss in staging). `metrics_for_tag` is the reverse index the resolver uses to walk a CIK's raw
facts ONCE and bucket each by the canonical metric(s) its tag feeds, rather than re-scanning the whole
fact list per metric.

NO yaml-less fallback: PyYAML is a declared dependency of the service (requirements.txt) and the python
gate (backtest-engine-test.Dockerfile). The registry is shipped inside `src/stage/metadata/`, so it is
present in every image that imports this module — the loader reads the packaged file by default.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

import yaml

from quant_core.fundamentals.contract import LINE_ITEMS

# The packaged registry. Co-located with this module under src/stage/metadata/ so it ships in every
# image (the Dockerfile COPYs src/ wholesale) and the gate reads the same file the runtime does.
_REGISTRY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "metadata", "metric_registry.yaml")

# The default sector template — used when a fact's sector is unknown/unspecified. Matches the
# normalizer's template set (general | bank | insurance | reit | utility); 'general' takes the
# `default` candidate list of each metric.
DEFAULT_SECTOR = "general"

# Canonical key set: the registry MUST only name metrics in the shared contract, so the writer/reader
# can't drift to a spelling the factors don't read. Imported, never re-listed (the whole point of
# quant_core.fundamentals.contract).
_CANONICAL = frozenset(LINE_ITEMS)


@dataclass(frozen=True)
class MetricRegistry:
    """The parsed, validated metric registry.

    * `version` — the YAML's schema version (bumped when the mapping shape changes; carried so a
      consumer can assert it understands the file).
    * `_candidates` — `{metric: {sector: (tag, …)}}`. Every metric always has a `general` entry (the
      `default` list); a sector with an override has its own tuple, otherwise the resolver falls back
      to `general`. An EMPTY tuple is meaningful (e.g. `gross_profit` for a bank): "this metric has no
      tag for this sector" — the resolver yields no fact for it (NaN-excluded downstream), distinct
      from "sector not overridden" (fall back to general).
    * `_flow_metrics` — the set of canonical metrics that are period flows (duration facts); the
      resolver applies QTD-vs-YTD disambiguation to these and takes the rest (balance-sheet instants)
      as-is.
    """

    version: int
    _candidates: dict[str, dict[str, tuple[str, ...]]]
    _flow_metrics: frozenset[str]

    def candidates(self, metric: str, sector: Optional[str] = None) -> tuple[str, ...]:
        """The ORDERED candidate tags for `metric` under `sector` (index 0 = most preferred).

        Falls back to the `general` (`default`) list when the sector has no override. An override that
        is an EMPTY list returns `()` — a deliberate "no tag for this sector" (the resolver then yields
        nothing for the metric), not a fall-through to general. Raises on an unknown metric (a typo
        must fail loud, not silently stage nothing)."""
        by_sector = self._candidates.get(metric)
        if by_sector is None:
            raise KeyError(f"metric_registry: unknown metric '{metric}'")
        sector_key = (sector or DEFAULT_SECTOR).lower()
        if sector_key in by_sector:
            return by_sector[sector_key]
        return by_sector[DEFAULT_SECTOR]

    def is_flow_metric(self, metric: str) -> bool:
        """True iff `metric` is a period flow (duration) needing QTD-vs-YTD disambiguation; False for a
        balance-sheet instant taken at period_end as-is."""
        return metric in self._flow_metrics

    def metrics(self) -> tuple[str, ...]:
        """Every canonical metric the registry maps, in declaration order."""
        return tuple(self._candidates.keys())

    def metrics_for_tag(self, raw_tag: str, sector: Optional[str] = None) -> tuple[str, ...]:
        """The canonical metric(s) `raw_tag` is a candidate for under `sector` — a reverse lookup over
        the registry (which canonical metric does this us-gaap/dei tag feed?).

        A single us-gaap tag CAN feed more than one canonical metric across the registry (rare, but the
        contract allows it); all matches are returned so none is dropped. Sector-scoped so a bank's
        `Revenues` maps to `total_revenue` (its bank override) while a manufacturer's does not (its
        default prefers the contract-revenue tag) — the lookup respects each filer's template. Provided
        for consumers/QA that want tag→metric attribution; the resolver itself scans per-metric."""
        out: list[str] = []
        for metric in self._candidates:
            if raw_tag in self.candidates(metric, sector):
                out.append(metric)
        return tuple(out)


def _coerce_tag_list(raw: object, *, metric: str, where: str) -> tuple[str, ...]:
    """A YAML candidate list → a validated tuple of non-empty `taxonomy:tag` strings. An empty list is
    allowed (the meaningful 'no tag for this sector'); a non-list, or a non-string / mis-shaped entry,
    is a registry authoring error and raises."""
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise ValueError(f"metric_registry: {metric}.{where} must be a list, got {type(raw).__name__}")
    tags: list[str] = []
    for entry in raw:
        if not isinstance(entry, str) or ":" not in entry or not entry.strip():
            raise ValueError(f"metric_registry: {metric}.{where} has a bad tag entry {entry!r} "
                             "(expected 'taxonomy:Tag')")
        tags.append(entry.strip())
    return tuple(tags)


def parse_registry(doc: object) -> MetricRegistry:
    """Validate a decoded registry document into a `MetricRegistry`. A total function over already-
    decoded YAML so it is unit-tested directly (no file I/O). Validates:
      * top-level shape (`version` int, `metrics` mapping);
      * every metric key is in the canonical `LINE_ITEMS` set (no drift to an unknown spelling);
      * each metric has a `default` candidate list; sector overrides live under `sectors.<template>`;
      * `flow_metrics` names only known metrics.
    Raises `ValueError` on any violation (an invalid registry must fail loud at load, not stage garbage).
    """
    if not isinstance(doc, dict):
        raise ValueError("metric_registry: top level must be a mapping")
    version = doc.get("version")
    if not isinstance(version, int):
        raise ValueError("metric_registry: 'version' must be an integer")

    metrics_doc = doc.get("metrics")
    if not isinstance(metrics_doc, dict):
        raise ValueError("metric_registry: 'metrics' must be a mapping")

    candidates: dict[str, dict[str, tuple[str, ...]]] = {}
    for metric, body in metrics_doc.items():
        if metric not in _CANONICAL:
            raise ValueError(f"metric_registry: '{metric}' is not a canonical LINE_ITEMS key "
                             "(import the vocabulary from quant_core.fundamentals; do not invent keys)")
        if not isinstance(body, dict):
            raise ValueError(f"metric_registry: metrics.{metric} must be a mapping")
        if "default" not in body:
            raise ValueError(f"metric_registry: metrics.{metric} is missing a 'default' candidate list")
        by_sector: dict[str, tuple[str, ...]] = {
            DEFAULT_SECTOR: _coerce_tag_list(body.get("default"), metric=metric, where="default")
        }
        sectors_doc = body.get("sectors") or {}
        if not isinstance(sectors_doc, dict):
            raise ValueError(f"metric_registry: metrics.{metric}.sectors must be a mapping")
        for sector, sector_tags in sectors_doc.items():
            by_sector[str(sector).lower()] = _coerce_tag_list(
                sector_tags, metric=metric, where=f"sectors.{sector}"
            )
        candidates[str(metric)] = by_sector

    flow_doc = doc.get("flow_metrics") or []
    if not isinstance(flow_doc, list):
        raise ValueError("metric_registry: 'flow_metrics' must be a list")
    flow_metrics = set()
    for fm in flow_doc:
        if fm not in candidates:
            raise ValueError(f"metric_registry: flow_metrics names '{fm}', which is not a mapped metric")
        flow_metrics.add(fm)

    return MetricRegistry(version=version, _candidates=candidates, _flow_metrics=frozenset(flow_metrics))


def load_registry(path: Optional[str] = None) -> MetricRegistry:
    """Load + validate the registry from `path` (default: the packaged
    `metadata/metric_registry.yaml`). `yaml.safe_load` (never `load`) so a registry file can't execute
    arbitrary Python."""
    with open(path or _REGISTRY_PATH, "r", encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    return parse_registry(doc)


@lru_cache(maxsize=1)
def default_registry() -> MetricRegistry:
    """The packaged registry, parsed once (it is immutable). The resolver's default source."""
    return load_registry()

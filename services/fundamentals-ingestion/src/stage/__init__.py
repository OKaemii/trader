"""stage — metric registry application (epic Task 6).

Maps raw us-gaap/dei tags to the canonical `LINE_ITEMS` (from `quant_core.fundamentals.contract`)
using `metadata/metric_registry.yaml` (tag → canonical key, unit, sign, preference order for
synonymous tags), producing interpreted facts the normalizer consumes. This is the US-normalization
layer that keeps a writer from emitting `revenue` while the factor reads `total_revenue`.
"""

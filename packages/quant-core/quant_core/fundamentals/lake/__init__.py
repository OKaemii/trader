"""PIT fundamentals Parquet-lake read engine (shared by the harvester write-path, the lake-backed
fundamentals-api, and backtest replay).

The lake is the *only* contract: one zstd-Parquet file per CIK (atomic replace → idempotent, no torn
reads), with the point-in-time guarantee reduced to a single SQL clause — `knowledge_ts <= :as_of`.
This package holds the bare read pieces: the per-CIK fact `SCHEMA` (`schema`), the `knowledge_ts`
derivation calendar (`calendar`), and — in later tasks — the query-time standardization, the DuckDB
store, and the platform contract layer.

Imports are deliberately NOT eager here: `calendar` is pure stdlib (no third-party dep), while
`schema` needs pyarrow (the `quant-core[lake]` extra). Keeping `__init__` free of a top-level
`schema` import means a caller that only needs the calendar (e.g. the harvester's `knowledge_ts`
derivation) does not drag in pyarrow. Import the submodule you need directly:

    from quant_core.fundamentals.lake.schema import SCHEMA
    from quant_core.fundamentals.lake.calendar import next_session_open_ms, derive_knowledge_ts
"""

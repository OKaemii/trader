"""Put the service root on sys.path so tests can `import src.snapshot` regardless of the directory
pytest is invoked from (CI runs the python gate from the repo root, mirroring how backtest-engine's,
fundamentals-ingestion's, and fundamentals-api's conftests work).

`src/snapshot.py` imports `psycopg` and `pyarrow` at module top-level (the snapshot job runs against
a live Timescale and writes Parquet). Those are heavy deps the python gate does NOT install (the gate
asserts the snapshotter's pure metadata — the `TABLES` specs — not the I/O). So we stub them in
`sys.modules` BEFORE the test imports `src.snapshot`: the `TABLES`/`TableSpec` definitions are plain
dataclasses that don't touch the stubbed modules, so the assertions run with zero infra deps."""
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Stub the heavy I/O deps so `import src.snapshot` succeeds in the deps-light gate. The metadata under
# test (TABLES) never calls into them; the snapshot job (which does) runs with the real deps in prod.
for _name in ("psycopg", "pyarrow", "pyarrow.parquet"):
    if _name not in sys.modules:
        sys.modules[_name] = types.ModuleType(_name)

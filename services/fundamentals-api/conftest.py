"""Put the service root on sys.path so tests can `import src.main` / `import src.resolver` regardless
of the directory pytest is invoked from (CI runs the python gate from the repo root, mirroring how
backtest-engine's and fundamentals-ingestion's conftests work). The read app + resolver import only
FastAPI/pydantic, the installed `quant_core` contract, and asyncpg/redis lazily — they unit-test
against in-memory fakes with no live Timescale/Redis connection."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

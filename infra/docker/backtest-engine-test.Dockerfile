# Python test gate for quant-core + backtest-engine.
#
# The authoring/CI sandbox has no numpy, so Python is only py_compile-checkable there. This image
# builds the real dependency stack (numpy/scipy/scikit-learn/giotto-tda/quant-core + pytest) and
# RUNs both pytest suites *during the build* — so `docker build -f this` is the test gate: a
# failing assertion fails the build. It is never deployed (build-images.sh ignores it); the
# runtime image (backtest-engine.Dockerfile) stays lean and test-free.
FROM python:3.12-slim

WORKDIR /app

# quant-core with the [test] (pytest + pytest-asyncio) and [http] (httpx) extras. Heavy layer
# (giotto-tda) cached separately so re-runs after editing a test only re-execute the pytest layer.
COPY packages/quant-core ./packages/quant-core
RUN pip install --no-cache-dir './packages/quant-core[http,test]'

# backtest-engine runtime deps (pymongo for job_runner, pandas, etc.) — also re-pins pytest.
COPY services/backtest-engine/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Sources + tests last (cheap layers, re-run on every edit).
COPY packages/quant-core/tests ./quant_core_tests
COPY services/backtest-engine/src ./src
COPY services/backtest-engine/conftest.py ./conftest.py
COPY services/backtest-engine/tests ./tests

# strategy-engine's PURE infrastructure suites (deps-light — only quant_core + httpx + motor, all
# installed above; no numpy needed in the test itself). Isolated under ./strategy_engine so its
# `src.*` package root doesn't collide with backtest-engine's `src` at /app, and run from that dir
# so `python -m pytest` prepends it to sys.path and `import src.*` resolves (the same way the local
# runner runs from services/strategy-engine). We gate the deps-clean suites here:
#   - test_fundamentals_as_of (the PIT seam),
#   - test_factor_store (the factor_scores writer/reader + history + source stamping + best-effort
#     guard — motor is installed via backtest-engine's requirements, so the store imports cleanly),
#   - test_lru_cache (the in-process TTL+LRU fronting the factor_scores scores endpoint — pure
#     stdlib, no Mongo/numpy: hit/expire/LRU/herd-coalesce + the (ticker, asOf-bucket) key),
#   - test_pipeline (the Strategy-Lab funnel helper — pure stdlib: declarative stage shape + the
#     narrowing invariant + degrade-gracefully when no cycle has run).
# The respx-backed strategy-engine tests stay on the local dev runner. Add more files as they
# become deps-clean.
COPY services/strategy-engine/src ./strategy_engine/src
COPY services/strategy-engine/tests/test_fundamentals_as_of.py ./strategy_engine/tests/test_fundamentals_as_of.py
COPY services/strategy-engine/tests/test_factor_store.py ./strategy_engine/tests/test_factor_store.py
COPY services/strategy-engine/tests/test_lru_cache.py ./strategy_engine/tests/test_lru_cache.py
COPY services/strategy-engine/tests/test_pipeline.py ./strategy_engine/tests/test_pipeline.py

# fundamentals-ingestion skeleton suite (PIT Fundamentals Warehouse write-side). Deps-clean: the app +
# stage stubs import only fastapi/pydantic + the installed quant_core (TestClient needs httpx from the
# [http] extra above) — no Mongo/Timescale connection. Isolated under ./fundamentals_ingestion so its
# `src.*` package root doesn't collide with backtest-engine's `src` at /app, and run from that dir so
# `import src.main` resolves via its own conftest (same approach as the strategy-engine suite above).
# PyYAML (epic Task 6): the metric registry (src/stage/metadata/metric_registry.yaml) is loaded with
# yaml.safe_load; it is not in quant-core's deps nor backtest-engine's requirements, so install it here
# (pinned to the service requirements.txt) before the fundamentals-ingestion suite runs.
RUN pip install --no-cache-dir 'PyYAML==6.0.2'
COPY services/fundamentals-ingestion/src ./fundamentals_ingestion/src
COPY services/fundamentals-ingestion/conftest.py ./fundamentals_ingestion/conftest.py
COPY services/fundamentals-ingestion/tests ./fundamentals_ingestion/tests

# quant-core suite imports the installed package; backtest suite imports src.* (conftest puts
# /app on the path). PYTHONDONTWRITEBYTECODE keeps the layer clean. -p no:cacheprovider avoids a
# read-only-fs cache complaint. A non-zero exit here fails the build = the gate.
ENV PYTHONDONTWRITEBYTECODE=1
RUN python -m pytest quant_core_tests -q -p no:cacheprovider \
 && python -m pytest tests -q -p no:cacheprovider \
 && (cd strategy_engine && python -m pytest tests -q -p no:cacheprovider) \
 && (cd fundamentals_ingestion && python -m pytest tests -q -p no:cacheprovider)

CMD ["true"]

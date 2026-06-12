FROM python:3.12-slim

WORKDIR /app

# Shared quant-core package first, with the [lake] extra (pyarrow + duckdb) — ONE source of truth for
# the on-disk Parquet SCHEMA (quant_core.fundamentals.lake.schema) and the next-session knowledge_ts
# calendar (quant_core.fundamentals.lake.calendar) the writer derives availability from. Installing the
# extra here (not re-pinning pyarrow in the service requirements) keeps writer and the DuckDB read engine
# on the same pins so they cannot drift. Heavy layer, cached separately from a service-code edit.
COPY packages/quant-core ./packages/quant-core
RUN pip install --no-cache-dir './packages/quant-core[lake]'

# The harvester's own direct deps (httpx for the EDGAR client; fastapi/uvicorn for the status surface).
COPY services/fundamentals-harvester/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Service sources + the FB→META rename seed CSV (src/main.py seeds ticker_history from /app/seeds/...).
COPY services/fundamentals-harvester/src ./src
COPY services/fundamentals-harvester/seeds ./seeds

# Port 8012 — distinct from strategy-engine (8000), backtest-engine (8001), fundamentals-ingestion
# (8010), and fundamentals-api (8011); the chart's Service + probes target the same number.
EXPOSE 8012

# One process, two jobs: `uvicorn app:app` serves the status API AND (because the chart sets
# HARVESTER_RUN_LOOP) starts the bootstrap+sweep write loop as a background task on app startup
# (src/app.py `_start_harvest_loop`). `--app-dir src` puts the service's `src/` on sys.path so the
# modules' bare intra-package imports (`import main`, `from edgar import Edgar`) resolve as top-level
# modules — the layout the conftest documents the deployed image runs from.
CMD ["uvicorn", "app:app", "--app-dir", "src", "--host", "0.0.0.0", "--port", "8012"]

FROM python:3.12-slim

WORKDIR /app

# Shared quant-core package first — one source of truth for the sci stack, the fundamentals contract
# (quant_core.fundamentals: LINE_ITEMS / market_of / SOURCE_*), AND the lake read engine
# (quant_core.fundamentals.lake) the resolver reads through. The [lake] extra pulls duckdb + pyarrow (the
# DuckDB-over-Parquet PIT reader) — the lake replaced the Timescale hypertable, so the service installs
# [lake] and no longer needs asyncpg. Heavy layer (giotto-tda etc.), cached separately so a service-code
# edit doesn't re-resolve it.
COPY packages/quant-core ./packages/quant-core
RUN pip install --no-cache-dir './packages/quant-core[lake]'

COPY services/fundamentals-api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/fundamentals-api/src ./src

# Port 8011 — distinct from strategy-engine (8000), backtest-engine (8001), and fundamentals-ingestion
# (8010); the chart's Service + probes target the same number.
EXPOSE 8011
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8011"]

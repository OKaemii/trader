FROM python:3.12-slim

WORKDIR /app

# Shared quant-core package first — one source of truth for the sci stack AND the fundamentals contract
# (quant_core.fundamentals: LINE_ITEMS / market_of / SOURCE_*) the resolver pivots its long facts INTO.
# Heavy layer (giotto-tda etc.), cached separately so a service-code edit doesn't re-resolve it.
# quant-core also supplies the asyncpg pin the Timescale reader uses.
COPY packages/quant-core ./packages/quant-core
RUN pip install --no-cache-dir ./packages/quant-core

COPY services/fundamentals-api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/fundamentals-api/src ./src

# Port 8011 — distinct from strategy-engine (8000), backtest-engine (8001), and fundamentals-ingestion
# (8010); the chart's Service + probes target the same number.
EXPOSE 8011
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8011"]

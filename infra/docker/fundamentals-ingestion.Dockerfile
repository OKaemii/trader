FROM python:3.12-slim

WORKDIR /app

# Shared quant-core package first — one source of truth for the sci stack AND the fundamentals
# contract (quant_core.fundamentals: LINE_ITEMS / market_of / FundamentalsAsOf) the ingestion stages
# import. Heavy layer (giotto-tda etc.), cached separately so a service-code edit doesn't re-resolve
# it. quant-core also supplies the asyncpg pin the Timescale writer uses.
COPY packages/quant-core ./packages/quant-core
RUN pip install --no-cache-dir ./packages/quant-core

COPY services/fundamentals-ingestion/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/fundamentals-ingestion/src ./src

# Port 8010 — distinct from strategy-engine (8000) and backtest-engine (8001); the chart's Service +
# probes target the same number.
EXPOSE 8010
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8010"]

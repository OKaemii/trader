FROM python:3.12-slim

WORKDIR /app

# Shared quant-core package first — one source of truth for the sci stack and the strategy
# code the replay validator imports; heavy layer (giotto-tda), cached separately. The [http]
# extra pulls httpx for YahooDailyBarsReader (the Phase-4 offline daily research source).
COPY packages/quant-core ./packages/quant-core
RUN pip install --no-cache-dir './packages/quant-core[http]'

COPY services/backtest-engine/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/backtest-engine/src ./src

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8001"]

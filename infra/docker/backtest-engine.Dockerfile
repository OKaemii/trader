FROM python:3.12-slim

WORKDIR /app

COPY services/backtest-engine/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/backtest-engine/src ./src

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8001"]

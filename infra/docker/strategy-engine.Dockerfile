FROM python:3.12-slim

# giotto-tda has heavy C++ deps — build layer is cached separately
WORKDIR /app

# Shared quant-core package first — one source of truth for the sci stack (numpy/scipy/
# sklearn/giotto-tda/cvxpy); heavy layer, cached separately.
COPY packages/quant-core ./packages/quant-core
RUN pip install --no-cache-dir ./packages/quant-core

COPY services/strategy-engine/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/strategy-engine/src ./src

EXPOSE 8000
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]

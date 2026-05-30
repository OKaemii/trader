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

# quant-core suite imports the installed package; backtest suite imports src.* (conftest puts
# /app on the path). PYTHONDONTWRITEBYTECODE keeps the layer clean. -p no:cacheprovider avoids a
# read-only-fs cache complaint. A non-zero exit here fails the build = the gate.
ENV PYTHONDONTWRITEBYTECODE=1
RUN python -m pytest quant_core_tests -q -p no:cacheprovider \
 && python -m pytest tests -q -p no:cacheprovider

CMD ["true"]

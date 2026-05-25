FROM python:3.12-slim

WORKDIR /app

COPY services/warehouse-snapshotter/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/warehouse-snapshotter/src ./src

# One-shot job — no long-running process, no port. CronJob spec runs `python
# -m src.snapshot` once per scheduled tick and exits.
ENTRYPOINT ["python", "-m", "src.snapshot"]

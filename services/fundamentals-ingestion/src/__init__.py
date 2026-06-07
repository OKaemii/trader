"""fundamentals-ingestion service package — the PIT Fundamentals Warehouse write-side.

Stage modules (each its own subpackage, populated by later epic tasks):
  security_master/ · download/ · raw_store/ · stage/ · normalize/ · qa/

They are kept side-effect-free so a future CronJob worker imports them directly rather than through
the FastAPI app in `main.py`.
"""

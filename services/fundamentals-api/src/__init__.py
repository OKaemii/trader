"""fundamentals-api — the read-side of the PIT Fundamentals Warehouse (epic Task 11).

Serves the point-in-time fundamentals the live seam (strategy-engine, epic Task 14) and the headline
`get_pit_fundamentals(symbols, as_of)` guarantee read off the bi-temporal `fundamentals` table that the
write-side service (fundamentals-ingestion, Tasks 4-9) lands. The look-ahead guard is in SQL, never in
app code: every as-of read filters `knowledge_ts <= as_of` in the query."""

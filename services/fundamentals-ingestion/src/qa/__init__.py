"""qa — sector-aware data-quality checks + quarantine (epic Task 8).

Runs identity checks (`Assets ≈ Liabilities + Equity` for the General template only; banks / insurers
/ REITs get their own), outlier detection (e.g. Revenue +5000%, Assets −99%), and missing-data
checks. Failures route to `fundamentals_quarantine` (not the canonical `fundamentals` table) and are
surfaced through an admin QA-report endpoint rather than silently dropped or silently accepted.
"""

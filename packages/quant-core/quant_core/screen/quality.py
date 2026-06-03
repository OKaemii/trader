"""QMJ (Quality-Minus-Junk) screen — the canonical quality gate shared by live + replay.

Mirrored by market-data-service's `qmj.ts` (the Scanner badge) — both reference these three
rules, documented by the constants. Fail-closed: a zero/missing denominator yields no ratios
(=> FAIL), so quality data we don't have is never a false PASS. Inputs are the raw line items
the host attaches via HistoryView.fundamentals (snake_case keys).
"""
from __future__ import annotations

from typing import Optional

ROE_MIN = 0.10   # Profitability: Return on Equity
DE_MAX = 2.0     # Solvency:      Debt / Equity
CR_MIN = 1.0     # Liquidity:     Current Ratio


def compute_ratios(f: dict[str, float]) -> Optional[dict[str, float]]:
    eq = f.get("total_equity", 0.0)
    cl = f.get("current_liabilities", 0.0)
    if eq <= 0 or cl <= 0:                       # fail-closed denominators
        return None
    return {
        "roe": f.get("net_income", 0.0) / eq,
        "debt_to_equity": f.get("total_debt", 0.0) / eq,
        "current_ratio": f.get("current_assets", 0.0) / cl,
    }


def quality_pass(f: dict[str, float]) -> bool:
    r = compute_ratios(f)
    return bool(r) and r["roe"] >= ROE_MIN and r["debt_to_equity"] <= DE_MAX and r["current_ratio"] >= CR_MIN

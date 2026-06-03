"""Load the current `company_fundamentals` snapshot (Mongo) as the point-in-time-APPROXIMATE
fundamentals for a high_velocity backtest. Yahoo has no as-of fundamentals, so the SAME current
snapshot is applied at every replay step — a documented look-ahead/survivorship approximation,
stamped in the report's data_quality. Best-effort: any miss → {} (the fail-closed QMJ screen then
emits nothing — an honest 'no fundamentals' backtest, never a fabricated one). Mapped to the
snake_case shape quant-core's quality.py expects.
"""
from __future__ import annotations

import os


async def load_fundamentals_snapshot(tickers: list[str]) -> dict[str, dict[str, float]]:
    if not tickers:
        return {}
    try:
        import motor.motor_asyncio
        url = os.getenv("MONGODB_URL", "mongodb://localhost:27017")
        client = motor.motor_asyncio.AsyncIOMotorClient(url, serverSelectionTimeoutMS=2000)
        db = client[os.getenv("MONGODB_DB", "trader")]
        docs = await db["company_fundamentals"].find({"_id": {"$in": list(tickers)}}).to_list(length=len(tickers))
    except Exception as exc:   # noqa: BLE001 — never break a backtest on a fundamentals miss
        print(f"[backtest] fundamentals snapshot load failed (continuing with none): {exc!r}", flush=True)
        return {}
    out: dict[str, dict[str, float]] = {}
    for d in docs:
        raw = d.get("raw") or {}
        out[str(d.get("_id"))] = {
            "market_cap_gbp":      float(d.get("marketCapGbp") or 0.0),
            "net_income":          float(raw.get("netIncome") or 0.0),
            "total_equity":        float(raw.get("totalEquity") or 0.0),
            "total_debt":          float(raw.get("totalDebt") or 0.0),
            "current_assets":      float(raw.get("currentAssets") or 0.0),
            "current_liabilities": float(raw.get("currentLiabilities") or 0.0),
        }
    return out

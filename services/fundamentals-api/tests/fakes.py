"""Test fakes + a synthetic-lake builder for the lake-backed read side (epic Task 10).

The resolver now reads the PIT-fundamentals **lake** (per-CIK Parquet, via the quant-core lake `Store`)
instead of the old Timescale hypertable, so the in-memory `FakeTimescale` is gone. Instead these helpers
build a SYNTHETIC lake on disk in the EXACT on-disk shape the harvester writes (the Task-3 `SCHEMA` for
facts + `ticker_history.parquet` + `entities.parquet`), reusing the shapes the quant-core lake tests
(`test_lake_contract.py` / `test_lake_store.py`) pin — so the resolver is exercised through the REAL read
engine (`store` + `metrics` + `contract`), no mock of the lake.

`FakeRedis` (the read-through cache double) and `FakeMarketDataReader` (the Gap-2 enrichment edge) are
carried over verbatim — they are lake-agnostic. duckdb + pyarrow are the `quant-core[lake]` extra; the
docker gate installs it, and these helpers `importorskip` both so the suite collects where they are
absent (the resolver tests that need a real lake skip there; the pure-cache/identity tests do not).
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

import pytest

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")
pytest.importorskip("duckdb")

from quant_core.fundamentals.lake.schema import SCHEMA  # noqa: E402

# The identity-table schemas the store reads by column name — same as the lake store/contract tests.
_TICKER_SCHEMA = pa.schema(
    [
        ("cik", pa.int32()),
        ("ticker", pa.string()),
        ("valid_from", pa.date32()),
        ("valid_to", pa.date32()),
    ]
)
_ENTITY_SCHEMA = pa.schema(
    [
        ("cik", pa.int32()),
        ("name", pa.string()),
        ("sic", pa.string()),
        ("sic_desc", pa.string()),
        ("exchanges", pa.string()),
        ("tickers", pa.string()),
        ("former_names", pa.string()),
    ]
)


def ms(y: int, mo: int, d: int, h: int = 14, mi: int = 30) -> int:
    """A UTC wall-clock instant as a UTC-ms epoch (the `knowledge_ts` / `as_of_ms` unit)."""
    return int(datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp() * 1000)


def fact(
    *,
    cik: int,
    concept: str,
    value: float,
    end: str,
    knowledge_ts: int,
    accession: str,
    start: Optional[str] = None,
    taxonomy: str = "us-gaap",
    unit: str = "USD",
    fy: int = 2023,
    fp: str = "FY",
    form: str = "10-K",
    filed: str = "2024-02-15",
) -> dict:
    """One fact row in the Task-3 SCHEMA shape (dates as `date`, ms axes as int)."""
    return {
        "cik": cik,
        "taxonomy": taxonomy,
        "concept": concept,
        "unit": unit,
        "start": date.fromisoformat(start) if start else None,
        "end": date.fromisoformat(end),
        "value": float(value),
        "fy": fy,
        "fp": fp,
        "form": form,
        "accession": accession,
        "filed": date.fromisoformat(filed),
        "accepted_ts": None,
        "knowledge_ts": knowledge_ts,
        "frame": None,
    }


def annual(cik: int, concept: str, fy: int, value: float, kts: int, *, taxonomy: str = "us-gaap",
           unit: str = "USD") -> dict:
    """A full-year duration fact (Jan 1 .. Dec 31 of `fy`) — `split_periods` classes it annual."""
    return fact(cik=cik, concept=concept, value=value, start=f"{fy}-01-01", end=f"{fy}-12-31",
                knowledge_ts=kts, accession=f"{concept[:4]}-{fy}", taxonomy=taxonomy, unit=unit,
                fy=fy, fp="FY", form="10-K", filed=f"{fy + 1}-02-15")


def instant(cik: int, concept: str, end: str, value: float, kts: int, *, taxonomy: str = "us-gaap",
            unit: str = "USD") -> dict:
    """A balance-sheet / cover-page instant fact (no `start`)."""
    return fact(cik=cik, concept=concept, value=value, start=None, end=end, knowledge_ts=kts,
                accession=f"{concept[:4]}-inst", taxonomy=taxonomy, unit=unit, form="10-K")


def write_facts(lake: Path, cik: int, rows: list[dict]) -> None:
    out = lake / "facts"
    out.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows, schema=SCHEMA),
                   out / f"cik={int(cik):010d}.parquet", compression="zstd")


def write_ticker_history(lake: Path, rows: list[dict]) -> None:
    pq.write_table(pa.Table.from_pylist(rows, schema=_TICKER_SCHEMA),
                   lake / "ticker_history.parquet", compression="zstd")


def write_entities(lake: Path, rows: list[dict]) -> None:
    pq.write_table(pa.Table.from_pylist(rows, schema=_ENTITY_SCHEMA),
                   lake / "entities.parquet", compression="zstd")


def full_name_facts(cik: int) -> list[dict]:
    """Every leg the contract assembles, for a fully-covered US name (mirrors the lake-contract test's
    `_full_name_facts`): 4 flows (FY2021..FY2023 net income so earnings_stability is defined) + 7
    instants at 2023-12-31. Resolves to 12 raw legs; the API adds market_cap_gbp + dividend_yield."""
    k = ms(2024, 2, 16)            # FY2023 10-K knowable
    k22, k21 = ms(2023, 2, 16), ms(2022, 2, 16)
    rows: list[dict] = []
    rows += [
        annual(cik, "NetIncomeLoss", 2021, 90.0, k21),
        annual(cik, "NetIncomeLoss", 2022, 100.0, k22),
        annual(cik, "NetIncomeLoss", 2023, 110.0, k),
    ]
    rows += [
        annual(cik, "Revenues", 2023, 1000.0, k),
        annual(cik, "GrossProfit", 2023, 400.0, k),
        annual(cik, "NetCashProvidedByUsedInOperatingActivities", 2023, 150.0, k),
    ]
    rows += [
        instant(cik, "StockholdersEquity", "2023-12-31", 500.0, k),
        instant(cik, "Assets", "2023-12-31", 1500.0, k),
        instant(cik, "Liabilities", "2023-12-31", 1000.0, k),
        instant(cik, "AssetsCurrent", "2023-12-31", 600.0, k),
        instant(cik, "LiabilitiesCurrent", "2023-12-31", 300.0, k),
        instant(cik, "LongTermDebt", "2023-12-31", 250.0, k),
        instant(cik, "EntityCommonStockSharesOutstanding", "2023-12-31", 50.0, k,
                taxonomy="dei", unit="shares"),
    ]
    return rows


def entity_row(cik: int, ticker: str, *, sic: str = "7372", sic_desc: str = "Software") -> dict:
    """One `entities.parquet` row (defaults to a software SIC → the `general` sector template)."""
    return {
        "cik": cik, "name": f"Co {cik}", "sic": sic, "sic_desc": sic_desc,
        "exchanges": json.dumps(["NYSE"]), "tickers": json.dumps([ticker]),
        "former_names": json.dumps([]),
    }


def ticker_row(cik: int, ticker: str, *, valid_from: date = date(2010, 1, 1),
               valid_to: Optional[date] = None) -> dict:
    """One `ticker_history.parquet` row (a bare symbol → CIK window)."""
    return {"cik": cik, "ticker": ticker, "valid_from": valid_from, "valid_to": valid_to}


class FakeRedis:
    """A trivial in-memory async Redis double: get / set(ex=) over a dict, plus hit counters so a test
    can assert the read-through cache short-circuited the lake."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.get_calls = 0
        self.set_calls = 0

    async def get(self, key: str) -> Optional[str]:
        self.get_calls += 1
        return self.store.get(key)

    async def set(self, key: str, value: str, ex: Optional[int] = None) -> None:
        self.set_calls += 1
        self.store[key] = value


class FakeMarketDataReader:
    """In-memory stand-in for `src.market_cap.MarketDataReader` — the Gap-2 enrichment edge — so the
    resolver's market-cap/dividend wiring is tested with NO HTTP and NO Redis. Seed the as-of adjusted
    close per (T212 ticker, asOf), the FX→GBP multiplier per currency, and the dividend yield per T212
    ticker; the resolver calls exactly these three methods (keyed on the T212 form).

    Carried over verbatim from the Timescale build (lake-agnostic). A ticker/asOf with no seeded close →
    None; a currency with no seeded rate → None; a ticker with no seeded yield is absent from the batch.
    """

    def __init__(self) -> None:
        self.closes: dict[tuple[str, Optional[int]], Optional[float]] = {}
        self.fx: dict[Optional[str], Optional[float]] = {"GBP": 1.0}
        self.dividend_yields: dict[str, float] = {}
        self.close_calls: list[tuple[str, Optional[int]]] = []
        self.batch_close_calls: list[tuple[tuple[str, ...], Optional[int]]] = []
        self.dividend_calls: list[tuple[tuple[str, ...], Optional[int]]] = []
        self.fx_calls: list[Optional[str]] = []

    def set_close(self, ticker: str, as_of_ms: Optional[int], close: Optional[float]) -> None:
        self.closes[(ticker, as_of_ms)] = close

    def set_fx(self, currency: Optional[str], rate: Optional[float]) -> None:
        self.fx[currency] = rate

    def set_dividend_yield(self, ticker: str, yield_: float) -> None:
        self.dividend_yields[ticker] = yield_

    async def adjusted_close_as_of(self, ticker: str, as_of_ms: Optional[int]) -> Optional[float]:
        self.close_calls.append((ticker, as_of_ms))
        return self.closes.get((ticker, as_of_ms))

    async def adjusted_closes_as_of(
        self, tickers: list[str], as_of_ms: Optional[int]
    ) -> dict[str, float]:
        self.batch_close_calls.append((tuple(tickers), as_of_ms))
        out: dict[str, float] = {}
        for t in tickers:
            c = self.closes.get((t, as_of_ms))
            if c is not None:
                out[t] = c
        return out

    async def fx_to_gbp(self, currency: Optional[str]) -> Optional[float]:
        self.fx_calls.append(currency)
        return self.fx.get(currency)

    async def dividend_yields_as_of(
        self, tickers: list[str], as_of_ms: Optional[int]
    ) -> dict[str, float]:
        self.dividend_calls.append((tuple(tickers), as_of_ms))
        return {t: self.dividend_yields[t] for t in tickers if t in self.dividend_yields}

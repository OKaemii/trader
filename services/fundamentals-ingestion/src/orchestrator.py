"""Ingestion orchestrator — the per-ticker pipeline that makes the US chain RUN end-to-end (epic Task 9).

This is the seam that WIRES the stage modules the earlier cards built (security master, EDGAR
downloader, raw store, metric registry, normalizer, QA engine) into one idempotent run. Earlier cards
delivered each stage as a side-effect-free library tested against fixtures; nothing called them in
sequence against the live sources. The cron/backfill Job runs THIS, which — per coverage ticker —

  1. RESOLVE CIK from the EDGAR bulk ticker map (`company_tickers.json`, fetched once per run): the
     bare US symbol → its zero-padded CIK + the SEC company title (the company name).
  2. FETCH submissions (SIC + filing lineage with the raw `accepted_ts`) and companyfacts (every
     us-gaap/dei fact the filer ever reported) — Task 5 clients, rate-limited + fail-soft.
  3. UPSERT company → instrument → ticker identifier (Task 4 writer); resolve the instrument_id.
  4. UPSERT each filing → build `lineage_by_accession` (accn → (filing_id, accepted_ts)) — the map the
     raw-zone writer needs so each fact lands under ITS filing's lineage (never one shared filing_id —
     a companyfacts payload spans every historical filing; mixing accessions would inject look-ahead).
  5. WRITE the raw zone via `RawFactsWriter.write_company_facts(facts, lineage_by_accession=…)` (Task 5):
     full preservation, hash-gated, idempotent.
  6. SELECT the sector template from the SIC (`normalize.sectors.template_for_sic`, Task 7) — bank /
     insurance / reit / utility / general — so a bank's revenue reads the right us-gaap tag.
  7. PER FILING (grouped by accession): STAGE the filing's facts (`stage.resolve_metrics(sector=…)`,
     Task 6) → BI-TEMPORAL WRITE (`FundamentalsWriter.write_filing(result, instrument_id=…,
     accepted_ts_ms=RAW accept, filing_id=…)`, Task 7; it derives knowledge_ts) → QA IN-LINE over the
     SAME StageResult + SAME sector AFTER the write (`QaEngine.qa_filing(result, instrument_id=…,
     sector=…, filing_id=…)`, Task 8; the outlier baseline reads earlier observations only, so running
     QA after the current write never self-compares).

IDEMPOTENT BY CONSTRUCTION (hash-gated; re-run = no-op). The security-master upserts are find-or-insert;
the raw zone is `ON CONFLICT DO NOTHING`; the canonical writer's content_hash gate makes an identical
re-ingest a clean no-op (no insert, no supersede, no log row). A second run over an unchanged filer
writes zero canonical rows. (Quarantine is an append review queue — a re-run MAY append duplicate
findings; Task 8 owns its lifecycle, and the canonical PIT surface is untouched by that churn.)

WHY PER-FILING. The canonical writer stamps ONE derived knowledge_ts (from the filing's accepted_ts)
on every fact in the StageResult it is handed — so the StageResult MUST be a single filing's facts. The
orchestrator therefore groups the CIK's raw facts by `accession_number`, stages each group with that
filing's lineage, and writes/QAs per filing. This also makes restatements work: a later 10-K/A re-reports
a period under a NEW accession → a later accepted_ts → a later knowledge_ts → the supersede path.

DEPENDENCY INVERSION. The orchestrator takes its clients + writers + a coverage→CIK resolver by
injection (the composition root, `ingest.py`, builds the real ones from env). The unit gate drives it
with the in-memory `FakeTimescale` + fixture clients, so the WHOLE wiring is proven deterministically
with no network and no DB — the live EDGAR backfill is the operator step (a real EDGAR_USER_AGENT +
external egress), not the gate.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

from src.download.edgar import EdgarFactsClient, RawFact
from src.normalize.sectors import TEMPLATE_GENERAL, template_for_sic
from src.normalize.writer import SOURCE_PIT_EDGAR, FundamentalsWriter
from src.qa.engine import QaEngine
from src.raw_store.writer import FilingLineage, RawFactsWriter
from src.security_master.edgar_submissions import (
    CompanySubmissions,
    EdgarSubmissionsClient,
    TickerMapEntry,
)
from src.security_master.openfigi import OpenFigiClient
from src.security_master.ticker_aliases import TickerAlias, resolve_alias
from src.security_master.writers import (
    SOURCE_SEC_EDGAR,
    CompanyRecord,
    FilingRecord,
    IdentifierRecord,
    ID_TICKER,
    InstrumentRecord,
    SecurityMasterWriter,
    country_for_ticker,
)
from src.stage.resolver import resolve_metrics

log = logging.getLogger("fundamentals-ingestion.orchestrator")

# T212 suffix for a US equity — the orchestrator reconstructs the tradeable join key from the bare
# coverage symbol so `instruments.t212_ticker` carries the symbol the live universe speaks. (Coverage
# already restricted the set to US names; UK is the gated later phase.)
_US_EQ_SUFFIX = "_US_EQ"


@dataclass(frozen=True)
class TickerResult:
    """The outcome of ingesting ONE coverage ticker (per-name roll-up of the per-filing stats)."""

    ticker: str
    cik: Optional[str] = None
    instrument_id: Optional[int] = None
    sector: str = TEMPLATE_GENERAL
    filings_seen: int = 0           # filings with at least one staged fact
    raw_written: int = 0            # newly-written raw_facts rows
    canonical_inserted: int = 0     # new canonical rows (first-prints + revisions)
    canonical_revisions: int = 0    # subset of inserted that superseded a prior current row
    canonical_skipped: int = 0      # idempotent no-ops (hash matched)
    quarantined: int = 0            # quarantine rows appended (writer conflicts + QA findings)
    skipped_reason: Optional[str] = None   # set when the ticker produced no write (why)


@dataclass
class IngestSummary:
    """The whole-run roll-up the cron logs + the trigger response surfaces."""

    requested: int = 0
    ingested: int = 0               # tickers that resolved a CIK and ran the pipeline
    skipped: int = 0                # tickers with no CIK / no facts
    raw_written: int = 0
    canonical_inserted: int = 0
    canonical_revisions: int = 0
    canonical_skipped: int = 0
    quarantined: int = 0
    results: list[TickerResult] = field(default_factory=list)

    def add(self, r: TickerResult) -> None:
        self.results.append(r)
        if r.skipped_reason is not None and r.cik is None:
            self.skipped += 1
        else:
            self.ingested += 1
        self.raw_written += r.raw_written
        self.canonical_inserted += r.canonical_inserted
        self.canonical_revisions += r.canonical_revisions
        self.canonical_skipped += r.canonical_skipped
        self.quarantined += r.quarantined


def build_ticker_cik_map(entries: list[TickerMapEntry]) -> dict[str, str]:
    """Bare uppercase US symbol → zero-padded CIK, from the EDGAR `company_tickers.json` map.

    A symbol carried by several CIKs (rare; a recycled ticker) keeps the FIRST seen — `company_tickers`
    lists each filer's CURRENT ticker, so a live duplicate is an edge SEC itself rarely emits; the
    orchestrator logs it and proceeds (the security master's effective-dated identifiers carry the real
    rename history once both filers are ingested)."""
    out: dict[str, str] = {}
    for e in entries:
        sym = e.ticker.strip().upper()
        if not sym:
            continue
        if sym in out and out[sym] != e.cik:
            log.warning("[orchestrator] ticker %s maps to multiple CIKs (%s, %s); keeping the first",
                        sym, out[sym], e.cik)
            continue
        out.setdefault(sym, e.cik)
    return out


def _exchange_currency(exchanges: tuple[str, ...]) -> tuple[Optional[str], Optional[str]]:
    """Best-effort (exchange, currency) for a US filer from its submissions `exchanges` array.

    US common stock trades in USD; we record the first listed exchange (NYSE/Nasdaq) and USD as the
    instrument currency. A missing exchange leaves it None (never a guess) — the instrument still
    upserts; the fact tables key on instrument_id, not exchange/currency."""
    exch = exchanges[0] if exchanges else None
    return exch, "USD"


def _group_facts_by_accession(facts: list[RawFact]) -> dict[str, list[RawFact]]:
    """Group a CIK's raw facts by their own `accession_number`. A fact with no accession is dropped
    from the per-filing staging (it has no filing lineage to write under) — it is still preserved in
    the raw zone via `write_company_facts`'s own per-accession skip; staging needs a filing to stamp."""
    by_accn: dict[str, list[RawFact]] = defaultdict(list)
    for f in facts:
        if f.accession_number:
            by_accn[f.accession_number].append(f)
    return by_accn


class IngestionOrchestrator:
    """Runs the full US ingestion pipeline per coverage ticker. All collaborators are injected so the
    pipeline is exercised with fakes in the gate; the composition root (`ingest.py`) builds the real
    ones from env."""

    def __init__(
        self,
        *,
        submissions_client: EdgarSubmissionsClient,
        facts_client: EdgarFactsClient,
        secmaster: SecurityMasterWriter,
        raw_writer: RawFactsWriter,
        fundamentals_writer: FundamentalsWriter,
        qa_engine: QaEngine,
        openfigi_client: Optional[OpenFigiClient] = None,
        source: str = SOURCE_PIT_EDGAR,
    ) -> None:
        self._submissions = submissions_client
        self._facts = facts_client
        self._secmaster = secmaster
        self._raw = raw_writer
        self._fundamentals = fundamentals_writer
        self._qa = qa_engine
        # OPTIONAL OpenFIGI fallback (sub-step 4). Used only to IDENTIFY a symbol the SEC map + alias
        # table both miss — a brand-new filer can post-date even a daily SEC snapshot. OpenFIGI returns
        # a FIGI, NOT a CIK, so it cannot itself complete the no_cik resolution (we never fabricate a
        # CIK); the seam logs the FIGI it found so an operator can add an alias entry, and records the
        # FIGI on the resolved instrument when the name otherwise resolves. None ⇒ the fallback is off.
        self._openfigi = openfigi_client
        self._source = source
        self._ticker_cik: dict[str, str] = {}

    async def prime_ticker_map(self) -> int:
        """Fetch the EDGAR bulk ticker map once per run (symbol→CIK). Returns the map size. A failed
        fetch (fail-soft → empty) leaves the map empty; every ticker then skips with `no_cik` and the
        next run retries — the run never throws."""
        entries = await self._submissions.fetch_company_tickers()
        self._ticker_cik = build_ticker_cik_map(entries)
        log.info("[orchestrator] primed EDGAR ticker map: %d symbols", len(self._ticker_cik))
        return len(self._ticker_cik)

    async def _resolve_cik(self, sym: str) -> tuple[Optional[str], Optional[TickerAlias]]:
        """Resolve a bare US symbol → (CIK, bridging alias). The CIK is the stable, rename-invariant key.

        Resolution order, each step honest (a miss never fabricates a CIK):
          1. The SEC bulk `company_tickers.json` map (the common path — every filer's CURRENT symbol).
          2. The curated `TICKER_ALIASES` table — bridges a symbol the SEC snapshot misses because of a
             rename (FB after the Meta rebrand) or because the name is too new for the snapshot. On a hit
             the alias is returned alongside its CIK so `_upsert_entity` can record the rename interval.
          3. The optional OpenFIGI fallback — IDENTIFIES a still-unresolved symbol but returns a FIGI, not
             a CIK, so it cannot complete the resolution: it logs the FIGI it found (an operator then adds
             an alias entry) and the symbol still skips `no_cik`. This keeps the seam real and exercised
             without ever inventing a CIK.

        Returns `(None, None)` when nothing resolves (the caller skips `no_cik`)."""
        cik = self._ticker_cik.get(sym)
        if cik is not None:
            return cik, None

        alias = resolve_alias(sym)
        if alias is not None:
            log.info("[orchestrator] %s missing from SEC ticker map — bridged via alias to CIK %s (%s)",
                     sym, alias.cik, alias.note)
            return alias.cik, alias

        # Last resort: a brand-new filer can post-date even a daily SEC snapshot. OpenFIGI can confirm the
        # security exists (a FIGI), but it carries no CIK — so we cannot resolve from it (no fabrication).
        # Surface the FIGI so an operator can add a curated alias entry; the symbol still skips no_cik.
        await self._identify_via_openfigi(sym)
        return None, None

    async def _identify_via_openfigi(self, sym: str) -> Optional[str]:
        """Best-effort OpenFIGI identification of a symbol the SEC map + alias table both miss.

        Returns the composite FIGI when OpenFIGI resolves the name (logged so an operator can add an
        alias), else None. Fail-soft + a no-op when no OpenFIGI client is injected — the FIGI is an
        identity hint, NOT a CIK, so this never resolves the ingest by itself."""
        if self._openfigi is None:
            return None
        try:
            mapping = await self._openfigi.map_ticker(sym)
        except Exception as exc:  # noqa: BLE001 — the fallback is best-effort; never abort the ticker
            log.warning("[orchestrator] OpenFIGI lookup for %s failed: %s", sym, exc)
            return None
        if mapping is None:
            return None
        figi = mapping.composite_figi or mapping.figi  # composite is rename-stable; specific listing else
        if figi is not None:
            log.info("[orchestrator] %s unresolved by SEC map + alias table; OpenFIGI identifies FIGI %s "
                     "(%s) — add a curated TICKER_ALIASES entry to bridge it to a CIK",
                     sym, figi, mapping.name or "?")
        return figi

    async def run(self, symbols: list[str]) -> IngestSummary:
        """Ingest a coverage set (bare US symbols). Primes the ticker map, then runs the per-ticker
        pipeline for each, accumulating an `IngestSummary`. One ticker's failure is isolated (logged,
        counted as skipped) — a bad filer never aborts the batch."""
        if not self._ticker_cik:
            await self.prime_ticker_map()
        summary = IngestSummary(requested=len(symbols))
        # One name at a time (memory hardening §C4): the loop fetches + ingests a single CIK's
        # companyfacts per iteration, never accumulating payloads across the backfill. `ingest_ticker`
        # drops its own facts before returning; `result` here is only a small `TickerResult` (counts +
        # ids), and dropping it each iteration keeps the per-name boundary explicit — so a deep
        # curated-US walk holds one payload resident, bounding the 768Mi backfill-Job pod.
        for symbol in symbols:
            try:
                result = await self.ingest_ticker(symbol)
            except Exception as exc:  # noqa: BLE001 — isolate one bad filer; the batch continues
                log.exception("[orchestrator] ticker %s failed: %s", symbol, exc)
                result = TickerResult(ticker=symbol, skipped_reason=f"error:{type(exc).__name__}")
            summary.add(result)
            del result
        log.info(
            "[orchestrator] run complete: requested=%d ingested=%d skipped=%d raw=%d "
            "canonical_inserted=%d revisions=%d quarantined=%d",
            summary.requested, summary.ingested, summary.skipped, summary.raw_written,
            summary.canonical_inserted, summary.canonical_revisions, summary.quarantined,
        )
        return summary

    async def ingest_ticker(self, symbol: str) -> TickerResult:
        """The per-ticker pipeline (steps 1–7 of the module docstring). Returns a `TickerResult`.

        A ticker with no CIK in the map, or no submissions, or no facts is SKIPPED (with a reason) — the
        skip is honest (we never fabricate an entity/fact), and the run continues."""
        sym = symbol.strip().upper()
        cik, alias = await self._resolve_cik(sym)
        if cik is None:
            return TickerResult(ticker=sym, skipped_reason="no_cik")

        submissions = await self._submissions.fetch_submissions(cik)
        if submissions is None:
            return TickerResult(ticker=sym, cik=cik, skipped_reason="no_submissions")

        # SIC → sector template (general/bank/insurance/reit/utility — the SIC→QA routing bucket, NOT a
        # GICS sector). Computed BEFORE the entity upsert so `companies.sector` is populated on the
        # find-or-insert, and reused as the staging candidate-tag override below (step 6 — same value).
        sector = template_for_sic(submissions.sic)

        facts = await self._facts.fetch_company_facts(cik)
        if not facts:
            # No facts to write, but we still want the entity in the security master (it resolves
            # to an instrument for a later run / the read API). Upsert it, then skip the fact write.
            instrument_id = await self._upsert_entity(sym, submissions, sector=sector, alias=alias)
            return TickerResult(
                ticker=sym, cik=cik, instrument_id=instrument_id,
                sector=sector, skipped_reason="no_facts",
            )

        # Steps 3: company → instrument → ticker identifier → instrument_id.
        instrument_id = await self._upsert_entity(sym, submissions, sector=sector, alias=alias)

        # Step 4: upsert filings → lineage_by_accession (accn → (filing_id, accepted_ts)).
        lineage = await self._upsert_filings(submissions, instrument_id=instrument_id)

        # Step 5: raw zone (full preservation, hash-gated, per-accession lineage).
        raw_written = await self._raw.write_company_facts(facts, lineage_by_accession=lineage)

        # Step 6: the SIC→sector template (computed above) drives the staging candidate-tag overrides.

        # Step 7: per filing — stage → write → QA in-line.
        canon_inserted = canon_revisions = canon_skipped = quarantined = filings_with_facts = 0
        by_accn = _group_facts_by_accession(facts)
        # Memory hardening (plan §C4): a heavy filer's companyfacts is a large in-RAM list, and on the
        # 768Mi backfill-Job pod a deep curated-US walk must hold ONE payload at a time, not accumulate.
        # `by_accn` now owns every RawFact (grouped by accession), so the flat `facts` list is dead from
        # here — drop it so the redundant container can't keep the peak doubled through the per-filing
        # loop below. The decoded JSON itself was already freed inside `fetch_company_facts` (a local
        # there); this drops the last app-RAM hold on the parsed facts that the loop doesn't read.
        del facts
        for accn, accn_facts in by_accn.items():
            filing_lineage = lineage.get(accn)
            if filing_lineage is None:
                continue  # no filing_id / accepted_ts for this accession → can't stamp; skip (honest)
            filing_id, accepted_ts = filing_lineage

            staged = resolve_metrics(accn_facts, cik=cik, sector=sector)
            if not staged.facts and not staged.conflicts:
                continue  # this filing carried no canonical-metric facts (e.g. a non-financial form)
            filings_with_facts += 1

            write_stats = await self._fundamentals.write_filing(
                staged, instrument_id=instrument_id, accepted_ts_ms=accepted_ts,
                filing_id=filing_id, source=self._source,
            )
            canon_inserted += write_stats.inserted
            canon_revisions += write_stats.revisions
            canon_skipped += write_stats.skipped
            quarantined += write_stats.quarantined

            # QA IN-LINE, AFTER the write, over the SAME StageResult + SAME sector (Task 8 note). The
            # outlier baseline reads observations strictly EARLIER than this filing's periods, so the
            # just-written current rows are never self-compared.
            qa_stats = await self._qa.qa_filing(
                staged, instrument_id=instrument_id, sector=sector, filing_id=filing_id,
            )
            quarantined += qa_stats.quarantined

        # The grouped facts are fully consumed — drop the last app-RAM reference to this name's payload
        # so it is reclaimable before the caller's loop moves to the next name (memory hardening §C4: the
        # returned `TickerResult` carries only counts/ids, never the facts, so no payload survives here).
        del by_accn
        return TickerResult(
            ticker=sym, cik=cik, instrument_id=instrument_id, sector=sector,
            filings_seen=filings_with_facts, raw_written=raw_written,
            canonical_inserted=canon_inserted, canonical_revisions=canon_revisions,
            canonical_skipped=canon_skipped, quarantined=quarantined,
        )

    async def _upsert_entity(
        self, symbol: str, submissions: CompanySubmissions, *, sector: str,
        alias: Optional[TickerAlias] = None,
    ) -> int:
        """Upsert the company + instrument + ticker identifier(s); return the instrument_id.

        Idempotent (find-or-insert by CIK / by (company, t212_ticker) / by exact identifier interval).
        The `t212_ticker` is the reconstructed `<SYMBOL>_US_EQ` join key the live universe speaks.

        TICKER IDENTITY — two cases, both append-only (never an UPDATE), both idempotent:
          * No rename (`alias` is None, or an alias with no `renamed_from` — a legacy/origin or new
            IPO/ADR symbol): the current display ticker is appended as a single open-ended `ticker`
            interval. `effective_from` 0 (epoch) is the safe lower bound for a backfill that only knows
            "this is the ticker now"; a successor appended later closes it on read.
          * A recorded rename (`alias.renamed_from` set — the current side of a rename, e.g. ingesting
            META with the SEC map missing the legacy FB): record the rename as TWO effective-dated rows
            via `record_ticker_change` — the PRIOR symbol (`FB`) closed at `since_ms`, the CURRENT symbol
            (`META`) open from it — so the rename year is recorded in the identifier history. No
            `fundamentals` fact is rewritten; this is purely a resolution concern (`since_ms` is the
            rename instant the as-of interval resolver keys off).

        `sector` is the SIC→QA template (`template_for_sic` — general/bank/insurance/reit/utility, a
        coarse routing bucket, NOT a GICS sector), recorded on `companies.sector` so the quarantine
        `by_sector` JOIN buckets a filer's findings rather than reading `(unknown)`. Unlike the
        append-only identifiers this is a MUTABLE classification: `upsert_company` writes it on insert
        and backfills it on the find-or-insert FOUND path (so the ~21 pre-existing rows gain a sector)."""
        company_id = await self._secmaster.upsert_company(
            CompanyRecord(
                name=submissions.name or symbol,
                country=country_for_ticker(f"{symbol}{_US_EQ_SUFFIX}"),
                sector=sector,
                cik=submissions.cik,
            )
        )
        exchange, currency = _exchange_currency(submissions.exchanges)
        instrument_id = await self._secmaster.upsert_instrument(
            InstrumentRecord(
                company_id=company_id,
                instrument_type="common",
                exchange=exchange,
                currency=currency,
                t212_ticker=f"{symbol}{_US_EQ_SUFFIX}",
            )
        )
        if alias is not None and alias.renamed_from:
            # A recorded rename: append the prior symbol's interval (closed at the rename instant) and the
            # current symbol's interval (open from it). Append-only + idempotent (re-running the same
            # rename is a no-op via the exact-interval guard in `append_identifier`).
            await self._secmaster.record_ticker_change(
                instrument_id,
                old_ticker=alias.renamed_from,
                new_ticker=symbol,
                changed_at_ms=alias.since_ms,
            )
        else:
            # No rename to record: the current display ticker (the SEC symbol) as an open-ended interval.
            await self._secmaster.append_identifier(
                IdentifierRecord(
                    instrument_id=instrument_id,
                    identifier_type=ID_TICKER,
                    identifier_value=symbol,
                    effective_from=0,
                    effective_to=None,
                )
            )
        return instrument_id

    async def _upsert_filings(
        self, submissions: CompanySubmissions, *, instrument_id: int
    ) -> dict[str, FilingLineage]:
        """Upsert every filing in the submissions → `lineage_by_accession` (accn → (filing_id,
        accepted_ts)). A filing with no `accepted_ts` (SEC omitted it) is EXCLUDED from the map — its
        facts then skip the raw + canonical write rather than landing under a fabricated knowledge_ts
        (the bi-temporal contract; the raw-zone writer's own skip mirrors this). Idempotent via the
        filings table's `UNIQUE (source, accession_number)`."""
        lineage: dict[str, FilingLineage] = {}
        for filing in submissions.filings:
            if not filing.accession_number:
                continue
            filing_id = await self._secmaster.upsert_filing(
                FilingRecord(
                    instrument_id=instrument_id,
                    accession_number=filing.accession_number,
                    form_type=filing.form,
                    source=SOURCE_SEC_EDGAR,
                    filed_ts=filing.filed_ts,
                    accepted_ts=filing.accepted_ts,
                    is_amendment=filing.is_amendment,
                )
            )
            # No filing_id (a write failure) OR no accepted_ts ⇒ no honest lineage to stamp → skip.
            if filing_id is None or filing.accepted_ts is None:
                continue
            lineage[filing.accession_number] = (filing_id, filing.accepted_ts)
        return lineage

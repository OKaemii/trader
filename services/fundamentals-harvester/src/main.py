"""fundamentals-harvester — the PIT lake write path.

Bootstrap once, then run forever:

  bootstrap   WATCHLIST set   -> fetch companyfacts per ticker (minutes)
              WATCHLIST unset -> SEC nightly bulk zip, the whole universe (~1.3 GB)
  every N min sweep           -> parse today's EDGAR daily form index, refresh only the CIKs that
                                 actually filed, snapshot tickers

The only contract with the read service is the lake on shared storage:

  <lake>/facts/cik=##########.parquet   PIT facts (one file per CIK, atomic replace)
  <lake>/events/cik=##########.parquet  PIT earnings-event dates (8-K Item 2.02, one file per CIK)
  <lake>/ticker_history.parquet         bare symbol -> CIK with validity ranges
  <lake>/entities.parquet               names, SIC, former names
  <lake>/bootstrap_complete.json        SENTINEL — written ONLY after a full bulk pass finishes

The earnings-EVENT store (Pipeline A) is filled by the sweep, not the bulk bootstrap: the bulk zip is
companyfacts (XBRL) only — it carries no 8-K item codes — so the announcement dates accrue from each
sweep's `/submissions` fetch (which DOES carry the items), exactly as the precise per-accession
`knowledge_ts` refinement does.

The schema + the next-session `knowledge_ts` derivation come from quant-core
(`quant_core.fundamentals.lake.{schema,calendar}`), shared with the read engine so writer and reader
cannot drift. The 30-min sweep carries each filing's exact `acceptanceDateTime` (from `/submissions`)
→ a precise `knowledge_ts`; the bulk bootstrap has no acceptance time → the look-ahead-safe
`filed`-date fallback, refined by a later sweep.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx

from edgar import Edgar
from events import write_earnings_events
from identity import seed_ticker_history, snapshot_tickers, upsert_entities
from normalize import parse_acceptance_ms, write_company_facts

LAKE = Path(os.environ.get("LAKE_DIR", "/data"))
SEEDS = Path(os.environ.get("SEEDS_FILE", "/app/seeds/ticker_history.csv"))
WATCHLIST = [t.strip().upper() for t in os.environ.get("WATCHLIST", "").split(",") if t.strip()]
SWEEP_MINUTES = int(os.environ.get("SWEEP_MINUTES", "30"))

# Forms whose XBRL feeds the companyfacts API (plus amendments).
FORMS = {"10-K", "10-Q", "10-K/A", "10-Q/A", "20-F", "20-F/A", "40-F", "6-K"}

# The bootstrap-completion sentinel. The prototype skipped bootstrap when ANY facts/*.parquet existed
# — but a crash mid-bulk-load (one file written, 14,999 missing) would then be mistaken for "done",
# leaving permanent gaps. Instead the FULL bulk pass (and the watchlist pass) writes this marker as
# its very last act; `main` bootstraps unless it exists, so a partial/crashed bootstrap re-runs
# (crash-safe resume). BOTH modes write it so a healthy bootstrap is not re-run on every pod restart;
# it marks "the configured bootstrap completed", NOT "the lake covers the whole universe" — under a
# WATCHLIST it means only the watchlist names were harvested (expanding WATCHLIST after the first run
# does not re-bootstrap the added names; production uses full-universe, where the sweep then keeps
# every filed CIK fresh).
SENTINEL = "bootstrap_complete.json"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("harvester")


# --------------------------------------------------------------------------- #
# /submissions -> accession acceptance map                                    #
# --------------------------------------------------------------------------- #
def acceptance_map(subs: dict) -> dict[str, int]:
    """Build `accession_number -> acceptance UTC ms` from a `/submissions` doc.

    `filings.recent` carries parallel arrays (`accessionNumber`, `acceptanceDateTime`) for the most
    recent filings — which is exactly the set a sweep refreshes (a name that just filed). Older
    filings live in additional paged JSON files (`filings.files`); those are NOT fetched here (the
    sweep targets fresh filings, and a deeper backfill of acceptance times for decades-old accessions
    is not worth N extra requests per CIK). A fact whose accession is absent from this map falls back
    to the `filed`-date `knowledge_ts` — look-ahead-safe, just coarser by ≤1 session.
    """
    filings = (subs.get("filings") or {}).get("recent") or {}
    accns = filings.get("accessionNumber") or []
    accepted = filings.get("acceptanceDateTime") or []
    out: dict[str, int] = {}
    for accn, raw in zip(accns, accepted):
        ms = parse_acceptance_ms(raw)
        if accn and ms is not None:
            out[accn] = ms
    return out


# --------------------------------------------------------------------------- #
# Per-entity refresh                                                          #
# --------------------------------------------------------------------------- #
async def refresh_cik(edgar: Edgar, cik: int) -> dict | None:
    """Re-pull one entity with its EXACT acceptance times. Returns its submissions doc (for the
    entity upsert), or None for a filer with no XBRL facts (funds etc.).

    Fetches `/submissions` FIRST so its `accession -> acceptanceDateTime` map is available when
    `write_company_facts` derives `knowledge_ts` — the sweep path's whole purpose is the precise
    next-session availability, so the map must be built before (not after) the write.

    The SAME `/submissions` doc is the Pipeline A earnings-event source: its `filings.recent` carries
    the item codes (the daily form index does not), so the Item-2.02 8-K announcement dates are
    extracted from it here — no extra EDGAR request, the same fetch the facts write already needs.
    """
    try:
        cf = await edgar.companyfacts(cik)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:  # filer with no XBRL facts (funds etc.)
            return None
        raise
    subs = await edgar.submissions(cik)
    n = write_company_facts(LAKE, cf, acceptance_map(subs))
    # Pipeline A: persist this CIK's historical earnings-announcement (8-K Item 2.02) dates from the
    # submissions doc already in hand. Returns 0 (no file written) for a CIK with no recent earnings 8-K
    # — the common steady state; never an error.
    events = write_earnings_events(LAKE, subs)
    log.info("refreshed cik=%s (%s) facts=%d earnings_events=%d", cik, subs.get("name"), n, events)
    return subs


# --------------------------------------------------------------------------- #
# Bootstrap                                                                   #
# --------------------------------------------------------------------------- #
def _sentinel_path() -> Path:
    return LAKE / SENTINEL


def _write_sentinel(entities: int) -> None:
    """Mark a full bulk bootstrap as complete — written ONLY after the whole zip is normalized."""
    _sentinel_path().write_text(
        json.dumps(
            {
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "entities": entities,
                "mode": "watchlist" if WATCHLIST else "full",
            }
        )
    )


async def bootstrap(edgar: Edgar) -> None:
    log.info("bootstrap: starting (watchlist=%s)", WATCHLIST or "FULL UNIVERSE")
    if SEEDS.exists():
        added = seed_ticker_history(LAKE, SEEDS)
        log.info("bootstrap: seeded %d historical ticker rows", added)
    tickers = await edgar.company_tickers()
    snapshot_tickers(LAKE, tickers)

    if WATCHLIST:
        by_ticker = {v["ticker"].upper(): int(v["cik_str"]) for v in tickers.values()}
        subs = []
        for t in WATCHLIST:
            cik = by_ticker.get(t)
            if cik is None:
                log.warning(
                    "bootstrap: %s not found in EDGAR ticker map "
                    "(private companies like SpaceX do not file)",
                    t,
                )
                continue
            doc = await refresh_cik(edgar, cik)
            if doc:
                subs.append(doc)
        upsert_entities(LAKE, subs)
        _write_sentinel(len(subs))
        log.info("bootstrap: watchlist done — %d entities, sentinel written", len(subs))
        return

    # Full universe via the nightly bulk archive — one download, ~1.3 GB. No per-accession acceptance
    # time is available here (15k /submissions calls would defeat the bulk download), so every fact
    # gets the look-ahead-safe `filed`-date `knowledge_ts` fallback; a later sweep refines each CIK.
    bulk = LAKE / "bulk" / "companyfacts.zip"
    if not bulk.exists():
        log.info("bootstrap: downloading %s", Edgar.BULK_COMPANYFACTS)
        await edgar.download(Edgar.BULK_COMPANYFACTS, bulk)
    written = 0
    skipped = 0
    with zipfile.ZipFile(bulk) as z:
        names = z.namelist()
        for i, name in enumerate(names, 1):
            try:
                cf = json.loads(z.read(name))
            except json.JSONDecodeError:
                continue
            if cf.get("facts"):
                # Guard EACH entity: a single malformed companyfacts (an unexpected shape the
                # per-fact fail-closed filter doesn't anticipate) must NOT abort the whole bulk pass
                # before the sentinel is written — that would leave no sentinel, re-bootstrap on
                # restart against the cached zip, and crash at the same entity forever (the exact
                # permanent-gap crash-loop the sentinel exists to prevent). Log and move on, like the
                # sweep path's per-CIK guard.
                try:
                    write_company_facts(LAKE, cf)  # accepted_by_accession=None -> filed fallback
                    written += 1
                except Exception:
                    skipped += 1
                    log.exception("bootstrap: entity %s failed to normalize, skipping", name)
            if i % 1000 == 0:
                log.info("bootstrap: %d/%d entities normalized (%d skipped)", i, len(names), skipped)
    _write_sentinel(written)
    log.info(
        "bootstrap: done — %d entities normalized (%d skipped), sentinel written; "
        "entity metadata fills in via sweeps",
        written,
        skipped,
    )


# --------------------------------------------------------------------------- #
# Incremental sweeps                                                          #
# --------------------------------------------------------------------------- #
_CIK_IN_PATH = re.compile(r"edgar/data/(\d+)/")


def ciks_from_form_index(text: str) -> set[int]:
    """Parse a daily form.idx into the set of CIKs that filed an XBRL-bearing form.

    The filing path (`edgar/data/{cik}/...`) is the only column immune to whitespace quirks in
    company names, so the CIK is extracted from it; the leading column is the form type, which gates
    on `FORMS`. Lines without a recognized form or without a filing path are ignored (header lines,
    the `---` separator, blank lines).
    """
    out: set[int] = set()
    for line in text.splitlines():
        form = re.split(r"\s{2,}", line.strip(), maxsplit=1)[0]
        if form in FORMS:
            m = _CIK_IN_PATH.search(line)
            if m:
                out.add(int(m.group(1)))
    return out


def _state_path() -> Path:
    return LAKE / "harvester_state.json"


def _load_done() -> dict[str, list[int]]:
    p = _state_path()
    return json.loads(p.read_text()) if p.exists() else {}


def _save_done(done: dict[str, list[int]]) -> None:
    keep = sorted(done)[-3:]  # only the last few days matter
    _state_path().write_text(json.dumps({k: done[k] for k in keep}))


async def sweep(edgar: Edgar) -> None:
    tickers = await edgar.company_tickers()
    snapshot_tickers(LAKE, tickers)

    done = _load_done()
    todo: set[int] = set()
    for d in (date.today(), date.today() - timedelta(days=1)):
        try:
            ciks = ciks_from_form_index(await edgar.daily_form_index(d))
        except httpx.HTTPStatusError:
            continue  # weekend / holiday / index not yet published
        todo |= ciks - set(done.get(d.isoformat(), []))

    if WATCHLIST:  # storage-light mode: only refresh names we track
        watch_ciks = {
            int(v["cik_str"]) for v in tickers.values() if v["ticker"].upper() in WATCHLIST
        }
        todo &= watch_ciks

    if not todo:
        log.info("sweep: nothing new")
        return

    log.info("sweep: %d entities filed — refreshing", len(todo))
    subs = []
    for cik in sorted(todo):
        try:
            doc = await refresh_cik(edgar, cik)
            if doc:
                subs.append(doc)
            done.setdefault(date.today().isoformat(), []).append(cik)
        except Exception:
            log.exception("sweep: cik=%s failed, will retry next sweep", cik)
    if subs:
        upsert_entities(LAKE, subs)
    _save_done(done)


async def main() -> None:
    LAKE.mkdir(parents=True, exist_ok=True)
    edgar = Edgar()
    # Bootstrap unless the completion sentinel exists — a partial (crashed) bootstrap left no
    # sentinel, so it re-runs. NOT keyed on "any facts/*.parquet exists" (a single written file would
    # falsely look done).
    if not _sentinel_path().exists():
        await bootstrap(edgar)
    while True:
        try:
            await sweep(edgar)
        except Exception:
            log.exception("sweep failed")
        await asyncio.sleep(SWEEP_MINUTES * 60)


if __name__ == "__main__":
    asyncio.run(main())

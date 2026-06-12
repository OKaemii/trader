"""Harvester status + config + run-history — the data behind the portal's harvester Operations panel.

The harvester is a pure EDGAR→lake write service with NO database. Everything the portal needs to render
"is the lake bootstrapped, how big is it, when did it last sweep, what is it configured to do" is read
off the lake's own on-disk state — the SAME files the write path produces (`src/main.py`,
`src/identity.py`):

  * `<lake>/bootstrap_complete.json`  SENTINEL — `{completed_at, entities, mode}`, written ONLY after a
                                      full bootstrap pass. Its presence == bootstrap complete. It marks
                                      "the configured bootstrap finished", NOT "the lake covers the whole
                                      universe" (under a WATCHLIST only those names were harvested).
  * `<lake>/harvester_state.json`     SWEEP LEDGER — `{date_iso: [cik, ...]}` for the last few days (the
                                      sweep's `_save_done` keeps the last 3). Drives `last_sweep_*` and the
                                      `/runs` history. Absent until the first sweep refreshes a filed CIK.
  * `<lake>/facts/cik=*.parquet`      one file per covered CIK — the covered-CIK count is just the file
                                      count (no parse needed for the headline number).
  * `<lake>/{ticker_history,entities}.parquet`  the identity files — their presence + size round out the
                                      lake-size view.

PURE by construction: every function takes the lake `Path` (and reads `os.environ` for `config`), so the
FastAPI layer (`app.py`) is a thin shell and the assembly unit-tests against a tmp fixture lake with no
network and no EDGAR client. A cold lake (nothing harvested yet) yields `bootstrap_complete=False`, a
zero covered count, and `last_sweep=None` — the correct pre-bootstrap state, never an error.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Optional

# These default to the harvester's own env knobs (mirrors src/main.py + src/edgar.py). Read at call time
# (not import time) so a test can monkeypatch the environment and a redeploy with new env is reflected
# without a code change.
_SENTINEL = "bootstrap_complete.json"
_STATE = "harvester_state.json"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _read_json(path: Path) -> Optional[dict]:
    """Read a small JSON state file, or None when it is absent/unreadable. A corrupt state file degrades
    to None (a partial status beats a 500) — the harvester rewrites it on the next sweep."""
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _dir_size_bytes(root: Path) -> int:
    """Total on-disk byte size of the lake tree (facts/ + the identity/state files). Walks the tree with
    `os.scandir` (cheap — a few thousand small Parquet files); a vanished file mid-walk is skipped (a
    concurrent atomic-replace), never raised."""
    total = 0
    if not root.exists():
        return 0
    stack = [root]
    while stack:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat().st_size
                    except OSError:
                        continue  # file replaced/removed mid-walk — skip
        except OSError:
            continue
    return total


def _covered_cik_count(lake: Path) -> int:
    """The number of CIKs with a per-CIK fact file — the headline covered count, read as a file count
    (the unit of storage is one file per CIK), so no Parquet parse is needed for the number."""
    facts = lake / "facts"
    if not facts.exists():
        return 0
    return sum(1 for p in facts.glob("cik=*.parquet"))


def build_status(lake: Path, *, now_ms: Optional[int] = None) -> dict:
    """Assemble the harvester status payload off the lake's on-disk state.

    Returns:
      * `bootstrap_complete`  — the sentinel is present (a full/watchlist bootstrap finished).
      * `bootstrap`           — the sentinel contents (`completed_at`, `entities`, `mode`) or None.
      * `covered_ciks`        — count of `facts/cik=*.parquet` files.
      * `last_sweep_date`     — the most recent date key in `harvester_state.json` (ISO date), or None.
      * `last_sweep_ciks`     — how many CIKs that most-recent sweep refreshed, or 0.
      * `lake_size_bytes`     — total byte size of the lake tree.
      * `lake_dir`            — the lake path (operational visibility).
      * `has_ticker_history` / `has_entities` — the identity files are present (a usable lake resolves
                                tickers→CIK and carries SIC for the sector template only once these exist).

    A cold lake yields `bootstrap_complete=False`, `covered_ciks=0`, `last_sweep_date=None` — the correct
    pre-bootstrap state, not an error."""
    now = now_ms if now_ms is not None else _now_ms()
    sentinel = _read_json(lake / _SENTINEL)
    state = _read_json(lake / _STATE) or {}
    # The state ledger is keyed by ISO date; the newest key is the last sweep that refreshed anything.
    sweep_dates = sorted(k for k in state.keys())
    last_sweep_date = sweep_dates[-1] if sweep_dates else None
    last_sweep_ciks = len(state.get(last_sweep_date, [])) if last_sweep_date else 0
    return {
        "service": "fundamentals-harvester",
        "now_ms": now,
        "bootstrap_complete": sentinel is not None,
        "bootstrap": sentinel,
        "covered_ciks": _covered_cik_count(lake),
        "last_sweep_date": last_sweep_date,
        "last_sweep_ciks": last_sweep_ciks,
        "lake_size_bytes": _dir_size_bytes(lake),
        "lake_dir": str(lake),
        "has_ticker_history": (lake / "ticker_history.parquet").exists(),
        "has_entities": (lake / "entities.parquet").exists(),
    }


def build_config(env: Optional[dict] = None) -> dict:
    """The harvester's effective env knobs — the operator's "what is this harvester configured to do" view.

    Reads `os.environ` (overridable via `env` for tests). The EDGAR User-Agent is surfaced only as a
    boolean `edgar_user_agent_set` (whether it carries an `@` contact, the same fail-closed signal
    `src/edgar.py` gates on) — the UA value itself is operational config but is not echoed here to keep the
    status surface free of a contact string the portal would otherwise render. The other knobs are the
    poll cadence + the storage-light watchlist + the lake path.
    """
    env = env if env is not None else os.environ
    ua = env.get("EDGAR_USER_AGENT", "")
    watchlist = [t.strip().upper() for t in env.get("WATCHLIST", "").split(",") if t.strip()]
    return {
        "lake_dir": env.get("LAKE_DIR", "/data"),
        "sweep_minutes": int(env.get("SWEEP_MINUTES", "30")),
        "watchlist": watchlist,
        "watchlist_mode": bool(watchlist),
        "edgar_reqs_per_sec": env.get("EDGAR_REQS_PER_SEC", "") or "10",
        # Fail-closed signal only — a usable SEC UA carries an `@` contact (src/edgar.py `_ua_is_valid`).
        # Never echo the UA string itself on the status surface.
        "edgar_user_agent_set": bool(ua and "@" in ua),
    }


def build_runs(lake: Path, *, limit: int = 10) -> dict:
    """Recent sweep history from `harvester_state.json` — one entry per date the sweep refreshed CIKs.

    The harvester's sweep ledger keeps the last few days (`_save_done` trims to 3); this returns them
    newest-first as `{date, ciks}` rows (the CIK COUNT, not the id list — the portal renders a count, and
    echoing thousands of ids would bloat the payload). A lake that has never swept (or whose ledger is
    absent) returns an empty list — the correct pre-sweep state, not an error. The `limit` bounds the rows
    defensively though the on-disk ledger is already short.
    """
    state = _read_json(lake / _STATE) or {}
    runs = [
        {"date": d, "ciks": len(state.get(d, []))}
        for d in sorted(state.keys(), reverse=True)[:limit]
    ]
    return {"runs": runs, "count": len(runs)}

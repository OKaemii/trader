# Wipe-and-refetch cutover runbook (PIT-fundamentals-lake + bare-ticker epic)

The terminal step of the `pit-fundamentals-lake-rearchitecture` epic (Task 23). The epic's
cutover cards were deployed **incrementally** to the live demo cluster (operator-directed:
"demo account, past data not important — wipe now, validate live"), so this is a **cleanup wipe
+ end-to-end validation**, not a single big-bang flag-day.

> **Guiding principle (a quant's call):** wipe the *disposable old-shape cruft*, **preserve the
> valuable + already-correct stores**. The deep Timescale `bars` history and the EDGAR lake are
> bare-native/new-shape and expensive to re-fetch (EODHD credits + an OOM-prone deep-chunk
> rebuild) — re-fetching them buys nothing. Wipe only what is old-shape and disposable.

## 0. Pre-wipe assessment (verify BEFORE wiping)

Confirm the new services are healthy and the lake is populated:

- Harvester lake: `kubectl exec -n trader <harvester-pod> -- sh -c 'cat /srv/fundamentals-lake/bootstrap_complete.json; ls /srv/fundamentals-lake/facts | wc -l'`
  → expect `bootstrap_complete` + ~17k `cik=*.parquet` + `entities.parquet` + `ticker_history.parquet`.
- Seam: scanner snapshot (bearer-token) → covered US names resolve `source:"pit-edgar"`, real
  `market_cap_gbp` (NVDA ≈ £3.7T, **not £0**), sectors populated, `SHELl_EQ` → fail-closed.
- Data shape (the cruft): Mongo `ohlcv_bars` had ~2.29M `{symbol:null,market:null}` rows (the
  three-DB-cutover dual-write mirror) blocking `bar_*_unique` index builds (E11000 log spam);
  `signals`/`orders`/`factor_scores` 100% old-shape; `instrument_registry` mixed (active new +
  stale old). Timescale `bars` = new-shape (`symbol`+`market`, **no `ticker` column**), deep +
  healthy (AAPL daily ~1,494 rows 2020→now).

> **OOM caveat:** `bars` is so deep that ANY unbounded query (even `count(*)` or a single-symbol
> count without a time bound) fan-locks every chunk → `53200 out of shared memory`. So a naive
> `TRUNCATE bars`/`DROP TABLE bars` will OOM (it AccessExclusiveLocks all chunks). **Never** wipe
> `bars` unbounded — and here we don't wipe it at all (it's healthy + preserved).

## 1. Credentials (in-cluster, no secret dump)

- **Mongo:** `kubectl exec -i -n trader mongodb-0 -c mongodb -- bash` then
  `P=$(cat "$MONGODB_ROOT_PASSWORD_FILE"); mongosh --quiet -u "$MONGODB_ROOT_USER" -p "$P" --authenticationDatabase admin`
- **Timescale:** `kubectl exec -i -n trader timescaledb-postgresql-0 -- bash` then
  `PGPASSWORD="${POSTGRES_PASSWORD:-$POSTGRESQL_PASSWORD}" psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-trader}"`
- **Redis:** `kubectl exec -n trader redis-master-0 -- sh -c 'redis-cli -a "$REDIS_PASSWORD" …'`
- **Admin API:** bearer token from `POST http://trader.local/api/auth/login` with
  `$TRADER_PORTAL_ADMIN_USERNAME/$TRADER_PORTAL_ADMIN_PASSWORD` (sourced from the zsh profile).
  NOTE: `/admin/api/*` = service routes (bearer-accessible); `/api/admin/*` = portal SSR routes
  (need the Next session cookie, NOT the bearer token).

## 2. Wipe (Mongo) — drop the cruft, clear the old-shape operational collections

```js
// in mongosh (trader db)
const d = db.getSiblingDB("trader");
d.ohlcv_bars.drop();                                  // dual-write mirror cruft (backend=timescale; NOT the read source)
for (const c of ["signals","orders","positions","held_set_snapshots","factor_scores",
                 "instrument_registry","portal_universe_overrides",
                 "company_fundamentals","earnings_calendar"]) d[c].deleteMany({});
```

**Preserve (do NOT wipe):** `index_constituents` (PIT index membership / backtest reference),
`corporate_actions` (EODHD-synced, mostly new-shape), and everything else.

## 3. Wipe (Redis) — bar caches only, NEVER flushdb

```sh
redis-cli -a "$REDIS_PASSWORD" --scan --pattern 'bars:*' | while read k; do redis-cli -a "$REDIS_PASSWORD" del "$k"; done
```
NEVER `FLUSHDB` — it would nuke the operational streams (`market:raw`, `signals:*`) and the
safety flags (`risk:circuit:open`, `trading:kill_switch`, `trading:live_approved`). Stale
ticker-keyed cache entries are otherwise harmless (the new code reads `${symbol}:${market}` keys;
old entries are never read and TTL out).

## 4. Preserve (explicitly NOT wiped)

- **Timescale `bars`/`quotes`** — deep, new-shape, healthy; re-fetch is costly + OOM-prone.
- **The EDGAR lake** (`/srv/fundamentals-lake`) — bare-native (CIK + bare symbol), 17,350
  entities; re-bootstrap is a 1.3 GB download + hours for zero benefit.
- **Old Timescale `fundamentals*`/`security_master`** + the old `fundamentals-ingestion`
  Deployment/CronJobs — left as the rollback target; **dropped in Task 24 (teardown)**.

## 5. Repopulate

- **Universe:** `POST /admin/api/market-data/universe/refresh` (or `…/scanner/run`) — rebuilds
  `instrument_registry` clean on `(symbol,market)` from the EODHD ≥£5B screener.
- **Bars:** the poller keeps writing 5m + the daily feed keeps the daily series fresh (Timescale
  `bars` was preserved, so no backfill needed). If you DID wipe bars: `POST …/backfill {days:60}`
  + `POST …/backfill-daily {scope:'curated-us', deep:true}`.
- **Signals/factors:** repopulate on the strategy's next cycle (the active `high_velocity_v1`
  rebalances monthly).
- **Lake:** the harvester's 30-min sweep keeps it fresh; no action.

## 6. Post-wipe validation (the epic QA Checklist)

- Mongo `ohlcv_bars` E11000 index-build spam **stops** (the cruft is gone).
- `instrument_registry` repopulates clean: all docs `{symbol, market}`, **zero `ticker`** field;
  sample `{symbol:"NVDA", market:"US", sector:"Technology"}`.
- Seam returns the byte-compatible 14-key dict for a covered US name (`source:"pit-edgar"`,
  non-null `market_cap_gbp`); non-US → `{}`.
- **Representative safe write:** `PUT /admin/api/market-data/universe/overrides`
  `{adds:[{symbol:"ORCL",market:"US"}]}` → `{ok:true}`; Mongo `portal_universe_overrides.adds` =
  `[{symbol:"ORCL",market:"US"}]` (bare, resolved to `ORCL_US_EQ` only on the wire). **Restore**
  `{adds:[],removes:[]}` after.
- Active universe shows `META_US_EQ` (FB→META rename), sectors from EODHD, all service pods
  `Running`.

## 7. Rollback

The cutover is irreversible to the old *data* (wiped) and there is no Yahoo fallback (Thread C).
The rollback for the *fundamentals seam* is the old Timescale `fundamentals-api` image + the old
`fundamentals-ingestion` stack — kept deployed until Task 24. Bars/universe simply re-fetch.

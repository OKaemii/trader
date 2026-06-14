// Typed collection name constants — prevents typos like db.collection('singals') from compiling
export const COLLECTIONS = {
  OHLCV_BARS:            'ohlcv_bars',
  SIGNALS:               'signals',
  TOPOLOGY_SNAPSHOTS:    'topology_snapshots',
  STRATEGY_HEALTH_LOG:   'strategy_health_log',
  MODEL_VERSIONS:        'model_versions',
  FEATURE_IMPORTANCE:    'feature_importance_log',
  // The active-universe membership journal, owned by market-data-service's UniverseManager: one
  // soft-delete row per instrument with `activeFrom`/`activeTo` (null = active) for point-in-time
  // universe reconstruction. Keyed on the bare (symbol, market) identity since Task 16b — each doc
  // carries `symbol`+`market` as two separate fields; the concatenated T212 `ticker` is no longer
  // stored (the registry diff add/retire/reactivate + every read re-derive the T212 ticker via the
  // ticker-identity adapter at the Mongo boundary). Doc: { symbol, market, name, sector, adv,
  // activeFrom, activeTo, addedReason, removedReason?, updatedAt }. Unique index on (symbol, market).
  INSTRUMENT_REGISTRY:   'instrument_registry',
  // Walk-forward ValidationReports persisted by backtest-engine's run_backtest (Phase 4).
  // Each doc carries engine ('replay' real | 'synthetic' placeholder), the gate metrics
  // (oos_sharpe/mean_ic/dsr/pbo/fdr_p), the benchmark overlay, regime breakdown, and a
  // data_source string stamping the survivorship caveat. Read by GET /admin/api/backtest/results.
  BACKTEST_RESULTS:      'backtest_results',
  // Durable queue for the hours-long MCPT validator (Phase 5). One doc per submitted run:
  // {status: queued|running|completed|failed, request, report?, error?, createdAt, claimedAt?}.
  // backtest-engine's in-process JobRunner claims FIFO atomically, runs the 4-step permutation
  // validator off the event loop, and writes the ValidationReportV2 back. A startup sweep
  // re-queues jobs left 'running' by a crashed process (replicas: 1). Endpoints under
  // POST/GET /admin/api/validator/*.
  VALIDATION_JOBS:       'validation_jobs',
  // Point-in-time index membership (Phase 6) — one row per {index, symbol, market, effective_from}
  // interval (effective_to=null = still a member). Two index tags coexist (`index:'sp500'` US +
  // `index:'FTSE100'` LSE), ingested by src/scripts/ingest_{sp500,ftse}_history.py — so EVERY
  // consumer MUST filter by `index`. Keyed on the bare (symbol, market) identity since Task 16b —
  // each doc carries `symbol`+`market` as two separate fields; the concatenated T212 `ticker` is no
  // longer stored (the Mongo read-sites re-derive the T212 ticker via the adapter before handing rows
  // to quant-core's pure universe_loader, which resolves the active set as-of any historical instant).
  // Membership is correct; delisted-name *prices* are best-effort. Upsert key (index, symbol, market,
  // effective_from). Doc: { index, symbol, market, effective_from, effective_to, data_source, ingested_at }.
  INDEX_CONSTITUENTS:    'index_constituents',
  USERS:                 'users',
  POSITIONS:             'positions',
  ORDERS:                'orders',
  // Per-ticker swing trade plan set by the operator from the portal: protective stop +
  // profit target (Money, listing currency) + free-text note. { _id: ticker, stop?, target?,
  // note?, updatedBy, updatedAt }. Read by signal-service's enriched-positions join (entry +
  // days-held from the opening BUY signal, R-multiple, stop distance) and the AlertWatcher,
  // which auto-derives stop/target price alert rules from each plan.
  TRADE_PLANS:           'trade_plans',
  // Per-instrument next earnings + dividend dates (UTC ms) for the swing-portal earnings calendar
  // and the "position reports within 10 days" flag. Keyed on the bare (symbol, market) identity since
  // Task 16b — `_id` is the composite `${symbol}:${market}` string (the single-string key rule for an
  // _id, mirroring the Redis-key convention) and `symbol`+`market` are also carried as separate fields;
  // the concatenated T212 `ticker` is no longer stored. Doc: { _id: '<symbol>:<market>', symbol,
  // market, nextEarningsDate?, dividendDate?, source, asOf, updatedAt }.
  // VESTIGIAL post-Yahoo-removal (Thread C / Task 20): EarningsStore's provider is the StubEarningsProvider,
  // which returns {} for every name, so the store stays empty (no doc is ever written) until a PIT-backed
  // earnings source is wired by a later epic. The shape is migrated for that future writer's sake.
  EARNINGS_CALENDAR:     'earnings_calendar',
  // Pipeline A (analyst-free-estimates-engine, Task 10) — HISTORICAL earnings-announcement EVENT dates,
  // the true SUE/PEAD event date = the 8-K Item 2.02 release ("Results of Operations and Financial
  // Condition"), NOT the 10-Q (the 8-K precedes the periodic report and is what the market reacts to).
  // AUTHORITATIVE STORE IS THE PIT LAKE, NOT MONGO: the fundamentals-harvester is a pure EDGAR→Parquet
  // service with no Mongo, and persists these per CIK at `<lake>/events/cik=<cik:010d>.parquet` (atomic
  // replace, the same model as `facts/`), each row { cik, symbol, event_date, accession, items,
  // accepted_ts, knowledge_ts, source } extracted from the 8-K's /submissions items column behind the
  // shared EDGAR_REQS_PER_SEC limiter, fail-closed without a real EDGAR_USER_AGENT. This constant is the
  // future Mongo READ-SIDE mirror (the shape a market-data read path would mirror events into for the
  // portal/strategy seam) — registered now alongside the rest of the earnings sub-domain so the read-side
  // writer has a typed home; like EARNINGS_CALENDAR it stays empty until that mirror is wired. Keyed on
  // the bare (symbol, market) identity: `_id` is `<symbol>:<market>:<accession>`, `symbol`/`market`/`cik`
  // queryable. Doc: { _id, cik, symbol, market, eventDate, accession, knowledgeTs, source, updatedAt }.
  EARNINGS_EVENTS:       'earnings_events',
  // Pipeline C (analyst-free-estimates-engine, Task 12) — forward analyst-consensus estimates. Written
  // by market-data-service's ConsensusStore from a ConsensusProvider. SHIPPED STUBBED: the wired
  // StubConsensusProvider returns {} for every name (no consensus vendor entitled), so this store stays
  // EMPTY until an EodhdConsensusProvider / gold-standard vendor is swapped in — the honest "requires
  // consensus — not sourced" state. Keyed on the bare (symbol, market) identity (the platform rule):
  // `_id` is the composite `<symbol>:<market>:<fiscal_period>:<metric>` string and `symbol`/`market` are
  // also carried as queryable fields; the concatenated T212 ticker is never stored. Doc:
  //   { _id, symbol, market, fiscalPeriod, metric, consensus, numAnalysts, snapshotDate, source, updatedAt }.
  CONSENSUS_ESTIMATE:    'consensus_estimate',
  // Pipeline C (Task 12) — realised earnings surprises. surprise_pct = (actual_eps − consensus_eps)/
  // |consensus_eps| (the ONLY honest surprise — measured against analyst consensus; a mechanical
  // SUE-vs-seasonal-RW or EAR proxy is NOT a surprise and must never land here). Derived by
  // ConsensusStore.refresh ONLY where a consensus EPS estimate AND a realised actual coexist for a
  // (ticker, fiscal_period). SHIPPED STUBBED → empty (no consensus → no surprise; "not built rather than
  // faked"). `surprisePct` is null when the consensus denominator is zero (fail-closed, never a fabricated
  // 0%). Keyed on the bare (symbol, market) identity: `_id` is `<symbol>:<market>:<fiscal_period>`,
  // `symbol`/`market` queryable. Doc:
  //   { _id, symbol, market, fiscalPeriod, actualEps, consensusEps, surprisePct, source, updatedAt }.
  EARNINGS_SURPRISE:     'earnings_surprise',
  // Price alert rules (manual + auto-derived from trade-plan stop/target). The AlertWatcher reads
  // enabled rules each cycle and fires on a bar-range cross. { _id: id, ticker, kind, direction,
  // level: Money, enabled, cooldownH, lastFiredAt?, source, updatedAt }. Derived rules use a
  // deterministic id `${ticker}:${kind}` so re-saving a plan updates rather than duplicates.
  ALERT_RULES:           'alert_rules',
  // Append-only nightly swing-screener snapshots. One doc per run: { runAt, criteria, scanned,
  // rows: top-N candidates with their fired technical signals + score }. Read latest-first by the
  // portal /screener page; written by market-data-service's SwingScreener.
  SWING_SCREEN_RESULTS:  'swing_screen_results',
  BAD_TICKS:             'bad_ticks',
  PUSH_TOKENS:           'push_tokens',
  RISK_REJECTIONS:       'risk_rejections',
  RISK_STATE:            'risk_state',
  // Operator-driven forced add/remove for the curated universe — a singleton { _id:'singleton', ... }.
  // Keyed on the bare (symbol, market) identity since Task 16b: `adds` / `removes` are arrays of
  // { symbol, market } objects (was bare/T212 strings), so the storage carries GOOGL not GOOGL_US_EQ.
  // Written/read by market-data-service (PUT/GET /admin/api/market-data/universe/overrides + applied in
  // UniverseManager.refresh). The bare-forced-add UX (the portal posting {symbol,market} directly) is
  // Task 18/21; until then the admin handler still accepts T212 strings on the wire and splits them to
  // { symbol, market } at the Mongo boundary, re-deriving the T212 string on read so the in-memory
  // override-application stays behaviour-identical. Doc: { _id:'singleton',
  // adds:[{symbol,market}], removes:[{symbol,market}], updatedBy, updatedAt }.
  PORTAL_UNIVERSE_OVERRIDES: 'portal_universe_overrides',
  PORTAL_MARKET_CONFIG:      'portal_market_config',
  // Per-strategy tunable overrides set from the portal: { _id: strategy_id, liveParams,
  // searchGrid }. liveParams hot-applied by strategy-engine; searchGrid swept by the validator.
  PORTAL_STRATEGY_CONFIG:    'portal_strategy_config',
  MARKET_CALENDAR:           'market_calendar',
  COMPANY_PROFILES:          'company_profiles',
  // Per-instrument fundamentals (raw balance-sheet + income line items + market cap in GBP) for the
  // QMJ quality screen. Written by market-data-service's FundamentalsCache (Yahoo/PIT provider,
  // monthly refresh); read by the high-velocity strategy host + the Scanner/Feeds page. Keyed on the
  // bare (symbol, market) identity since Task 16b — `_id` is the composite `${symbol}:${market}` string
  // and `symbol`+`market` are carried as separate fields; the concatenated T212 `ticker` is no longer
  // stored. Doc: { _id: '<symbol>:<market>', symbol, market, asOf, raw, ratios, qualityPass,
  // marketCapGbp, source, updatedAt }. Still actively written under FUNDAMENTALS_PROVIDER=yahoo|pit
  // (the Yahoo QMJ snapshot / PIT-warehouse read-through) — NOT vestigial.
  COMPANY_FUNDAMENTALS:      'company_fundamentals',
  // Reusable holdings "pie" — one active doc per strategy (keyed by pieId uuid): target
  // weights + rebalance history. Written by signal-service's PieManager on each rebalance;
  // signals/orders carry the pieId for attribution. { pieId, strategyId, name, status, targets,
  // rebalanceHistory, ... }.
  PIES:                      'pies',
  // Portal-driven runtime singletons not covered by the market/strategy config docs — e.g. the
  // active-strategy selection ({ _id:'active_strategy', strategyId }). One doc per concern.
  PORTAL_RUNTIME_CONFIG:     'portal_runtime_config',
  // Operator-tunable risk limits overlaid on the RISK_LIMITS compile-time defaults: singleton
  // { _id:'singleton', overrides, updatedAt } where `overrides` holds only the tunable subset
  // (maxDailyLoss/maxDrawdownHalt/maxSingleName/maxSectorConcentration/maxWeeklyTurnover). Read hot
  // by signal-service's RiskLimitsProvider (15s cache + config:invalidated). Each absent field
  // falls back to the compile-time default; structural/env-backed fields are not overridable here.
  PORTAL_RISK_CONFIG:        'portal_risk_config',
  // Per-ticker GICS metadata sourced from Yahoo `quoteSummary(assetProfile)`. Owned by
  // market-data-service's UniverseManager: looked up + refreshed (>30d stale) on every
  // universe rebuild. Replaces the no-op T212-derived `sector='Unknown'` path so
  // sector-relative strategies (SectorMomentum) and the notification renderer see real
  // GICS labels. Operator can pin a manual override via `source='manual'` — the periodic
  // Yahoo refresh skips those rows.
  INSTRUMENT_METADATA:       'instrument_metadata',
  // Append-only audit log written inside the same transaction as every revision insert
  // into `ohlcv_bars`. Each entry records {ticker, observation_ts, interval,
  // knowledge_ts, prior_hash, new_hash}. `prior_hash: null` marks the first-print —
  // useful for revision-rate dashboards. Powers GET /api/admin/market-data/revisions/:ticker.
  BAR_REVISIONS_LOG:         'bar_revisions_log',
  // Append-only per-cycle research factor scores. One doc per (ticker, cycle): the canonical
  // research-factor set (momentum/volatility/value/quality) computed over the active universe and
  // persisted best-effort after compute_features (a store failure logs, never blocks emission).
  // Written by strategy-engine's FactorStore (factor_store.py); read by the strategy-engine scores
  // / factor-history endpoints (GET /admin/api/strategy/{scores,factor-history}) and, for the
  // signal "Why?" panel, as-of the signal's knowledge time. Keyed on the bare (symbol, market)
  // identity since Task 16b — each doc carries `symbol`+`market` as two separate fields; the
  // concatenated T212 `ticker` is no longer stored (the reader endpoints take a T212 ticker, split it
  // to (symbol, market) for the query, and re-derive `ticker` on the way out so the portal contract is
  // unchanged). Doc:
  //   { symbol, market, observation_ts,    // cycle as_of_ms (knowledge time of these closes)
  //     factors: {
  //       momentum:   { raw, pct, source }, // pct = cross-sectional percentile (0..100)
  //       volatility: { raw, pct, source },
  //       value:      { raw, pct, source },
  //       quality:    { raw, pct, source } } }
  // Each factor stamps a `source` so a later point-in-time fundamentals warehouse can re-backfill
  // and upgrade previously-`null` rows in place, matched by (symbol, market, observation_ts), guarded
  // by the per-factor `source` (plan §H). `source` is one of:
  //   'eod'                  — from our own EODHD-fed persisted daily series (price factors)
  //   'div'                  — from the EODHD Dividends feed (value's dividend-yield component)
  //   'yahoo-snapshot'       — forward-only Yahoo quoteSummary snapshot (quality; value earnings/book)
  //   'pit-edgar'            — future US point-in-time EDGAR warehouse (out of scope this epic)
  //   'pit-companies-house'  — future UK point-in-time Companies House warehouse (out of scope)
  //   null                   — no source available (e.g. historical Quality pre-PIT-warehouse:
  //                            { raw: null, pct: null, source: null } — never a fabricated value)
  // Indexes (created by the writer task, NOT here): (symbol, market, observation_ts).
  FACTOR_SCORES:             'factor_scores',
  // Append-only per-cycle snapshot of the optimiser's held set. After the long-only optimiser
  // produces the final weights each cycle, signal-service writes one doc per ranked name. Powers
  // the Strategy Impact (GET /admin/api/signals/strategy-impact?ticker=) and Factor Evolution
  // selected/holding context. Keyed on the bare (symbol, market) identity since Task 16a (the
  // concatenated T212 ticker is no longer stored). Doc:
  //   { strategy_id, observation_ts, symbol, market,
  //     rank,              // from sorting composite_scores
  //     selected,         // true = in the held set
  //     weight,           // final long-only weight (0 when not selected)
  //     holding_age_days } // days since the oldest open BUY for this name
  // Indexes (created by the writer, NOT here): (strategy_id, observation_ts) and
  // (strategy_id, symbol, market, observation_ts) for per-name inclusion history.
  HELD_SET_SNAPSHOTS:        'held_set_snapshots',
  // Per-entity research notebook entry. signal-service's `research` module serves
  // GET/PUT /admin/api/research/notes/:ticker. Body is operator-authored markdown; the `@`-links in
  // the body are parsed into a backlink index so a strategy/signal/symbol view can list "notes
  // referencing me". Doc:
  //   { _id: <entity key, e.g. ticker>,
  //     body,             // raw markdown
  //     links: [ { kind: 'strategy' | 'signal' | 'symbol', ref } ],  // parsed @-links
  //     updatedBy, updatedAt }
  // Indexes (created by the writer task, NOT here): a backlink lookup over `links.ref`
  // ("notes referencing entity X").
  RESEARCH_NOTES:            'research_notes',
  // Per-instrument corporate-actions store (cash dividends + stock splits) sourced from the EODHD
  // Dividends/Splits feeds. Written by market-data-service's CorporateActionsStore via an
  // INCREMENTAL sync — each pass fetches only the events newer than the last stored ex-date /
  // split-effective date, so a re-sync with no new actions makes ZERO upstream EODHD calls
  // (plan §I). Keyed on the bare (symbol, market) identity since Task 16b — `_id` is the composite
  // `${symbol}:${market}` string and `symbol`+`market` are carried as separate fields; the
  // concatenated T212 `ticker` is no longer stored (the public methods take a T212 ticker and bridge
  // to the (symbol, market) `_id` at the Mongo boundary). One doc per instrument:
  //   { _id: '<symbol>:<market>', symbol, market,
  //     dividends: [ { date,            // 'YYYY-MM-DD' ex-dividend date (point-in-time key)
  //                    valuePerShare,   // gross dividend per share, BASE units (pence killed at
  //                                     // the boundary — LSE pence ÷100 → GBP, like prices)
  //                    currency? } ],   // EODHD-declared currency when present
  //     splits:    [ { date,           // 'YYYY-MM-DD' split-effective date
  //                    ratio,           // raw EODHD ratio string, e.g. '2/1'
  //                    factor } ],      // ratio parsed to a share-count multiplier (NaN = don't auto-adjust)
  //     lastDividendDate?,             // 'YYYY-MM-DD' max ex-date stored — the incremental `from` cursor
  //     lastSplitDate?,                // 'YYYY-MM-DD' max split-date stored — the incremental `from` cursor
  //     source, asOf, updatedAt }
  // Read by the admin GET /admin/api/market-data/corporate-actions?ticker= (corporate-actions list
  // on History) and by the internal GET /internal/api/dividend-yield (the point-in-time, backfillable
  // Value dividend-yield leg the strategy factor host injects into HistoryView.fundamentals — §H;
  // T9 factor host + T17 research-backfill consume it).
  CORPORATE_ACTIONS:         'corporate_actions',

  // Per-symbol EODHD news (Overview "Recent Events" panel + the narrative/"Why?" event context).
  // A read-through store with an INCREMENTAL, credit-thrifty sync (plan §H/§I): each doc carries a
  // `lastFetchedDate` cursor (the publish-date of the newest stored article); a re-sync fetches only
  // articles after that date and appends genuinely-new links, so a current symbol spends ~no EODHD
  // credits. Body text is dropped (headline/link/date/symbols/tags + optional sentiment only).
  // Fetched lazily (on symbol open / once-daily background pass) — NEVER per page-load. One doc per
  // ticker:
  //   { _id: ticker,
  //     articles: [ { date,        // ISO-8601 publish timestamp from EODHD (the dedupe/ordering key
  //                                 // is `link`; multiple articles can share a publish day)
  //                   title, link,
  //                   symbols,      // related EODHD symbols (may be empty)
  //                   tags,         // EODHD topic tags (may be empty)
  //                   sentiment? }],// { polarity, neg, neu, pos } — ONLY when the tier returns it
  //     lastFetchedDate?,          // 'YYYY-MM-DD' max publish-date stored — the incremental `from` cursor
  //     source, asOf, updatedAt }
  // Read by the admin GET /admin/api/market-data/news?ticker= (Overview Recent Events — T24/T30/T35).
  NEWS:                      'news',
  // Cached day's market narrative — the data-grounded hybrid prose served by signal-service's
  // research module (GET /admin/api/market/narrative; T30). The portal_* config pattern: one
  // singleton doc regenerated on a new trading day (the keying field is the UTC date string of the
  // generation day) or on demand (?refresh=1). The narrative is CONSTRAINED to the numbers in
  // GET /admin/api/market/summary — a post-check rejects any figure not in that payload and falls
  // back to a deterministic template. Doc:
  //   { _id:'singleton',
  //     tradingDay,   // 'YYYY-MM-DD' the narrative was generated for (the cache key); a request on a
  //                   // later UTC day regenerates
  //     narrative,    // the prose served to the portal
  //     source,       // 'llm' (LLM prose passed the post-check) | 'template' (deterministic fallback)
  //     summary,      // the exact MarketSummary the narrative was built from (audit / numbers source)
  //     generatedAt } // ms the doc was written
  MARKET_NARRATIVE:          'market_narrative',
} as const;

export type CollectionName = typeof COLLECTIONS[keyof typeof COLLECTIONS];

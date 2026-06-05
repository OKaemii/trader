// Typed collection name constants — prevents typos like db.collection('singals') from compiling
export const COLLECTIONS = {
  OHLCV_BARS:            'ohlcv_bars',
  SIGNALS:               'signals',
  TOPOLOGY_SNAPSHOTS:    'topology_snapshots',
  STRATEGY_HEALTH_LOG:   'strategy_health_log',
  MODEL_VERSIONS:        'model_versions',
  FEATURE_IMPORTANCE:    'feature_importance_log',
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
  // Point-in-time index membership (Phase 6) — one row per {index, ticker, effective_from}
  // interval (effective_to=null = still a member). Ingested from the fja05680/sp500 community
  // CSV by src/scripts/ingest_sp500_history.py. quant-core's universe_loader resolves the active
  // set as-of any historical instant so the validator can run a survivorship-bias-reduced
  // universe (membership is correct; delisted-name *prices* are best-effort from Yahoo).
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
  BAD_TICKS:             'bad_ticks',
  PUSH_TOKENS:           'push_tokens',
  RISK_REJECTIONS:       'risk_rejections',
  RISK_STATE:            'risk_state',
  PORTAL_UNIVERSE_OVERRIDES: 'portal_universe_overrides',
  PORTAL_MARKET_CONFIG:      'portal_market_config',
  // Per-strategy tunable overrides set from the portal: { _id: strategy_id, liveParams,
  // searchGrid }. liveParams hot-applied by strategy-engine; searchGrid swept by the validator.
  PORTAL_STRATEGY_CONFIG:    'portal_strategy_config',
  MARKET_CALENDAR:           'market_calendar',
  COMPANY_PROFILES:          'company_profiles',
  // Per-ticker fundamentals (raw balance-sheet + income line items + market cap in GBP) for the
  // QMJ quality screen. Written by market-data-service's FundamentalsCache (Yahoo quoteSummary,
  // monthly refresh); read by the high-velocity strategy host + the Scanner/Feeds page. Doc:
  // { _id: ticker, asOf, raw, ratios, qualityPass, source, updatedAt }.
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
} as const;

export type CollectionName = typeof COLLECTIONS[keyof typeof COLLECTIONS];

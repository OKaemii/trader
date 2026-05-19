// Typed collection name constants — prevents typos like db.collection('singals') from compiling
export const COLLECTIONS = {
  OHLCV_BARS:            'ohlcv_bars',
  SIGNALS:               'signals',
  TOPOLOGY_SNAPSHOTS:    'topology_snapshots',
  STRATEGY_HEALTH_LOG:   'strategy_health_log',
  MODEL_VERSIONS:        'model_versions',
  FEATURE_IMPORTANCE:    'feature_importance_log',
  INSTRUMENT_REGISTRY:   'instrument_registry',
  USERS:                 'users',
  POSITIONS:             'positions',
  ORDERS:                'orders',
  BAD_TICKS:             'bad_ticks',
  PUSH_TOKENS:           'push_tokens',
  RISK_REJECTIONS:       'risk_rejections',
  RISK_STATE:            'risk_state',
  PORTAL_UNIVERSE_OVERRIDES: 'portal_universe_overrides',
  PORTAL_MARKET_CONFIG:      'portal_market_config',
  MARKET_CALENDAR:           'market_calendar',
  COMPANY_PROFILES:          'company_profiles',
  // Per-ticker GICS metadata sourced from Yahoo `quoteSummary(assetProfile)`. Owned by
  // market-data-service's UniverseManager: looked up + refreshed (>30d stale) on every
  // universe rebuild. Replaces the no-op T212-derived `sector='Unknown'` path so
  // sector-relative strategies (SectorMomentum) and the notification renderer see real
  // GICS labels. Operator can pin a manual override via `source='manual'` — the periodic
  // Yahoo refresh skips those rows.
  INSTRUMENT_METADATA:       'instrument_metadata',
} as const;

export type CollectionName = typeof COLLECTIONS[keyof typeof COLLECTIONS];

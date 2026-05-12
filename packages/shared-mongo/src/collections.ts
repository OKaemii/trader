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
} as const;

export type CollectionName = typeof COLLECTIONS[keyof typeof COLLECTIONS];

variable "namespace" {}
variable "redis_password" { sensitive = true }
variable "mongodb_password" { sensitive = true }
variable "timescaledb_password" { sensitive = true }

resource "helm_release" "redis" {
  name       = "redis"
  repository = "https://charts.bitnami.com/bitnami"
  chart      = "redis"
  version    = "25.5.2"
  namespace  = var.namespace

  set = [
    {
      name  = "auth.password"
      value = var.redis_password
    },
    {
      name  = "architecture"
      value = "standalone"
    },
  ]
}

resource "helm_release" "mongodb" {
  name       = "mongodb"
  repository = "https://charts.bitnami.com/bitnami"
  chart      = "mongodb"
  version    = "18.7.1"
  namespace  = var.namespace

  set = [
    {
      name  = "auth.rootPassword"
      value = var.mongodb_password
    },
    {
      name  = "auth.username"
      value = "trader"
    },
    {
      name  = "auth.password"
      value = var.mongodb_password
    },
    {
      name  = "auth.database"
      value = "trader"
    },
    # ── StatefulSet conversion (2026-05-15) ──────────────────────────────────
    # Replica-set architecture is the correct shape for a database in k8s: the
    # workload becomes a StatefulSet with stable pod identity, OrderedReady pod
    # management (no two pods ever holding the PVC lock at once), and a future
    # path to true HA by bumping replicaCount. With replicaCount=1 we run as a
    # one-member rs0 — oplog enabled, change streams + transactions available.
    # Drivers connect with `directConnection=true` so they don't try to discover
    # phantom secondaries.
    { name = "architecture", value = "replicaset" },
    { name = "replicaCount", value = "1" },
    # Keep the new PVC across helm uninstall as a belt-and-braces safety net;
    # the old standalone PVC `mongodb` is orphaned by this transition but its
    # PV has been patched to Retain (2026-05-15) so the data isn't lost.
    { name = "persistence.resourcePolicy", value = "keep" },
    # Inter-member auth keyfile: lives in the `mongodb` Secret under key
    # `mongodb-replica-set-key`. The chart auto-creates it on a fresh install. On
    # the in-place standalone→replicaset upgrade the existing Secret was missing
    # that key, so it was patched in manually (2026-05-15) and the chart reads it
    # from there on subsequent applies. If the Secret is ever deleted/recreated
    # the chart will generate a fresh key — harmless for a 1-member rs.
    # Memory bumped 2026-05-25: the chart's default ~1500Mi limit OOMKilled mongodb
    # during the connection storm when the three-database-split deploy rolled all
    # consumers at once (node has ample RAM — this is a per-container cgroup limit,
    # not node pressure). 4Gi absorbs reconnection + WiredTiger-cache spikes; the
    # eventual barsBackend cutover will re-roll consumers and re-storm.
    { name = "resources.limits.cpu",      value = "1500m" },
    { name = "resources.limits.memory",   value = "3Gi" },
    { name = "resources.requests.cpu",    value = "500m" },
    { name = "resources.requests.memory", value = "1Gi" },
  ]
}

resource "helm_release" "timescaledb" {
  name       = "timescaledb"
  repository = "https://charts.bitnami.com/bitnami"
  chart      = "postgresql"
  version    = "16.7.27"
  namespace  = var.namespace

  set = [
    # Swap the default Bitnami Postgres image for the upstream Timescale image (same
    # PG major; ships with the timescaledb extension already compiled in). The
    # initdbScripts below just CREATE EXTENSION so live and read paths see a Timescale
    # hypertable, not a plain table.
    { name = "image.repository", value = "timescale/timescaledb" },
    { name = "image.tag",        value = "2.17.2-pg16" },
    # Bitnami postgresql 15.x+ verifies images against an allowlist and refuses
    # non-Bitnami images (bitnami/charts#30850). We intentionally run the upstream
    # timescale/timescaledb image, so opt out of that verification gate.
    { name = "global.security.allowInsecureImages", value = "true" },
    { name = "auth.username",       value = "trader" },
    { name = "auth.password",       value = var.timescaledb_password },
    { name = "auth.postgresPassword", value = var.timescaledb_password },
    { name = "auth.database",       value = "trader_ts" },
    # Single-node k3s — replication off; primary architecture only. Bumping to HA
    # later means flipping to architecture=replication and replicaCount=N with a
    # full restore from the logical dump (see CLAUDE.md storage section, task 21).
    { name = "architecture", value = "standalone" },
    # Sized to fit the existing homeserver: 60d × 200 tickers × 78 5m bars/day
    # ≈ 1M rows, compressed to ~200MB after the 7d compression policy kicks in.
    # 20Gi is generous headroom for the audit hypertables + future doc-#5 quotes.
    { name = "primary.persistence.size", value = "20Gi" },
    { name = "primary.persistence.resourcePolicy", value = "keep" },
    # `shared_preload_libraries=timescaledb` is required — without it, the extension
    # compiles but CREATE EXTENSION fails at boot. Passed via the Bitnami chart's
    # extendedConfiguration value, which the chart appends to postgresql.conf.
    { name = "primary.extendedConfiguration",
      value = "shared_preload_libraries = 'timescaledb'\n" },
    # Bitnami's default resourcesPreset gave Timescale only 192Mi → OOMKilled under
    # query/insert load on the 706k-row hypertable (2026-05-25). Size it for the live
    # bar store (node has ample RAM): 4Gi covers work_mem sorts + compression + WAL.
    { name = "primary.resources.limits.cpu",      value = "2000m" },
    { name = "primary.resources.limits.memory",   value = "2Gi" },
    { name = "primary.resources.requests.cpu",    value = "500m" },
    { name = "primary.resources.requests.memory", value = "256Mi" },
  ]

  # CREATE EXTENSION inside the trader_ts DB on first boot. Runs as the superuser
  # on the freshly-initialized cluster, before the regular DB is ready for app
  # connections. Idempotent (IF NOT EXISTS) so re-deploys are safe.
  values = [yamlencode({
    primary = {
      initdb = {
        scripts = {
          "00-extension.sql" = "CREATE EXTENSION IF NOT EXISTS timescaledb;\n"
        }
      }
      # The upstream timescale/timescaledb image is built on the OFFICIAL postgres
      # image: it creates the initial DB from POSTGRES_DB (Bitnami sets only
      # POSTGRES_DATABASE, which the official entrypoint ignores) and writes its
      # socket/lock to /var/run/postgresql, which the chart's read-only rootfs leaves
      # unwritable. Supply POSTGRES_DB + a writable emptyDir so the image boots.
      extraEnvVars      = [{ name = "POSTGRES_DB", value = "trader_ts" }]
      extraVolumes      = [{ name = "pg-run", emptyDir = {} }]
      extraVolumeMounts = [{ name = "pg-run", mountPath = "/var/run/postgresql" }]
    }
  })]
}

resource "helm_release" "trader_app" {
  name      = "trader-app"
  chart     = "../helm/trader"
  namespace = var.namespace
  depends_on = [helm_release.redis, helm_release.mongodb, helm_release.timescaledb]
}

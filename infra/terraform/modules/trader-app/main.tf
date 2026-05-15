variable "namespace" {}
variable "redis_password" { sensitive = true }
variable "mongodb_password" { sensitive = true }

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
  ]
}

resource "helm_release" "trader_app" {
  name      = "trader-app"
  chart     = "../helm/trader"
  namespace = var.namespace
  depends_on = [helm_release.redis, helm_release.mongodb]
}

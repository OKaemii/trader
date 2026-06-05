variable "namespace" {}

resource "helm_release" "kube_prometheus_stack" {
  name             = "kube-prometheus-stack"
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  version          = "58.0.0"
  namespace        = "monitoring"
  create_namespace = true

  set = [
    {
      name  = "grafana.adminPassword"
      value = "prom-operator"
    },
    {
      name  = "grafana.ingress.enabled"
      value = "true"
    },
    {
      name  = "grafana.ingress.hosts[0]"
      value = "grafana.trader.local"
    },
  ]

  # Keep a short local retention (Prometheus stays the scrape engine) but stream every sample to
  # Mimir for long-term storage. With multitenancy disabled in Mimir the tenant is `anonymous`.
  values = [yamlencode({
    prometheus = {
      prometheusSpec = {
        retention = "15d"
        remoteWrite = [{
          url     = "http://mimir-nginx.monitoring.svc.cluster.local/api/v1/push"
          headers = { "X-Scope-OrgID" = "anonymous" }
        }]
      }
    }
  })]
}

resource "helm_release" "loki" {
  name             = "loki"
  repository       = "https://grafana.github.io/helm-charts"
  chart            = "loki-stack"
  version          = "2.10.2"
  namespace        = "monitoring"
  create_namespace = true

  set = [
    {
      name  = "loki.isDefault"
      value = "false"
    },
  ]
}

resource "kubernetes_config_map" "strategy_health_dashboard" {
  metadata {
    name      = "trader-strategy-health-dashboard"
    namespace = "monitoring"
    labels = {
      grafana_dashboard = "1"
    }
  }

  data = {
    "strategy-health.json" = jsonencode({
      title         = "Strategy Health"
      uid           = "trader-strategy-health"
      schemaVersion = 36
      version       = 2
      tags          = ["trader", "strategy"]
      panels = [
        {
          id      = 1
          title   = "Health Score"
          type    = "stat"
          gridPos = { h = 4, w = 6, x = 0, y = 0 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "strategy_health_score"
            legendFormat = "Health"
          }]
          fieldConfig = { defaults = { min = 0, max = 1, thresholds = { steps = [
            { color = "red", value = 0 },
            { color = "orange", value = 0.26 },
            { color = "yellow", value = 0.76 },
            { color = "green", value = 1 },
          ] } } }
        },
        {
          id      = 2
          title   = "Rolling Sharpe 30d"
          type    = "timeseries"
          gridPos = { h = 8, w = 12, x = 0, y = 4 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "strategy_rolling_sharpe_30d"
            legendFormat = "Sharpe 30d"
          }]
        },
        {
          id      = 3
          title   = "Hit Rate 30d"
          type    = "timeseries"
          gridPos = { h = 8, w = 12, x = 12, y = 4 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "strategy_hit_rate_30d"
            legendFormat = "Hit Rate"
          }]
          fieldConfig = { defaults = { min = 0, max = 1, thresholds = { steps = [
            { color = "red", value = 0 },
            { color = "green", value = 0.47 },
          ] } } }
        },
        {
          id      = 4
          title   = "Turnover Ratio"
          type    = "gauge"
          gridPos = { h = 4, w = 6, x = 6, y = 0 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "strategy_turnover_ratio"
            legendFormat = "Turnover"
          }]
          fieldConfig = { defaults = { min = 0, max = 4, thresholds = { steps = [
            { color = "green", value = 0 },
            { color = "yellow", value = 1.5 },
            { color = "red", value = 2 },
          ] } } }
        },
        {
          id      = 5
          title   = "IC t-Stat"
          type    = "gauge"
          gridPos = { h = 4, w = 6, x = 12, y = 0 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "strategy_ic_tstat"
            legendFormat = "IC t-stat"
          }]
          fieldConfig = { defaults = { min = 0, max = 3, thresholds = { steps = [
            { color = "red", value = 0 },
            { color = "green", value = 1 },
          ] } } }
        },
        {
          id      = 6
          title   = "Feature Drift (KL)"
          type    = "timeseries"
          gridPos = { h = 4, w = 6, x = 18, y = 0 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "strategy_feature_drift_kl"
            legendFormat = "KL Divergence"
          }]
          fieldConfig = { defaults = { thresholds = { steps = [
            { color = "green", value = 0 },
            { color = "red", value = 0.6 },
          ] } } }
        },
      ]
    })
  }

  depends_on = [helm_release.kube_prometheus_stack]
}

# ── Grafana Mimir — long-term metric storage ──────────────────────────────────────────
# Single-node homeserver config (NOT HA): 1 replica per component, zone-aware replication off,
# bundled MinIO for object storage, multitenancy off (tenant = "anonymous"). Prometheus
# remote_writes every sample here (see kube_prometheus_stack.values above); reads go through the
# nginx gateway. Before treating this as durable: bump replicas, enable zone-aware replication,
# and point at a real object store. The chart version may need a bump on first `terraform apply`.
resource "helm_release" "mimir" {
  name             = "mimir"
  repository       = "https://grafana.github.io/helm-charts"
  chart            = "mimir-distributed"
  version          = "5.5.1"
  namespace        = "monitoring"
  create_namespace = true

  values = [yamlencode({
    mimir = {
      structuredConfig = {
        multitenancy_enabled = false
        ingester             = { ring = { replication_factor = 1 } }
        limits               = { compactor_blocks_retention_period = "90d" }
      }
    }
    metaMonitoring     = { serviceMonitor = { enabled = false } }
    minio              = { enabled = true, replicas = 1, persistence = { size = "20Gi" } }
    alertmanager       = { enabled = false }
    ruler              = { enabled = false }
    overrides_exporter = { enabled = false }
    rollout_operator   = { enabled = false }
    ingester           = { replicas = 1, zoneAwareReplication = { enabled = false }, persistentVolume = { size = "10Gi" } }
    store_gateway      = { replicas = 1, zoneAwareReplication = { enabled = false }, persistentVolume = { size = "10Gi" } }
    compactor          = { replicas = 1, persistentVolume = { size = "10Gi" } }
    distributor        = { replicas = 1 }
    querier            = { replicas = 1 }
    query_frontend     = { replicas = 1 }
    query_scheduler    = { replicas = 1 }
    nginx              = { replicas = 1 }
  })]
}

# Mimir as a Grafana datasource (auto-provisioned via the kube-prometheus-stack Grafana sidecar,
# which watches configmaps labelled grafana_datasource=1). Reads through the nginx gateway's
# Prometheus-compatible query path. Dashboards can target uid "mimir" for history beyond
# Prometheus's local 15d retention.
resource "kubernetes_config_map" "mimir_datasource" {
  metadata {
    name      = "mimir-datasource"
    namespace = "monitoring"
    labels    = { grafana_datasource = "1" }
  }
  data = {
    "mimir-datasource.yaml" = yamlencode({
      apiVersion = 1
      datasources = [{
        name           = "Mimir"
        type           = "prometheus"
        uid            = "mimir"
        access         = "proxy"
        url            = "http://mimir-nginx.monitoring.svc.cluster.local/prometheus"
        isDefault      = false
        jsonData       = { httpHeaderName1 = "X-Scope-OrgID" }
        secureJsonData = { httpHeaderValue1 = "anonymous" }
      }]
    })
  }
  depends_on = [helm_release.mimir]
}

# ── Trader Platform overview dashboard ────────────────────────────────────────────────
# DevOps at-a-glance: service health, restarts, CPU/mem (kube-state-metrics + cAdvisor) plus the
# app metrics the services now expose (strategy signals/bars/regime + Node runtime via the shared
# /metrics). Panels read from Prometheus (live + reliable); flip a panel's datasource to "mimir"
# in Grafana for long-range history.
resource "kubernetes_config_map" "trader_platform_dashboard" {
  metadata {
    name      = "trader-platform-dashboard"
    namespace = "monitoring"
    labels    = { grafana_dashboard = "1" }
  }

  data = {
    "trader-platform.json" = jsonencode({
      title         = "Trader Platform"
      uid           = "trader-platform"
      schemaVersion = 36
      version       = 1
      tags          = ["trader", "platform", "devops"]
      panels = [
        {
          id      = 1
          title   = "Services up"
          type    = "stat"
          gridPos = { h = 4, w = 6, x = 0, y = 0 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "count(up{namespace=\"trader\"} == 1)"
            legendFormat = "up"
          }]
        },
        {
          id      = 2
          title   = "Signals published (1h)"
          type    = "stat"
          gridPos = { h = 4, w = 6, x = 6, y = 0 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "sum(increase(strategy_signals_published_total[1h]))"
            legendFormat = "signals"
          }]
        },
        {
          id      = 3
          title   = "Regime confidence"
          type    = "stat"
          gridPos = { h = 4, w = 6, x = 12, y = 0 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "avg(strategy_regime_confidence)"
            legendFormat = "regime"
          }]
          fieldConfig = { defaults = { min = 0, max = 1 } }
        },
        {
          id      = 4
          title   = "Pod restarts (24h)"
          type    = "stat"
          gridPos = { h = 4, w = 6, x = 18, y = 0 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "sum(increase(kube_pod_container_status_restarts_total{namespace=\"trader\"}[24h]))"
            legendFormat = "restarts"
          }]
          fieldConfig = { defaults = { thresholds = { steps = [
            { color = "green", value = 0 },
            { color = "red", value = 1 },
          ] } } }
        },
        {
          id      = 5
          title   = "CPU by pod"
          type    = "timeseries"
          gridPos = { h = 8, w = 12, x = 0, y = 4 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "sum by (pod) (rate(container_cpu_usage_seconds_total{namespace=\"trader\", container!=\"\"}[5m]))"
            legendFormat = "{{pod}}"
          }]
        },
        {
          id      = 6
          title   = "Memory (working set) by pod"
          type    = "timeseries"
          gridPos = { h = 8, w = 12, x = 12, y = 4 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "sum by (pod) (container_memory_working_set_bytes{namespace=\"trader\", container!=\"\"})"
            legendFormat = "{{pod}}"
          }]
          fieldConfig = { defaults = { unit = "bytes" } }
        },
        {
          id      = 7
          title   = "Signals published by strategy (15m rate)"
          type    = "timeseries"
          gridPos = { h = 8, w = 12, x = 0, y = 12 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "sum by (strategy_id) (rate(strategy_signals_published_total[15m]))"
            legendFormat = "{{strategy_id}}"
          }]
        },
        {
          id      = 8
          title   = "Bars processed by strategy (15m rate)"
          type    = "timeseries"
          gridPos = { h = 8, w = 12, x = 12, y = 12 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "sum by (strategy_id) (rate(strategy_bars_processed_total[15m]))"
            legendFormat = "{{strategy_id}}"
          }]
        },
        {
          id      = 9
          title   = "Node event-loop lag p99"
          type    = "timeseries"
          gridPos = { h = 8, w = 12, x = 0, y = 20 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "nodejs_eventloop_lag_p99_seconds{namespace=\"trader\"}"
            legendFormat = "{{pod}}"
          }]
          fieldConfig = { defaults = { unit = "s" } }
        },
        {
          id      = 10
          title   = "Processing errors by strategy (15m rate)"
          type    = "timeseries"
          gridPos = { h = 8, w = 12, x = 12, y = 20 }
          targets = [{
            datasource   = { type = "prometheus", uid = "prometheus" }
            expr         = "sum by (strategy_id) (rate(strategy_processing_errors_total[15m]))"
            legendFormat = "{{strategy_id}}"
          }]
        },
      ]
    })
  }

  depends_on = [helm_release.kube_prometheus_stack]
}

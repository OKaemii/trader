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
            datasource = { type = "prometheus", uid = "prometheus" }
            expr       = "strategy_health_score"
            legendFormat = "Health"
          }]
          fieldConfig = { defaults = { min = 0, max = 1, thresholds = { steps = [
            { color = "red",    value = 0 },
            { color = "orange", value = 0.26 },
            { color = "yellow", value = 0.76 },
            { color = "green",  value = 1 },
          ]}}}
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
            { color = "red",   value = 0 },
            { color = "green", value = 0.47 },
          ]}}}
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
            { color = "green",  value = 0 },
            { color = "yellow", value = 1.5 },
            { color = "red",    value = 2 },
          ]}}}
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
            { color = "red",   value = 0 },
            { color = "green", value = 1 },
          ]}}}
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
            { color = "red",   value = 0.6 },
          ]}}}
        },
      ]
    })
  }

  depends_on = [helm_release.kube_prometheus_stack]
}

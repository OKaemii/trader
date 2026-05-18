// KEDA — Kubernetes Event-Driven Autoscaling. Powers the scale-to-zero behaviour on
// the daily strategy-engine worker (WP3): when no entries sit on `market:raw:daily`,
// the worker scales to 0 replicas; KEDA spins it back up the moment market-data-service
// emits a daily bar at session close, and scales back down after the cooldown.
//
// The chart installs the operator in its own namespace and registers the ScaledObject /
// TriggerAuthentication / ScaledJob CRDs cluster-wide. ScaledObjects themselves live in
// the trader namespace alongside the deployments they target — see
// infra/helm/trader/charts/strategy-engine/templates/scaledobject.yaml.
resource "helm_release" "keda" {
  name             = "keda"
  repository       = "https://kedacore.github.io/charts"
  chart            = "keda"
  version          = "2.15.1"
  namespace        = "keda"
  create_namespace = true
  // The operator is a no-op until a ScaledObject is created so default values are fine.
  // Pin the chart version explicitly so an upstream bump doesn't silently change scaler
  // semantics under the cluster — we only upgrade after re-reading the changelog.
}

variable "namespace" {}
variable "redis_password" { sensitive = true }
variable "mongodb_password" { sensitive = true }

resource "helm_release" "redis" {
  name       = "redis"
  repository = "https://charts.bitnami.com/bitnami"
  chart      = "redis"
  version    = "25.5.2"
  namespace  = var.namespace

  set {
    name  = "auth.password"
    value = var.redis_password
  }
  set {
    name  = "architecture"
    value = "standalone"
  }
}

resource "helm_release" "mongodb" {
  name       = "mongodb"
  repository = "https://charts.bitnami.com/bitnami"
  chart      = "mongodb"
  version    = "18.7.1"
  namespace  = var.namespace

  set {
    name  = "auth.rootPassword"
    value = var.mongodb_password
  }
  set {
    name  = "auth.username"
    value = "trader"
  }
  set {
    name  = "auth.password"
    value = var.mongodb_password
  }
  set {
    name  = "auth.database"
    value = "trader"
  }
}

resource "helm_release" "trader_app" {
  name      = "trader-app"
  chart     = "../../helm/trader"
  namespace = var.namespace
  depends_on = [helm_release.redis, helm_release.mongodb]
}

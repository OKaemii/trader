variable "namespace" {}
variable "jwt_secret" { sensitive = true }
variable "internal_secret" { sensitive = true }
variable "redis_password" { sensitive = true }
variable "mongodb_password" { sensitive = true }
variable "t212_api_key" { sensitive = true }
variable "resend_api_key" { sensitive = true }
variable "notify_email" {}
variable "seed_admin_email" { default = "" }
variable "seed_admin_password" {
  sensitive = true
  default   = ""
}

resource "kubernetes_namespace" "trader" {
  metadata { name = var.namespace }
}

resource "kubernetes_secret" "trader_secrets" {
  metadata {
    name      = "trader-secrets"
    namespace = var.namespace
  }
  data = {
    JWT_SECRET          = var.jwt_secret
    INTERNAL_SECRET     = var.internal_secret
    REDIS_PASSWORD      = var.redis_password
    MONGODB_PASSWORD    = var.mongodb_password
    T212_API_KEY        = var.t212_api_key
    RESEND_API_KEY      = var.resend_api_key
    NOTIFY_EMAIL        = var.notify_email
    SEED_ADMIN_EMAIL    = var.seed_admin_email
    SEED_ADMIN_PASSWORD = var.seed_admin_password
  }
  depends_on = [kubernetes_namespace.trader]
}

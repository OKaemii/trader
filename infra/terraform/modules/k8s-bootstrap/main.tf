variable "namespace" {}
variable "jwt_secret" { sensitive = true }
variable "internal_secret" { sensitive = true }
variable "redis_password" { sensitive = true }
variable "mongodb_password" { sensitive = true }
variable "timescaledb_password" { sensitive = true }
variable "t212_api_key" { sensitive = true }
variable "t212_api_key_id" {
  sensitive = true
  default   = ""
}
variable "t212_api_key_demo" {
  sensitive = true
  default   = ""
}
variable "t212_api_key_id_demo" {
  sensitive = true
  default   = ""
}
variable "resend_api_key" { sensitive = true }
variable "deepseek_api_key" {
  sensitive = true
  default   = ""
}
variable "email_to" {}
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
    TIMESCALEDB_PASSWORD = var.timescaledb_password
    T212_API_KEY         = var.t212_api_key
    T212_API_KEY_ID      = var.t212_api_key_id
    T212_API_KEY_DEMO    = var.t212_api_key_demo
    T212_API_KEY_ID_DEMO = var.t212_api_key_id_demo
    RESEND_API_KEY       = var.resend_api_key
    DEEPSEEK_API_KEY     = var.deepseek_api_key
    EMAIL_TO            = var.email_to
    SEED_ADMIN_EMAIL    = var.seed_admin_email
    SEED_ADMIN_PASSWORD = var.seed_admin_password
  }
  depends_on = [kubernetes_namespace.trader]
}

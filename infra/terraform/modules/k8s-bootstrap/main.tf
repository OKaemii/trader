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
variable "twelvedata_api_key" {
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

# GHCR credentials for pulling the private trader-* images that the build-deploy
# workflow pushes. ghcr_username is the GitHub username/org; ghcr_token is a PAT
# (or fine-grained token) with read:packages.
variable "ghcr_username" {
  default = ""
}
variable "ghcr_token" {
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
    TWELVEDATA_API_KEY   = var.twelvedata_api_key
    RESEND_API_KEY       = var.resend_api_key
    DEEPSEEK_API_KEY     = var.deepseek_api_key
    EMAIL_TO            = var.email_to
    SEED_ADMIN_EMAIL    = var.seed_admin_email
    SEED_ADMIN_PASSWORD = var.seed_admin_password
  }
  depends_on = [kubernetes_namespace.trader]
}

# Private-GHCR image pull secret. The build-deploy workflow pushes images to
# ghcr.io/<owner>/trader-*; k3s needs credentials to pull them. Attached to the
# namespace default ServiceAccount below so every pod inherits it without each
# Deployment having to declare imagePullSecrets.
resource "kubernetes_secret" "ghcr_pull" {
  metadata {
    name      = "ghcr-pull"
    namespace = var.namespace
  }
  type = "kubernetes.io/dockerconfigjson"
  data = {
    ".dockerconfigjson" = jsonencode({
      auths = {
        "ghcr.io" = {
          username = var.ghcr_username
          password = var.ghcr_token
          auth     = base64encode("${var.ghcr_username}:${var.ghcr_token}")
        }
      }
    })
  }
  depends_on = [kubernetes_namespace.trader]
}

# Attach ghcr-pull to the namespace default ServiceAccount so all trader pods can
# pull private images. k3s auto-creates this SA with the namespace; this resource
# adopts and patches it (Terraform owns it from here on).
resource "kubernetes_default_service_account" "trader" {
  metadata {
    namespace = var.namespace
  }
  image_pull_secret {
    name = kubernetes_secret.ghcr_pull.metadata[0].name
  }
  depends_on = [kubernetes_secret.ghcr_pull]
}
